import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiti } from './jiti.mjs';

const { delta, loadAgents, AGENT_ENTRY } = await jiti.import('../src/persist.ts');

const u = n => `🍃-${String(n).padStart(20, '0')}`;
const entry = n => ({ __type: 'ET.HostInstruction', __uid: u(n), content: `e${n}`, timestamp: n });
const agent = (uid, entries) => ({ __type: 'ET.InvestigationAgent', __uid: uid, context_: entries });
const saved = data => ({ type: 'custom', customType: AGENT_ENTRY, data });

test('deltas hold only what the session does not have yet', () => {
  const a = agent(u(0), [entry(1), entry(2), entry(3)]);
  assert.deepEqual(delta(a, 0), { uid: u(0), from: 0, entries: [entry(1), entry(2), entry(3)] });
  assert.deepEqual(delta(a, 2), { uid: u(0), from: 2, entries: [entry(3)] });
  assert.equal(delta(a, 3), undefined);
});

test('loading concatenates deltas in order, skips inconsistent ones, and orders by last save', () => {
  const entries = [
    saved({ uid: u(0), from: 0, entries: [entry(1)] }),
    saved({ uid: u(9), from: 0, entries: [entry(5)] }),
    { type: 'message', message: {} },
    saved({ uid: u(0), from: 1, entries: [entry(2)] }),
    saved({ uid: u(0), from: 5, entries: [entry(7)] }),   // does not continue the record
    { type: 'custom', customType: 'other', data: { uid: u(0), from: 2, entries: [entry(8)] } },
  ];
  const agents = loadAgents(entries);
  assert.deepEqual(agents.map(a => a.__uid), [u(9), u(0)]);
  assert.deepEqual(agents[1], agent(u(0), [entry(1), entry(2)]));
  assert.deepEqual(loadAgents([]), []);
});
