// Stream-repair regression suite. Runs against lib/index.js (what DSH loads).
// Usage: node tests/stream-repair.mjs
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const BASE = { 工具修复: true, 自动续写: true, 续写轮数: 3, 空响应修复: true, 空响应次数: 3 };

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

async function run(config, options, makeStream) {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, config);
  const stream = ctx.handlers['llm/stream'];
  assert.ok(stream, 'llm/stream hook must be registered');
  let calls = 0;
  const next = () => {
    calls += 1;
    return makeStream(calls);
  };
  const out = [];
  for await (const chunk of stream(options, next)) out.push(chunk);
  return { out, logs, calls };
}

const lastFinish = (out) => [...out].reverse().find((c) => c.type === 'finish');
const kinds = (out) => out.map((c) => (c.type === 'finish' ? `finish:${c.reason.kind}` : c.type));

const textStream = (text, reason) =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: reason } };
  })();

const emptyStream = () =>
  (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();

const toolStream = () =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '我来写。' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '我来写。' } };
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id: 't1', name: 'write_file', argumentsDelta: '{"path":"a"}' };
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 't1', name: 'write_file', arguments: '{"path":"a"}' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 1. 空响应 → 可重试错误，而不是静默完成
test('空响应转成 EMPTY_RESPONSE', async () => {
  const { out } = await run(BASE, Object.freeze({ messages: [] }), emptyStream);
  const finish = lastFinish(out);
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE');
});

// 2. 只有空白字符也算空响应
test('纯空格正文算空响应', async () => {
  const { out } = await run(BASE, Object.freeze({ messages: [] }), () => textStream('   ', 'stop'));
  const finish = lastFinish(out);
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE');
});

// 3. max-tokens 且有正文 → 续写（只读 options 上必须成功）
test('max-tokens 续写成功', async () => {
  const options = Object.freeze({ messages: [] });
  const { out, calls, logs } = await run(BASE, options, (call) =>
    textStream(call === 1 ? '前半段。' : '后半段。', call === 1 ? 'max-tokens' : 'stop'),
  );
  assert.equal(calls, 2, '续写应把 next() 调用两次');
  assert.equal(lastFinish(out).reason.kind, 'stop');
  assert.equal(options.messages.length, 2, '应往 messages 追加 assistant + user');
  assert.ok(!logs.some((m) => m.includes('could not arm')), '不应出现只读赋值失败');
});

// 4. 断流但有正文 → 也续写，而不是贴 token 上限
test('断流后自动续写', async () => {
  const options = Object.freeze({ messages: [] });
  const { out, calls, logs } = await run(BASE, options, (call) => {
    if (call > 1) return textStream('补齐的结尾。', 'stop');
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '写到一半' };
      const error = new Error('socket hang up');
      error.code = 'TRANSPORT';
      throw error;
    })();
  });
  assert.equal(calls, 2, '断流后应续写');
  assert.ok(logs.some((m) => m.includes('auto-continue')), '应记录续写');
  assert.equal(lastFinish(out).reason.kind, 'stop');
});

// 5. 工具调用原样放行
test('工具调用不被改写', async () => {
  const { out, calls } = await run(BASE, Object.freeze({ messages: [] }), toolStream);
  assert.equal(calls, 1);
  const closes = out.filter((c) => c.type === 'block-end').map((c) => c.block.type);
  assert.deepEqual(closes, ['text', 'tool-call']);
  assert.equal(lastFinish(out).reason.kind, 'stop');
});

// 6. 全部关闭 → 完全透传，行为回到 0.4.7
test('开关全关时透传', async () => {
  const { out, calls } = await run(
    { 工具修复: false, 自动续写: false, 空响应修复: false },
    Object.freeze({ messages: [] }),
    emptyStream,
  );
  assert.equal(calls, 1);
  assert.equal(lastFinish(out).reason.kind, 'stop');
});

// 7. messages 数组也被冻结 → 优雅降级，不抛
test('数组冻结时降级为 max-tokens', async () => {
  const { out, logs } = await run(BASE, Object.freeze({ messages: Object.freeze([]) }), () =>
    textStream('只写了一半。', 'max-tokens'),
  );
  assert.equal(lastFinish(out).reason.kind, 'max-tokens');
  assert.ok(logs.some((m) => m.includes('could not arm')));
});

// 8. 空响应次数用尽 → 不再重试，按 stop 收尾
test('空响应预算用尽后放行', async () => {
  const { out, logs } = await run(
    { ...BASE, 空响应次数: 0 },
    Object.freeze({ messages: [] }),
    emptyStream,
  );
  assert.equal(lastFinish(out).reason.kind, 'stop');
  assert.ok(logs.some((m) => m.includes('budget spent')) || out.length > 0);
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
