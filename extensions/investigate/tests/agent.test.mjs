import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { limitsForEffort, zeroUsage } from '../src/core.mjs';
import { normalizeContext } from './normalize-context.mjs';
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
const { runInvestigation } = await jiti.import('../src/worker.ts');
const { createRunStore } = await jiti.import('../src/store.ts');
const agentCore = await jiti.import('../src/agent.ts');
const { render, status, nextStep, turnsInRun, usage, currentRun, append, CORRECTIVE_INSTRUCTION, MIXED_BATCH_REASON } = agentCore;
const { ModelRuntime } = await import(`${host}/dist/index.js`);
const { createAssistantMessageEventStream } = await import(`${host}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const root = new URL('../', import.meta.url).pathname;
const snapshot = await loadConfig(root);
const legacy = JSON.parse(await readFile(new URL('./fixtures/legacy-contexts.json', import.meta.url), 'utf8'));

const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });

async function scripted(script) {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const model = runtime.getModel(snapshot.config.provider, snapshot.config.model);
  runtime.getAvailable = async () => [model];
  runtime.hasConfiguredAuth = () => true;
  let turn = 0;
  const contexts = [];
  runtime.streamSimple = (_selected, context) => {
    contexts.push(JSON.parse(JSON.stringify(context)));
    const stream = createAssistantMessageEventStream();
    const content = script(turn++);
    const message = {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { ...zeroUsage(), input: 10, output: 5, totalTokens: 15 },
      stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 1000 + turn,
    };
    queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
    return stream;
  };
  return { runtime, contexts };
}

// Same scenarios the legacy AgentSession-based worker was captured with.
const scenarios = {
  tools_then_submit: t => [
    [{ type: 'text', text: 'Looking.' }, call('ls', { path: '.' }, 'c1'), call('read', { path: 'a.txt' }, 'c2')],
    [call('grep', { pattern: 'needle', path: '.' }, 'c3'), call('read', { path: 'missing.txt' }, 'c4')],
    [call('read', { wrong: 1 }, 'c5')],
    [{ type: 'text', text: 'Done.' }, call('submit_answer', { text: 'Answer.', excerpts: [{ path: 'a.txt', start_line: 2, end_line: 2 }] }, 'c6')],
  ][t],
  corrective_then_submit: t => [
    [{ type: 'text', text: 'Plain answer without submit.' }],
    [call('submit_answer', { text: 'Corrected.' }, 'c1')],
  ][t],
  mixed_batch: t => [
    [call('submit_answer', { text: 'Bad batch' }, 'c1'), call('ls', { path: '.' }, 'c2')],
    [call('submit_answer', { text: 'Safe' }, 'c3')],
  ][t],
  invalid_submission: t => [
    [call('submit_answer', { text: '' }, 'c1')],
    [call('submit_answer', { text: 'Valid now' }, 'c2')],
  ][t],
};

// Verbatim system prompt template of the legacy session-based worker.
function legacyPreamble(effort) {
  const { workerPrompt, repositoryMap, config } = snapshot;
  const limits = limitsForEffort(config, effort);
  const maxTurns = limits.maxTurns;
  return `${workerPrompt}\n\n# Latest repository overview skill\nSource: ${config.repositoryMapFile}\n\n${repositoryMap}\n\n# Hard limits\nAt most ${maxTurns} model requests. Final answer: ${limits.maxAnswerCharacters} characters. Total returned response including excerpts: ${limits.maxResponseCharacters} characters. At most ${limits.maxExcerpts} excerpts, each ${limits.maxExcerptCharacters} characters; they must also fit the total response budget. No recursive investigation.`;
}

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'inv-golden-'));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(dir, 'sub', 'b.txt'), 'needle here\n');
  return dir;
}
const run = (runtime, cwd, extra = {}) => runInvestigation({
  snapshot, request: { question: 'Where?', detail: 'standard', include_references: true, effort: 4 },
  cwd, signal: new AbortController().signal, modelRuntime: runtime, ...extra,
});

for (const [name, script] of Object.entries(scenarios)) {
  test(`model contexts match the legacy session-based worker: ${name}`, async () => {
    const dir = await fixtureDir();
    try {
      const { runtime, contexts } = await scripted(script);
      const result = await run(runtime, dir);
      const expected = legacy[name];
      assert.equal(result.turns, expected.result.turns);
      assert.deepEqual(normalizeContext(contexts, dir), expected.contexts);
      // The fixture masks the preamble; check it against the legacy template exactly.
      for (const context of contexts) assert.equal(context.messages[0].sections.preamble, legacyPreamble(4));
      // The record alone reproduces every context that was sent.
      const agent = result.agent;
      const responses = agent.context_.flatMap((e, i) => e.__type === 'ET.LLMResponse' ? [i] : []);
      for (const [n, index] of responses.entries()) {
        const prefix = { ...agent, context_: agent.context_.slice(0, index) };
        assert.deepEqual(normalizeContext(render(prefix), dir), normalizeContext(contexts[n], dir));
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('a finished agent keeps its full record and is answered', async () => {
  const dir = await fixtureDir();
  try {
    const { runtime } = await scripted(scenarios.tools_then_submit);
    // Watch the store: the agent value after every event.
    const store = createRunStore('r');
    const seen = [];
    const dispatch = store.dispatch;
    store.dispatch = event => { const commands = dispatch(event); if (store.state().agent) seen.push(store.state().agent); return commands; };
    const result = await run(runtime, dir, { store });
    assert(seen.length > 5);
    const agent = result.agent;
    assert.equal(agent.__type, 'ET.InvestigationAgent');
    assert.match(agent.__uid, /^🍃-[0-9a-f]{20}$/);
    assert.equal(status(agent), 'answered');
    assert.deepEqual(agent.context_.map(e => e.__type), [
      'ET.InvestigationConfig', 'ET.InvestigationRequest',
      'ET.LLMResponse', 'ET.ToolResult', 'ET.ToolResult',
      'ET.LLMResponse', 'ET.ToolResult', 'ET.ToolResult',
      'ET.LLMResponse', 'ET.ToolResult',
      'ET.LLMResponse', 'ET.ToolResult',
      'ET.RunEnded',
    ]);
    assert(agent.context_.every(e => /^🍃-[0-9a-f]{20}$/.test(e.__uid)));
    assert.equal(new Set(agent.context_.map(e => e.__uid)).size, agent.context_.length);
    // Tool calls are not entries of their own; they live inside responses.
    assert(!agent.context_.some(e => e.__type === 'ET.ToolCall'));
    // Every published value is a prefix of the next: the record only grows.
    for (let i = 1; i < seen.length; i++) assert.deepEqual(seen[i].context_.slice(0, seen[i - 1].context_.length), seen[i - 1].context_);
    // The record is plain JSON data.
    assert.deepEqual(JSON.parse(JSON.stringify(agent)), agent);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('budget exhaustion keeps the agent as resumable data', async () => {
  const dir = await fixtureDir();
  try {
    const { runtime } = await scripted(() => [call('ls', { path: '.' }, 'c1')]);
    await assert.rejects(run(runtime, dir, { request: { question: 'Loop', effort: 0 } }), error => {
      assert.match(error.message, /exceeded 2 model requests/);
      assert.equal(status(error.agent), 'resumable');
      const last = error.agent.context_.at(-1);
      assert.equal(last.__type, 'ET.RunEnded');
      assert.equal(last.reason, 'budget_exhausted');
      assert.equal(turnsInRun(error.agent), 2);
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation ends the run as cancelled and keeps prior facts', async () => {
  const dir = await fixtureDir();
  try {
    const controller = new AbortController();
    const { runtime } = await scripted(turn => {
      if (turn === 1) controller.abort(new Error('stop now'));
      return [call('ls', { path: '.' }, `c${turn}`)];
    });
    await assert.rejects(run(runtime, dir, { signal: controller.signal }), error => {
      assert.match(error.message, /stop now/);
      const last = error.agent.context_.at(-1);
      assert.equal(last.reason, 'cancelled');
      assert(error.agent.context_.some(e => e.__type === 'ET.ToolResult'));
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Pure core: plain data in, plain data out; no model, no file system.
const limits = { maxTurns: 2, timeoutSeconds: 30, maxAnswerCharacters: 100, maxResponseCharacters: 1000, maxExcerpts: 1, maxExcerptCharacters: 100, maxFileBytes: 1000 };
const u = n => `🍃-${String(n).padStart(20, '0')}`;
const base = {
  __type: 'ET.InvestigationAgent', __uid: u(0),
  context_: [
    { __type: 'ET.InvestigationConfig', __uid: u(1), provider: 'p', model: 'm', thinkingLevel: 'low', sessionId: 's',
      workerPrompt: 'W', repositoryMapSource: 'map.md', repositoryMap: 'MAP', cwd: '/w', tools: [{ name: 'ls', description: 'd', parameters: {} }], timestamp: 1 },
    { __type: 'ET.InvestigationRequest', __uid: u(2), request: { question: 'Q' }, limits, timestamp: 2 },
  ],
};
const response = (n, content, stopReason = 'toolUse') => ({ __type: 'ET.LLMResponse', __uid: u(n), content, usage: { ...zeroUsage(), input: 3 }, stopReason, timestamp: n });
const toolResult = (n, id) => ({ __type: 'ET.ToolResult', __uid: u(n), toolCallId: id, toolName: 'ls', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: n });

test('render builds strings only from recorded parts', () => {
  const agent = append(append(base, response(3, [call('ls', {}, 'a')])), toolResult(4, 'a'));
  const { messages } = render(agent);
  assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
  assert(messages[0].sections.preamble.startsWith('W\n\n# Latest repository overview skill\nSource: map.md\n\nMAP\n\n# Hard limits\nAt most 2 model requests.'));
  assert.equal(messages[0].sections.cwd, '<cwd>\n/w\n</cwd>');
  assert.deepEqual(messages[0].toolsAdded, [{ name: 'ls', description: 'd', parameters: {} }]);
  assert.equal(messages[1].content[0].text, 'Investigation request (task data):\n{\n  "question": "Q"\n}');
  assert(!('__uid' in messages[2]) && !('__type' in messages[3]));
  assert.deepEqual(render(agent), render(JSON.parse(JSON.stringify(agent))), 'same data, same context');
});

test('next step, status, turns and usage are derived from the record', () => {
  assert.deepEqual(nextStep(base), { kind: 'call_model' });
  assert.equal(status(base), 'running');
  const withCalls = append(base, response(3, [call('ls', {}, 'a')]));
  assert.equal(nextStep(withCalls).kind, 'execute_tools');
  const mixed = append(base, response(3, [call('submit_answer', { text: 't' }, 'a'), call('ls', {}, 'b')]));
  assert.deepEqual(nextStep(mixed), { kind: 'block_batch', calls: mixed.context_.at(-1).content, reason: MIXED_BATCH_REASON });
  const plain = append(base, response(3, [{ type: 'text', text: 'no submit' }], 'stop'));
  assert.deepEqual(nextStep(plain), { kind: 'instruct', content: CORRECTIVE_INSTRUCTION });
  const corrected = append(append(plain, { __type: 'ET.HostInstruction', __uid: u(4), content: CORRECTIVE_INSTRUCTION, timestamp: 4 }), response(5, [{ type: 'text', text: 'still none' }], 'stop'));
  assert.equal(nextStep(corrected).kind, 'end');
  assert.match(nextStep(corrected).message, /no valid submit_answer after 2 requests/);
  const exhausted = append(append(append(withCalls, toolResult(4, 'a')), response(5, [call('ls', {}, 'b')])), toolResult(6, 'b'));
  assert.deepEqual(nextStep(exhausted), { kind: 'end', reason: 'budget_exhausted', message: 'Investigation exceeded 2 model requests' });
  assert.equal(turnsInRun(exhausted), 2);
  assert.equal(usage(currentRun(exhausted)).input, 6);
  const failed = append(base, { ...response(3, [], 'error'), errorMessage: 'provider down' });
  assert.deepEqual(nextStep(failed), { kind: 'end', reason: 'error', message: 'provider down' });
  const submitted = append(append(base, response(3, [call('submit_answer', { text: 't' }, 'a')])),
    { ...toolResult(4, 'a'), toolName: 'submit_answer', details: { response: { text: 't', warnings: [], excerpts: [] } } });
  assert.deepEqual(nextStep(submitted), { kind: 'end', reason: 'submitted' });
  const ended = append(submitted, { __type: 'ET.RunEnded', __uid: u(5), reason: 'submitted', timestamp: 5 });
  assert.equal(status(ended), 'answered');
  assert.equal(status(append(exhausted, { __type: 'ET.RunEnded', __uid: u(7), reason: 'budget_exhausted', timestamp: 7 })), 'resumable');
});
