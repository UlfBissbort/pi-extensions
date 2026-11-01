import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('local overrides are optional, validated, and shallow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'investigate-config-'));
  try {
    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    for (const key of ['instructionsFile', 'parentPromptFile', 'repositoryMapFile']) config[key] = join(root, config[key]);
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    assert.equal((await loadConfig(dir)).config.model, config.model);
    await writeFile(join(dir, 'config.local.json'), JSON.stringify({ provider: 'example', model: 'my-model', tools: { allowBash: false } }));
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.provider, 'example');
    assert.equal(loaded.config.model, 'my-model');
    assert.equal(loaded.config.tools.allowBash, false);
    assert.deepEqual(loaded.config.limits, config.limits);
    for (const invalid of ['null', '[]', '{', '{"unknown":true}', '{"limits":{}}']) {
      await writeFile(join(dir, 'config.local.json'), invalid);
      await assert.rejects(loadConfig(dir));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
