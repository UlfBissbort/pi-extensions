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
      assert(updates.every(u => u.details.progress.requestId === results[i].details.requestId));
      assert.equal(updates[0].details.progress.phase, 'queued');
      assert.equal(updates.at(-1).details.progress.phase, 'completed');
    }
    assert.notEqual(results[0].details.requestId, results[1].details.requestId);
    assert.equal(updatesA[0].details.progress.entries.length, 1, 'Published snapshots must not mutate');
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
    assert(JSON.stringify(result.details.progress).includes('PRIVATE_WORKER_DRAFT'), 'UI history remains inspectable');
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
