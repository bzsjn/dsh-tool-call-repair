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

## 配置项

`cordis.patch.yml`：

```yaml
config:
  工具修复: true
  空响应修复: true
  退化检测: true
  退化阈值: 2
  退化续跑: true
  退化续跑上限: 3
  历史清洗: true
  历史清洗占位: true
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
| `空响应修复` | 零内容的完成响应改写成 `EMPTY_RESPONSE` 失败帧，交给重试链 | 原样放行，空回答会被当成成功落库 |
| `退化检测` | 思考流连续出现纯应答短句判定为复读，截断并按 `max-tokens` 收尾 | 不干预思考流 |
| `退化阈值` | 同一短句连续出现几次算复读，默认 `2` | 越小越激进，`1` 会误伤正常应答 |
| `退化续跑` | 截断后在本轮末尾推一条输入，让模型给结论或调工具 | 只截断，不推续跑 |
| `退化续跑上限` | 同一轮最多续跑几次，默认 `3` | 防止截断→续跑→再截断的死循环 |
| `历史清洗` | 发请求前把历史里 `content: []` 的 assistant 消息摘出去，阻止空回答污染后续轮次 | 历史原样发出，空回答会被反复带给上游 |
| `历史清洗占位` | 清洗时用一条极简文本替身顶替空消息，保住 user/assistant 交替 | 整条删除，可能出现连续两条 user |
| `历史清洗文本` | 占位替身的正文，默认「（本轮模型未产出内容）」 | — |

`重试次数: 12` 的退避阶梯：1s,2s,4s,8s,16s,32s,64s,128s,240s ×4，累计约 20 分钟。DSH 内置 `llm-retry` 先跑 5 次（约 15 秒），然后本插件接着跑长窗口。

`token上限` 按字符计，不是 token 数。中文约 1 字≈1 token，英文约 4 字符≈1 token，所以 32000 大致对应 8k–32k token 区间。服务端不认 `max_tokens`（实测传 200 却输出 13424），这个开关是客户端自己停。

英文键 `repairStream` / `retryEnabled` / `maxRetries` / `dispatchTruncatedToolCalls` 仍然兼容，中文键优先。新增键同样接受英文别名：`emptyGuard` / `degenerate` / `degenerateThreshold` / `degenerateFragments` / `degenerateResume` / `degenerateResumeText` / `degenerateResumeLimit` / `historyClean` / `historyPlaceholder` / `historyPlaceholderText`。

### 历史清洗与空响应修复的分工

两者处理同一类故障的两端：

- **空响应修复**在 `llm/stream` 出口，管**新的**空响应——转成 `EMPTY_RESPONSE` 失败帧，交给重试链，不让它落库。
- **历史清洗**在 `agent/pre-step` 入口，管**旧的**空回答——已经被落库的那些，每次发请求前摘掉，避免污染继续传播。

只开守卫，老会话里已有的空回答仍然会被反复送给上游；只开清洗，新产生的空响应还是会落库。两个一起开才闭环。

## 目录结构

与 `dsh-token-total` 同构：`src/` 放 TypeScript 源，`lib/` 放产物，`lib/types/` 放声明。

```
dsh-tool-call-repair/
  package.json          入口声明：main / types / exports / dsh.bundle.patch
  cordis.patch.yml      bundle 层：insert 一条可开关的 entry
  tsconfig.json         编译 src 到 lib
  .build/pNN.js         0.5.0 起的手工分片（权威源，按编号合并）
  scripts/build-lib.mjs    合并分片到 lib/index.js，--check 校验一致性
  src/index.ts          0.4.7 的 TS 参考实现，待下版本同步
  lib/index.js          运行时实际加载（由 build-lib.mjs 生成，不手改）
  lib/types/index.d.ts  类型声明
  tests/                回归套件：stream-repair.mjs、degenerate.mjs、history-clean.mjs
  CHANGELOG.md
  README.md
  icon.svg
```

**0.5.0 起，改逻辑只改 `.build/pNN.js` 分片**，然后 `node scripts/build-lib.mjs` 重新生成
`lib/index.js`，`--check` 校验一致性，`node tests/stream-repair.mjs` 之类的套件跑回归。
`src/index.ts` 目前是 0.4.7 的 TS 参考实现（类型与注释），函数体尚未转写 0.5.0 的三层；
环境里没有 `typescript` 时无法 `tsc`，所以别指望它和 `lib/` 逐行一致——行为以分片为准。
装了 `typescript` 之后可以把分片转写回 `src/` 并恢复 `pnpm build` 构建链。

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

回归套件（无需编译，直接跑产物）：

```bash
node tests/stream-repair.mjs    # 8 例：空响应、截断续写、断流、冻结 options
node tests/degenerate.mjs       # 8 例：复读拦截、阈值、续跑上限、开关、标记消费
node tests/history-clean.mjs    # 8 例：占位替换、删除模式、开关、工具/思考消息豁免
```

`npm test` 跑全部三个套件。

日志判据：

```
tool-call-repair: attempt 1 for MALFORMED_RESPONSE on turn 3 step 5 in 250ms
tool-call-repair: budget spent for MALFORMED_RESPONSE on turn 3 step 5
tool-call-repair: 思考段复读「好。」，截断本轮并按 max-tokens 收尾
tool-call-repair: 命中行之后转入正文/工具，不拦截「好。」
tool-call-repair: 上游返回零内容的完成响应，转成 EMPTY_RESPONSE
tool-call-repair: 历史清洗 替换 1 条空回答（turn 34）
```

看到「历史清洗 … 条空回答」说明老会话里已经落库的空回答被拦在请求之外了；这条日志
每轮最多出现一次，数字是该轮被清掉的消息条数。

## 边界

工具执行层的硬失败（`ToolBatchExecutionError`）在 DSH 里没有公开 waterfall 钩子，
`agent/error` 只读、`tools.execute` 无可拦截点，所以本插件兜底的是模型请求层。
单次工具执行失败本身在 `dsh-tools` 里已降级成 tool_result 错误回给模型，不会终止任务。

根治仍在上游：换直连通道或原生 `dsh-llm-deepseek`，比客户端兜底干净。

## 从插件市场安装

`index.json` 是本仓库的插件市场索引（format 1）。DSH 里走这条路装，比手抄 `github:` spec 稳：

1. 设置 → 插件 → 实验性插件 → 更多 → 启用「自定义插件市场」，重启 DSH。
2. 发现 → 添加索引源，粘贴：

```
https://bzsjn.github.io/dsh-tool-call-repair/index.json
```

3. 列表里选 `dsh-tool-call-repair`，核对来源 `github.com/bzsjn/dsh-tool-call-repair`、包名
   `dsh-tool-call-repair`，确认安装。

索引里每个版本都钉到 commit，`0.4.2` 就是
`git+https://github.com/bzsjn/dsh-tool-call-repair.git#31a299b46176b86394ce7acd8db459cf93517815`。
`engines.dsh` 为 `>=0.2.1-rc.1 <0.3.0`，不匹配的 DSH 版本不会出现在可选列表里。

## 发布索引

`index.json` 由 `scripts/build-index.mjs` 从 git tag 生成：**tag 即版本，commit 时间即
`publishTimestamp`**。所以要发新版本，先改 `package.json` 的 `version`、打 tag、推 tag。

```powershell
node scripts/build-index.mjs          # 生成 index.json
node scripts/build-index.mjs --check  # 只做格式自检
```

GitHub Pages 一次性设置：仓库 Settings → Pages → Source 选 **GitHub Actions**。
之后 push tag 或 main，`.github/workflows/publish-index.yml` 会用 `fetch-depth: 0` 拉全量
tag、重建索引、发布 `index.json` + `icon.svg` 到 Pages。

带 DSH 自带验证器的深校验（格式错会指出 JSON path）：

```powershell
$env:DSH_PLUGIN_MARKET_INDEX = '<DSH>/resources/app/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
node scripts/validate-index.mjs
```

本地先试再发布：仓库根起静态服务（`python -m http.server 8080`），索引源填
`http://127.0.0.1:8080/index.json`。索引允许 http，相对 `icon.svg` 按同源解析。