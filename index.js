/**
 * Host half of the usage-hud bundle.
 *
 * The readout itself is rendered by the Client module through
 * `conversation.composer.dock`. This half answers `GET /usage-hud/today`:
 * today's provider-reported usage aggregated from the durable session logs,
 * bucketed by local hour and by the provider's peak/off-peak price window. DSH
 * stores no currency prices, so the fee is computed from `prices.json` beside
 * this file (with a shipped fallback).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PRICES = join(PLUGIN_DIR, 'prices.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const CACHE_TTL_MS = 90000;

/**
 * Shipped price table; `prices.json` beside this file overrides it.
 *
 * Prices are the provider's PEAK rate in CNY per million tokens. Off-peak is the
 * peak rate times `offPeakDiscount`. The peak window is DeepSeek's: Beijing time,
 * Monday to Friday excluding Chinese statutory holidays, 09:00-12:00 and
 * 14:00-18:00; everything else is off-peak.
 */
const DEFAULT_PRICES = {
  currency: 'CNY',
  unit: 'per-million-tokens',
  fallbackModel: 'deepseek-flash',
  pricingBasis: 'peak',
  offPeakDiscount: 0.5,
  peak: { weekdays: [1, 2, 3, 4, 5], intervals: [[540, 720], [840, 1080]], holidays: [] },
  models: {
    'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  note: 'Peak prices in CNY per million tokens; off-peak scales by offPeakDiscount.',
};

/** @returns the price table, preferring `prices.json`. */
function loadPrices() {
  try {
    const parsed = JSON.parse(readFileSync(PRICES, 'utf8'));
    return { ...DEFAULT_PRICES, ...parsed, models: { ...DEFAULT_PRICES.models, ...(parsed.models ?? {}) } };
  } catch {
    return DEFAULT_PRICES;
  }
}

/** @returns local midnight of the given instant. */
function localMidnight(instant) {
  const date = new Date(instant);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** @returns the minute of the local day, 0..1439. */
function minuteOfDay(instant) {
  const date = new Date(instant);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Decode a jsonl.zstd session log, whose frames are appended independently.
 * @param buffer - raw file bytes.
 * @returns parsed events, in file order.
 */
function decodeEvents(buffer) {
  const magics = [];
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) {
      magics.push(index);
    }
  }
  let text = '';
  for (let index = 0; index < magics.length; index += 1) {
    const start = magics[index];
    const end = index + 1 < magics.length ? magics[index + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    } catch {
      // A byte pattern that only looks like a frame boundary; skip it.
    }
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A line cut by a frame boundary; the next frame repeats nothing.
    }
  }
  return events;
}

/** @returns the account/session log files that can hold events from `since`. */
function recentLogs(root, since) {
  const files = [];
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    let sessions;
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(workspaceDir, session.name);
      let entries;
      try {
        entries = readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue;
        const path = join(sessionDir, entry.name);
        try {
          const stat = statSync(path);
          if (stat.size > MAX_LOG_BYTES) continue;
          if (stat.mtimeMs < since) continue;
          files.push({ path, mtimeMs: stat.mtimeMs });
        } catch {
          // Unreadable file: leave it out.
        }
      }
    }
  }
  return files;
}

/** @returns a fresh accumulator for one bucket. */
function emptyBucket() {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tokens: 0, fee: 0 };
}

/** @param target - bucket to add into. @param usage - provider-reported usage. */
function addUsage(target, usage) {
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  target.requests += 1;
  target.input += input;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.output += output;
  target.tokens += input + cacheRead + cacheWrite + output;
}

/**
 * @param instant - epoch ms.
 * @param peak - the peak-window definition.
 * @returns whether the instant falls in the provider's peak price window.
 */
function isPeakTime(instant, peak) {
  const date = new Date(instant);
  const weekdays = Array.isArray(peak.weekdays) ? peak.weekdays : [1, 2, 3, 4, 5];
  if (!weekdays.includes(date.getDay())) return false;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const key = `${date.getFullYear()}-${month}-${day}`;
  if (Array.isArray(peak.holidays) && peak.holidays.includes(key)) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  const intervals = Array.isArray(peak.intervals) ? peak.intervals : [];
  return intervals.some(([from, to]) => minute >= from && minute < to);
}

/**
 * @param usage - provider-reported usage for one request.
 * @param price - peak-rate prices for one model.
 * @param discount - window multiplier.
 * @returns fee for that single request.
 */
function feeOfUsage(usage, price, discount) {
  const uncached = ((usage.input + usage.cacheWrite) / 1e6) * price.cacheMiss;
  const cached = (usage.cacheRead / 1e6) * price.cacheHit;
  const output = (usage.output / 1e6) * price.output;
  return (uncached + cached + output) * discount;
}

/** @returns the sessions root under the harness home. */
function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
}

/** @returns the log file of one session, or undefined when it is not on disk. */
function sessionLog(sessionId) {
  let workspaces;
  try {
    workspaces = readdirSync(sessionsRoot(), { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const sessionDir = join(sessionsRoot(), workspace.name, sessionId);
    try {
      const entries = readdirSync(sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue;
        return join(sessionDir, entry.name);
      }
    } catch {
      // Not this workspace.
    }
  }
  return undefined;
}

/**
 * Price every assistant message of one session, so the message action strip can
 * show what that reply cost.
 * @param sessionId - durable session id.
 * @returns per-message fee and token totals, keyed by message id.
 */
function aggregateSession(sessionId) {
  const file = sessionLog(sessionId);
  if (file === undefined) return { session: sessionId, found: false, currency: loadPrices().currency, messages: {} };

  const prices = loadPrices();
  const discount = typeof prices.offPeakDiscount === 'number' ? prices.offPeakDiscount : 0.5;
  const peakWindow = prices.peak ?? DEFAULT_PRICES.peak;

  let events;
  try {
    events = decodeEvents(readFileSync(file));
  } catch {
    return { session: sessionId, found: false, currency: prices.currency, messages: {} };
  }

  const messages = {};
  const turns = new Map();
  let route;
  for (const event of events) {
    if (event?.type === 'request/context' && typeof event.data?.model === 'string') {
      route = event.data.model;
    } else if (event?.type === 'request/header' && typeof event.data?.header?.config?.model === 'string') {
      route = event.data.header.config.model;
    }
    if (event?.type !== 'assistant/message' || event.data?.usage === undefined) continue;
    const id = event.data.message?.id;
    const time = event.time;
    if (typeof id !== 'string' || typeof time !== 'number') continue;

    const usage = event.data.usage;
    const model = route ?? 'unknown';
    const exact = prices.models[model] !== undefined;
    const price = exact ? prices.models[model] : prices.models[prices.fallbackModel];
    const peak = isPeakTime(time, peakWindow);
    const amount = feeOfUsage(
      {
        input: Number(usage.inputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0,
        output: Number(usage.outputTokens) || 0,
      },
      price,
      peak ? 1 : discount,
    );
    messages[id] = {
      model,
      peak,
      turn: event.data.turn,
      fee: amount,
      input: Number(usage.inputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      cacheWrite: Number(usage.cacheWriteTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      tokens:
        (Number(usage.inputTokens) || 0) +
        (Number(usage.cacheReadTokens) || 0) +
        (Number(usage.cacheWriteTokens) || 0) +
        (Number(usage.outputTokens) || 0),
    };

    // The message action strip shows the whole Turn's token total, so the fee
    // beside it must be the Turn's fee — one message's share is an order of
    // magnitude smaller and would read as a mismatch.
    const turn = event.data.turn;
    if (typeof turn === 'number') {
      const aggregate = turns.get(turn) ?? { tokens: 0, fee: 0, messages: 0 };
      aggregate.tokens += messages[id].tokens;
      aggregate.fee += amount;
      aggregate.messages += 1;
      turns.set(turn, aggregate);
    }
  }

  for (const entry of Object.values(messages)) {
    const aggregate = typeof entry.turn === 'number' ? turns.get(entry.turn) : undefined;
    if (aggregate === undefined) continue;
    entry.turnTokens = aggregate.tokens;
    entry.turnFee = aggregate.fee;
    entry.turnMessages = aggregate.messages;
  }

  return { session: sessionId, found: true, currency: prices.currency, messages };
}

/** @returns the whole day's aggregate. */
function aggregateToday(now) {
  const prices = loadPrices();
  const discount = typeof prices.offPeakDiscount === 'number' ? prices.offPeakDiscount : 0.5;
  const peakWindow = prices.peak ?? DEFAULT_PRICES.peak;
  const start = localMidnight(now);
  const end = start + DAY_MS;
  const roots = [process.env.DSH_HOME ?? join(homedir(), '.dsh')].map((home) => join(home, 'sessions'));

  const hours = Array.from({ length: 24 }, () => emptyBucket());
  const models = new Map();
  let scanned = 0;

  /** @param instant - event time. @returns the model price row and its window multiplier. */
  const priceAt = (instant, model) => {
    const exact = prices.models[model] !== undefined;
    const price = exact ? prices.models[model] : prices.models[prices.fallbackModel];
    return { price, exact, multiplier: isPeakTime(instant, peakWindow) ? 1 : discount };
  };

  for (const root of roots) {
    for (const file of recentLogs(root, start - 2 * 60 * 60 * 1000)) {
      let events;
      try {
        events = decodeEvents(readFileSync(file.path));
      } catch {
        continue;
      }
      scanned += 1;
      let route;
      for (const event of events) {
        if (event?.type === 'request/context' && typeof event.data?.model === 'string') {
          route = event.data.model;
        } else if (event?.type === 'request/header' && typeof event.data?.header?.config?.model === 'string') {
          route = event.data.header.config.model;
        }
        const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined;
        const time = event?.time;
        if (usage === undefined || typeof time !== 'number') continue;
        if (time < start || time >= end) continue;

        const model = route ?? 'unknown';
        const { price, multiplier } = priceAt(time, model);
        const sample = {
          input: Number(usage.inputTokens) || 0,
          cacheRead: Number(usage.cacheReadTokens) || 0,
          cacheWrite: Number(usage.cacheWriteTokens) || 0,
          output: Number(usage.outputTokens) || 0,
        };
        const amount = feeOfUsage(sample, price, multiplier);

        const hour = new Date(time).getHours();
        addUsage(hours[hour], usage);
        hours[hour].fee += amount;
        if (!models.has(model)) models.set(model, emptyBucket());
        addUsage(models.get(model), usage);
        models.get(model).fee += amount;
      }
    }
  }

  const totals = emptyBucket();
  const peak = emptyBucket();
  const offPeak = emptyBucket();
  const hoursOut = [];

  for (let hour = 0; hour < 24; hour += 1) {
    const bucket = hours[hour];
    for (const key of ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'tokens', 'fee']) totals[key] += bucket[key];
    // A single local date means the weekday is constant, so the window of an
    // hour is decided by its start minute.
    const hourStart = start + hour * 60 * 60 * 1000;
    const window = isPeakTime(hourStart, peakWindow) ? 'peak' : 'offPeak';
    const target = window === 'peak' ? peak : offPeak;
    for (const key of ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'tokens', 'fee']) target[key] += bucket[key];
    hoursOut.push({ hour, ...bucket, window });
  }

  const modelsOut = [];
  for (const [model, bucket] of models) {
    modelsOut.push({ model, ...bucket, pricing: prices.models[model] === undefined ? 'fallback' : 'exact' });
  }

  return {
    day: new Date(start).toISOString().slice(0, 10),
    start,
    end,
    now,
    currency: prices.currency,
    unit: prices.unit,
    pricingBasis: prices.pricingBasis ?? 'peak',
    offPeakDiscount: discount,
    peakWindow: {
      weekdays: peakWindow.weekdays ?? [1, 2, 3, 4, 5],
      intervals: peakWindow.intervals ?? DEFAULT_PRICES.peak.intervals,
      holidays: peakWindow.holidays ?? [],
    },
    scannedFiles: scanned,
    totals,
    peak,
    offPeak,
    hours: hoursOut,
    models: modelsOut.sort((left, right) => right.tokens - left.tokens),
    pricing: {
      fallbackModel: prices.fallbackModel,
      known: Object.keys(prices.models),
      exact: modelsOut.every((entry) => entry.pricing === 'exact'),
    },
  };
}
const SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function apply(ctx) {
  let todayCache;
  const sessionCache = new Map();
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: '/usage-hud',
          handler: (req, res) => {
            const url = req.url ?? '/usage-hud';
            const send = (payload) => {
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              res.end(JSON.stringify(payload));
            };

            if (req.method !== 'GET') {
              res.writeHead(404);
              res.end();
              return;
            }

            const now = Date.now();
            const force = url.includes('force=1');

            if (url.startsWith('/usage-hud/today')) {
              if (force || todayCache === undefined || now - todayCache.at > CACHE_TTL_MS) {
                let payload;
                try {
                  payload = aggregateToday(now);
                } catch (error) {
                  payload = { error: String(error && (error.message || error)) };
                }
                todayCache = { at: now, payload };
              }
              send(todayCache.payload);
              return;
            }

            if (url.startsWith('/usage-hud/session')) {
              const sessionId = new URL(url, 'http://x').searchParams.get('session') ?? '';
              if (!SESSION_ID.test(sessionId)) {
                res.writeHead(400);
                res.end();
                return;
              }
              const cached = sessionCache.get(sessionId);
              if (!force && cached !== undefined && now - cached.at <= CACHE_TTL_MS) {
                send(cached.payload);
                return;
              }
              let payload;
              try {
                payload = aggregateSession(sessionId);
              } catch (error) {
                payload = { session: sessionId, found: false, messages: {}, error: String(error && (error.message || error)) };
              }
              sessionCache.set(sessionId, { at: now, payload });
              send(payload);
              return;
            }

            res.writeHead(404);
            res.end();
          },
        }),
      'usage-hud: usage routes',
    );
  });
}