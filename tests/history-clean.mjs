// History clean-up regression suite. Runs against lib/index.js (what DSH loads).
// Usage: node tests/history-clean.mjs
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const BASE = {
  工具修复: false,
  自动续写: false,
  空响应修复: false,
  退化检测: false,
  历史清洗: true,
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

async function runPreStep(config, messages) {
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, config);
  const hook = ctx.handlers['agent/pre-step'];
  assert.ok(hook, 'agent/pre-step hook must be registered');
  const decision = { kind: 'enter', messages, turn: 7, step: 2 };
  const out = await hook({ turn: 7, step: 2 }, async () => decision);
  return { out, logs, decision };
}

const blank = (id) => ({ role: 'assistant', content: [], id });
const said = (text, role = 'user') => ({ role, content: [{ type: 'text', text }] });

// 1. 空回答被替换成占位文本，其余消息保持原样
{
  const input = [said('继续'), blank('m1'), said('嗯')];
  const { out, logs } = await runPreStep(BASE, input);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content.length, 1);
  assert.equal(out.messages[1].content[0].type, 'text');
  assert.ok(out.messages[1].content[0].text.includes('未产出'));
  assert.equal(out.messages[1].id, 'm1', 'other fields must survive');
  assert.equal(out.messages[0].content[0].text, '继续');
  assert.ok(logs.some((l) => l.includes('历史清洗')), 'must log the clean-up');
  console.log('ok 1 - placeholder replaces blank assistant');
}

// 2. 关掉占位就整条剔除
{
  const input = [said('继续'), blank('m1'), said('嗯')];
  const { out } = await runPreStep({ ...BASE, 历史清洗占位: false }, input);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content[0].text, '继续');
  assert.equal(out.messages[1].content[0].text, '嗯');
  console.log('ok 2 - placeholder off drops the message');
}

// 3. 开关关掉时一条都不动
{
  const input = [said('继续'), blank('m1')];
  const { out, logs } = await runPreStep({ ...BASE, 历史清洗: false }, input);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].content.length, 0);
  assert.equal(logs.length, 0);
  console.log('ok 3 - disabled keeps history untouched');
}

// 4. 带工具调用的 assistant 消息不算空，必须留着
{
  const withTool = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 't1', name: 'ops_bash', arguments: '{}' }],
  };
  const withReasoning = { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }] };
  const { out } = await runPreStep(BASE, [said('跑'), withTool, withReasoning]);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].content[0].type, 'tool-call');
  assert.equal(out.messages[2].content[0].type, 'reasoning');
  console.log('ok 4 - tool-call and reasoning survive');
}

// 5. 只有空白文本的空回答也算空
{
  const blankText = { role: 'assistant', content: [{ type: 'text', text: '   \n\t ' }] };
  const { out, logs } = await runPreStep(BASE, [said('继续'), blankText]);
  assert.equal(out.messages[1].content[0].text.includes('未产出'), true);
  assert.ok(logs.length > 0);
  console.log('ok 5 - whitespace-only text counts as blank');
}

// 6. 干净历史不产生任何改动，也不打日志
{
  const input = [said('继续'), said('做完了', 'assistant')];
  const { out, logs, decision } = await runPreStep(BASE, input);
  assert.equal(out.messages, decision.messages, 'must return the same array');
  assert.equal(logs.length, 0);
  console.log('ok 6 - clean history untouched');
}

// 7. 除 messages 外的字段必须原样带出
{
  const { out } = await runPreStep(BASE, [blank('m1')]);
  assert.equal(out.kind, 'enter');
  assert.equal(out.turn, 7);
  assert.equal(out.step, 2);
  console.log('ok 7 - decision fields preserved');
}

// 8. 上游插件返回非 enter 决策时不插手
{
  const logs = [];
  const ctx = makeCtx(logs);
  apply(ctx, BASE);
  const hook = ctx.handlers['agent/pre-step'];
  const out = await hook({ turn: 1, step: 1 }, async () => undefined);
  assert.equal(out, undefined);
  console.log('ok 8 - undefined decision passed through');
}

console.log('\ntests/history-clean.mjs: 8/8 passed');
