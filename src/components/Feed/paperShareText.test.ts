import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The card's share button, read as source (convention ce139ce: comments
// stripped, a bounded slice, the pieces bound in one contiguous pattern).
// What it must send is covered by `paperShareData` in shareLink.test.ts;
// this pins that the button sends it.

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the card shares its paper with the title as text, through its own panel', async () => {
  const card = stripComments(await readFile(new URL('./PaperCard.tsx', import.meta.url), 'utf8'));
  assert.doesNotMatch(card, /navigator\.share\(/, 'the system share sheet no longer opens from the card');
  assert.match(card, /<SharePanel\s+title=\{paper\.title\}\s+url=\{shareUrl\}\s+onShared=\{handleShared\}/);
  const panel = stripComments(await readFile(new URL('./SharePanel.tsx', import.meta.url), 'utf8'));
  assert.match(panel, /const \{ text = '' \} = paperShareData\(\{ title, url \}\);/);
});

test('every share the panel reports is a method the analytics allowlist keeps', async () => {
  const card = await readFile(new URL('./PaperCard.tsx', import.meta.url), 'utf8');
  const service = await readFile(new URL('../../services/analyticsService.ts', import.meta.url), 'utf8');
  const allowed = new Set(service.match(/method: new Set\(\[([^\]]+)\]\)/)![1].match(/'([^']+)'/g)!.map((v) => v.slice(1, -1)));
  const reported = card.match(/const reported = [^;]+;/)?.[0] || '';
  const values = (reported.match(/\? '([^']+)' : '([^']+)'/) || []).slice(1);
  assert.equal(values.length, 2, 'the card maps every panel method onto one of two values');
  for (const value of values) assert.ok(allowed.has(value), `${value} is in the method allowlist`);
  assert.match(card, /trackEvent\('share', \{ method: reported,/);
});
