import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EFFORT_FIELDS, exactKeys, nonblank, positive, extractPrompt, limitsForEffort } from './core.mjs';

export function validateConfig(c) {
  exactKeys(c, ['provider', 'model', 'thinkingLevel', 'instructionsFile', 'parentPromptFile', 'repositoryMapFile', 'defaults', 'tools', 'limits', 'effortScale', 'handoff'], 'config');
  for (const key of ['provider', 'model', 'instructionsFile', 'parentPromptFile', 'repositoryMapFile']) nonblank(c[key], key);
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(c.thinkingLevel)) throw new Error('Invalid thinkingLevel');
  exactKeys(c.defaults, ['detail', 'includeReferences', 'effort'], 'defaults');
  if (!['brief', 'standard', 'detailed'].includes(c.defaults.detail) || typeof c.defaults.includeReferences !== 'boolean' || !Number.isSafeInteger(c.defaults.effort) || c.defaults.effort < 0 || c.defaults.effort > 10) throw new Error('Invalid defaults');
  if (c.handoff !== undefined) {
    exactKeys(c.handoff, ['timeoutSeconds', 'maxOutputTokens'], 'handoff');
    positive(c.handoff.timeoutSeconds, 'handoff.timeoutSeconds');
    positive(c.handoff.maxOutputTokens, 'handoff.maxOutputTokens');
    if (c.handoff.timeoutSeconds > 300 || c.handoff.maxOutputTokens > 32768) throw new Error('Unsafe handoff limit');
  }
  exactKeys(c.tools, ['allowBash'], 'tools');
  if (typeof c.tools.allowBash !== 'boolean') throw new Error('allowBash must be boolean');
  const keys = ['maxConcurrentInvestigations', 'maxTurns', 'timeoutSeconds', 'maxRequestCharacters', 'maxAnswerCharacters', 'maxExcerpts', 'maxExcerptCharacters', 'maxResponseCharacters', 'maxFileBytes'];
  exactKeys(c.limits, keys, 'limits');
  for (const key of keys) positive(c.limits[key], key);
  if (c.limits.timeoutSeconds > 86400 || c.limits.maxFileBytes > 64 * 1024 * 1024 || c.limits.maxConcurrentInvestigations > 32) throw new Error('Unsafe operational limit');
  exactKeys(c.effortScale, ['exponent', 'minimum', 'maximum'], 'effortScale');
  if (typeof c.effortScale.exponent !== 'number' || !Number.isFinite(c.effortScale.exponent) || c.effortScale.exponent < 1 || c.effortScale.exponent > 3) throw new Error('effortScale.exponent must be between 1 and 3');
  for (const endpoint of ['minimum', 'maximum']) {
    const values = c.effortScale[endpoint];
    exactKeys(values, EFFORT_FIELDS, `effortScale.${endpoint}`);
    for (const key of EFFORT_FIELDS) {
      positive(values[key], `${endpoint}.${key}`);
      if ((endpoint === 'minimum' && values[key] > c.limits[key]) || (endpoint === 'maximum' && values[key] < c.limits[key])) throw new Error(`effortScale.${endpoint}.${key} must bracket the effort-4 limit`);
    }
  }
  if (c.effortScale.maximum.timeoutSeconds > 86400) throw new Error('Unsafe operational limit');
  for (let effort = 0; effort <= 10; effort++) {
    const limits = limitsForEffort(c, effort);
    if (limits.maxResponseCharacters < limits.maxAnswerCharacters + limits.maxExcerpts * 180 + 300) throw new Error(`effort ${effort}: maxResponseCharacters needs space for answer and omission warnings`);
  }
  return structuredClone(c);
}

export function stripDocumentMetadata(text) {
  return text.replace(/^(?:\uFEFF)?(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/, '');
}

export async function loadWorkerContext(root, config) {
  const read = async key => {
    const text = await readFile(resolve(root, config[key]), 'utf8');
    if (text.length > 64000) throw new Error(`${key} exceeds 64000 characters`);
    return text;
  };
  const [worker, overview] = await Promise.all([read('instructionsFile'), read('repositoryMapFile')]);
  return {
    workerPrompt: extractPrompt(worker, 'WORKER'),
    repositoryMap: nonblank(stripDocumentMetadata(overview), 'repository overview'),
  };
}

export async function loadConfig(root) {
  const defaults = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
  let local = {};
  try {
    local = JSON.parse(await readFile(resolve(root, 'config.local.json'), 'utf8'));
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('config.local.json must be an object');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Deliberately shallow: nested sections must be supplied in full.
  const config = validateConfig({ ...defaults, ...local });
  async function document(key) {
    const text = await readFile(resolve(root, config[key]), 'utf8');
    if (text.length > 64000) throw new Error(`${key} exceeds 64000 characters`);
    return text;
  }
  const [workerContext, parent] = await Promise.all([loadWorkerContext(root, config), document('parentPromptFile')]);
  return { config, ...workerContext, parentPrompt: extractPrompt(parent, 'PARENT') };
}
