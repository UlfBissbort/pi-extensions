import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroUsage } from '../src/core.mjs';
import { jiti } from './jiti.mjs';

const { initRun, reduceRun, steps, snapshot, MAX_STEPS, MAX_TOTAL_TEXT, stepSize } = await jiti.import('../src/run.ts');
const { status } = await jiti.import('../src/agent.ts');

const u = n => `🍃-${String(n).padStart(20, '0')}`;
const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });
const response = (n, content) => ({ __type: 'ET.LLMResponse', __uid: u(n), content, usage: zeroUsage(), stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: n });
const result = (n, id, toolName, isError = false, text = 'raw output') => ({ __type: 'ET.ToolResult', __uid: u(n), toolCallId: id, toolName, content: [{ type: 'text', text }], isError, durationMs: 1200, timestamp: n });
const limits = { maxTurns: 3, timeoutSeconds: 60, maxAnswerCharacters: 100, maxResponseCharacters: 100, maxExcerpts: 1, maxExcerptCharacters: 100, maxFileBytes: 100 };
const configEntry = { __type: 'ET.InvestigationConfig', __uid: u(1), provider: 'p', model: 'm', thinkingLevel: 'off', sessionId: 's', workerPrompt: 'W', repositoryMapSource: 'map', repositoryMap: 'MAP', cwd: '/w', tools: [], timestamp: 1 };
const requestEntry = { __type: 'ET.InvestigationRequest', __uid: u(2), request: { question: 'Where is config loaded?' }, limits, timestamp: 2 };
const started = { __type: 'ET.InvestigationAgent', __uid: u(0), context_: [configEntry, requestEntry] };
const submitted = { text: 'In loadConfig.', warnings: [], excerpts: [] };
const agent = { ...started, context_: [...started.context_,
  response(3, [{ type: 'thinking', thinking: 'SECRET_REASONING' }, { type: 'text', text: 'Looking.' },
    call('read', { path: 'src/config.mjs' }, 'a'), call('grep', { pattern: 'local', path: '.' }, 'b')]),
  result(4, 'a', 'read'), result(5, 'b', 'grep', true, 'grep failed'),
  response(6, [call('submit_answer', { text: 'In loadConfig.', excerpts: [{ path: 'src/config.mjs' }] }, 'c')]),
  { ...result(7, 'c', 'submit_answer'), details: { response: submitted } },
  { __type: 'ET.RunEnded', __uid: u(8), reason: 'submitted', timestamp: 8 },
] };

test('steps are a pure, private view of the record with ids from what each step is', () => {
  const s = steps(agent);
  assert.deepEqual(s.map(x => [x.id, x.kind, x.outcome ?? x.reason ?? null]), [
    ['run:1:request', 'request', null],
    ['turn:1:text', 'model', null],
    ['turn:1:call:a', 'tool', 'ok'],
    ['turn:1:call:b', 'tool', 'error'],
    ['turn:2:call:c', 'submit', 'ok'],
    ['run:1:end', 'end', 'submitted'],
  ]);
  assert.deepEqual(s[2], { id: 'turn:1:call:a', kind: 'tool', name: 'read', args: { path: 'src/config.mjs' }, outcome: 'ok', live: false, durationMs: 1200 });
  assert.equal(s[3].error, 'grep failed');
  assert.deepEqual([s[4].answer, s[4].excerpts], ['In loadConfig.', 1]);
  const text = JSON.stringify(s);
  assert(!text.includes('SECRET_REASONING'), 'thinking is never shown');
  assert(!text.includes('raw output'), 'successful tool output is not shown');
  assert.deepEqual(steps(JSON.parse(JSON.stringify(agent))), s, 'same data, same steps');
});

test('a step keeps its id from streaming to recorded', () => {
  const content = [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'Look' }, call('read', { path: 'x' }, 'a')];
  const live = steps(started, content);
  assert.deepEqual(live.slice(1).map(s => [s.id, s.live, s.outcome ?? null]), [['turn:1:text', true, null], ['turn:1:call:a', true, 'pending']]);
  assert(!JSON.stringify(live).includes('SECRET'));
  const recorded = steps({ ...started, context_: [...started.context_, response(3, content)] });
  assert.deepEqual(recorded.map(s => s.id), live.map(s => s.id));
  assert.deepEqual(recorded.slice(1).map(s => [s.live, s.outcome ?? null]), [[false, null], [false, 'pending']]);
  // A provider may reuse a call id in a later turn; steps stay distinct.
  const reused = steps({ ...started, context_: [...started.context_, response(3, [call('ls', {}, 'x')]), result(4, 'x', 'ls'), response(5, [call('ls', {}, 'x')])] });
  assert.deepEqual(reused.slice(1).map(s => [s.id, s.outcome]), [['turn:1:call:x', 'ok'], ['turn:2:call:x', 'pending']]);
});

test('the snapshot is bounded, plain data, and reports what it dropped', () => {
  const many = { ...started, context_: [...started.context_,
    ...Array.from({ length: 200 }, (_, i) => response(100 + i, [{ type: 'text', text: 'x'.repeat(5000) }]))] };
  const s = snapshot({ ...initRun('r'), agent: many });
  assert(s.steps.length <= MAX_STEPS);
  assert(s.steps.reduce((n, x) => n + stepSize(x), 0) <= MAX_TOTAL_TEXT);
  assert.equal(s.omitted + s.steps.length, 201);
  assert.equal(s.steps.at(-1).id, 'turn:200:text', 'newest steps are kept');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  const one = snapshot({ ...initRun('r'), phase: 'completed', agent });
  assert.equal(one.handle, `ET.InvestigationAgent('${u(0)}')`);
  assert.equal(one.agentStatus, 'answered');
  assert.equal(one.turns, 2);
});

// The worker loop as pure data: an edge that answers each effect command with a scripted event.
function drive(script, { interruptAt } = {}) {
  let state = initRun('r');
  const log = [];
  let queue = [];
  const dispatch = event => {
    const [next, commands] = reduceRun(state, event);
    state = next;
    log.push([event.type, commands.map(c => c.type)]);
    queue.push(...commands.filter(c => c.type !== 'publish'));
  };
  dispatch({ type: 'started', agent: started });
  let n = 100;
  for (let turn = 0; queue.length; ) {
    const command = queue.shift();
    if (command.type === 'done') break;
    if (command.type === 'callModel') {
      if (turn === interruptAt) dispatch({ type: 'interrupted', reason: 'cancelled', message: 'stop' });
      dispatch({ type: 'appended', entries: [response(n++, script[turn++])] });
    } else if (command.type === 'executeTools') {
      dispatch({ type: 'appended', entries: command.calls.map(c => c.name === 'submit_answer'
        ? { ...result(n++, c.id, c.name), details: { response: submitted } } : result(n++, c.id, c.name)) });
    } else dispatch({ type: 'appended', entries: command.drafts.map(d => ({ ...d, __uid: u(n++), timestamp: n })) });
  }
  return { state, log };
}

test('the reducer runs the whole worker loop as data', () => {
  const { state, log } = drive([[call('ls', {}, 'a')], [{ type: 'text', text: 'No submit.' }], [call('submit_answer', { text: 'T' }, 'b')]]);
  assert.deepEqual(state.agent.context_.slice(2).map(e => e.__type), [
    'ET.LLMResponse', 'ET.ToolResult', 'ET.LLMResponse', 'ET.HostInstruction', 'ET.LLMResponse', 'ET.ToolResult', 'ET.RunEnded']);
  assert.equal(status(state.agent), 'answered');
  assert.equal(state.phase, 'running');
  assert.equal(state.awaiting, undefined);
  // Every event publishes; every fact yields exactly one next command.
  assert.deepEqual(log[0], ['started', ['publish', 'callModel']]);
  assert(log.slice(1, -1).every(([type, commands]) => type === 'appended' && commands.length === 2 && commands[0] === 'publish'));
  assert.deepEqual(log.at(-1), ['appended', ['publish', 'done']]);
});

test('an interruption waits for the outstanding effect, records it, then ends the run', () => {
  const { state, log } = drive([[call('ls', {}, 'a')], [call('ls', {}, 'b')]], { interruptAt: 1 });
  assert.deepEqual(log.find(([type]) => type === 'interrupted'), ['interrupted', []], 'nothing new while the model call is outstanding');
  assert.deepEqual(state.agent.context_.slice(2).map(e => e.__type), ['ET.LLMResponse', 'ET.ToolResult', 'ET.LLMResponse', 'ET.RunEnded']);
  assert.deepEqual([state.agent.context_.at(-1).reason, state.agent.context_.at(-1).message], ['cancelled', 'stop']);
  // With nothing outstanding, the stop applies at once.
  const [idle, commands] = reduceRun({ ...initRun('r'), agent: started }, { type: 'interrupted', reason: 'cancelled', message: 'now' });
  assert.equal(idle.awaiting, 'record');
  assert.deepEqual(commands.at(-1), { type: 'record', drafts: [{ __type: 'ET.RunEnded', reason: 'cancelled', message: 'now' }] });
  // A failed effect ends the run with its error.
  const [, afterFailure] = reduceRun({ ...initRun('r'), agent: started, awaiting: 'model' }, { type: 'failed', reason: 'error', message: 'boom' });
  assert.deepEqual(afterFailure.at(-1).drafts, [{ __type: 'ET.RunEnded', reason: 'error', message: 'boom' }]);
});

test('streaming is throttled and a recorded response replaces it', () => {
  const [running] = reduceRun(initRun('r'), { type: 'started', agent: started });
  assert.equal(running.awaiting, 'model');
  const [live, commands] = reduceRun(running, { type: 'streamed', content: [{ type: 'text', text: 'Lo' }] });
  assert.deepEqual(commands, [{ type: 'publish', throttle: true }]);
  assert.equal(snapshot(live).turns, 1);
  const [recorded] = reduceRun(live, { type: 'appended', entries: [response(3, [{ type: 'text', text: 'Look' }])] });
  assert.equal(recorded.streaming, undefined);
  assert.deepEqual(snapshot(recorded).steps.map(s => [s.id, s.text ?? null]), [['run:1:request', null], ['turn:1:text', 'Look']]);
  const [phased] = reduceRun(recorded, { type: 'phase', phase: 'completed' });
  assert.equal(phased.phase, 'completed');
  assert.equal(phased.model, 'p/m', 'the model comes from the recorded config');
});
