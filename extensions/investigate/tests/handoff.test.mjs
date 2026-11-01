import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/config.mjs';
import { zeroUsage } from '../src/core.mjs';
import { jiti } from './jiti.mjs';
const { activityLog, handoffDetails, summaryText } = await jiti.import('../src/handoff.ts');
const { initRun, reduceRun } = await jiti.import('../src/run.ts');

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
test('handoff settings are bounded and nested overrides must be complete', () => {
  assert.deepEqual(validateConfig(config).handoff, { timeoutSeconds: 60, maxOutputTokens: 4096 });
  for (const handoff of [{}, { timeoutSeconds: 1 }, { timeoutSeconds: 301, maxOutputTokens: 100 }, { timeoutSeconds: 1, maxOutputTokens: 0 }, { timeoutSeconds: 1, maxOutputTokens: 32769 }, { timeoutSeconds: 1, maxOutputTokens: 100, model: 'other' }]) assert.throws(() => validateConfig({ ...config, handoff }));
});
test('hard stop escalates soft stop and a later hard stop cancels handoff, not a new research run', () => {
  const soft = { type: 'interrupted', reason: 'user_stopped', message: 'Stopped by the user' };
  const hard = { type: 'interrupted', reason: 'user_hard_stopped', message: 'Hard-stopped by the user' };
  let [state] = reduceRun({ ...initRun('r'), awaiting: 'model' }, soft);
  let commands;
  [state, commands] = reduceRun(state, hard);
  assert.equal(state.stop.reason, 'user_hard_stopped');
  assert.deepEqual(commands[0], { type: 'abort', stage: 'research' });
  assert.deepEqual(reduceRun(state, hard), [state, []]);
  state = { ...state, awaiting: 'handoff', phase: 'handing_off' };
  assert.deepEqual(reduceRun(state, soft), [state, []]);
  assert.deepEqual(reduceRun(state, hard)[1], [{ type: 'abort', stage: 'handoff' }]);
});
test('activity logs handle reused tool ids honestly and cache ratio uses total input, not uncached input alone', () => {
  const response = path => ({ __type: 'ET.LLMResponse', content: [{ type: 'toolCall', name: 'read', id: 'same', arguments: { path } }] });
  const agent = { context_: [
    { __type: 'ET.InvestigationRequest', request: { question: 'check two files' } },
    response('first'), { __type: 'ET.ToolResult', toolCallId: 'same', isError: false },
    response('second'), { __type: 'ET.RunEnded', reason: 'user_stopped' },
  ] };
  const log = activityLog(agent);
  assert.match(log, /first.*completed/);
  assert.match(log, /second.*not executed/);
  const usage = { ...zeroUsage(), input: 20, cacheRead: 80 };
  agent.context_.push({ __type: 'ET.Handoff', outcome: 'summary', usage });
  assert.equal(handoffDetails(agent).cacheReadRatio, 0.8);
  assert.equal(summaryText({ stopReason: 'aborted', content: [{ type: 'text', text: 'incomplete' }] }), undefined);
  assert.equal(summaryText({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash', arguments: {} }] }), undefined);
});
