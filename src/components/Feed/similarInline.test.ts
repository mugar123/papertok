import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE: Similar takes the abstract\'s place in the slot, one face at a time', async () => {
  const card = await read('./PaperCard.tsx');
  assert.match(card, /const similarInline = similarOpen && !relatedInline;/);
  assert.match(card, /const slotAway = relatedInline \|\| similarInline;/);
  assert.match(card, /\) : similarInline \? \(\s*<motion\.div\s+key="similar"/, 'a face of the slot, mounted only while open');
  assert.match(card, /if \(next\) \{\s*setSimilarOpen\(false\);\s*openRelated\(\);/, 'opening the graph closes Similar');
  assert.match(card, /if \(!similarOpen\) setShowRelated\(false\);/, 'opening Similar closes the graph');
});
