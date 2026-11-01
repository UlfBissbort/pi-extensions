import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
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
const { runInvestigation, isolatedResources } = await jiti.import('../src/worker.ts');
const { registerInvestigation } = await jiti.import('../src/extension.ts');
const { steps } = await jiti.import('../src/run.ts');
const { render } = await jiti.import('../src/agent.ts');
const { ModelRuntime, createAgentSession, SessionManager, SettingsManager } = await import(`${host}/dist/index.js`);
const { createAssistantMessageEventStream } = await import(`${host}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const { convertResponsesMessages } = await import(`${host}/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`);
const root = new URL('../', import.meta.url).pathname;
const snapshot = await loadConfig(root);

async function scriptedRuntime(script, capture = []) {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const model = runtime.getModel(snapshot.config.provider, snapshot.config.model);
  assert(model, 'Pinned model exists in local catalog');
  runtime.getAvailable = async () => [model];
  runtime.hasConfiguredAuth = () => true;
  let turn = 0;
  runtime.streamSimple = (selected, context, options) => {
    capture.push({ selected, context: structuredClone(context), options });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const content = await script(turn++, context, options);
        const usage = { ...zeroUsage(), input: 10, output: 5, totalTokens: 15 };
        const message = {
          role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage, stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
        };
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      } catch (e) {
        const error = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: e.message, timestamp: Date.now() };
        stream.push({ type: 'error', reason: error.stopReason, error }); stream.end(error);
      }
    });
    return stream;
  };
  return runtime;
}
const call = (name, args, id = 't1') => ({ type: 'toolCall', id, name, arguments: args });
const submit = (text, excerpts) => call('submit_answer', { text, ...(excerpts ? { excerpts } : {}) });
const run = (runtime, extra = {}) => runInvestigation({ snapshot, request: { question: 'Find the answer', detail: 'standard', include_references: true }, cwd: root, signal: new AbortController().signal, modelRuntime: runtime, ...extra });

test('Pi native extension loader loads the actual entry point without installation', async () => {
  const { loadExtensions } = await import(`${host}/dist/core/extensions/loader.js`);
  const loaded = await loadExtensions([join(root, 'index.ts')], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert(loaded.extensions[0].tools.has('investigate'));
});

test('resource loader excludes all discovered context and extensions', () => {
  const loader = isolatedResources('only this');
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.equal(loader.getSystemPrompt(), 'only this');
});

test('real SDK loop reads fixture, keeps intermediate commentary private, and submits exact text and excerpt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-sdk-'));
  try {
    const path = join(dir, 'source.txt');
    await writeFile(path, 'header\n  "actual" & <source>\nend\n');
    await writeFile(join(dir, 'AGENTS.md'), 'PARENT_HISTORY_SENTINEL: this instruction must not be auto-discovered.');
    const capture = [];
    const runtime = await scriptedRuntime((turn, context) => {
      if (turn === 0) return [{ type: 'text', text: 'INTERMEDIATE_NOT_FOR_PARENT' }, call('read', { path })];
      assert(JSON.stringify(context).includes('actual'));
      return [submit('Final answer.', [{ path, start_line: 2, end_line: 2 }])];
    }, capture);
    const result = await run(runtime, { cwd: dir });
    assert.equal(result.turns, 2); assert.equal(result.usage.input, 20);
    assert(result.text.includes('Final answer.'));
    assert(result.text.includes('  "actual" & <source>\n'));
    assert(!result.text.includes('INTERMEDIATE_NOT_FOR_PARENT'));
    const readStep = steps(result.agent).find(s => s.kind === 'tool' && s.name === 'read');
    assert.deepEqual(JSON.parse(readStep.argumentsText), { path });
    assert(readStep.resultText.includes('  "actual" & <source>'), 'the call and model-visible tool output are in one step');
    const first = JSON.stringify(capture[0].context);
    assert(!first.includes('Work directly; do not delegate'));
    assert(!first.includes('PARENT_HISTORY_SENTINEL'));
    const declared = capture[0].context.messages.filter(m => m.role === 'system');
    assert(JSON.stringify(declared).includes('submit_answer'));
    assert(!JSON.stringify(declared).includes('"name":"investigate"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing submission gets one bounded corrective prompt', async () => {
  const runtime = await scriptedRuntime(turn => turn === 0 ? [{ type: 'text', text: 'Not submitted' }] : [submit('Corrected')]);
  const result = await run(runtime);
  assert.equal(result.turns, 2); assert(result.text.includes('Corrected'));
});

test('repeated plain answers fail rather than returning a draft', async () => {
  const runtime = await scriptedRuntime(() => [{ type: 'text', text: 'Draft only' }]);
  await assert.rejects(run(runtime), /no valid submit_answer/);
});

test('mixed completion batch is blocked before any sibling execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-mixed-'));
  try {
    const marker = join(dir, 'must-not-exist');
    const runtime = await scriptedRuntime(turn => turn === 0 ? [submit('Invalid batch'), call('bash', { command: `touch '${marker}'` }, 't2')] : [submit('Safe')]);
    const result = await run(runtime);
    assert(result.text.includes('Safe')); assert(!result.text.includes('Invalid batch'));
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('turn budget is enforced and usage retained on error', async () => {
  const runtime = await scriptedRuntime(() => [call('ls', { path: root })]);
  const limited = structuredClone(snapshot); limited.config.limits.maxTurns = 2;
  await assert.rejects(run(runtime, { snapshot: limited }), error => {
    assert.match(error.message, /exceeded|Incomplete/); assert.equal(error.turns, 2); assert.equal(error.usage.input, 20); return true;
  });
});

test('per-call effort controls the worker request ceiling', async () => {
  const runtime = await scriptedRuntime(turn => turn < 2 ? [call('ls', { path: root })] : [submit('Found')]);
  const result = await run(runtime, { request: { question: 'Find the answer', effort: 4 } });
  assert.equal(result.turns, 3);
  assert(result.text.includes('Found'));
  const shortRuntime = await scriptedRuntime(() => [call('ls', { path: root })]);
  await assert.rejects(run(shortRuntime, { request: { question: 'Find the answer', effort: 0 } }), error => {
    assert.equal(error.turns, 2); return true;
  });
});

test('cancellation aborts the provider and settles the worker', async () => {
  const controller = new AbortController();
  let observed = false;
  const runtime = await scriptedRuntime(async (_turn, _context, options) => {
    await new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { observed = true; reject(new Error('aborted')); }, { once: true });
      controller.abort(new Error('test cancellation'));
    });
  });
  await assert.rejects(run(runtime, { signal: controller.signal }), /test cancellation/);
  assert(observed);
});

test('unsupported model and thinking fail before model requests', async () => {
  const runtime = await scriptedRuntime(() => { throw new Error('Must not call'); });
  const missing = structuredClone(snapshot); missing.config.model = 'not-a-real-model';
  await assert.rejects(run(runtime, { snapshot: missing }), /Unknown investigator model/);
  const bad = structuredClone(snapshot); bad.config.thinkingLevel = 'invalid';
  await assert.rejects(run(runtime, { snapshot: bad }), /Unsupported thinking/);
});

test('two workers do not share conversations or result state', async () => {
  const seenA = [], seenB = [];
  const a = await scriptedRuntime(() => [submit('A')], seenA);
  const b = await scriptedRuntime(() => [submit('B')], seenB);
  const [ra, rb] = await Promise.all([run(a, { request: { question: 'Only question A' } }), run(b, { request: { question: 'Only question B' } })]);
  assert(ra.text.includes('A')); assert(rb.text.includes('B'));
  assert(!JSON.stringify(seenA[0].context).includes('Only question B'));
  assert(!JSON.stringify(seenB[0].context).includes('Only question A'));
});

test('full extension pipeline queues independent calls, returns text/usage, and shuts down queued and running work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-extension-'));
  try {
    const config = structuredClone(snapshot.config);
    config.limits.maxConcurrentInvestigations = 1;
    config.instructionsFile = join(root, 'prompts/worker.md');
    config.parentPromptFile = join(root, 'prompts/parent.md');
    config.repositoryMapFile = join(dir, 'SKILL.md');
    await writeFile(config.repositoryMapFile, '---\nname: repo-map\n---\nREPO_VERSION_ONE');
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    const handlers = {}, tools = [];
    let created = 0;
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    await registerInvestigation({ on: (name, fn) => handlers[name] = fn, registerTool: tool => tools.push(tool) }, dir, {
      createRuntime: async () => {
        created++;
        const n = created;
        return scriptedRuntime(async (_turn, context) => {
          const serialized = JSON.stringify(context);
          const marker = n === 1 ? 'REPO_VERSION_ONE' : 'REPO_VERSION_TWO';
          assert(serialized.includes(marker));
          assert(serialized.indexOf('You are an investigation assistant') < serialized.indexOf(marker));
          assert(!serialized.includes('name: repo-map'));
          if (n === 1) await gate;
          return [submit(`result ${n}`)];
        });
      },
    });
    const tool = tools[0];
    assert.equal(tool.executionMode, 'parallel');
    const updatesA = [], updatesB = [];
    const a = tool.execute('a', { question: 'A' }, undefined, update => updatesA.push(update), { cwd: dir });
    const b = tool.execute('b', { question: 'B' }, undefined, update => updatesB.push(update), { cwd: dir });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(created, 1);
    await writeFile(config.repositoryMapFile, '---\nname: repo-map\n---\nREPO_VERSION_TWO');
    unblock();
    const results = await Promise.all([a, b]);
    assert.equal(created, 2);
    assert(results.every(r => !r.isError && r.usage.input === 10 && r.content.length === 1));
    assert.notEqual(results[0].content[0].text, results[1].content[0].text);
    assert(results.every(r => !('messages' in r.details)));
    for (const [i, updates] of [updatesA, updatesB].entries()) {
      assert(updates.length > 3);
      assert(updates.every(u => u.content.length === 0));
      assert(updates.every(u => u.details.requestId === results[i].details.requestId));
      assert(updates.every(u => u.details.snapshot.requestId === results[i].details.requestId));
      assert(updates.every(u => u.details.snapshot.railIndex === results[i].details.snapshot.railIndex), 'rail colour stays fixed through streaming and completion');
      assert.equal(updates[0].details.snapshot.phase, 'queued');
      assert.equal(updates.at(-1).details.snapshot.phase, 'completed');
      assert.equal(updates.at(-1).details.snapshot.handle, results[i].details.agent);
    }
    assert.notEqual(results[0].details.requestId, results[1].details.requestId);
    assert.notEqual(results[0].details.snapshot.railIndex, results[1].details.snapshot.railIndex, 'parallel investigations get distinct colour lanes');
    assert.equal(updatesA[0].details.snapshot.steps.length, 0, 'Published snapshots must not mutate');
    await handlers.session_shutdown();

    const handlers2 = {}, tools2 = [];
    let running = false;
    await registerInvestigation({ on: (name, fn) => handlers2[name] = fn, registerTool: tool => tools2.push(tool) }, dir, {
      createRuntime: async () => scriptedRuntime(async (_turn, _context, options) => {
        running = true;
        await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
      }),
    });
    const c = tools2[0].execute('c', { question: 'C' }, undefined, undefined, { cwd: dir });
    const d = tools2[0].execute('d', { question: 'D' }, undefined, undefined, { cwd: dir });
    for (let i = 0; i < 100 && !running; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(running);
    await handlers2.session_shutdown();
    const stopped = await Promise.all([c, d]);
    assert(stopped.every(r => r.isError && r.content[0].text.includes('shut down')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parent SDK → investigate → worker SDK → parent receives only final plain text', async () => {
  const handlers = {}, tools = [], workerRequests = [];
  await registerInvestigation({ on: (name, fn) => handlers[name] = fn, registerTool: t => tools.push(t) }, root, {
    createRuntime: async () => scriptedRuntime(turn => turn === 0 ? [{ type: 'text', text: 'PRIVATE_WORKER_DRAFT' }, call('ls', { path: root })] : [submit('Final\n"unescaped" <answer>')], workerRequests),
  });
  const parentRuntime = await scriptedRuntime((turn, context) => {
    if (turn === 0) return [call('investigate', { question: 'Inspect this directory and summarize briefly.' })];
    const result = context.messages.find(m => m.role === 'toolResult' && m.toolName === 'investigate');
    assert(result);
    const text = result.content.find(c => c.type === 'text').text;
    assert(text.includes('Final\n"unescaped" <answer>'));
    assert(!text.includes('PRIVATE_WORKER_DRAFT'));
    assert(!text.includes('\\n'));
    // Bounded UI history may be stored in tool details for replay; it must not
    // enter model-facing content. Provider serialization is tested separately.
    assert(!JSON.stringify(result.content).includes('PRIVATE_WORKER_DRAFT'));
    assert(JSON.stringify(result.details.snapshot).includes('PRIVATE_WORKER_DRAFT'), 'UI history remains inspectable');
    const model = parentRuntime.getModel(snapshot.config.provider, snapshot.config.model);
    const wire = convertResponsesMessages(model, context, new Set(['openai-codex']));
    assert(!JSON.stringify(wire).includes('PRIVATE_WORKER_DRAFT'), 'UI history must not be serialized to the parent provider');
    assert(JSON.stringify(wire).includes('unescaped'));
    return [{ type: 'text', text: 'Parent complete.' }];
  });
  const { session } = await createAgentSession({
    cwd: root, modelRuntime: parentRuntime,
    model: parentRuntime.getModel(snapshot.config.provider, snapshot.config.model),
    thinkingLevel: 'low', tools: ['investigate'], customTools: tools,
    resourceLoader: isolatedResources('PARENT_HISTORY_SENTINEL'),
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } }),
  });
  try {
    await session.prompt('Use investigate and then finish.');
    assert.equal(session.getLastAssistantText(), 'Parent complete.', JSON.stringify(session.messages.at(-1)));
    assert(workerRequests.length > 0);
    assert(!JSON.stringify(workerRequests).includes('PARENT_HISTORY_SENTINEL'));
  } finally { session.dispose(); await handlers.session_shutdown(); }
});

test('extension deadline cancels a real SDK request and returns a text error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-deadline-'));
  try {
    const config = structuredClone(snapshot.config);
    config.limits.timeoutSeconds = 1;
    config.effortScale.minimum.timeoutSeconds = 1;
    config.instructionsFile = join(root, 'prompts/worker.md');
    config.parentPromptFile = join(root, 'prompts/parent.md');
    config.repositoryMapFile = join(root, 'repository-map.md');
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    const tools = [];
    await registerInvestigation({ on: () => {}, registerTool: t => tools.push(t) }, dir, {
      createRuntime: async () => scriptedRuntime(async (_turn, _ctx, options) => {
        await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }),
    });
    const result = await tools[0].execute('id', { question: 'Wait' }, undefined, undefined, { cwd: dir });
    assert(result.isError); assert.match(result.content[0].text, /deadline exceeded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('extension registers one tool and adds/removes prompt section without overwriting others', async () => {
  const handlers = {}, tools = [];
  await registerInvestigation({ on: (name, fn) => handlers[name] = fn, registerTool: tool => tools.push(tool) }, root);
  assert.equal(tools.length, 1); assert.equal(tools[0].name, 'investigate');
  const event = { systemPromptOptions: { selectedTools: ['investigate'], sections: { untouched: 'keep' } } };
  await handlers.before_agent_start(event); await handlers.before_agent_start(event);
  assert(event.systemPromptOptions.sections.investigation.includes('default way'));
  assert.equal(event.systemPromptOptions.sections.untouched, 'keep');
  event.systemPromptOptions.selectedTools = [];
  await handlers.before_agent_start(event);
  assert(!('investigation' in event.systemPromptOptions.sections));
  await handlers.session_shutdown();
  await assert.rejects(tools[0].execute('id', { question: 'q' }, undefined, undefined, { cwd: root }), /shutting down/);
});

test('a continued agent sees its full previous context plus the follow-up, under one system message', async () => {
  const seen = [];
  const runtime = await scriptedRuntime(turn => [
    [call('ls', { path: root }, 'a')], [submit('First')],
    [submit('Second')],
  ][turn], seen);
  const first = await run(runtime);
  const before = first.agent.context_;
  const second = await run(runtime, { agent: first.agent, request: { question: 'Follow up', detail: 'brief', include_references: false, effort: 0 } });
  assert.equal(second.agent.__uid, first.agent.__uid);
  assert.deepEqual(second.agent.context_.slice(0, before.length), before, 'the record only grows');
  assert(second.text.includes('Second'));
  assert.equal(second.turns, 1, 'turns count within the new run');
  const context = seen[2].context;
  assert.deepEqual(context.messages.slice(0, -1), structuredClone(render({ ...first.agent, context_: before }).messages), 'the whole first run precedes the follow-up');
  assert(JSON.stringify(context).includes('First'), 'including its submitted answer');
  assert.equal(context.messages.filter(m => m.role === 'system').length, 1);
  const followUp = context.messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.match(followUp.content[0].text, /continues this investigation[\s\S]*At most 2 model requests[\s\S]*"question": "Follow up"/);
  assert.equal(seen[2].options.sessionId, seen[0].options.sessionId, 'same model session');
});

test('extension results start with the agent handle, continue by handle, and reject unknown or busy handles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-continue-'));
  try {
    const config = structuredClone(snapshot.config);
    config.instructionsFile = join(root, 'prompts/worker.md');
    config.parentPromptFile = join(root, 'prompts/parent.md');
    config.repositoryMapFile = join(root, 'repository-map.md');
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    const handlers = {}, tools = [], contexts = [];
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    await registerInvestigation({ on: (name, fn) => handlers[name] = fn, registerTool: t => tools.push(t) }, dir, {
      createRuntime: async () => scriptedRuntime(async (_turn, context) => {
        contexts.push(structuredClone(context));
        const last = JSON.stringify(context.messages.at(-1));
        if (last.includes('slow follow-up')) await gate;
        return [submit(last.includes('follow-up') ? 'Answer two' : 'Answer one')];
      }),
    });
    const tool = tools[0];
    const first = await tool.execute('a', { question: 'Start' }, undefined, undefined, { cwd: dir });
    const handle = first.details.agent;
    assert.match(handle, /^ET\.InvestigationAgent\('🍃-[0-9a-f]{20}'\)$/);
    const name = first.details.name;
    assert.match(name, /^[a-z]+(_[a-z]+)*$/);
    assert(first.content[0].text.startsWith(`${name} = ${handle} answered\n\n<investigation_answer>`), first.content[0].text);

    const second = await tool.execute('b', { agent: handle, question: 'A follow-up' }, undefined, undefined, { cwd: dir });
    assert(!second.isError, second.content[0].text);
    assert.equal(second.details.agent, handle);
    assert(second.content[0].text.startsWith(`${name} = ${handle} answered\n\n`));
    assert.equal(second.details.name, name, 'a continued investigator keeps its name');
    assert(second.content[0].text.includes('Answer two'));
    assert(JSON.stringify(contexts.at(-1)).includes('Answer one'), 'the follow-up sees the first run');
    // The bare UID works too.
    const slow = tool.execute('c', { agent: name, question: 'A slow follow-up' }, undefined, undefined, { cwd: dir });
    await new Promise(resolve => setTimeout(resolve, 30));
    const busy = await tool.execute('d', { agent: handle, question: 'Parallel follow-up' }, undefined, undefined, { cwd: dir });
    assert(busy.isError); assert(busy.content[0].text.startsWith(`${name} = ${handle} running\n\nNot started:`), busy.content[0].text);
    assert.equal(busy.details.agentStatus, 'running');
    unblock();
    assert(!(await slow).isError);

    const unknown = await tool.execute('e', { agent: "ET.InvestigationAgent('🍃-00000000000000000000')", question: 'x' }, undefined, undefined, { cwd: dir });
    assert(unknown.isError); assert.match(unknown.content[0].text, /^Investigation failed or incomplete: Unknown agent/);
    const invalid = await tool.execute('f', { agent: 'nonsense', question: 'x' }, undefined, undefined, { cwd: dir });
    assert(invalid.isError); assert.match(invalid.content[0].text, /Invalid agent: nonsense/);
    const uid = handle.match(/'(.*)'/)[1];
    const byUid = await tool.execute('g', { agent: uid, question: 'A follow-up by uid' }, undefined, undefined, { cwd: dir });
    assert(!byUid.isError, byUid.content[0].text);
    await handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A fake Pi for the extension: handlers, tools, sent messages, widgets, notices, completion.
async function extensionHarness(dir, script, session = []) {
  const config = structuredClone(snapshot.config);
  config.instructionsFile = join(root, 'prompts/worker.md');
  config.parentPromptFile = join(root, 'prompts/parent.md');
  config.repositoryMapFile = join(root, 'repository-map.md');
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const h = { handlers: {}, tools: [], contexts: [], notes: [], sent: [], widgets: new Map(), widgetLog: [], providers: [] };
  let delivered;
  h.nextMessage = () => new Promise(resolve => { delivered = resolve; });
  const pi = {
    on: (name, fn) => h.handlers[name] = fn,
    registerTool: t => h.tools.push(t),
    registerMessageRenderer: (type, fn) => h.renderer = fn,
    sendMessage: (message, options) => { h.sent.push({ message, options }); delivered?.(h.sent.at(-1)); },
    appendEntry: (customType, data) => session.push(structuredClone({ type: 'custom', customType, data })),
  };
  h.session = session;
  h.start = () => h.handlers.session_start({}, { hasUI: true, ui: h.ui, sessionManager: { getEntries: () => session, getBranch: () => session } });
  const tui = { requestRender() {} };
  const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: t => t, style: (_s, t) => t, colors: {} };
  h.ui = {
    notify: (text, level) => h.notes.push([level, text]),
    setWidget: (key, factory) => {
      h.widgetLog.push([key, !!factory]);
      if (factory) h.widgets.set(key, factory(tui, theme)); else h.widgets.delete(key);
    },
    addAutocompleteProvider: factory => h.providers.push(factory),
  };
  await registerInvestigation(pi, dir, {
    createRuntime: async () => scriptedRuntime(async (turn, context, options) => {
      h.contexts.push(structuredClone(context));
      return script(turn, context, options);
    }),
  });
  h.input = text => h.handlers.input({ type: 'input', text, source: 'interactive', streamingBehavior: 'steer' }, { hasUI: true, ui: h.ui });
  h.ctx = { cwd: dir, hasUI: true, ui: h.ui };
  h.theme = theme;
  return h;
}
const lastUserText = context => context.messages.at(-1).content[0].text;

test('names are shown from launch, never reused, and @name messages reach the running investigator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-names-'));
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await extensionHarness(dir, async (turn, context) => {
      if (JSON.stringify(context).includes('Wait for me') && h.contexts.length === 1) { await gate; return [call('ls', { path: dir }, 'l1')]; }
      return [submit('Done')];
    });
    // A name shown earlier in this session (e.g. before a reload) is never issued again.
    const taken = 'hypatia_the_patient';
    const entries = [{ type: 'message', message: { role: 'toolResult', toolName: 'investigate', details: { name: taken } } }];
    await h.handlers.session_start({}, { hasUI: false, sessionManager: { getEntries: () => entries } });
    const tool = h.tools[0];
    const updates = [];
    const pending = tool.execute('a', { question: 'Wait for me' }, undefined, u => updates.push(u), h.ctx);
    await new Promise(resolve => setTimeout(resolve, 20));
    const name = updates[0].details.snapshot.name;
    assert(name && name !== taken, 'the name is known at launch, before the agent record exists');
    const prefix = name.slice(0, name.length - 2);
    // Addressed by unique prefix with an ellipsis, while the first model request is still out.
    assert.deepEqual(await h.input(`@${prefix}… look in the tests instead`), { action: 'handled' });
    assert.match(h.notes.at(-1)[1], new RegExp(`^Sent to ${name}`));
    assert.equal(updates.at(-1).details.snapshot.pendingMessages, 1);
    assert.deepEqual(await h.input('@nobody_known hello'), { action: 'continue' }, 'unknown names are ordinary parent input');
    assert.deepEqual(await h.input('no address here'), { action: 'continue' });
    release();
    const result = await pending;
    assert(!result.isError, result.content[0].text);
    // Delivered at the turn boundary: after the tool result, before the next model request.
    const roles = h.contexts.at(-1).messages.map(m => m.role);
    assert.deepEqual(roles.slice(-3), ['assistant', 'toolResult', 'user']);
    assert.match(lastUserText(h.contexts.at(-1)), /^Message from the human user[\s\S]*look in the tests instead$/);
    const text = result.content[0].text;
    assert(text.startsWith(`${name} = ${result.details.agent} answered\n\nThe user sent this investigator messages during this call`), text);
    assert(text.includes('- "look in the tests instead"'));
    assert(result.details.snapshot.steps.some(s => s.kind === 'user' && s.text === 'look in the tests instead'));
    // A parallel investigator gets a different name.
    const other = await tool.execute('b', { question: 'Other' }, undefined, undefined, h.ctx);
    assert.notEqual(other.details.name, name);
    assert.notEqual(other.details.name, taken);
    await h.handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writing to a finished investigator resumes it in a live widget and reports to the parent in its own colour', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-resume-'));
  try {
    const h = await extensionHarness(dir, async (_turn, context) =>
      [submit(lastUserText(context).includes('one more thing') ? 'Second answer' : 'First answer')]);
    await h.handlers.session_start({}, { hasUI: true, ui: h.ui, sessionManager: { getEntries: () => [] } });
    const first = await h.tools[0].execute('a', { question: 'Start', effort: 1, detail: 'brief' }, undefined, undefined, h.ctx);
    const { name, agent: handle } = first.details;
    const rail = first.details.snapshot.railIndex;
    const delivered = h.nextMessage();
    assert.deepEqual(await h.input(`@${name} one more thing`), { action: 'handled' });
    assert.match(h.notes.at(-1)[1], new RegExp(`^Resuming ${name}`));
    // While it runs, the chain is a widget above the editor.
    const runWidgets = () => [...h.widgets.keys()].filter(k => k.startsWith('investigate-run-'));
    assert.equal(runWidgets().length, 1);
    const widgetLines = h.widgets.get(runWidgets()[0]).render(100);
    assert(widgetLines[0].includes(name), widgetLines.join('\n'));
    const { message, options } = await delivered;
    assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.equal(message.customType, 'investigation-report');
    assert.equal(message.display, true);
    assert(message.content.startsWith(`${name} = ${handle} answered\n\nThe user resumed this investigator directly`), message.content);
    assert(message.content.includes('- "one more thing"') && message.content.includes('Second answer'));
    assert.equal(runWidgets().length, 0, 'the widget is gone once the box is in the transcript');
    // The model saw the whole first run, then the user's message with this run's limits.
    const context = h.contexts.at(-1);
    assert(JSON.stringify(context).includes('First answer'));
    assert.equal(context.messages.filter(m => m.role === 'system').length, 1);
    assert.match(lastUserText(context), /^The human user resumes this investigation[\s\S]*At most \d+ model requests[\s\S]*one more thing$/);
    // Same agent, same name, same colour; the box shows the user's message first in the new run.
    const details = message.details;
    assert.equal(details.agent, handle);
    assert.equal(details.name, name);
    assert.equal(details.snapshot.railIndex, rail);
    const runSteps = details.snapshot.steps.slice(details.snapshot.steps.findIndex(s => s.id === 'run:2:request'));
    assert.deepEqual(runSteps.map(s => s.kind), ['user', 'submit', 'end']);
    assert.equal(runSteps[0].text, 'one more thing');
    // The transcript box renders from the message alone.
    const lines = h.renderer(message, { expanded: false }, h.theme).render(100);
    assert(lines[0].includes(name) && lines.some(l => l.includes('one more thing')), lines.join('\n'));
    // The parent can continue it afterwards as usual.
    const third = await h.tools[0].execute('b', { agent: name, question: 'Third' }, undefined, undefined, h.ctx);
    assert(!third.isError, third.content[0].text);
    assert.equal(third.details.snapshot.railIndex, rail, 'a parent continuation keeps the colour too');
    await h.handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a message sent while the investigator submits its answer starts a resumed run right after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-late-'));
  try {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const inFinal = new Promise(resolve => { started = resolve; });
    const h = await extensionHarness(dir, async (_turn, context) => {
      if (lastUserText(context).includes('also check the docs')) return [submit('Docs checked')];
      started(); await gate; return [submit('Main answer')];
    });
    await h.handlers.session_start({}, { hasUI: true, ui: h.ui, sessionManager: { getEntries: () => [] } });
    const updates = [];
    const pending = h.tools[0].execute('a', { question: 'Main' }, undefined, u => updates.push(u), h.ctx);
    await inFinal;
    const name = updates.at(-1).details.snapshot.name;
    await h.input(`@${name} also check the docs`);
    const delivered = h.nextMessage();
    release();
    const result = await pending;
    assert(!result.isError);
    assert(result.content[0].text.includes('while it was finishing; it continues with them now and reports back in a separate message:\n- "also check the docs"'), result.content[0].text);
    const { message } = await delivered;
    assert(message.content.includes('The user resumed this investigator directly') && message.content.includes('Docs checked'), message.content);
    assert.equal(message.details.name, name);
    await h.handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('@ autocompletes running and finished investigators and leaves other completions alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-complete-'));
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await extensionHarness(dir, async (_turn, context) => {
      if (lastUserText(context).includes('Slow')) await gate;
      return [submit('ok')];
    });
    await h.handlers.session_start({}, { hasUI: true, ui: h.ui, sessionManager: { getEntries: () => [] } });
    const fallback = { triggerCharacters: ['/'], getSuggestions: async () => ({ prefix: 'file', items: [{ value: 'src/', label: 'src/' }] }), applyCompletion: () => ({ lines: ['file'], cursorLine: 0, cursorCol: 4 }) };
    assert.equal(h.providers.length, 1);
    const provider = h.providers[0](fallback);
    assert.deepEqual(provider.triggerCharacters.sort(), ['/', '@']);
    const done = await h.tools[0].execute('a', { question: 'Fast' }, undefined, undefined, h.ctx);
    const updates = [];
    const slow = h.tools[0].execute('b', { question: 'Slow' }, undefined, u => updates.push(u), h.ctx);
    await new Promise(resolve => setTimeout(resolve, 20));
    const live = updates.at(-1).details.snapshot.name;
    const signal = new AbortController().signal;
    const all = await provider.getSuggestions(['@'], 0, 1, { signal });
    assert.equal(all.prefix, '@');
    assert.deepEqual(all.items.map(i => i.value), [live, done.details.name], 'running first, then finished');
    assert.match(all.items[0].description, /running|starting|queued/);
    assert.match(all.items[1].description, /resumes with your message/);
    // Any part of a name matches.
    const part = live.split('_').at(-1);
    assert((await provider.getSuggestions([`@${part}`], 0, part.length + 1, { signal })).items.some(i => i.value === live));
    // Not an address: elsewhere in the text, or no matching name, goes to Pi's completion.
    assert.equal((await provider.getSuggestions(['see @'], 0, 5, { signal })).prefix, 'file');
    assert.equal((await provider.getSuggestions(['@src/ma'], 0, 7, { signal })).prefix, 'file');
    const applied = provider.applyCompletion(['@ki rest'], 0, 3, all.items[0], '@ki');
    assert.deepEqual(applied, { lines: [`@${live} rest`], cursorLine: 0, cursorCol: live.length + 2 });
    assert.deepEqual(provider.applyCompletion(['x'], 0, 1, { value: 'src/', label: 'src/' }, 'x'), { lines: ['file'], cursorLine: 0, cursorCol: 4 });
    release();
    await slow;
    await h.handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finished investigators survive a reload: suggested, resumable, and continued with their context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-reload-'));
  try {
    const script = async (_turn, context) => [submit(lastUserText(context).includes('Start') ? 'First answer' : 'Later answer')];
    const before = await extensionHarness(dir, script);
    await before.start();
    const first = await before.tools[0].execute('a', { question: 'Start' }, undefined, undefined, before.ctx);
    const second = await before.tools[0].execute('b', { agent: first.details.name, question: 'More' }, undefined, undefined, before.ctx);
    assert(!second.isError);
    const deltas = before.session.filter(e => e.customType === 'investigation-agent');
    assert.equal(deltas.length, 2, 'one save per finished run');
    assert.equal(deltas[1].data.from, deltas[0].data.entries.length, 'the second save holds only the new entries');
    await before.handlers.session_shutdown();

    // A reload: a fresh extension instance on the same session.
    const after = await extensionHarness(dir, script, before.session);
    await after.start();
    const { name, agent: handle } = first.details;
    const provider = after.providers[0]({ getSuggestions: async () => null, applyCompletion: () => ({}) });
    const items = (await provider.getSuggestions(['@'], 0, 1, { signal: new AbortController().signal })).items;
    assert.deepEqual(items.map(i => i.value), [name]);
    // The parent continues it by name, with the whole history from before the reload.
    const third = await after.tools[0].execute('c', { agent: name, question: 'After reload' }, undefined, undefined, after.ctx);
    assert(!third.isError, third.content[0].text);
    assert.equal(third.details.agent, handle);
    assert.equal(third.details.snapshot.railIndex, first.details.snapshot.railIndex);
    const context = JSON.stringify(after.contexts.at(-1));
    assert(context.includes('First answer') && context.includes('Later answer'));
    // The user can resume it too.
    const delivered = after.nextMessage();
    assert.deepEqual(await after.input(`@${name} and once more`), { action: 'handled' });
    assert((await delivered).message.content.startsWith(`${name} = ${handle} answered`));
    // A new investigator does not reuse the name.
    const fresh = await after.tools[0].execute('d', { question: 'Start again' }, undefined, undefined, after.ctx);
    assert.notEqual(fresh.details.name, name);
    await after.handlers.session_shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
