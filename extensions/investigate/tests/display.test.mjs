import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiti, tuiPath } from './jiti.mjs';

const { initDisplay, reduceDisplay, reduceAll, isOpen, eventsFromRender, RESULT_ID } = await jiti.import('../src/display.ts');
const { renderDisplay, renderInvestigationCall, renderInvestigationResult } = await jiti.import('../src/render.ts');
const { holdScroll } = await jiti.import('../src/scroll.ts');
const { visibleWidth, ScrollView, rgbColor, colorToRgb } = await import(tuiPath);

const long = (tag, n = 8) => Array.from({ length: n }, (_, i) => `line ${tag}.${i}`).join('\n');
const snapshot = {
  requestId: 'r1', handle: "ET.InvestigationAgent('🍃-00000000000000000000')", phase: 'completed', agentStatus: 'answered', model: 'p/m', turns: 2, omitted: 0,
  steps: [
    { id: 'run:1:request', kind: 'request', question: 'Where is config loaded?' },
    { id: 'turn:1:text', kind: 'model', text: long('A'), live: false },
    { id: 'turn:1:call:a', kind: 'tool', name: 'read', args: { path: 'src/config.mjs' }, argumentsText: '{\n  "path": "src/config.mjs"\n}', resultText: 'read output', outcome: 'ok', live: false, durationMs: 1200 },
    { id: 'turn:1:call:b', kind: 'tool', name: 'grep', args: { pattern: 'local', path: '.' }, argumentsText: '{\n  "pattern": "local",\n  "path": "."\n}', resultText: 'grep failed', outcome: 'error', live: false },
    { id: 'turn:2:text', kind: 'model', text: long('B'), live: false },
    { id: 'turn:2:call:c', kind: 'submit', answer: 'In loadConfig.', excerpts: 1, outcome: 'ok', live: false },
    { id: 'run:1:end', kind: 'end', reason: 'submitted' },
  ],
};
const withData = (open = false) => reduceAll(initDisplay(open), [{ type: 'snapshot', snapshot }, { type: 'final', text: long('R', 6), failed: false }])[0];

test('toggling flips one step only; opening or closing all clears the overrides', () => {
  let s = withData();
  let commands;
  [s, commands] = reduceDisplay(s, { type: 'toggle', id: 'turn:1:text' });
  assert.deepEqual(commands, [{ type: 'holdScroll' }, { type: 'redraw' }]);
  assert(isOpen(s, 'turn:1:text') && !isOpen(s, 'turn:2:text'));
  [s] = reduceDisplay(s, { type: 'toggle', id: 'turn:2:text' });
  [s] = reduceDisplay(s, { type: 'toggle', id: 'turn:1:text' });
  assert(!isOpen(s, 'turn:1:text') && isOpen(s, 'turn:2:text'), 'closing A leaves B open');
  [s, commands] = reduceDisplay(s, { type: 'defaultOpen', value: true });
  assert.deepEqual(commands, [{ type: 'holdScroll' }]);
  assert(snapshot.steps.every(step => isOpen(s, step.id)) && isOpen(s, RESULT_ID), 'open all opens all');
  [s] = reduceDisplay(s, { type: 'toggle', id: 'turn:2:text' });
  assert(!isOpen(s, 'turn:2:text') && isOpen(s, 'turn:1:text'), 'a click overrides the default for one step');
  assert.deepEqual(reduceDisplay(s, { type: 'defaultOpen', value: true }), [s, []], 'no change, no commands');
  const [next] = reduceDisplay(s, { type: 'snapshot', snapshot: { ...snapshot, turns: 3 } });
  assert.equal(next.open, s.open, 'new data keeps the open steps');
  const [unknown] = reduceDisplay(s, { type: 'toggle', id: 'gone' });
  assert.deepEqual(renderDisplay(unknown, 60, style).lines, renderDisplay(s, 60, style).lines, 'unknown ids are harmless');
});

test("Pi's renderResult arguments become events only when something changed", () => {
  const s = initDisplay(false);
  const input = { snapshot, text: '', isPartial: true, isError: false, expanded: false };
  assert.deepEqual(eventsFromRender(s, input), [{ type: 'snapshot', snapshot }]);
  const [withSnapshot] = reduceAll(s, eventsFromRender(s, input));
  assert.deepEqual(eventsFromRender(withSnapshot, input), [], 'a repeated call is no event');
  assert.deepEqual(eventsFromRender(withSnapshot, { ...input, isPartial: false, text: 'done', isError: true }), [{ type: 'final', text: 'done', failed: true }]);
  assert.deepEqual(eventsFromRender(withSnapshot, { ...input, expanded: true }), [{ type: 'defaultOpen', value: true }]);
});

// Renders theme tokens as real ANSI codes so widths and colours can be checked.
const BG = { userMessageBg: 41, customMessageBg: 42, toolPendingBg: 43, toolSuccessBg: 44, toolErrorBg: 45 };
const style = {
  fg: (_c, t) => `\x1b[36m${t}\x1b[39m`,
  bg: (c, t) => `\x1b[${BG[c]}m${t}\x1b[49m`,
  bold: t => `\x1b[1m${t}\x1b[22m`,
  colors: { toolSuccessBg: rgbColor(0, 80, 0), customMessageBg: rgbColor(0, 20, 0) },
  style: (t, { bg }) => { const { g } = colorToRgb(bg); assert(g > 20 && g < 80, 'a distinct, nearby green from the theme'); return `\x1b[46m${t}\x1b[49m`; },
};
const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '');
// A box starts with its blank separator line; its header row follows.
const headRows = ({ lines, targets }) => lines.flatMap((l, i) => i > 0 && targets[i] && lines[i - 1] === '' ? [i] : []);

test('every step is one coloured box under the agent handle, within the width', () => {
  for (const width of [24, 60, 120]) {
    const { lines, targets } = renderDisplay(withData(true), width, style);
    assert(lines.every(l => visibleWidth(l) <= width), `fits width ${width}`);
    assert.equal(lines.length, targets.length);
  }
  const rendered = renderDisplay(withData(), 60, style);
  const { lines } = rendered;
  assert.equal(plain(renderDisplay(withData(), 120, style).lines[0]), "◆ ET.InvestigationAgent('🍃-00000000000000000000') · answered · 2 model requests");
  assert.deepEqual(headRows(rendered).map(i => [plain(lines[i]).trim().split(/\s+/)[0], Number(lines[i].match(/\x1b\[(4\d)m/)[1])]), [
    ['request', 41], ['model', 42], ['tool', 44], ['tool', 45], ['model', 42], ['submit', 44], ['end', 44], ['result', 44],
  ], 'model and tool steps have different colours; errors stand out; the result is a box too');
  assert(plain(lines.find(l => plain(l).includes('read src/config.mjs (lines 1 onward)'))).includes('✓ 1.2s'));
  assert(!lines.some(l => plain(l).includes('grep failed') || plain(l).includes('read output')), 'tool results stay closed by default');
  assert(lines.some(l => plain(l).includes('… 5 more lines')) && !lines.some(l => plain(l).includes('line A.0')), 'long steps start closed with a preview');
  assert(lines.some(l => plain(l).includes('line R.5')) && !lines.some(l => plain(l).includes('line R.0')), 'so does the result');
  const failed = renderDisplay(reduceDisplay(withData(), { type: 'final', text: 'boom', failed: true })[0], 60, style).lines;
  assert(failed.find(l => plain(l).includes('returned to the parent')).includes('\x1b[45m'), 'failures use the error colour');
});

test('a single open tool box contains arguments and a separately shaded result; errors remain connected', () => {
  const before = renderDisplay(withData(), 80, style);
  assert(!plain(before.lines.join('\n')).includes('read output') && !plain(before.lines.join('\n')).includes('grep failed'));
  const [opened] = reduceDisplay(withData(), { type: 'toggle', id: 'turn:1:call:a' });
  const after = renderDisplay(opened, 80, style);
  assert.equal(headRows(after).length, headRows(before).length, 'opening does not add another box');
  const callRow = after.lines.findIndex(l => plain(l).includes('read src/config.mjs'));
  const resultRow = after.lines.findIndex(l => plain(l).includes('read output'));
  assert(after.lines[callRow].includes('\x1b[44m'));
  assert(after.lines[resultRow].includes('\x1b[46m'), 'successful result uses another theme-derived shade');
  assert(resultRow > callRow && resultRow < after.lines.findIndex(l => plain(l).includes('grep local')));
  assert(after.lines.some(l => plain(l).includes('"path": "src/config.mjs"')));
  assert(after.targets[resultRow].id === 'turn:1:call:a' && after.targets[resultRow].toggles, 'clicking the result closes its call');
  assert(!after.lines.some(l => plain(l).includes('grep failed')), 'a second tool remains closed');
  const [failed] = reduceDisplay(opened, { type: 'toggle', id: 'turn:1:call:b' });
  const error = renderDisplay(failed, 80, style);
  assert(error.lines.find(l => plain(l).includes('grep failed')).includes('\x1b[45m'), 'error result uses the error shade');
  assert(error.targets[error.lines.findIndex(l => plain(l).includes('grep failed'))].id === 'turn:1:call:b');
  assert(error.lines.every(l => visibleWidth(l) <= 80));
  const legacy = { ...snapshot, steps: [{ id: 'old', kind: 'tool', name: 'read', args: { path: 'old.txt' }, error: 'old error', outcome: 'error', live: false }] };
  const old = renderDisplay(reduceAll(initDisplay(true), [{ type: 'snapshot', snapshot: legacy }])[0], 60, style);
  assert(old.lines.some(l => plain(l).includes('old error')), 'previously persisted tool snapshots still render');
});

test('opening a step changes only its own height; box count and lines above it stay', () => {
  const before = renderDisplay(withData(), 60, style);
  const after = renderDisplay(reduceDisplay(withData(), { type: 'toggle', id: 'turn:2:text' })[0], 60, style);
  const first = before.targets.findIndex(t => t?.id === 'turn:2:text');
  assert.deepEqual(after.lines.slice(0, first), before.lines.slice(0, first), 'lines above are identical');
  assert.equal(after.lines.length - before.lines.length, 8 - 4, 'only B grew: 8 body lines instead of a 4-line preview');
  assert.equal(headRows(after).length, headRows(before).length, 'same number of boxes');
  const tail = n => before.lines.slice(before.lines.length - n);
  assert.deepEqual(after.lines.slice(after.lines.length - 10), tail(10), 'boxes below are unchanged, only shifted');
  // Every line of every box is a click target; short boxes are targets that change nothing.
  const boxLines = before.targets.slice(before.targets.findIndex(Boolean));
  assert(boxLines.every(Boolean));
  assert.equal(before.targets.find(t => t?.id === 'turn:1:call:a' && t.toggles)?.toggles, true);
  assert.equal(before.targets.find(t => t?.id === 'turn:1:text' && t.toggles)?.toggles, true);
  assert.equal(before.targets[0], undefined, 'the chain header is left to Pi');
});

test('before any snapshot the display shows a plain status text', () => {
  assert(plain(renderDisplay(initDisplay(false), 40, style).lines.join('\n')).includes('Starting investigation…'));
  const [failed] = reduceDisplay(initDisplay(false), { type: 'final', text: 'Investigation failed: boom', failed: true });
  assert(plain(renderDisplay(failed, 40, style).lines.join('\n')).includes('Investigation failed: boom'));
});

test('Pi renderers: the call until execution starts, then the chain; clicks toggle through the reducer', () => {
  const ctx = { outputPad: 1, executionStarted: false, isError: false, state: {}, invalidate: () => { invalidated++; } };
  let invalidated = 0;
  const callComponent = renderInvestigationCall({ question: 'Where?' }, style, ctx);
  assert(plain(callComponent.render(40).join('\n')).includes('investigate Where?'));
  assert.equal(renderInvestigationCall({ question: 'Where?' }, style, { ...ctx, executionStarted: true, lastComponent: callComponent }), callComponent);
  assert.deepEqual(callComponent.render(40), []);

  const partial = { ...snapshot, phase: 'running', agentStatus: 'running' };
  const component = renderInvestigationResult({ content: [], details: { snapshot: partial } }, { expanded: false, isPartial: true }, style, { ...ctx, executionStarted: true });
  let lines = component.render(60);
  assert(lines.every(l => l.startsWith(' ') && visibleWidth(l) <= 60), 'outputPad is applied');
  const row = text => lines.findIndex(l => plain(l).includes(text));
  const click = (y, type = 'click') => component.handleMouse({ type, button: 'left', x: 3, y, screenX: 3, screenY: y, width: 60, height: lines.length });
  const shows = text => component.render(60).some(l => plain(l).includes(text));

  assert.equal(click(row('line A.7'), 'press'), undefined, 'presses are left to text selection');
  assert.deepEqual(click(row('line A.7')), { handled: true });
  assert(shows('line A.0') && !shows('line B.0'), 'only A opens');
  assert.equal(invalidated, 1);
  lines = component.render(60);
  assert.deepEqual(click(row('read src/config.mjs')), { handled: true }, 'one click opens the tool call and result');
  assert.equal(invalidated, 2);
  assert(shows('read output') && shows('"path": "src/config.mjs"'));
  lines = component.render(60);
  assert.deepEqual(click(row('read src/config.mjs') - 1), { handled: true }, 'the blank line above a box is claimed too');
  assert.equal(invalidated, 2, 'a separator click does not toggle');
  assert.equal(click(0), undefined, "the header click is Pi's");

  // Later updates from the worker, and the final result, keep the open steps.
  const done = renderInvestigationResult({ content: [{ type: 'text', text: 'Final' }], details: { snapshot } }, { expanded: false, isPartial: false }, style, { ...ctx, executionStarted: true, lastComponent: component });
  assert.equal(done, component);
  assert(shows('line A.0') && shows('Final'));
  // Pi's expand toggle opens everything.
  renderInvestigationResult({ content: [{ type: 'text', text: 'Final' }], details: { snapshot } }, { expanded: true, isPartial: false }, style, { ...ctx, executionStarted: true, lastComponent: component });
  assert(shows('line A.0') && shows('line B.0'));
  assert(plain(component.render(120)[0]).endsWith('· answered · 2 model requests · p/m'), 'with the model in the header');
});

test('holding the scroll keeps the clicked line on its screen row at the bottom of the transcript', () => {
  // Real pi-tui ScrollView: the transcript follows its end, as when Pi is scrolled to the bottom.
  const transcript = new ScrollView({ render: () => [], invalidate() {} }, { follow: 'end', primary: true });
  const viewport = 20, before = 100, clickedLine = 90, grows = 12;
  transcript.updateLayout(before, viewport, () => {});
  const row = () => clickedLine - transcript.scrollTop;
  const start = row();
  assert.equal(transcript.isFollowingEnd, true);
  const command = holdScroll({ top: transcript.scrollTop, following: transcript.isFollowingEnd });
  transcript.scrollTo(command.scrollTo, { disableFollow: command.disableFollow });
  transcript.updateLayout(before + grows, viewport, () => {});
  assert.equal(row(), start, 'opening does not move the clicked line');
  transcript.updateLayout(before, viewport, () => {});
  assert.equal(row(), start, 'closing it again does not move it either');
  assert.equal(holdScroll({ top: 5, following: false }), undefined, 'scrolled-up transcripts already keep their offset');
});
