import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { host } from './host.mjs';
const requireHost = createRequire(`${host}/package.json`);
const { createJiti } = requireHost('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
  '@earendil-works/pi-tui': `${host}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
} });
const { initialProgress, reduceProgress, progressLines, safeDisplay, createProgressReporter, createWorkerProgress } = await jiti.import('../src/progress.ts');
const { renderInvestigationCall, renderInvestigationResult } = await jiti.import('../src/render.ts');
const { visibleWidth } = await import(`${host}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const uid = '12345678-aaaa-bbbb-cccc-123456789abc';

test('progress reducers preserve UID and immutable snapshots; text updates replace rows', () => {
  const first = initialProgress(uid, 0);
  const second = reduceProgress(first, { type: 'entry', key: 't', kind: 'writing', text: 'First' }, 10);
  const third = reduceProgress(second, { type: 'entry', key: 't', kind: 'writing', text: 'First and more' }, 20);
  assert.equal(first.entries.length, 0);
  assert.equal(second.entries[0].text, 'First');
  assert.equal(third.entries.length, 1);
  assert.equal(third.entries[0].text, 'First and more');
  assert.equal(third.requestId, uid);
  assert.equal(third.entries[0].at, 10);
});

test('expanded activity labels every event with UID and retains multi-line public text', () => {
  const state = reduceProgress(initialProgress(uid, 0), { type: 'entry', key: 'a', kind: 'writing', text: 'one\ntwo' }, 1000);
  const lines = progressLines(state, true);
  assert(lines.every(line => line.startsWith('[inv-12345678]')));
  assert(lines.some(line => line.includes(uid)));
  assert(lines.some(line => line.endsWith('two')));
});

test('UI log and individual previews have hard bounds and disclose omission', () => {
  let state = initialProgress(uid, 0);
  for (let i = 0; i < 200; i++) state = reduceProgress(state, { type: 'entry', key: String(i), kind: 'writing', text: 'x'.repeat(20000) });
  assert(state.entries.length <= 80);
  assert(state.entries.reduce((n, e) => n + e.text.length, 0) <= 24000);
  assert(state.omitted > 0);
  assert(state.entries.every(e => e.text.includes('UI preview shortened')));
});

test('terminal control sequences are stripped from UI-only text', () => {
  const unsafe = '\x1b[31mred\x1b[0m\x1b]52;c;YQ==\x07\x00\u202e\nreal';
  assert.equal(safeDisplay(unsafe), 'red\nreal');
});

test('worker activity shows reads and their ranges without including raw document contents', () => {
  const events = [];
  const report = createWorkerProgress(e => events.push(e));
  report({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: { path: '/docs/a.md', offset: 10, limit: 5 } }, 1);
  report({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'PRIVATE_DOCUMENT_BODY' }] } }, 1);
  assert(events[1].text.includes('/docs/a.md'));
  assert(events[1].text.includes('10–14'));
  assert.equal(events[1].kind, 'tool completed');
  assert(!JSON.stringify(events).includes('PRIVATE_DOCUMENT_BODY'));
  assert.equal(events[0].key, events[1].key);
});

test('streamed public text and parsed submission text are visible, private reasoning is excluded', () => {
  const events = [];
  const report = createWorkerProgress((e, immediate) => events.push({ ...e, immediate }));
  const partial = { role: 'assistant', content: [{ type: 'thinking', thinking: 'HIDDEN_REASONING' }, { type: 'text', text: 'Looking for definitions.' }] };
  report({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', partial, delta: 'HIDDEN_REASONING' } }, 1);
  assert.equal(events.length, 0);
  report({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', partial, delta: 'definitions.' } }, 1);
  assert.equal(events[0].text, 'Looking for definitions.');
  assert.equal(events[0].immediate, false);
  report({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', partial: { role: 'assistant', content: [{ type: 'toolCall', name: 'submit_answer', arguments: { text: 'Final\n"decoded"' } }] }, delta: '\\n\\"raw JSON fragments' } }, 2);
  assert.equal(events.at(-1).kind, 'answer draft');
  assert.equal(events.at(-1).text, 'Final\n"decoded"');
  assert(!JSON.stringify(events).includes('HIDDEN_REASONING'));
  assert(!JSON.stringify(events).includes('raw JSON fragments'));
});

test('UI updates coalesce text deltas and cease after completion', async () => {
  const updates = [];
  const reporter = createProgressReporter(uid, Date.now(), p => updates.push(p));
  reporter.emit({ type: 'phase', phase: 'queued', text: 'queued' });
  for (let i = 0; i < 20; i++) reporter.emit({ type: 'entry', key: 'text', kind: 'writing', text: `text ${i}` }, false);
  assert.equal(updates.length, 1);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(updates.length, 2);
  assert.equal(updates[1].entries.at(-1).text, 'text 19');
  reporter.emit({ type: 'entry', key: 'text', kind: 'writing', text: 'pending' }, false);
  reporter.close();
  await new Promise(resolve => setTimeout(resolve, 140));
  reporter.emit({ type: 'phase', phase: 'completed', text: 'closed' });
  assert.equal(updates.length, 2);
});

test('a failing progress observer cannot interrupt the worker', () => {
  const reporter = createProgressReporter(uid, 0, () => { throw new Error('UI failed'); });
  assert.doesNotThrow(() => reporter.emit({ type: 'phase', phase: 'queued', text: 'x' }));
  reporter.close();
});

test('renderers handle partial/final results, narrow widths, Unicode and component reuse', () => {
  const theme = { fg: (_name, text) => text, bold: text => text };
  const context = { lastComponent: undefined, isError: false };
  const state = reduceProgress(initialProgress(uid, 0), { type: 'entry', key: 'text', kind: 'writing', text: 'Finding 🌿 中文 documents\nNext line' });
  const partial = { content: [], details: { progress: state } };
  const component = renderInvestigationResult(partial, { expanded: true, isPartial: true }, theme, context);
  for (const width of [10, 20, 80]) for (const line of component.render(width)) assert(visibleWidth(line) <= width);
  const final = renderInvestigationResult({ content: [{ type: 'text', text: 'Final answer' }], details: { progress: state } }, { expanded: true, isPartial: false }, theme, { ...context, lastComponent: component });
  assert.equal(final, component);
  assert(final.render(80).join('\n').includes('Final answer'));
  const call = renderInvestigationCall({ question: 'Find docs', scope: ['/tmp'] }, theme, context);
  assert(call.render(80).join('\n').includes('Find docs'));
  assert.doesNotThrow(() => renderInvestigationCall({}, theme, context));
  assert.doesNotThrow(() => renderInvestigationResult({ content: [], details: undefined }, { expanded: false, isPartial: true }, theme, context));
});
