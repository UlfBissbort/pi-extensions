import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiti } from './jiti.mjs';

const { NAMES, pickName, resolveName, parseAddress, firstPart, addressToken, completeAddress, applyAddress } = await jiti.import('../src/names.ts');

test('the name list is unique, identifier-shaped, and prefix-free', () => {
  assert(NAMES.length >= 200);
  assert.equal(new Set(NAMES).size, NAMES.length);
  for (const name of NAMES) assert.match(name, /^[a-z]+(_[a-z]+)*$/);
  for (const a of NAMES) for (const b of NAMES) if (a !== b) assert(!b.startsWith(a), `${a} is a prefix of ${b}`);
});

test('names are never issued twice; numbered rounds follow once all are taken', () => {
  const pool = ['erasmus_the_learned', 'hume_the_candid'];
  const issued = new Set();
  const draws = [];
  for (let i = 0; i < 6; i++) { const name = pickName(pool, issued); issued.add(name); draws.push(name); }
  assert.equal(new Set(draws).size, 6);
  assert.deepEqual(draws.slice(0, 2).sort(), pool);
  assert.deepEqual(draws.slice(2, 4).sort(), ['erasmus_the_learned_2', 'hume_the_candid_2']);
  assert.deepEqual(draws.slice(4).sort(), ['erasmus_the_learned_3', 'hume_the_candid_3']);
});

test('running investigators get different first parts where possible', () => {
  const pool = ['louis_the_pious', 'louis_the_fat', 'kant_the_punctual'];
  for (let i = 0; i < 20; i++) assert.equal(pickName(pool, new Set(), new Set(['louis'])), 'kant_the_punctual');
  assert.equal(firstPart(pickName(pool, new Set(['kant_the_punctual']), new Set(['louis']))), 'louis', 'falls back when unavoidable');
});

test('an address resolves by exact name or unique prefix', () => {
  const names = ['richard_the_lionheart', 'erasmus_the_learned', 'erasmus_the_learned_2'];
  assert.deepEqual(resolveName('richard_the…', names), { kind: 'one', name: 'richard_the_lionheart' });
  assert.deepEqual(resolveName('richard_the...', names), { kind: 'one', name: 'richard_the_lionheart' });
  assert.deepEqual(resolveName('erasmus_the_learned', names), { kind: 'one', name: 'erasmus_the_learned' }, 'exact beats prefix');
  assert.deepEqual(resolveName('erasmus', names), { kind: 'ambiguous', names: ['erasmus_the_learned', 'erasmus_the_learned_2'] });
  assert.deepEqual(resolveName('nobody', names), { kind: 'none' });
  assert.deepEqual(parseAddress('@richard_the… do something different!'), { token: 'richard_the…', message: 'do something different!' });
  assert.deepEqual(parseAddress('@kant: check the tests\nand the docs'), { token: 'kant', message: 'check the tests\nand the docs' });
  assert.equal(parseAddress('email me @ home'), undefined);
  assert.equal(parseAddress('@kant'), undefined, 'an address without a message is ordinary input');
});

test('an address is completed only at the start of the message, matching any part of a name', () => {
  assert.equal(addressToken(['@kan'], 0, 4), 'kan');
  assert.equal(addressToken(['@'], 0, 1), '');
  assert.equal(addressToken(['hi @kan'], 0, 7), undefined);
  assert.equal(addressToken(['@kant x'], 0, 7), undefined, 'the address already ends');
  assert.equal(addressToken(['x', '@kan'], 1, 4), undefined);
  const c = [{ name: 'richard_the_lionheart', description: '' }, { name: 'kant_the_punctual', description: '' }];
  assert.deepEqual(completeAddress('lion', c).map(x => x.name), ['richard_the_lionheart']);
  assert.deepEqual(completeAddress('the', c).map(x => x.name), ['richard_the_lionheart', 'kant_the_punctual']);
  assert.deepEqual(completeAddress('', c).length, 2);
  assert.deepEqual(applyAddress(['@ri do this', 'next'], 3, 'richard_the_lionheart'),
    { lines: ['@richard_the_lionheart do this', 'next'], cursorLine: 0, cursorCol: 23 });
});
