import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiti } from './jiti.mjs';
const { parseAddressed, commandCompletion, applyCommand, statusText } = await jiti.import('../src/addressed.ts');

test('addressed commands reserve only a leading command-shaped word', () => {
  for (const command of ['stop', 'stopp', 'status']) assert.equal(parseAddressed(`@name /${command}`).command, command);
  assert.match(parseAddressed('@name /stpo').error, /Unknown/);
  assert.match(parseAddressed('@name /stop extra').error, /Usage/);
  for (const text of ['/Users/ulf/dev is here', 'please explain /stop', '/stop.txt', '/stop/']) assert.equal(parseAddressed(`@name ${text}`).kind, 'message');
  assert.equal(parseAddressed('ordinary'), undefined);
});
test('command completion is scoped, preserves suffix, and falls back outside its domain', () => {
  const names = ['name_one', 'name_two'];
  assert.deepEqual(commandCompletion(['@name_one /'], 0, 11, names).items.map(i => i.value), ['/stop', '/stopp', '/status']);
  for (const text of ['@name /', '@unknown /', '@name_one /Users/x', '@name_one hello /', '@name_one /zzz']) assert.equal(commandCompletion([text], 0, text.length, names), undefined);
  assert.equal(commandCompletion(['@name_one /'], 1, 11, names), undefined);
  assert.deepEqual(applyCommand(['@name_one /st suffix', 'more'], 13, '/stop', '/st'), { lines: ['@name_one /stop suffix', 'more'], cursorLine: 0, cursorCol: 16 });
  assert.match(statusText('n'), /not running/);
});
