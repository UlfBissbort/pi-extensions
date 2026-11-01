// End to end through Pi's real mouse routing: raw SGR mouse input into pi-tui's
// fullscreen TUI, which routes it to Pi's real ToolExecutionComponent hosting our
// renderers. This is the level at which clicks used to fall through to Pi's
// whole-tool expand toggle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { host } from './host.mjs';
import { jiti, tuiPath } from './jiti.mjs';

const { renderInvestigationCall, renderInvestigationResult } = await jiti.import('../src/render.ts');
const { setTui } = await jiti.import('../src/scroll.ts');
const { ToolExecutionComponent, initTheme } = await import(`${host}/dist/index.js`);
const { TuiAltScreen, Text } = await import(tuiPath);

initTheme('dark');
const COLUMNS = 80, ROWS = 24;

function fakeTerminal() {
  const terminal = {
    input: undefined,
    start(onInput) { this.input = onInput; },
    stop() {}, drainInput: async () => {}, write() {},
    get columns() { return COLUMNS; }, get rows() { return ROWS; }, get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  return terminal;
}

const long = (tag, n = 8) => Array.from({ length: n }, (_, i) => `line ${tag}.${i}`).join('\n');
const snapshot = {
  requestId: 'r1', handle: "ET.InvestigationAgent('🍃-00000000000000000000')", phase: 'running', agentStatus: 'running', model: 'p/m', turns: 2, omitted: 0,
  steps: [
    { id: 'run:1:request', kind: 'request', question: 'Where is config loaded?' },
    { id: 'turn:1:text', kind: 'model', text: long('A'), live: false },
    { id: 'turn:1:call:a', kind: 'tool', name: 'read', args: { path: 'src/config.mjs' }, outcome: 'ok', live: false, durationMs: 1200 },
    { id: 'turn:2:text', kind: 'model', text: long('B'), live: false },
    { id: 'turn:2:call:b', kind: 'tool', name: 'ls', args: { path: '.' }, outcome: 'pending', live: false },
  ],
};
const definition = { name: 'investigate', label: 'Investigate', renderShell: 'self', renderCall: renderInvestigationCall, renderResult: renderInvestigationResult };
const plain = line => line.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, '');

function mount({ filler }) {
  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  setTui(tui);   // as the extension's empty below-editor widget does
  tui.addChild(new Text(Array.from({ length: filler }, (_, i) => `transcript ${i}`).join('\n'), 0, 0));
  const tool = new ToolExecutionComponent('investigate', 'call-1', { question: 'Where is config loaded?' }, {}, definition, tui, '/w');
  tui.addChild(tool);
  tool.markExecutionStarted();
  tool.updateResult({ content: [], details: { snapshot }, isError: false }, true);
  tui.start();
  tui.renderNow(true);
  const screen = () => tui.getScreenLines().map(plain);
  const rowOf = text => screen().findIndex(l => l.includes(text));
  // Press and release at one cell, as a terminal sends a click (1-based SGR coordinates).
  const click = (row, column = 10) => {
    assert(row >= 0, 'row is on screen');
    terminal.input(`\x1b[<0;${column};${row + 1}M`);
    terminal.input(`\x1b[<0;${column};${row + 1}m`);
    tui.renderNow();
  };
  // The whole tool display, including lines scrolled out of view.
  const document = () => tool.render(COLUMNS).map(plain);
  return { tui, tool, terminal, screen, document, rowOf, click, stop: () => tui.stop() };
}

const boxCount = lines => lines.filter(l => /^\s*(request|model|tool|submit|host|end|result)\s/.test(l)).length;

test('clicking a box in the real TUI opens only that box and keeps it in place', () => {
  const ui = mount({ filler: 40 });
  try {
    assert.equal(ui.tui.isFollowingOutput, true, 'the transcript is at its end');
    const before = ui.screen();
    const boxes = boxCount(ui.document());
    assert.equal(boxes, 5);
    assert(before.some(l => l.includes('… 5 more lines')) && !before.some(l => l.includes('line B.0')));

    // A closed box previews its last lines; its header is four rows above the last one.
    const row = ui.rowOf('line B.7');
    const head = row - 4;
    assert.match(before[head], /^\s*model\s.*▸/);
    ui.click(row);
    const after = ui.screen();
    assert.equal(ui.tool.expanded, false, "Pi's expand toggle never fired");
    assert.equal(boxCount(ui.document()), boxes, 'the number of boxes is unchanged');
    assert.equal(ui.tui.viewportTop, 37, 'the transcript did not move');
    assert.match(after[head], /^\s*model\s.*▾/, 'the box header keeps its screen row');
    assert.deepEqual(after.slice(0, head), before.slice(0, head), 'everything above the box is unchanged');
    assert(after.some(l => l.includes('line B.0')), 'B opened');

    // A short box and a separator line claim the click too, and change nothing.
    ui.click(ui.rowOf('read src/config.mjs'));
    assert.equal(ui.tool.expanded, false);
    ui.click(ui.rowOf('read src/config.mjs') - 1);
    assert.equal(ui.tool.expanded, false);
    assert.deepEqual(ui.screen(), after, 'clicks that change nothing leave the screen as it was');

    // Clicking B's header closes it: the screen returns to exactly what it was.
    ui.click(head, 30);
    assert.deepEqual(ui.screen(), before);
  } finally { ui.stop(); }
});

test('the open state survives new data, and only the clicked box changes when scrolled up', () => {
  const ui = mount({ filler: 40 });
  try {
    ui.click(ui.rowOf('line B.7'));
    ui.tool.updateResult({ content: [], details: { snapshot: { ...snapshot, steps: [...snapshot.steps, { id: 'turn:3:text', kind: 'model', text: 'Next.', live: true }] } }, isError: false }, true);
    ui.tui.renderNow();
    assert(ui.screen().some(l => l.includes('line B.0')), 'B stays open across an update');
    assert.equal(boxCount(ui.document()), 6, 'new steps only ever add boxes');

    // Scroll up with the wheel, one notch at a time, until A's preview is in view; then open A.
    for (let i = 0; i < 40 && ui.rowOf('line A.7') < 4; i++) {
      ui.terminal.input('\x1b[<64;10;5M');
      ui.tui.renderNow();
    }
    assert.equal(ui.tui.isFollowingOutput, false);
    const top = ui.tui.viewportTop;
    const head = ui.rowOf('line A.7') - 4;
    const above = ui.screen().slice(0, head + 1);
    ui.click(head);
    assert.equal(ui.tui.viewportTop, top, 'the transcript did not move');
    assert.deepEqual(ui.screen().slice(0, head), above.slice(0, head), 'everything above the box is unchanged');
    assert.match(ui.screen()[head], /^\s*model\s.*▾/, 'the box header keeps its screen row');
    assert(ui.screen().some(l => l.includes('line A.0')));
    assert.equal(ui.tool.expanded, false);
  } finally { ui.stop(); }
});

test("clicking the chain header is Pi's expand toggle: everything opens, no box is added", () => {
  const ui = mount({ filler: 0 });
  try {
    const boxes = boxCount(ui.document());
    ui.click(ui.rowOf('ET.InvestigationAgent'), 5);
    assert.equal(ui.tool.expanded, true);
    const open = ui.document();
    assert.equal(boxCount(open), boxes);
    assert(open.some(l => l.includes('line A.0')) && open.some(l => l.includes('line B.0')));
    // A second click on the same word within 500 ms is Pi's double-click: it selects the word.
    ui.click(ui.rowOf('ET.InvestigationAgent'), 5);
    assert.equal(ui.tool.expanded, true);
    ui.click(ui.rowOf('ET.InvestigationAgent'), 40);
    assert.equal(ui.tool.expanded, false);
    assert(!ui.document().some(l => l.includes('line A.0')));
  } finally { ui.stop(); }
});
