/**
 * dsh-tool-call-repair 0.5.0
 *
 * 一个 llm/stream 出口同时管四件事：
 *
 * 1. 流层协议修复：上游把工具参数截断时补发 block-end，按 tool-calls /
 *    max-tokens 收尾，而不是让整轮失败。残缺参数原样派发，由工具报错、
 *    模型读到错误后自己重写。
 * 2. 空响应修复：上游回了 stop 却一个内容块都没有，转成 EMPTY_RESPONSE（连续次数受「空响应次数」约束）
 *    抛给重试层，不再静默落库成一条空回答。
 * 3. 退化拦截 + 续跑：思考段陷入短句复读时收口本轮，按 max-tokens 收尾，
 *    绝不伪造 stop；本轮边界用 agent.steer 推一条输入让本轮继续。
 * 4. agent/request-error：指数退避 + 有界预算重试。
 *
 * 任何一层都不改写截断的 JSON：猜缺失的尾巴可能改掉真正要执行的命令。
 */
import z from '@deepseek-ai/schemastery';

// dsh-llm 是 DSH 运行时注入的内置包，不总能在插件自己的 node_modules 里解析。
// 有就用真的（保证与引擎的 UserMessage 结构一致），没有就退到等价的最小红对象，
// 免得整个插件因为一个可选依赖炸掉。
let createUserMessage;
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  createUserMessage = (input) => ({ role: 'user', ...input });
}
