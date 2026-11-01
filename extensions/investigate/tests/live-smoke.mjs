// Explicit opt-in only: this makes a paid/authenticated request to the configured model.
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to authorize the live model smoke test');
import { host } from './host.mjs';
const requireHost = createRequire(`${host}/package.json`);
const { createJiti } = requireHost('jiti');
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': `${host}/dist/index.js`, typebox: requireHost.resolve('typebox'), '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/compat.js` } });
const { runInvestigation } = await jiti.import('../src/worker.ts');
const { createRunStore } = await jiti.import('../src/store.ts');
const { steps } = await jiti.import('../src/run.ts');
const { ModelRuntime } = await import(`${host}/dist/index.js`);
const snapshot = await loadConfig(new URL('../', import.meta.url).pathname);
snapshot.config.tools.allowBash = false;
snapshot.config.limits.maxTurns = 4;
// Test only the protocol; do not expose the repository map or perform real research.
snapshot.repositoryMap = 'This is a synthetic smoke test. Only inspect the supplied fixture.';
const dir = await mkdtemp(join(tmpdir(), 'investigate-live-'));
const events = [];
const store = createRunStore('live');
const dispatch = store.dispatch;
store.dispatch = event => { events.push(event.type); return dispatch(event); };
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('Smoke test timed out')), 60000);
try {
  const path = join(dir, 'fixture.txt');
  await writeFile(path, 'header\n  "live excerpt" & <source>\nlast\n');
  const runtime = await ModelRuntime.create({ signal: controller.signal });
  console.log(`Testing ${snapshot.config.provider}/${snapshot.config.model} (${snapshot.config.thinkingLevel})`);
  const result = await runInvestigation({ snapshot, cwd: dir, signal: controller.signal, modelRuntime: runtime,
    store,
    request: { question: `Read ${path}, then call submit_answer alone with text exactly "Smoke test passed." and one excerpt for that file, start_line 2, end_line 2. No other research is necessary.`, detail: 'brief', include_references: false },
  });
  assert(result.text.includes('Smoke test passed.'));
  assert(result.text.includes('  "live excerpt" & <source>\n'));
  assert.equal(result.excerpts.length, 1);
  const chain = steps(result.agent);
  assert(chain.some(s => s.kind === 'tool' && s.outcome === 'ok' && s.name === 'read'));
  assert(chain.some(s => s.kind === 'submit' && s.outcome === 'ok' && s.answer.includes('Smoke test passed.')));
  assert(events.includes('streamed'), 'streamed partial responses reach the store');
  console.log(JSON.stringify({ success: true, model: result.model, turns: result.turns, usage: result.usage, events: events.length }));
  console.log(result.text);
} finally { clearTimeout(timer); await rm(dir, { recursive: true, force: true }); }
