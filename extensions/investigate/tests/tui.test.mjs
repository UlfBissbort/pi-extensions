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
  requestId: 'r1', railIndex: 0, handle: "ET.InvestigationAgent('🍃-00000000000000000000')", phase: 'running', agentStatus: 'running', model: 'p/m', turns: 2, omitted: 0,
  steps: [
    { id: 'run:1:request', kind: 'request', question: 'Where is config loaded?' },
    { id: 'turn:1:text', kind: 'model', text: long('A'), live: false },
    { id: 'turn:1:call:a', kind: 'tool', name: 'read', args: { path: 'src/config.mjs' }, argumentsText: '{\n  "path": "src/config.mjs"\n}', resultText: 'read contents', outcome: 'ok', live: false, durationMs: 1200 },
    { id: 'turn:2:text', kind: 'model', text: long('B'), live: false },
    { id: 'turn:2:call:b', kind: 'tool', name: 'ls', args: { path: '.' }, argumentsText: '{\n  "path": "."\n}', outcome: 'pending', live: false },
  ],
};
const definition = { name: 'investigate', label: 'Investigate', renderShell: 'self', renderCall: renderInvestigationCall, renderResult: renderInvestigationResult };
const plain = line => line.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, '');

function mount({ filler, definition: tool = definition }) {
  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  setTui(tui);   // as the extension's empty below-editor widget does
  tui.addChild(new Text(Array.from({ length: filler }, (_, i) => `transcript ${i}`).join('\n'), 0, 0));
  const component = new ToolExecutionComponent('investigate', 'call-1', { question: 'Where is config loaded?' }, {}, tool, tui, '/w');
  tui.addChild(component);
  component.markExecutionStarted();
  if (tool === definition) component.updateResult({ content: [], details: { snapshot }, isError: false }, true);
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
  const document = () => component.render(COLUMNS).map(plain);
  return { tui, tool: component, terminal, screen, document, rowOf, click, stop: () => tui.stop() };
}

const boxCount = lines => lines.filter(l => /^\s*▌\s+(request|model|tool|submit|host|end)\s/.test(l) || /^\s*▌\s+result\s+returned to the parent/.test(l)).length;

test('two adjacent investigations keep distinct rails and independent open state in the real TUI', () => {
  const terminal = fakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  setTui(tui);
  const mounted = index => {
    const component = new ToolExecutionComponent('investigate', `call-${index}`, { question: 'Where?' }, {}, definition, tui, '/w');
    const details = { snapshot: { ...snapshot, requestId: `request-${index}`, railIndex: index,
      handle: `ET.InvestigationAgent('🍃-${index}')`, steps: [snapshot.steps[0], snapshot.steps[2]] } };
    tui.addChild(component);
    component.markExecutionStarted();
    component.updateResult({ content: [], details, isError: false }, true);
    return component;
  };
  const first = mounted(0), second = mounted(1);
  tui.start();
  try {
    tui.renderNow(true);
    const railAnsi = component => {
      const lines = component.render(COLUMNS).filter(l => l.includes('▌'));
      const colors = lines.map(l => l.match(/(\x1b\[[0-9;]+m)▌/)?.[1]);
      assert(colors.length > 4 && colors.every(c => c === colors[0]), 'the rail is continuous through this call');
      return colors[0];
    };
    const a = railAnsi(first), b = railAnsi(second);
    assert(a && b && a !== b, 'the two agents have distinct theme colours');
    const screen = tui.getScreenLines().map(plain);
    const row = screen.findIndex(l => l.includes('read src/config.mjs'));
    assert(row >= 0);
    terminal.input(`\x1b[<0;10;${row + 1}M`);
    terminal.input(`\x1b[<0;10;${row + 1}m`);
    tui.renderNow();
    assert(first.render(COLUMNS).map(plain).some(l => l.includes('read contents')));
    assert(!second.render(COLUMNS).map(plain).some(l => l.includes('read contents')), 'the other agent stays closed');
    assert.equal(railAnsi(first), a);
    assert.equal(railAnsi(second), b);
  } finally { tui.stop(); }
});

test('clicking a box in the real TUI opens only that box and keeps it in place', () => {
  const ui = mount({ filler: 40 });
  try {
    assert.equal(ui.tui.isFollowingOutput, true, 'the transcript is at its end');
    const before = ui.screen();
    const initialTop = ui.tui.viewportTop;
    const boxes = boxCount(ui.document());
    assert.equal(boxes, 5);
    assert(before.some(l => l.includes('… 5 more lines')) && !before.some(l => l.includes('line B.0')));

    // A closed box previews its last lines; its header is four rows above the last one.
    const row = ui.rowOf('line B.7');
    const head = row - 4;
    assert.match(before[head], /^\s*▌\s+model\s.*▸/);
    ui.click(row);
    const after = ui.screen();
    assert.equal(ui.tool.expanded, false, "Pi's expand toggle never fired");
    assert.equal(boxCount(ui.document()), boxes, 'the number of boxes is unchanged');
    assert.equal(ui.tui.viewportTop, initialTop, 'the transcript did not move');
    assert.match(after[head], /^\s*▌\s+model\s.*▾/, 'the box header keeps its screen row');
    assert.deepEqual(after.slice(0, head), before.slice(0, head), 'everything above the box is unchanged');
    assert(after.some(l => l.includes('line B.0')), 'B opened');

    // A single click opens the call and result together, without changing B's state.
    const readHead = ui.rowOf('read src/config.mjs');
    ui.click(readHead);
    assert.equal(ui.tool.expanded, false);
    assert.equal(ui.tui.viewportTop, initialTop);
    assert(ui.document().some(l => l.includes('read contents')));
    assert(ui.document().some(l => l.includes('"path": "src/config.mjs"')));
    assert(ui.document().some(l => l.includes('line B.0')), 'opening read leaves B open');
    assert.equal(boxCount(ui.document()), boxes);
    ui.click(ui.rowOf('read contents'), 35);
    assert.deepEqual(ui.screen(), after, 'one click on the result closes its call without closing B');

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
    assert.match(ui.screen()[head], /^\s*▌\s+model\s.*▾/, 'the box header keeps its screen row');
    assert(ui.screen().some(l => l.includes('line A.0')));
    assert.equal(ui.tool.expanded, false);
  } finally { ui.stop(); }
});

test("clicking the chain header is Pi's expand toggle: everything opens, no box is added", () => {
  const ui = mount({ filler: 0 });
  try {
    const boxes = boxCount(ui.document());
    ui.click(ui.rowOf('ET.InvestigationAgent'), 9);
    assert.equal(ui.tool.expanded, true);
    const open = ui.document();
    assert.equal(boxCount(open), boxes);
    assert(open.some(l => l.includes('line A.0')) && open.some(l => l.includes('line B.0')));
    // A second click on the same word within 500 ms is Pi's double-click: it selects the word.
    ui.click(ui.rowOf('ET.InvestigationAgent'), 9);
    assert.equal(ui.tool.expanded, true);
    ui.click(ui.rowOf('ET.InvestigationAgent'), 40);
    assert.equal(ui.tool.expanded, false);
    assert(!ui.document().some(l => l.includes('line A.0')));
  } finally { ui.stop(); }
});

// The whole pipeline: the extension runs a scripted model that streams like a
// real provider (one live partial object, mutated in place); every onUpdate goes
// into Pi's tool display, and the user clicks while the response is streaming.
test('a step opened while streaming stays open once recorded, through the whole extension', async () => {
  const { registerInvestigation } = await jiti.import('../src/extension.ts');
  const { loadConfig } = await import('../src/config.mjs');
  const { zeroUsage } = await import('../src/core.mjs');
  const { ModelRuntime } = await import(`${host}/dist/index.js`);
  const { createAssistantMessageEventStream } = await import(`${host}/node_modules/@earendil-works/pi-ai/dist/index.js`);
  const root = new URL('../', import.meta.url).pathname;
  const { config } = await loadConfig(root);
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  let streaming;
  const midStream = new Promise(resolve => { streaming = resolve; });
  const createRuntime = async () => {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const model = runtime.getModel(config.provider, config.model);
    runtime.getAvailable = async () => [model];
    let turn = 0;
    runtime.streamSimple = () => {
      const stream = createAssistantMessageEventStream();
      const n = turn++;
      const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { ...zeroUsage(), input: 10 }, stopReason: 'toolUse', timestamp: n };
      (async () => {
        stream.push({ type: 'start', partial: output });
        if (n === 0) {
          output.content.push({ type: 'text', text: '' });
          for (const line of long('S').split('\n')) {
            output.content[0].text += `${line}\n`;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: line, partial: output });
          }
          output.content.push({ type: 'toolCall', id: 'call_1|fc_1', name: 'ls', arguments: {} });
          stream.push({ type: 'toolcall_start', contentIndex: 1, partial: output });
          streaming();
          await paused;
          output.content[1].arguments = { path: '.' };
        } else output.content.push({ type: 'toolCall', id: 'call_2|fc_2', name: 'submit_answer', arguments: { text: 'All done.' } });
        stream.push({ type: 'done', reason: 'toolUse', message: output });
        stream.end(output);
      })();
      return stream;
    };
    return runtime;
  };
  const tools = [];
  await registerInvestigation({ on: () => {}, registerTool: tool => tools.push(tool) }, root, { createRuntime });
  const [investigate] = tools;
  const ui = mount({ filler: 0, definition: { ...definition, renderCall: investigate.renderCall, renderResult: investigate.renderResult } });
  try {
    const done = investigate.execute('call-1', { question: 'Q' }, undefined, update => { ui.tool.updateResult(update, true); ui.tui.renderNow(); }, { cwd: root });
    await midStream;
    await new Promise(resolve => setTimeout(resolve, 150));   // streamed publishes are coalesced
    const live = ui.document();
    assert(live.some(l => /^\s*▌\s+model\s.*… ▸/.test(l)), 'the streaming response is a closed, live box');
    const boxes = boxCount(live);
    ui.click(ui.rowOf('ls .'));
    assert(ui.document().some(l => l.includes('waiting for result')), 'tool call can be opened before the result arrives');
    ui.click(ui.rowOf('line S.7'));
    assert(ui.document().some(l => l.includes('line S.0')), 'model step opened while streaming');

    resume();
    const result = await done;
    assert(!result.isError, result.content[0].text);
    ui.tool.updateResult(result, false);
    ui.tui.renderNow();
    const final = ui.document();
    assert(final.some(l => l.includes('line S.0')), 'still open once the response is recorded');
    assert(final.some(l => /^\s*▌\s+tool\s+ls \. .*✓/.test(l)), 'the streamed tool call resolved in place');
    const resolved = result.details.snapshot.steps.find(s => s.kind === 'tool' && s.name === 'ls');
    assert(resolved.resultText && resolved.outcome === 'ok');
    assert(final.some(l => l.includes('"path": "."')), 'call arguments updated from the provider');
    assert(final.some(l => l.includes(resolved.resultText.split('\n').find(Boolean).slice(0, 20))), 'the open tool shows its actual result after recording');
    assert(boxCount(final) > boxes, 'boxes were only added');
    assert(final.some(l => /^\s*▌\s+result\s+returned to the parent/.test(l)));
    assert.equal(ui.tool.expanded, false);
  } finally { resume(); ui.stop(); }
});

// Pi's regular (non-fullscreen) mode: no mouse routing and no primary scroll view.
test('in the regular TUI the chain renders the same, and the scroll hold is a no-op', async () => {
  const { TuiMainScreen } = await import(tuiPath);
  const tui = new TuiMainScreen(fakeTerminal());
  setTui(tui);
  const component = new ToolExecutionComponent('investigate', 'call-1', { question: 'Q' }, {}, definition, tui, '/w');
  tui.addChild(component);
  component.markExecutionStarted();
  component.updateResult({ content: [], details: { snapshot }, isError: false }, true);
  const lines = component.render(COLUMNS).map(plain);
  assert.equal(boxCount(lines), 5);
  assert(lines.every(l => l.length <= COLUMNS));
  // Toggle via Pi's expand flag, which runs the holdScroll command without a scroll view.
  component.setExpanded(true);
  assert(component.render(COLUMNS).map(plain).some(l => l.includes('line A.0')));
});
