import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zeroUsage } from '../src/core.mjs';
import { host } from './host.mjs';

const requireHost = createRequire(`${host}/package.json`);
const { createJiti } = requireHost('jiti');
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
    'typebox': requireHost.resolve('typebox'),
    '@earendil-works/pi-tui': `${host}/node_modules/@earendil-works/pi-tui/dist/index.js`,
    '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  },
});
const { init, update, view, MAX_BLOCKS, MAX_TOTAL_TEXT } = await jiti.import('../src/view.ts');
const { renderView, renderInvestigationCall, renderInvestigationResult } = await jiti.import('../src/render.ts');
const { visibleWidth } = await import(`${host}/node_modules/@earendil-works/pi-tui/dist/index.js`);

// A recorded agent as plain data: the UI must be derivable from this alone.
const u = n => `🍃-${String(n).padStart(20, '0')}`;
const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });
const response = (n, content) => ({ __type: 'ET.LLMResponse', __uid: u(n), content, usage: zeroUsage(), stopReason: 'toolUse', timestamp: n });
const result = (n, id, toolName, isError = false, text = 'raw output') => ({ __type: 'ET.ToolResult', __uid: u(n), toolCallId: id, toolName, content: [{ type: 'text', text }], isError, durationMs: 1200, timestamp: n });
const agent = {
  __type: 'ET.InvestigationAgent', __uid: u(0),
  context_: [
    { __type: 'ET.InvestigationConfig', __uid: u(1), cwd: '/w', tools: [], timestamp: 1 },
    { __type: 'ET.InvestigationRequest', __uid: u(2), request: { question: 'Where is config loaded?' }, limits: {}, timestamp: 2 },
    response(3, [{ type: 'thinking', thinking: 'SECRET_REASONING' }, { type: 'text', text: 'Looking.' },
      call('read', { path: 'src/config.mjs' }, 'a'), call('grep', { pattern: 'local', path: '.' }, 'b')]),
    result(4, 'a', 'read'), result(5, 'b', 'grep', true, 'grep failed'),
    response(6, [call('submit_answer', { text: 'In loadConfig.', excerpts: [{ path: 'src/config.mjs' }] }, 'c')]),
    result(7, 'c', 'submit_answer'),
    { __type: 'ET.RunEnded', __uid: u(8), reason: 'submitted', timestamp: 8 },
  ],
};

test('the step chain is a pure view of the agent record', () => {
  const v = view(update(update(init('r1'), { type: 'agent', agent }), { type: 'phase', phase: 'completed' }));
  assert.equal(v.handle, `ET.InvestigationAgent('${u(0)}')`);
  assert.equal(v.agentStatus, 'answered');
  assert.equal(v.turns, 2);
  assert.deepEqual(v.blocks.map(b => [b.kind, b.status, b.title]), [
    ['request', 'info', ''],
    ['model', 'info', ''],
    ['tool', 'ok', 'read src/config.mjs (lines 1 onward)'],
    ['tool', 'error', 'grep local in .'],
    ['submit', 'ok', 'submit_answer · 1 excerpt'],
    ['end', 'ok', 'run ended · submitted'],
  ]);
  const text = JSON.stringify(v);
  assert(!text.includes('SECRET_REASONING'), 'thinking is never shown');
  assert(!text.includes('raw output'), 'successful tool output is not shown');
  assert(text.includes('grep failed'), 'tool errors are shown');
  assert.deepEqual(JSON.parse(text), v, 'the view is plain data');
  assert.deepEqual(view(update(init('r1'), { type: 'agent', agent: JSON.parse(JSON.stringify(agent)) })).blocks, v.blocks, 'same data, same view');
});

test('streaming text is shown live and replaced by the recorded fact', () => {
  const running = { ...agent, context_: agent.context_.slice(0, 2) };
  let model = update(update(init('r1'), { type: 'agent', agent: running }), { type: 'phase', phase: 'running' });
  model = update(model, { type: 'streaming', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'Look' }, call('read', { path: 'x' }, 'a')] });
  const live = view(model);
  assert.deepEqual(live.blocks.slice(1).map(b => [b.kind, b.status, b.text]), [['model', 'streaming', 'Look'], ['tool', 'streaming', '']]);
  assert.equal(live.turns, 1);
  assert(!JSON.stringify(live).includes('SECRET'));
  const recorded = view(update(model, { type: 'agent', agent: { ...agent, context_: agent.context_.slice(0, 3) } }));
  assert.deepEqual(recorded.blocks.slice(1).map(b => [b.kind, b.status]), [['model', 'info'], ['tool', 'running'], ['tool', 'running']]);
});

test('the view stays bounded and reports what it dropped', () => {
  const many = { ...agent, context_: [agent.context_[0], agent.context_[1],
    ...Array.from({ length: 200 }, (_, i) => response(100 + i, [{ type: 'text', text: 'x'.repeat(5000) }]))] };
  const v = view(update(init('r'), { type: 'agent', agent: many }));
  assert(v.blocks.length <= MAX_BLOCKS);
  assert(v.blocks.reduce((n, b) => n + b.text.length + b.title.length, 0) <= MAX_TOTAL_TEXT);
  assert.equal(v.omitted + v.blocks.length, 201);
  assert.equal(v.blocks.at(-1).key, `${u(299)}:text`, 'newest steps are kept');
});

// Renders theme tokens as real ANSI codes so widths and colours can be checked.
const BG = { userMessageBg: 41, customMessageBg: 42, toolPendingBg: 43, toolSuccessBg: 44, toolErrorBg: 45 };
const style = {
  fg: (_c, t) => `\x1b[36m${t}\x1b[39m`,
  bg: (c, t) => `\x1b[${BG[c]}m${t}\x1b[49m`,
  bold: t => `\x1b[1m${t}\x1b[22m`,
};
const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '');

test('rendering draws one coloured box per step under the agent handle, within the width', () => {
  const v = view(update(update(init('r1'), { type: 'agent', agent }), { type: 'phase', phase: 'completed' }));
  for (const width of [24, 60, 120]) {
    const lines = renderView(v, style, width, { expanded: true });
    assert(lines.every(l => visibleWidth(l) <= width), `fits width ${width}`);
  }
  const lines = renderView(v, style, 60, { expanded: true, final: 'FINAL TEXT' });
  assert(plain(lines[0]).startsWith(`◆ ET.InvestigationAgent('${u(0)}')`));
  const heads = lines.filter(l => /\x1b\[4\dm \x1b\[36m\x1b\[1m\w/.test(l));
  assert.deepEqual(heads.map(l => [plain(l).trim().split(/\s+/)[0], Number(l.match(/\x1b\[(4\d)m/)[1])]), [
    ['request', 41], ['model', 42], ['tool', 44], ['tool', 45], ['submit', 44], ['end', 44],
  ], 'model and tool steps have different colours; errors stand out');
  assert(plain(lines.find(l => plain(l).includes('read src/config.mjs'))).includes('✓ 1.2s'));
  assert(lines.some(l => plain(l).includes('FINAL TEXT')));
  const collapsed = renderView(v, style, 60, { expanded: false, final: 'FINAL TEXT' });
  assert(collapsed.some(l => plain(l).includes('1 earlier step · expand tool output to see more')));
  assert(!collapsed.some(l => plain(l).includes('FINAL TEXT')));
});

test('Pi renderers show the call until execution starts, then the chain; components are reused', () => {
  const theme = { ...style };
  const ctx = { outputPad: 1, executionStarted: false, isError: false };
  const callComponent = renderInvestigationCall({ question: 'Where?' }, theme, ctx);
  assert(plain(callComponent.render(40).join('\n')).includes('investigate Where?'));
  assert.equal(renderInvestigationCall({ question: 'Where?' }, theme, { ...ctx, executionStarted: true, lastComponent: callComponent }), callComponent);
  assert.deepEqual(callComponent.render(40), []);
  const v = view(update(init('r1'), { type: 'agent', agent }));
  const partial = renderInvestigationResult({ content: [], details: { view: v } }, { expanded: false, isPartial: true }, theme, ctx);
  const lines = partial.render(40);
  assert(lines.every(l => l.startsWith(' ') && visibleWidth(l) <= 40), 'outputPad is applied');
  assert(plain(lines[0]).includes('ET.InvestigationAgent'));
  const failed = renderInvestigationResult({ content: [{ type: 'text', text: 'Investigation failed: boom' }] }, { expanded: false, isPartial: false }, theme, { ...ctx, isError: true, lastComponent: partial });
  assert.equal(failed, partial);
  assert(plain(failed.render(40).join('\n')).includes('Investigation failed: boom'));
});
