import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the comments kill switch is the shared Checkbox, named by a Label that points at it', async () => {
  const jsx = stripComments(await readFile(new URL('./ModerationPage.jsx', import.meta.url), 'utf8'));
  assert.match(jsx, /import \{ Checkbox \} from '\.\.\/ui\/checkbox\.jsx'/);
  assert.match(jsx, /import \{ Label \} from '\.\.\/ui\/label\.jsx'/);
  assert.doesNotMatch(jsx, /type="checkbox"/);
  assert.match(jsx, /<Checkbox id=\{killswitchId\} checked=\{frozen\} onCheckedChange=\{toggleFreeze\} \/>/);
  assert.match(jsx, /<Label htmlFor=\{killswitchId\}>/);
  const css = stripComments(await readFile(new URL('./ModerationPage.css', import.meta.url), 'utf8'));
  assert.doesNotMatch(css, /accent-color/);
  assert.match(css, /\.moderation-killswitch label\s*\{/);
});
