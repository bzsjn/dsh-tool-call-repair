# dsh-tool-call-repair

模型请求出现可恢复故障时自动重试，避免整轮任务被一次瞬时错误终止。

## 解决的问题

实测于同一网关（`daapsaak` + `anthropic-messages`）：

- 请求写 `max_tokens: 200`，上游返回 `output_tokens: 13424`，`stop_reason` 恒为 `tool_use`
- `tool_use` 的 `input_json_delta` 未写完就 `content_block_stop`，适配器丢弃该 block 并抛
  `MALFORMED_RESPONSE`，该码不在默认重试集合，整轮失败
- 相同请求重复执行曾直接 `502 回源请求被中断`
- 同一条命令上一轮缺 `}`、下一轮完整

这些是链路抖动，不是确定性 bug，重试即可恢复。

## 策略

挂在 `agent/request-error` waterfall 上：

- `codes: ['*']` 时任何失败码都重试，黑名单除外
- 黑名单永不重试：`ABORTED`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REPLAY_STATE`、`NO_ADAPTER`
- 指数退避 + 抖动，`initialDelayMs` 起，`maxDelayMs` 封顶
- 双层预算：`maxRetries` 管单个 `turn+step`，`maxRetriesPerTurn` 管整轮，防止跨 step 累积成死循环
- 预算耗尽则放行原始错误，不做无限重试
- 全程 abort 感知：退避期间收到中止立即放弃
- 下游（如 `llm-retry`）已决定重试时不抢，避免重复计数
- 钩子自身异常一律吞掉并记日志，绝不打断会话

本插件**不修补**残缺 JSON。猜补缺失的尾部会改变将要执行的命令。

## 失败路径分工

模型请求失败有两条到达路径，按「是否已经产生输出」分工，避免重复输出：

| 路径 | 已产生输出 | 处理 |
|---|---|---|
| 流内抛异常 | 否 | 原样抛出 → `agent/request-error` 重试（本次尝试干净，无副作用） |
| 流内抛异常 | 是 | 就地闭合未闭合块 + 降级为 `tool-calls` / `max-tokens` |
| `finish{kind:"error"}` | 否 | 原样透传 → 重试 |
| `finish{kind:"error"}` | 是 | 闭合 + 降级 |
| 黑名单码（`ABORTED`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REPLAY_STATE`、`NO_ADAPTER`） | 任意 | 原样透传，不降级 |

降级后：带工具调用则结束为 `tool-calls`，工具拿到残缺参数 schema 失败、错误回给模型、模型自行重写；纯文本则结束为 `max-tokens`，本轮收尾、下一条继续。两种情况都不会死会话。

## 三个开关

`cordis.patch.yml`：

```yaml
config:
  工具修复: true
  重试次数: 12
  token上限: 0
  maxRetriesPerTurn: 40
  codes: ['*']
  initialDelayMs: 1000
  maxDelayMs: 240000
  jitterRatio: 0.2
```

| 开关 | 作用 | 关闭时 |
|---|---|---|
| `工具修复` | 流层补发缺失的 `block-end`，把截断的 tool call 按 `tool-calls` 收尾并派发，模型读到参数错误后重写 | 不接管流，截断会照原样失败 |
| `重试次数` | 模型请求失败的重试上限。覆盖 `TRANSPORT`、`SERVER`、`TIMEOUT`、`RATE_LIMIT`、`EMPTY_RESPONSE`、`MALFORMED_RESPONSE` | `0` 完全不注册重试层 |
| `token上限` | 本轮输出字符预算，达到即补 `block-end` 并按截断收尾 | `0` 不干预，交给服务端 |

`重试次数: 12` 的退避阶梯：1s,2s,4s,8s,16s,32s,64s,128s,240s ×4，累计约 20 分钟。DSH 内置 `llm-retry` 先跑 5 次（约 15 秒），然后本插件接着跑长窗口。

`token上限` 按字符计，不是 token 数。中文约 1 字≈1 token，英文约 4 字符≈1 token，所以 32000 大致对应 8k–32k token 区间。服务端不认 `max_tokens`（实测传 200 却输出 13424），这个开关是客户端自己停。

英文键 `repairStream` / `retryEnabled` / `maxRetries` / `dispatchTruncatedToolCalls` 仍然兼容，中文键优先。

## 目录结构

与 `dsh-token-total` 同构：`src/` 放 TypeScript 源，`lib/` 放产物，`lib/types/` 放声明。

```
dsh-tool-call-repair/
  package.json          入口声明：main / types / exports / dsh.bundle.patch
  cordis.patch.yml      bundle 层：insert 一条可开关的 entry
  tsconfig.json         编译 src 到 lib
  src/index.ts          源文件（权威实现，改逻辑改这里）
  lib/index.js          编译产物（运行时实际加载）
  lib/types/index.d.ts  类型声明
  README.md
  icon.svg
```

改逻辑先改 `src/index.ts` 再同步 `lib/index.js`。装了 `typescript` 后可直接 `pnpm build`。

## 安装位置

真身只有一份：`<profile>/plugins/dsh-tool-call-repair`。
`<profile>/node_modules/dsh-tool-call-repair` 是指向它的目录连接（junction），
profile 依赖声明为 `file:./plugins/dsh-tool-call-repair`。

所以改代码只改一处，`src` 与 `lib` 都在真身里，不存在需要同步的第二份副本。

若 junction 被重装依赖破坏，重建：

```powershell
New-Item -ItemType Junction `
  -Path '<profile>\node_modules\dsh-tool-call-repair' `
  -Target '<profile>\plugins\dsh-tool-call-repair'
```

挂载只有一条通道：插件自带的 `cordis.patch.yml`（bundle 层）。
profile 的 `cordis.patch.yml` 不再写 mount 行，避免双挂载。

## 验证

日志判据：

```
tool-call-repair: attempt 1 for MALFORMED_RESPONSE on turn 3 step 5 in 250ms
tool-call-repair: budget spent for MALFORMED_RESPONSE on turn 3 step 5
```

## 边界

工具执行层的硬失败（`ToolBatchExecutionError`）在 DSH 里没有公开 waterfall 钩子，
`agent/error` 只读、`tools.execute` 无可拦截点，所以本插件兜底的是模型请求层。
单次工具执行失败本身在 `dsh-tools` 里已降级成 tool_result 错误回给模型，不会终止任务。

根治仍在上游：换直连通道或原生 `dsh-llm-deepseek`，比客户端兜底干净。