// Scoped-provider compensation suite. Runs against lib/index.js.
// Usage: node tests/scoped-provider.mjs
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const BASE = {
  工具修复: false,
  自动续写: false,
  空响应修复: false,
  退化检测: false,
  历史清洗: false,
  initialDelayMs: 0,
  jitterRatio: 0,
};

function makeCtx(logs) {
  const handlers = {};
  return {
    handlers,
    logger: { warn: (message) => logs.push(message) },
    on(event, handler) {
      handlers[event] = handler;
    },
  };
}

async function runRequest(overrides, seed) {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, ...overrides });
  const hook = ctx.handlers['agent/request'];
  assert.ok(hook, 'agent/request hook must be registered');
  const out = await hook({ turn: 1, step: 1 }, async () => seed);
  return { out, logs };
}

async function runError(overrides, payload, downstream) {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, ...overrides });
  const hook = ctx.handlers['agent/request-error'];
  assert.ok(hook, 'agent/request-error hook must be registered');
  const out = await hook(payload, async () => downstream);
  return { out, logs };
}

const agent = { steer() {} };
const big = {
  provider: 'daapsaak',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: 'high',
  maxTokens: 1048576,
};

// 1. 白名单供应商：maxTokens 被钳到定向上限，其余字段原样返回
{
  const { out, logs } = await runRequest({}, big);
  assert.equal(out.maxTokens, 32768);
  assert.equal(out.provider, 'daapsaak');
  assert.equal(out.model, 'deepseek-v4.1-flash');
  assert.equal(out.reasoningEffort, 'high');
  assert.ok(logs.some((line) => line.includes('maxTokens 1048576 -> 32768')));
}

// 2. 不在白名单的供应商：原样返回同一个对象，一个字段都不动
{
  const seed = { ...big, provider: 'deepseek-account', maxTokens: 1048576 };
  const { out, logs } = await runRequest({}, seed);
  assert.equal(out, seed);
  assert.equal(out.maxTokens, 1048576);
  assert.equal(logs.length, 0);
}

// 3. 中转站的 copy 端点不在白名单里，同样不钳
{
  const seed = { ...big, provider: 'daapsaak-copy' };
  const { out } = await runRequest({}, seed);
  assert.equal(out, seed);
  assert.equal(out.maxTokens, 1048576);
}

// 4. 白名单留空：整体关闭
{
  const seed = { ...big };
  const { out } = await runRequest({ 定向供应商: [] }, seed);
  assert.equal(out, seed);
}

// 5. 已经低于上限：不重造对象
{
  const seed = { ...big, maxTokens: 8192 };
  const { out } = await runRequest({}, seed);
  assert.equal(out, seed);
  assert.equal(out.maxTokens, 8192);
}

// 6. 定向上限设成 0：不钳制
{
  const seed = { ...big };
  const { out } = await runRequest({ 定向输出上限: 0 }, seed);
  assert.equal(out, seed);
}

// 7. 上限可以在配置里调
{
  const { out } = await runRequest({ 定向输出上限: 4096 }, { ...big });
  assert.equal(out.maxTokens, 4096);
}

async function repeatError(overrides, payload, downstream) {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, ...overrides });
  const hook = ctx.handlers['agent/request-error'];
  assert.ok(hook, 'agent/request-error hook must be registered');
  const results = [];
  for (let index = 0; index < 12; index += 1) {
    results.push(await hook(payload, async () => downstream));
  }
  return { results, logs };
}

const failure = (provider, code) => ({
  provider,
  failure: { code },
  agent,
  turn: 1,
  step: 1,
  signal: undefined,
});

// 8. 白名单供应商：下游不接管时自己接管，预算是定向的 8 次
{
  const { results, logs } = await repeatError({}, failure('daapsaak', 'SERVER'), undefined);
  const retried = results.filter((item) => item?.kind === 'retry').length;
  assert.equal(retried, 8);
  assert.equal(results[8], undefined);
  assert.ok(logs.some((line) => line.includes('budget spent')));
}

// 9. 非白名单供应商：仍然用全局的重试次数
{
  const { results } = await repeatError(
    { 重试次数: 2 },
    failure('deepseek-account', 'SERVER'),
    undefined,
  );
  assert.equal(results.filter((item) => item?.kind === 'retry').length, 2);
}

// 10. 白名单供应商：下游已经决定重试时直接沿用，不另记账
{
  const { results } = await repeatError({ 定向重试次数: 1 }, failure('daapsaak', 'SERVER'), {
    kind: 'retry',
  });
  assert.equal(results.every((item) => item?.kind === 'retry'), true);
}

// 11. 非白名单供应商：下游的决定原样透传
{
  const decision = { kind: 'abort' };
  const { results } = await repeatError({}, failure('deepseek-account', 'SERVER'), decision);
  assert.equal(results.every((item) => item === decision), true);
}

// 12. 不可重试的失败码照旧让位，哪怕在白名单里
{
  const { results } = await repeatError({}, failure('daapsaak', 'AUTH'), undefined);
  assert.equal(results.every((item) => item === undefined), true);
}

// 13. 定向重试次数设成 0：不接管
{
  const { results } = await repeatError({ 定向重试次数: 0 }, failure('daapsaak', 'SERVER'), undefined);
  assert.equal(results.every((item) => item === undefined), true);
}

// 14. 白名单供应商的空响应预算取定向值（默认 5，全局是 3）
{
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, 空响应修复: true });
  const stream = ctx.handlers['llm/stream'];
  const emptyStream = () =>
    (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  const out = [];
  for await (const chunk of stream({ provider: 'daapsaak', messages: [] }, emptyStream)) {
    out.push(chunk);
  }
  const finish = out.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE');
  assert.ok(logs.some((line) => line.includes('/5（定向）')));
}

console.log('tests/scoped-provider.mjs: 14/14 passed');
