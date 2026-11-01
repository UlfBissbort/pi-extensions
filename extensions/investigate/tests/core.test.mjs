import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRequest, limitsForEffort, validateSubmission, selectLines, frame, assembleResponse, readBoundedText, extractPrompt, createSemaphore, addUsage, zeroUsage } from '../src/core.mjs';
import { loadConfig, loadWorkerContext, stripDocumentMetadata, validateConfig } from '../src/config.mjs';
const root = new URL('../', import.meta.url).pathname;
const snapshot = await loadConfig(root);
const { config } = snapshot;

test('actual config and marked prompts load; defaults, model, and no editorial header', () => {
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.provider, 'openai');
  assert.equal(config.thinkingLevel, 'medium');
  assert.equal(config.limits.maxTurns, 20);
  assert.equal(config.repositoryMapFile, './repository-map.md');
  assert(snapshot.repositoryMap.includes('# Repository orientation'));
  assert(!snapshot.repositoryMap.includes('description: Use when figuring'));
  assert(!snapshot.workerPrompt.includes('+++'));
  assert(!snapshot.parentPrompt.includes('## Integration contract'));
  assert.deepEqual(normalizeRequest({ question: ' foo ' }, config), { question: 'foo', scope: [], detail: 'standard', include_references: true, effort: 4 });
});
test('worker startup rereads the current prompt and repo skill without cached copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-fresh-prompt-'));
  try {
    const c = { instructionsFile: 'worker.md', repositoryMapFile: 'SKILL.md' };
    const prompt = text => `editorial\n<!-- BEGIN INVESTIGATE WORKER PROMPT -->\n${text}\n<!-- END INVESTIGATE WORKER PROMPT -->`;
    await writeFile(join(dir, 'worker.md'), prompt('INITIAL'));
    await writeFile(join(dir, 'SKILL.md'), '---\nname: repo-map\n---\n# Latest map\nVERSION_ONE');
    const first = await loadWorkerContext(dir, c);
    await writeFile(join(dir, 'worker.md'), prompt('UPDATED'));
    await writeFile(join(dir, 'SKILL.md'), '---\nname: repo-map\n---\n# Latest map\nVERSION_TWO');
    const second = await loadWorkerContext(dir, c);
    assert.equal(first.workerPrompt, 'INITIAL');
    assert(first.repositoryMap.includes('VERSION_ONE'));
    assert.equal(second.workerPrompt, 'UPDATED');
    assert(second.repositoryMap.includes('VERSION_TWO'));
    assert(!second.repositoryMap.includes('VERSION_ONE'));
    assert(!second.repositoryMap.includes('name: repo-map'));
    await rm(join(dir, 'SKILL.md'));
    await assert.rejects(loadWorkerContext(dir, c), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('skill metadata removal supports YAML and TOML while preserving body', () => {
  assert.equal(stripDocumentMetadata('---\r\nname: x\r\n---\r\n# Body\r\n'), '# Body\r\n');
  assert.equal(stripDocumentMetadata('+++\ntitle = "x"\n+++\n# Body'), '# Body');
  assert.equal(stripDocumentMetadata('# Body\n---\nrest'), '# Body\n---\nrest');
});

test('request validation rejects malformed and oversized input', () => {
  for (const bad of [{}, { question: ' ' }, { question: 'x', unknown: true }, { question: 'x', scope: [''] }, { question: 'x', scope: 'a' }, { question: 'x', detail: 'long' }, { question: 'x', include_references: 1 }, { question: 'x', context: 3 }, { question: 'a'.repeat(25000) }]) assert.throws(() => normalizeRequest(bad, config));
  assert.equal(normalizeRequest({ question: 'x', include_references: false }, config).include_references, false);
  for (const effort of [0, 8, 10]) assert.equal(normalizeRequest({ question: 'x', effort }, config).effort, effort);
  for (const effort of [-1, 11, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeRequest({ question: 'x', effort }, config));
  assert.throws(() => normalizeRequest({ question: 'x', max_turns: 50 }, config));
});
test('effort scales all five ceilings from configured endpoints through the effort-4 pivot', () => {
  const fields = ['maxTurns', 'timeoutSeconds', 'maxAnswerCharacters', 'maxResponseCharacters', 'maxExcerpts'];
  const picked = limits => Object.fromEntries(fields.map(key => [key, limits[key]]));
  assert.deepEqual(picked(limitsForEffort(config, 0)), config.effortScale.minimum);
  assert.deepEqual(picked(limitsForEffort(config, 4)), picked(config.limits));
  assert.deepEqual(picked(limitsForEffort(config, 10)), config.effortScale.maximum);
  assert.deepEqual(picked(limitsForEffort(config, 8)), { maxTurns: 97, timeoutSeconds: 428, maxAnswerCharacters: 80670, maxResponseCharacters: 161340, maxExcerpts: 30 });
  for (let effort = 1; effort <= 10; effort++) for (const key of fields) assert(limitsForEffort(config, effort)[key] >= limitsForEffort(config, effort - 1)[key]);
  const excerpts = Array.from({ length: 16 }, () => ({ path: 'example.txt' }));
  assert.throws(() => validateSubmission({ text: 'ok', excerpts }, limitsForEffort(config, 4)));
  assert.equal(validateSubmission({ text: 'ok', excerpts }, limitsForEffort(config, 10)).excerpts.length, 16);
  assert.throws(() => validateSubmission({ text: 'x'.repeat(6001) }, limitsForEffort(config, 0)));
  assert.equal(validateSubmission({ text: 'x'.repeat(6001) }, limitsForEffort(config, 10)).text.length, 6001);
});
test('config validation and budgets reject unsafe values', () => {
  for (const mutate of [c => c.limits.maxTurns = 0, c => c.model = '', c => c.extra = 1, c => c.thinkingLevel = 'huge', c => c.limits.maxResponseCharacters = 100, c => c.limits.maxFileBytes = 1e12, c => c.effortScale.exponent = 0, c => c.effortScale.maximum.maxTurns = 10, c => c.defaults.effort = 11]) {
    const c = structuredClone(config); mutate(c); assert.throws(() => validateConfig(c));
  }
});
test('submission validation rejects malformed selections and preserves answer', () => {
  assert.deepEqual(validateSubmission({ text: ' x\n' }, config.limits), { text: ' x\n', excerpts: [] });
  for (const bad of [{ text: '' }, { text: 'x', excerpts: [{ path: 'f', start_line: 0 }] }, { text: 'x', excerpts: [{ path: 'f', start_line: 3, end_line: 2 }] }, { text: 'x', excerpts: [{ path: 'f', end_line: 1.5 }] }, { text: 'x', excerpts: [{ path: 'f', extra: 1 }] }, { text: 'x'.repeat(25000) }]) assert.throws(() => validateSubmission(bad, config.limits));
});
test('line selection preserves original CRLF, indentation, Unicode, EOF', () => {
  const text = 'α\r\n  "b"\r\nlast';
  assert.deepEqual(selectLines(text, { start_line: 2, end_line: 2 }), { text: '  "b"\r\n', start: 2, end: 2 });
  assert.equal(selectLines(text, {}).text, text);
  assert.equal(selectLines('a\n', {}).end, 1);
  assert.equal(selectLines('\n', {}).end, 1);
  assert.deepEqual(selectLines('', {}), { text: '', start: 0, end: 0 });
  for (const selection of [{ start_line: 0 }, { start_line: 4 }, { start_line: 3, end_line: 1 }, { end_line: 4 }]) assert.throws(() => selectLines(text, selection));
  assert.throws(() => selectLines('', { start_line: 1 }));
});
test('frames preserve text, avoid closing-tag collisions, never JSON/XML escape source', () => {
  const source = '</content>\n"x" & <b>\n</content_1>';
  const rendered = frame('content', source);
  assert(rendered.startsWith('<content_2>\n'));
  assert(rendered.includes(source));
  assert(!rendered.includes('\\n'));
  assert(!rendered.includes('&lt;'));
});
test('assembly uses one read per file and appends exact labeled content', async () => {
  let reads = 0;
  const source = 'one\n"two" & <three>\nlast';
  const result = await assembleResponse({ text: 'Answer\nwith details.', excerpts: [{ path: 'a', start_line: 2, end_line: 2 }, { path: 'a', start_line: 3 }] }, '/workspace', config.limits, undefined, async () => { reads++; return { text: source, captured: 'now', sha256: 'hash' }; });
  assert.equal(reads, 1);
  assert(result.text.includes('Answer\nwith details.'));
  assert(result.text.includes('Path: /workspace/a'));
  assert(result.text.includes('Lines: 2–2'));
  assert(result.text.includes('"two" & <three>\n'));
  assert.equal(result.warnings.length, 0);
});
test('excerpt errors are explicit, bounded, and do not discard answer', async () => {
  const result = await assembleResponse({ text: 'Kept.', excerpts: [{ path: 'absent' }, { path: 'oversized' }, { path: 'range', start_line: 50 }] }, '/', { ...config.limits, maxExcerptCharacters: 10 }, undefined, async path => {
    if (path.endsWith('absent')) throw new Error('Missing file');
    return { text: 'long text here\n', captured: 'now' };
  });
  assert.equal(result.warnings.length, 3);
  assert(result.text.includes('Kept.'));
  assert(!result.text.includes('<source_excerpt>'));
});
test('total response budget omits rather than silently truncates excerpts', async () => {
  const result = await assembleResponse({ text: 'answer', excerpts: [{ path: 'a' }] }, '/', { ...config.limits, maxResponseCharacters: 600 }, undefined, async () => ({ text: 'x'.repeat(500), captured: 'now' }));
  assert.equal(result.warnings.length, 1);
  assert(result.text.length <= 600);
});
test('bounded reads reject binary, invalid UTF-8, directories, and large files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-core-'));
  try {
    await writeFile(join(dir, 'text'), 'hello\r\n🌿');
    const result = await readBoundedText(join(dir, 'text'), 100);
    assert.equal(result.text, 'hello\r\n🌿'); assert.equal(result.sha256.length, 64);
    await writeFile(join(dir, 'binary'), Buffer.from([0, 1]));
    await writeFile(join(dir, 'invalid'), Buffer.from([255]));
    for (const file of ['binary', 'invalid']) await assert.rejects(readBoundedText(join(dir, file), 100));
    await assert.rejects(readBoundedText(dir, 100));
    await assert.rejects(readBoundedText(join(dir, 'text'), 2));
    const c = new AbortController(); c.abort(new Error('cancelled'));
    await assert.rejects(readBoundedText(join(dir, 'text'), 100, c.signal), /cancelled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('prompt extraction rejects missing, duplicate, reversed markers', () => {
  assert.throws(() => extractPrompt('no markers', 'WORKER'));
  assert.throws(() => extractPrompt('<!-- END INVESTIGATE WORKER PROMPT --><!-- BEGIN INVESTIGATE WORKER PROMPT -->', 'WORKER'));
});
test('semaphore is bounded, FIFO, abortable, and release is idempotent', async () => {
  const slots = createSemaphore(1);
  const release1 = await slots.acquire();
  const cancelled = new AbortController();
  const pending = slots.acquire(cancelled.signal);
  const pending2 = slots.acquire();
  assert.deepEqual(slots.stats(), { active: 1, queued: 2 });
  cancelled.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  release1(); release1();
  const release2 = await pending2;
  assert.deepEqual(slots.stats(), { active: 1, queued: 0 });
  release2(); assert.equal(slots.stats().active, 0);
});
test('usage sums each field without mutating input', () => {
  const zero = zeroUsage();
  const result = addUsage(zero, { input: 3, output: 4, totalTokens: 7, cost: { total: 0.1 } });
  assert.equal(zero.input, 0); assert.equal(result.input, 3); assert.equal(result.cost.total, 0.1);
});
