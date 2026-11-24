// 退化拦截 + 续跑回归套件。跑的是 lib/index.js（DSH 实际加载的产物）。
// 用法：node tests/degenerate.mjs
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

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

function makeAgent(id, steered) {
  return { session: { id }, steer: (message) => steered.push(message) };
}

async function collect(ctx, chunks, sessionId = 's1') {
  const handler = ctx.handlers['llm/stream'];
  assert.ok(handler, 'llm/stream hook must be registered');
  const out = [];
  const next = () =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  for await (const chunk of handler({ sessionId, messages: [] }, next)) out.push(chunk);
  return out;
}

const lastFinish = (out) => [...out].reverse().find((c) => c.type === 'finish');
const kinds = (out) =>
  out.map((c) => (c.type === 'finish' ? `finish:${c.reason.kind}` : c.type));
const reasoning = (text) => [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text },
];
const tail = [
  { type: 'reasoning-delta', index: 0, text: '再往下想' },
  { type: 'finish', reason: { kind: 'stop' } },
];

const BASE = { 退化检测: true, 退化阈值: 2, 退化续跑: true };
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 1. 连续两句填充短句 → 截断，收尾必须是 max-tokens 而不是 stop
test('连续短句复读被截断并按 max-tokens 收尾', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  const out = await collect(ctx, [...reasoning('好。\n好。\n'), ...tail]);
  assert.equal(lastFinish(out).reason.kind, 'max-tokens', '不得伪造 stop');
  const closed = out.filter((c) => c.type === 'block-end');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].block.type, 'reasoning');
  assert.ok(
    logs.some((m) => m.includes('复读')),
    '应记录复读拦截',
  );
});

// 2. 阈值 3 时只连续两句不拦
test('未达阈值不拦截', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, 退化阈值: 3 });
  const out = await collect(ctx, [...reasoning('好。\n好。\n'), ...tail]);
  assert.equal(lastFinish(out).reason.kind, 'stop');
});

// 3. 命中行位于思考段末尾（后面换正文）→ 不拦
test('命中在思考段末尾不拦截', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  const out = await collect(ctx, [
    ...reasoning('好。\n好。'),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '好。\n好。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '结论如下。' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '结论如下。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  assert.equal(lastFinish(out).reason.kind, 'stop');
  assert.ok(out.some((c) => c.type === 'text-delta'));
});

// 4. 截断后本轮边界续跑一次
test('截断后 turn-stopping 推一条续跑输入', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  await collect(ctx, [...reasoning('好。\n好。\n'), ...tail]);

  const steered = [];
  ctx.handlers['agent/turn-stopping']({ agent: makeAgent('s1', steered), turn: 1 });
  assert.equal(steered.length, 1);
  const message = steered[0];
  assert.equal(message.source.kind, 'plugin:tool-call-repair');
  assert.equal(message.source.form, 'notice');
  assert.ok(message.source.summary.length > 0);
  assert.ok(message.content[0].text.length > 0);

  // 标记已消费：再次触发不应重复推
  ctx.handlers['agent/turn-stopping']({ agent: makeAgent('s1', steered), turn: 1 });
  assert.equal(steered.length, 1);
});

// 5. 续跑上限封顶
test('同一轮续跑不超过上限', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, 退化续跑上限: 1 });
  const steered = [];
  const agent = makeAgent('s1', steered);

  for (let i = 0; i < 2; i += 1) {
    await collect(ctx, [...reasoning('好。\n好。\n'), ...tail]);
    ctx.handlers['agent/turn-stopping']({ agent, turn: 1 });
  }
  assert.equal(steered.length, 1, '上限 1 时只能续跑一次');
});

// 6. 关掉退化检测 → 完全放行
test('退化检测关闭后不拦截', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, { ...BASE, 退化检测: false });
  const out = await collect(ctx, [...reasoning('好。\n好。\n好。'), ...tail]);
  assert.equal(lastFinish(out).reason.kind, 'stop');
});

// 7. 只吐短句、无正文的整轮（空回答现场）现在要么续跑要么可重试
test('只有思考短句的一轮不会静默收场', async () => {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  const out = await collect(ctx, [...reasoning('好。\n好。\n'), { type: 'finish', reason: { kind: 'stop' } }]);
  const finish = lastFinish(out);
  assert.notEqual(finish.reason.kind, 'stop');
  assert.equal(kinds(out).filter((k) => k === 'finish:stop').length, 0);
});

// 8. 本轮被截断后用户关掉续跑：turn-stopping 不注入，标记也不留到下一轮
test('关闭续跑后标记被清掉且不再注入', async () => {
  const logs = [];
  const steered = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  await collect(ctx, [...reasoning('好。\n好。\n'), ...tail], 's9');

  // 用户在这一轮边界之前关掉了续跑
  ctx.handlers['agent/turn-stopping']({ agent: makeAgent('s9', steered), turn: 2 });
  assert.equal(steered.length, 1, '开着的这一轮应当续跑一次');

  // 再触发一次：标记已经用掉，不能重复注入
  ctx.handlers['agent/turn-stopping']({ agent: makeAgent('s9', steered), turn: 2 });
  assert.equal(steered.length, 1, '同一标记只能消费一次');
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log('       ', error.message);
  }
}
console.log(failed === 0 ? `\n${cases.length}/${cases.length} passed` : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
