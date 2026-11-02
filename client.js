/**
 * Usage HUD — a permanently visible readout in the composer dock.
 *
 * It answers the question "how much have I spent, and how full is the context"
 * without opening Settings or hovering a pill: session token totals, cache-hit
 * ratio, context occupancy and — when an account credential is stored — the
 * Platform balance, all on one line under the composer.
 *
 * Every number is read from the Client services that already own it:
 * `tokenUsage` and `contextPressure` are session projections, and the balance is
 * a Host Remote call shared through a small module-level cache so that switching
 * sessions or remounting the dock does not re-hit the network.
 */

window.__ModuleLoader__.load({
  id: '@local/usage-hud',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = '@local/usage-hud';
    const STYLE_TAG = NS + '/usage-hud.css';
    const BALANCE_TTL_MS = 60000;
    const TODAY_TTL_MS = 90000;
    const FALLBACK_CLIENT_VERSION = '0.2.1-rc.5';

    /** Copy for both shipped locales; slot copy re-reads it on a language switch. */
    const COPY = {
      en: {
        'hud.tokens': '{value} tok',
        'hud.cache': 'cache {percent}%',
        'hud.context': 'context {percent}%',
        'hud.balance': 'balance {amount}',
        'hud.placeholder': 'usage —',
        'hud.balanceUnavailable': 'balance —',
        'hud.aria': 'Account balance. Activate to refresh.',
        'panel.title': 'Today',
        'panel.requests': '{count} requests',
        'panel.peak': 'Peak',
        'panel.peakWindow': 'the rest of the day',
        'panel.offPeakNote': '{percent}% of peak rate',
        'panel.offPeak': 'Off-peak',
        'panel.total': 'Total',
        'panel.hours': 'Usage by hour',
        'panel.hourTip': '{hour}:00 · {tokens} tok',
        'panel.hourCost': '{amount} · {window}',
        'panel.in': 'Uncached input',
        'panel.cacheRead': 'Cached input',
        'panel.cacheWrite': 'Cache write',
        'panel.out': 'Output',
        'panel.empty': 'No usage recorded today.',
        'panel.loading': 'Loading…',
        'panel.updated': 'updated {time}',
        'panel.error': 'Could not read today’s usage.',
        'panel.refresh': 'Refresh',
        'panel.close': 'Close',
        'panel.fallback': 'Fees use {model} prices. Add your model to prices.json for exact cost.',
        'turn.cost': '{amount}',
        'turn.costTitle': 'This turn cost {amount} ({tokens} tok)',
        'detail.title': 'Usage',
        'detail.tokens': 'Session total: {count} tok',
        'detail.input': 'Uncached input: {count}',
        'detail.cacheRead': 'Cached input: {count}',
        'detail.cacheWrite': 'Cache write: {count}',
        'detail.output': 'Output: {count}',
        'detail.cacheHit': 'Cache hit: {percent}%',
        'detail.context': 'Context: {percent}% ({used} / {window})',
        'detail.balance': 'Balance: {amount}',
        'detail.bonus': 'Bonus credit: {amount}',
      },
      zh: {
        'hud.tokens': '{value} tok',
        'hud.cache': '缓存 {percent}%',
        'hud.context': '上下文 {percent}%',
        'hud.balance': '余额 {amount}',
        'hud.placeholder': '用量 —',
        'hud.balanceUnavailable': '余额 —',
        'hud.aria': '账户余额，点击查看今日用量。',
        'panel.title': '今日用量',
        'panel.requests': '{count} 次请求',
        'panel.peak': '忙时',
        'panel.peakWindow': '其余时段',
        'panel.offPeakNote': '{percent}% 价',
        'panel.offPeak': '闲时',
        'panel.total': '合计',
        'panel.hours': '按小时分布',
        'panel.hourTip': '{hour}:00 · {tokens} tok',
        'panel.hourCost': '{amount} · {window}',
        'panel.in': '未缓存输入',
        'panel.cacheRead': '缓存读取',
        'panel.cacheWrite': '缓存写入',
        'panel.out': '输出',
        'panel.empty': '今天还没有用量记录。',
        'panel.loading': '读取中…',
        'panel.updated': '更新于 {time}',
        'panel.error': '读取今日用量失败。',
        'panel.refresh': '刷新',
        'panel.close': '关闭',
        'panel.fallback': '费用按 {model} 单价估算；在 prices.json 里加上你的模型即可精确计费。',
        'turn.cost': '{amount}',
        'turn.costTitle': '本轮花费 {amount}（{tokens} tok）',
        'detail.title': '用量',
        'detail.tokens': '会话合计：{count} tok',
        'detail.input': '未缓存输入：{count}',
        'detail.cacheRead': '缓存读取：{count}',
        'detail.cacheWrite': '缓存写入：{count}',
        'detail.output': '输出：{count}',
        'detail.cacheHit': '缓存命中：{percent}%',
        'detail.context': '上下文：{percent}%（{used} / {window}）',
        'detail.balance': '余额：{amount}',
        'detail.bonus': '赠送额度：{amount}',
      },
    };

    const CSS = [
      '.uh-row{display:inline-flex;align-items:center;justify-content:center;gap:0;max-width:100%;flex-wrap:wrap}',
      '.uh-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.uh-pill:hover,.uh-pill:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.uh-pill:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:1px}',
      '.uh-pill svg{flex:none;width:14px;height:14px}',
      '.uh-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.uh-sep{color:var(--dsw-alias-label-tertiary);opacity:.55;padding:0 1px;user-select:none}',
      '.uh-strong{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.uh-panel{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:18px;max-height:min(60vh,440px);overflow-y:auto}',
      '.uh-panel-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
      '.uh-panel-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
      '.uh-panel-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}',
      '.uh-panel-rows{display:flex;flex-direction:column;gap:4px;margin:8px 0 0}',
      '.uh-panel-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.uh-panel-key{color:var(--dsw-alias-label-secondary);margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.uh-panel-strong{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.uh-panel-value{color:var(--dsw-alias-label-primary);margin:0;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.uh-bars{display:flex;align-items:flex-end;gap:2px;height:36px;margin:10px 0 2px}',
      '.uh-bars-wrap{position:relative}',
      '.uh-tip{position:absolute;bottom:calc(100% + 4px);transform:translateX(-50%);pointer-events:none;white-space:nowrap;border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);padding:2px 8px;font-size:12px;line-height:16px;display:flex;flex-direction:column;align-items:center;z-index:2}',
      '.uh-tip-main{font-variant-numeric:tabular-nums}',
      '.uh-tip-sub{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      /* No horizontal padding: the usage pill already pads 8px inside its own
         box, so an unpadded fee keeps the same 16px optical gap on both sides
         (8px pill padding + 8px row gap on the left, 8px margin + 8px row gap
         on the right) as the clock. */
      '.uh-cost{box-sizing:border-box;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;align-items:center;padding:1px 0;margin-right:8px;display:inline-flex;order:2}',
      /* The host renders the usage pill and the clock inside one inline-flex box
         that no slot reaches. Making that box box-less promotes both to flex
         items of the action row, so `order` can seat the fee between them. */
      '[data-clock="end"] > span:last-child{display:contents}',
      /* Restore the 8px left offset the promoted first item lost with its parent
         box, so the cluster keeps its original distance from the branch button. */
      '[data-clock="end"] > span:last-child > :first-child{margin-left:8px}',
      '[data-clock="end"] > span:last-child > :last-child{order:3}',
      '.uh-bar{flex:1;min-width:2px;border-radius:2px;background:var(--dsw-alias-label-tertiary);opacity:.5}',
      '.uh-bar-offpeak{background:var(--dsw-static-blue-450);opacity:.85}',
      '.uh-panel-note{color:var(--dsw-alias-label-tertiary);margin-top:8px}',
      '.uh-panel-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.uh-panel-button{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);cursor:pointer;border:0;padding:2px 10px;font:inherit;line-height:20px}',
      '.uh-panel-button:hover{color:var(--dsw-alias-label-primary)}',
      '.uh-panel-button:disabled{opacity:.5;cursor:default}',
    ].join('');

    /** @returns the Host build string used as Remote client metadata. */
    function clientVersion() {
      const boot = globalThis.__DSH_BOOT__;
      const candidates = [boot?.release?.version, boot?.version, boot?.clientVersion];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate;
      }
      return FALLBACK_CLIENT_VERSION;
    }

    /** @returns the active UI locale id, read at call time. */
    function activeLocale(ctx) {
      const snapshot = ctx.locale.getSnapshot();
      return typeof snapshot.active === 'string' && snapshot.active !== '' ? snapshot.active : 'en';
    }

    const formatterCache = new Map();

    /**
     * @param tag - BCP 47 tag.
     * @param options - Intl.NumberFormat options.
     * @returns a cached formatter, falling back to English for an unknown tag.
     */
    function formatter(tag, options) {
      const key = tag + '|' + JSON.stringify(options);
      let cached = formatterCache.get(key);
      if (cached !== undefined) return cached;
      try {
        cached = new Intl.NumberFormat(tag, options);
      } catch (_error) {
        cached = new Intl.NumberFormat('en', options);
      }
      formatterCache.set(key, cached);
      return cached;
    }

    /**
     * @param tag - BCP 47 tag.
     * @param value - token count.
     * @returns the count with locale-owned digit grouping.
     */
    function exact(tag, value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      return formatter(tag, { maximumFractionDigits: 0 }).format(value);
    }

    /**
     * Compact token count using the shared `common` namespace templates so the
     * readout matches the host pills.
     * @param value - token count.
     * @param t - translate seat.
     * @returns compact count, e.g. `12.3K`.
     */
    function compact(value, t) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
      if (value < 1000) return String(Math.round(value));
      if (value < 1e6) return t('number.thousand', { value: scaled(value / 1e3) });
      return t('number.million', { value: scaled(value / 1e6) });
    }

    /**
     * Host-currency-formatted amount, keeping the server's own string when the
     * currency is unknown to `Intl`.
     * @param tag - BCP 47 tag.
     * @param currency - ISO 4217 code reported by the Host.
     * @param amount - decimal string reported by the Host.
     * @returns display text.
     */
    function money(tag, currency, amount) {
      const parsed = Number(amount);
      if (!Number.isFinite(parsed)) return String(amount);
      try {
        return formatter(tag, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(parsed);
      } catch (_error) {
        return currency + ' ' + String(amount);
      }
    }

    /**
     * Balance reader shared by every mounted dock entry: one Host call serves all
     * of them for `BALANCE_TTL_MS`, and a forced read refreshes the shared cache.
     * @param ctx - Client root context.
     * @returns a reader resolving to the Host balance value, or null when unavailable.
     */
    function createBalanceReader(ctx) {
      let cached;
      let cachedAt = 0;
      let inflight = null;

      return function readBalance(force) {
        // A Remote namespace is its own injectable service, so `remote.account`
        // must be declared to be readable; resolve it defensively because an
        // absent account must degrade the readout, never blank the slot entry.
        let account;
        try {
          account = ctx.get('remote.account');
        } catch (_error) {
          return Promise.resolve(null);
        }
        if (account === undefined || typeof account.getBalance !== 'function') return Promise.resolve(null);

        const now = Date.now();
        if (force !== true && cached !== undefined && now - cachedAt < BALANCE_TTL_MS) return Promise.resolve(cached);
        if (inflight !== null) return inflight;

        const metadata = {
          version: clientVersion(),
          locale: activeLocale(ctx),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };

        inflight = (async () => {
          try {
            const result = await account.getBalance(metadata);
            if (result === null || result === undefined || result.ok !== true) return null;
            const value = result.value;
            if (value === null || value === undefined || value.status !== 'ready') return null;
            return value;
          } catch (_error) {
            return null;
          } finally {
            inflight = null;
          }
        })();

        return inflight.then((value) => {
          cached = value;
          cachedAt = Date.now();
          return value;
        });
      };
    }

    /**
     * Per-message fees for one session, shared by every message action strip.
     * @returns a reader resolving to `{ currency, messages }`, or null when the
     *   session log is not readable.
     */
    function createSessionCostReader() {
      const entries = new Map();
      return function readSession(sessionId, force) {
        if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve(null);
        const now = Date.now();
        const entry = entries.get(sessionId);
        if (force !== true && entry !== undefined) {
          if (entry.inflight !== undefined) return entry.inflight;
          if (now - entry.at < TODAY_TTL_MS) return Promise.resolve(entry.payload);
        }
        const query = '/usage-hud/session?session=' + encodeURIComponent(sessionId) + (force === true ? '&force=1' : '');
        const request = fetch(query, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((payload) => {
            entries.set(sessionId, { at: Date.now(), payload });
            return payload;
          })
          .catch(() => {
            entries.set(sessionId, { at: Date.now(), payload: null });
            return null;
          });
        entries.set(sessionId, {
          at: entry === undefined ? 0 : entry.at,
          payload: entry === undefined ? null : entry.payload,
          inflight: request,
        });
        return request;
      };
    }

    /** The cost chip in one assistant message's action strip. */
    function TurnCostChip(props) {
      const { messageId, sessionId, t, getLocale, readSession } = props;
      const tr = typeof t === 'function' ? t : (key) => key;
      const tag = typeof getLocale === 'function' ? getLocale() : 'en';
      const [shown, setShown] = React.useState(null);

      React.useEffect(() => {
        if (typeof readSession !== 'function' || typeof messageId !== 'string' || typeof sessionId !== 'string') return undefined;
        let live = true;
        const load = async () => {
          const first = await readSession(sessionId, false);
          if (!live) return;
          const hit = first?.messages?.[messageId];
          if (hit !== undefined) {
            setShown({ entry: hit, currency: first.currency ?? 'CNY' });
            return;
          }
          // A reply that settled after the cache was filled: read once more.
          const forced = await readSession(sessionId, true);
          if (!live) return;
          const again = forced?.messages?.[messageId];
          if (again !== undefined) setShown({ entry: again, currency: forced.currency ?? 'CNY' });
        };
        load().catch(() => {});
        return () => {
          live = false;
        };
      }, [messageId, sessionId]);

      if (shown === null) return null;
      const amount = fee(tag, shown.currency, shown.entry.turnFee ?? shown.entry.fee);
      return h(
        'span',
        {
          className: 'uh-cost',
          title: tr('turn.costTitle', {
            amount,
            tokens: exact(tag, shown.entry.turnTokens ?? shown.entry.tokens),
          }),
        },
        tr('turn.cost', { amount }),
      );
    }

    /**
     * @param usage - `tokenUsage` projection value.
     * @returns billed prompt tokens, the denominator of the cache-hit ratio.
     */
    function billedInput(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    }

    /**
     * @param pressure - `contextPressure` projection value.
     * @returns occupancy, or null while the window is still unknown.
     */
    function occupancy(pressure) {
      const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
      if (used === undefined || pressure?.contextWindow === undefined) return null;
      return {
        percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)),
        used,
        window: pressure.contextWindow,
      };
    }

    /** @returns a two-decimal money string for a computed fee. */
    function fee(tag, currency, value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      try {
        return formatter(tag, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
      } catch (_error) {
        return currency + ' ' + value.toFixed(2);
      }
    }

    /** @returns HH:mm for a minute of the local day. */
    function clock(minute) {
      const hours = String(Math.floor(minute / 60) % 24).padStart(2, '0');
      const minutes = String(minute % 60).padStart(2, '0');
      return hours + ':' + minutes;
    }

    /** @returns HH:mm for an epoch instant. */
    function clockOf(instant) {
      const date = new Date(instant);
      return clock(date.getHours() * 60 + date.getMinutes());
    }

    /** One labelled row of the day panel. */
    function PanelRow(props) {
      return h(
        'div',
        { className: 'uh-panel-row' },
        h('dt', { className: props.muted === true ? 'uh-panel-key' : 'uh-panel-key uh-panel-strong' }, props.label),
        h('dd', { className: 'uh-panel-value' }, props.value),
      );
    }

    /**
     * The 24-hour distribution bars with a hover readout that floats above the
     * chart: the native `title` tooltip renders under the pointer and gets
     * covered by it, so the readout is drawn here instead.
     */
    function HourBars(props) {
      const { hours, tr, tag, currency } = props;
      const [hover, setHover] = React.useState(null);
      const peak = Math.max(1, ...hours.map((hour) => hour.tokens));
      const label = hover === null ? null : hours[hover];
      const left = hover === null ? 0 : Math.min(88, Math.max(12, ((hover + 0.5) / 24) * 100));

      return h(
        'div',
        { className: 'uh-bars-wrap' },
        label === null
          ? null
          : h(
              'div',
              { className: 'uh-tip', style: { left: left + '%' } },
              h('span', { className: 'uh-tip-main' }, tr('panel.hourTip', { hour: String(label.hour).padStart(2, '0'), tokens: compact(label.tokens, tr) })),
              h(
                'span',
                { className: 'uh-tip-sub' },
                tr('panel.hourCost', {
                  amount: fee(tag, currency, label.fee),
                  window: label.window === 'offPeak' ? tr('panel.offPeak') : tr('panel.peak'),
                }),
              ),
            ),
        h(
          'div',
          { className: 'uh-bars', role: 'img', 'aria-label': tr('panel.hours') },
          hours.map((hour) =>
            h('div', {
              key: hour.hour,
              className: hour.window === 'offPeak' ? 'uh-bar uh-bar-offpeak' : 'uh-bar',
              style: { height: Math.max(2, Math.round((hour.tokens / peak) * 34)) + 'px' },
              onMouseEnter: () => setHover(hour.hour),
              onMouseLeave: () => setHover((current) => (current === hour.hour ? null : current)),
            }),
          ),
        ),
      );
    }

    /** Expanded day panel: today's usage by window, hour and model. */
    function TodayPanel(props) {
      const { tr, tag, data, loading, error, updatedAt, onRefresh, onClose, style, nodeRef } = props;
      const rows = [];

      if (error !== null) {
        rows.push(h('div', { key: 'error', className: 'uh-panel-note' }, tr('panel.error')));
      } else if (data === null) {
        rows.push(h('div', { key: 'loading', className: 'uh-panel-note' }, tr('panel.loading')));
      } else if (data.error !== undefined) {
        rows.push(h('div', { key: 'error', className: 'uh-panel-note' }, String(data.error)));
      } else {
        const currency = data.currency ?? 'CNY';
        const peakWindow = data.peakWindow ?? { intervals: [[540, 720], [840, 1080]] };
        const intervals = Array.isArray(peakWindow.intervals) ? peakWindow.intervals : [];
        const discount = typeof data.offPeakDiscount === 'number' ? data.offPeakDiscount : 0.5;
        const peakLabel =
          tr('panel.peak') + (intervals.length === 0 ? '' : ' · ' + intervals.map(([from, to]) => clock(from) + '–' + clock(to)).join(' / '));
        const offPeakLabel = tr('panel.offPeak') + ' · ' + tr('panel.offPeakNote', { percent: Math.round(discount * 100) });
        rows.push(
          h(
            'div',
            { key: 'head', className: 'uh-panel-head' },
            h('span', { className: 'uh-panel-title' }, tr('panel.title')),
            h(
              'span',
              { className: 'uh-panel-sub' },
              data.day +
                ' · ' +
                tr('panel.requests', { count: exact(tag, data.totals.requests) }) +
                (updatedAt > 0 ? ' · ' + tr('panel.updated', { time: clockOf(updatedAt) }) : ''),
            ),
          ),
        );

        if (data.totals.requests === 0) {
          rows.push(h('div', { key: 'empty', className: 'uh-panel-note' }, tr('panel.empty')));
        } else {
          rows.push(
            h(
              'dl',
              { key: 'windows', className: 'uh-panel-rows' },
              h(PanelRow, {
                key: 'peak',
                label: peakLabel,
                value: compact(data.peak.tokens, tr) + ' tok · ' + fee(tag, currency, data.peak.fee),
              }),
              h(PanelRow, {
                key: 'offpeak',
                label: offPeakLabel,
                value: compact(data.offPeak.tokens, tr) + ' tok · ' + fee(tag, currency, data.offPeak.fee),
              }),
              h(PanelRow, {
                key: 'total',
                label: tr('panel.total'),
                value: compact(data.totals.tokens, tr) + ' tok · ' + fee(tag, currency, data.totals.fee),
              }),
            ),
            h(HourBars, { key: 'bars', hours: data.hours, tr, tag, currency }),
            h(
              'dl',
              { key: 'detail', className: 'uh-panel-rows' },
              h(PanelRow, { key: 'in', label: tr('panel.in'), value: exact(tag, data.totals.input), muted: true }),
              h(PanelRow, { key: 'read', label: tr('panel.cacheRead'), value: exact(tag, data.totals.cacheRead), muted: true }),
              data.totals.cacheWrite === 0
                ? null
                : h(PanelRow, { key: 'write', label: tr('panel.cacheWrite'), value: exact(tag, data.totals.cacheWrite), muted: true }),
              h(PanelRow, { key: 'out', label: tr('panel.out'), value: exact(tag, data.totals.output), muted: true }),
            ),
          );

          const models = data.models ?? [];
          if (models.length > 0) {
            rows.push(
              h(
                'dl',
                { key: 'models', className: 'uh-panel-rows' },
                models.map((entry) =>
                  h(PanelRow, {
                    key: entry.model,
                    label: entry.model,
                    value: compact(entry.tokens, tr) + ' tok · ' + fee(tag, currency, entry.fee),
                    muted: true,
                  }),
                ),
              ),
            );
          }

          if (data.pricing !== undefined && data.pricing.exact !== true) {
            rows.push(
              h(
                'div',
                { key: 'pricing', className: 'uh-panel-note' },
                tr('panel.fallback', { model: data.pricing.fallbackModel }),
              ),
            );
          }
        }
      }

      rows.push(
        h(
          'div',
          { key: 'actions', className: 'uh-panel-actions' },
          h('button', { type: 'button', className: 'uh-panel-button', onClick: onRefresh, disabled: loading }, tr('panel.refresh')),
          h('button', { type: 'button', className: 'uh-panel-button', onClick: onClose }, tr('panel.close')),
        ),
      );

      return h('div', { className: 'uh-panel', role: 'dialog', 'aria-label': tr('panel.title'), style, ref: nodeRef }, rows);
    }

    /** The readout itself. */
    function UsageHud(props) {
      const { useProjection, t, getLocale, readBalance } = props;
      // The slot supplies these seats; a missing one must not blank the entry.
      const project = typeof useProjection === 'function' ? useProjection : undefined;
      const usage = project === undefined ? undefined : project('tokenUsage');
      const pressure = project === undefined ? undefined : project('contextPressure');
      const [balance, setBalance] = React.useState(null);
      const [revision, setRevision] = React.useState(0);

      React.useEffect(() => {
        let live = true;
        if (typeof readBalance !== 'function') return undefined;
        readBalance(revision > 0).then((value) => {
          if (live) setBalance(value);
        });
        return () => {
          live = false;
        };
      }, [revision]);

      const tag = typeof getLocale === 'function' ? getLocale() : 'en';
      const tr = typeof t === 'function' ? t : (key) => key;
      const buttonRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const [open, setOpen] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const [today, setToday] = React.useState(null);
      const [todayAt, setTodayAt] = React.useState(0);
      const todayAtRef = React.useRef(0);
      const [todayError, setTodayError] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const loadToday = React.useCallback((force) => {
        const now = Date.now();
        if (force !== true && todayAtRef.current !== 0 && now - todayAtRef.current < TODAY_TTL_MS) {
          return;
        }
        setLoading(true);
        setTodayError(null);
        fetch(force === true ? '/usage-hud/today?force=1' : '/usage-hud/today', { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((value) => {
            setToday(value);
            todayAtRef.current = Date.now();
            setTodayAt(todayAtRef.current);
            setLoading(false);
          })
          .catch((error) => {
            setTodayError(String((error && error.message) || error));
            setLoading(false);
          });
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return;
          if (buttonRef.current !== null && buttonRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) {
          setPosition(null);
          return;
        }
        const rect = buttonRef.current === null ? undefined : buttonRef.current.getBoundingClientRect();
        if (rect === undefined) return;
        const width = Math.min(340, window.innerWidth - 24);
        const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
        setPosition({ left, bottom: Math.max(12, window.innerHeight - rect.top + 8), width });
      }, [open]);
      const context = occupancy(pressure);
      const cacheHit =
        usage !== undefined && billedInput(usage) > 0 ? Math.round((usage.cacheReadTokens / billedInput(usage)) * 100) : null;
      const total = usage === undefined ? 0 : billedInput(usage) + usage.outputTokens;

      const wallet = balance?.value?.[0];
      // The dock row already carries the session's token, cache-hit and context
      // pills, so the readout adds only what is missing there: the account
      // balance. Without a balance it falls back to those session figures so the
      // entry never disappears silently.
      const segments =
        wallet === undefined
          ? [
              usage === undefined ? null : { key: 'tokens', text: tr('hud.tokens', { value: compact(total, tr) }) },
              cacheHit === null ? null : { key: 'cache', text: tr('hud.cache', { percent: cacheHit }) },
              context === null ? null : { key: 'context', text: tr('hud.context', { percent: context.percent }) },
            ].filter(Boolean)
          : [{ key: 'balance', text: tr('hud.balance', { amount: money(tag, wallet.currency, wallet.balance) }), strong: true }];

      // With no figure to show, keep a neutral placeholder: an entry that
      // silently disappears is indistinguishable from one that failed to load.
      const items =
        segments.length === 0 ? [{ key: 'placeholder', text: tr('hud.placeholder') }] : segments;

      const details = [
        tr('detail.title'),
        usage === undefined ? null : tr('detail.tokens', { count: exact(tag, total) }),
        usage === undefined ? null : tr('detail.input', { count: exact(tag, usage.uncachedInputTokens) }),
        usage === undefined ? null : tr('detail.cacheRead', { count: exact(tag, usage.cacheReadTokens) }),
        usage === undefined || usage.cacheWriteTokens === 0
          ? null
          : tr('detail.cacheWrite', { count: exact(tag, usage.cacheWriteTokens) }),
        usage === undefined ? null : tr('detail.output', { count: exact(tag, usage.outputTokens) }),
        cacheHit === null ? null : tr('detail.cacheHit', { percent: cacheHit }),
        context === null
          ? null
          : tr('detail.context', {
              percent: context.percent,
              used: exact(tag, context.used),
              window: exact(tag, context.window),
            }),
        wallet === undefined ? null : tr('detail.balance', { amount: money(tag, wallet.currency, wallet.balance) }),
        balance?.bonusWallets?.[0] === undefined
          ? null
          : tr('detail.bonus', {
              amount: money(tag, balance.bonusWallets[0].currency, balance.bonusWallets[0].balance),
            }),
      ]
        .filter(Boolean)
        .join('\n');

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style', 'data-plugin-css': STYLE_TAG }, CSS),
        h(
          'div',
          { key: 'row', className: 'uh-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'uh-pill',
              ref: buttonRef,
              title: details,
              'aria-label': tr('hud.aria'),
              'aria-expanded': open,
              onClick: () => {
                if (open) {
                  setOpen(false);
                  return;
                }
                setOpen(true);
                loadToday(false);
              },
            },
            h(
              'svg',
              { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 },
              h('ellipse', { cx: 8, cy: 4, rx: 5, ry: 2 }),
              h('path', { d: 'M3 4v4c0 1.1 2.24 2 5 2s5-.9 5-2V4' }),
              h('path', { d: 'M3 8v4c0 1.1 2.24 2 5 2s5-.9 5-2V8' }),
            ),
            items.flatMap((segment, index) => [
              index === 0
                ? null
                : h('span', { key: segment.key + '-sep', className: 'uh-sep', 'aria-hidden': true }, '·'),
              h(
                'span',
                { key: segment.key, className: segment.strong === true ? 'uh-label uh-strong' : 'uh-label' },
                segment.text,
              ),
            ]),
          ),
        ),
        open && position !== null
          ? h(TodayPanel, {
              key: 'panel',
              tr,
              tag,
              data: today,
              loading,
              error: todayError,
              updatedAt: todayAt,
              onRefresh: () => {
                loadToday(true);
                setRevision((value) => value + 1);
              },
              onClose: () => setOpen(false),
              style: position,
              nodeRef: panelRef,
            })
          : null,
      );
    }

    /** Reports a render failure instead of silently blanking the slot entry. */
    class HudBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        console.error('[usage-hud] render failed', error);
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    /** Slot entry wrapper: keeps one failing render from vanishing without a trace. */
    function BoundedUsageHud(props) {
      return h(HudBoundary, null, h(UsageHud, props));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        try {
          ctx.effect(() => {
            try {
              return ctx.locale.register(NS, COPY);
            } catch (error) {
              // A hot reload can re-register without disposing the previous copy.
              console.error('[usage-hud] locale registration failed', error);
              return () => {};
            }
          }, 'usage-hud: dictionaries');

          const readBalance = createBalanceReader(ctx);
          const readSession = createSessionCostReader();

          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'usage-hud',
                order: 2,
                locale: NS,
                inject: () => ({ getLocale: () => activeLocale(ctx), readBalance }),
              },
              BoundedUsageHud,
            ),
          );

          ctx.slots.inject('conversation.chat.assistant-actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.assistant-actions',
                id: 'usage-cost',
                order: 1,
                locale: NS,
                inject: () => ({ getLocale: () => activeLocale(ctx), readSession }),
              },
              TurnCostChip,
            ),
          );
        } catch (error) {
          console.error('[usage-hud] activation failed', error);
        }
      },
    };
  },
});