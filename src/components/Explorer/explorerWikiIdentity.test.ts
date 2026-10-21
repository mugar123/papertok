import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Wikipedia block of an OpenAlex entity used to come from a free-text
// search that kept its first hit: in the Spanish UI "Tumor progression" showed
// a cancer researcher's portrait and "Medicine" a Shakira single (audit of
// 2026-09-23). The lookup rules live in `loadEntityWikiInfo` and are tested
// in `wikiService.test.ts`; this file pins that the Explorer goes through it.
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code: string, from: string, to: string, label: string, maxLines: number) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

const source = stripComments(readFileSync(new URL('./EntityExplorer.tsx', import.meta.url), 'utf8'));

test('the Explorer loads its Wikipedia block through the identity-aware loader', () => {
  const effect = bounded(source, 'if (!canLoadWikiInfo) {', 'setSettledWikiRequestKey(wikiRequestKey)', 'the Wikipedia effect', 60);
  assert.match(
    effect,
    /loadEntityWikiInfo\(\{\s*entity: wikiEntity,\s*title: entityDisplayName,\s*signal: controller\.signal,\s*\}\)/,
  );
  assert.doesNotMatch(source, /getEntityWikiInfo\(/);
});

