# Usage HUD · 用量读数

在 DeepSeek Harness 的输入框下方常驻一行账户余额；点一下展开当天的用量与花费，每条回复旁边也会标出这条回答花了多少钱。

> A composer-dock readout for DeepSeek Harness: account balance always visible, one click for today's token usage by hour and by peak/off-peak price window, plus a per-reply cost chip next to each answer.

---

## 功能

**1. 常驻胶囊**

```
[复制] [👍] [👎] [分支]   ⛁ 用量 7.5M tok   ¥0.50   02:34
                                        ↑       ↑       ↑
                                      本次回答  花费    时间
```

- 输入框上方：`⛁ 余额 ¥128.00`，不点也一直在
- 每条回复的按钮行里：这一条回答的 token 与花费
- 悬停任意一处可看精确明细（未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 上下文占用）

**2. 点击展开「今日用量」**

- 今日总量、请求数、按小时分布的柱状图
- **忙时 / 闲时分开计价**，柱子上悬停显示那一小时花了多少
- 单独列出会话合计与按模型拆分
- 顶部显示「更新于 HH:mm」，跨 0 点自动归零

**3. 查询很省**

| 数据 | 何时查询 | 开销 |
|---|---|---|
| 余额 | 组件挂载时读一次，60 秒内复用 | 一次平台 HTTP 接口，**不消耗 token** |
| 今日用量 | 仅点开面板时；客户端与 Host 各缓存 90 秒 | 本地扫日志，命中缓存约 12 ms |
| 单条花费 | 会话级缓存 90 秒，新回复完成时补读一次 | 同上 |
| 胶囊上的 token / 缓存 / 上下文 | session projection 增量订阅 | 不轮询、不请求 |

---

## 数据来源与隐私

- **余额**：`account/getBalance`（DeepSeek 平台接口），与模型请求无关，**不产生 token 费用**
- **用量**：直接解析本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里的 `assistant/message` 事件，取其自带的 `usage` 与时间戳
- **不联网、不上报、不写日志**；所有计算都在本机完成
- 只统计**本机**的会话。同一账号在其他设备或网页版的用量不会出现在这里

---

## 安装

插件是一个标准的 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch` 和 `dsh.client`）。

**方式一：插件页面**

侧边栏 → **插件** → 填入仓库地址 `https://github.com/iammralmost/horizon` 或本地绝对路径。

**方式二：让 Agent 装**

> 用 `plugin_manager` 的 `install_bundle` 安装 `https://github.com/iammralmost/horizon`

**装完如果界面没变化**，按 `Ctrl+R` 刷新页面；仍无变化则完整退出 DSH 再打开（Host 需要重新组合 profile）。

---

## 配置 `prices.json`

DSH 本身不保存任何单价，所以费用是**按 `prices.json` 算出来的估算值**，不是平台账单。

```json
{
  "currency": "CNY",
  "pricingBasis": "peak",
  "offPeakDiscount": 0.5,
  "peak": {
    "weekdays": [1, 2, 3, 4, 5],
    "intervals": [[540, 720], [840, 1080]],
    "holidays": []
  },
  "models": {
    "deepseek-flash":    { "cacheHit": 0.04, "cacheMiss": 2, "output": 8 },
    "deepseek-v4-pro":   { "cacheHit": 0.30, "cacheMiss": 9, "output": 27 }
  }
}
```

- `models.*`：**高峰价**，单位是人民币元 / 百万 tokens；`cacheHit` 是缓存命中输入，`cacheMiss` 是未命中输入
- `offPeakDiscount`：空闲时段的价格倍率（官方为空闲 = 高峰的一半）
- `peak.intervals`：高峰时段，`[起, 止]` 以「当天第几分钟」表示，`[540, 720]` = 09:00–12:00，`[840, 1080]` = 14:00–18:00
- `peak.weekdays`：0 是周日，1–5 是周一到周五
- `peak.holidays`：**需要自己填法定节假日**（`"2026-10-01"` 这种格式）。留空时，节假日里的工作日会被当成高峰计价，费用会高估一倍

内置价目按 DeepSeek 官方公开价（`deepseek-flash` / `deepseek-v4-pro`）。价格调整后改这个文件即可，无需重新安装。

---

## 已知限制

- **费用是估算，不是账单**。单价来自 `prices.json`；DSH 不提供计价信息，也无法得知你的实际套餐
- 法定节假日需要手工维护，见上文
- 只统计本机会话日志；多设备用量不会合并
- 本插件针对 **DSH 0.2.1-rc.5** 的插槽与 DOM 结构编写。其中「把花费排在用量与时间之间」依赖 `conversation.chat.assistant-actions` 槽位和 action 行上的 `[data-clock="end"]` 结构；DSH 若改动这块布局，花费不会消失，但位置可能退回「用量」左侧
- Host 侧提供两个只读接口：`GET /usage-hud/today`、`GET /usage-hud/session?session=<id>`，仅监听本机

---

## 开发说明

- **`package.json` 的 `name` 必须与 `client.js` 里 `window.__ModuleLoader__.load({ id })` 完全一致**（当前都是 `@local/usage-hud`）。改名要同时改两处，否则模块会注册到一个永远不会被引用的 id 上，表现为「装好了但界面毫无变化」
- 改动 `client.js` 或 `index.js` 后需要让 Host 重新组合一次：碰一下 profile 的 `cordis.patch.yml` 可触发热重载，客户端再 `Ctrl+R`
- 包内文件：

| 文件 | 作用 |
|---|---|
| `client.js` | 胶囊、今日用量面板、单条花费 |
| `index.js` | 扫会话日志聚合，提供上述两个只读接口 |
| `prices.json` | 价目表与忙闲时段 |
| `cordis.patch.yml` | 插入 `usage-hud` 插件行 |
| `locale/*.json`、`icon.svg` | 插件列表中的标题、描述与图标 |

## License

MIT
