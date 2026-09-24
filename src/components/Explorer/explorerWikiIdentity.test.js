import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Wikipedia block of an OpenAlex entity used to come from a free-text
// search that kept its first hit: in the Spanish UI "Tumor progression" showed
// a cancer researcher's portrait and "Medicine" a Shakira single (audit of
// 2026-09-23). The lookup rules live in `loadEntityWikiInfo` and are tested
// in `wikiService.test.js`; this file pins that the Explorer goes through it.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

const source = stripComments(readFileSync(new URL('./EntityExplorer.jsx', import.meta.url), 'utf8'));

test('the Explorer loads its Wikipedia block through the identity-aware loader', () => {
  const effect = bounded(source, 'if (!canLoadWikiInfo) {', 'setSettledWikiRequestKey(wikiRequestKey)', 'the Wikipedia effect', 60);
  assert.match(
    effect,
    /loadEntityWikiInfo\(\{\s*entity: wikiEntity,\s*title: entityDisplayName,\s*alternateTitle,\s*language,\s*signal: controller\.signal,\s*\}\)/,
  );
  assert.doesNotMatch(source, /getEntityWikiInfo\(/);
});

test('the lookup is keyed on the identity fields, not on the entity object', () => {
  const memo = bounded(source, 'const wikiEntity = useMemo(', ');', 'the wiki identity memo', 8);
  assert.match(
    memo,
    /_queryTopic: entityIsQueryTopic,\s*_localTopic: entityIsLocalTopic,\s*ids: \{ wikidata: entityWikidataId, wikipedia: entityWikipediaUrl \},\s*\}\), \[entityIsLocalTopic, entityIsQueryTopic, entityWikidataId, entityWikipediaUrl\]/,
  );
});

test('a paragraph in another language than the interface says which one', () => {
  assert.match(
    source,
    /<p\s+key=\{visibleWikiInfo\?\.extract \? 'wiki' : 'fallback'\}\s+ref=\{wikiDescriptionTextRef\}\s+lang=\{wikiDescriptionLanguage !== language \? wikiDescriptionLanguage : undefined\}/,
  );
});
