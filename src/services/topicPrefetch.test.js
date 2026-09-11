import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { topicWikiRequest } from './topicPrefetch.js';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('a local topic asks for the same titles the explorer will, in the reader language', () => {
  const es = topicWikiRequest({ type: 'topic', id: 'math.NT' }, 'es');
  const en = topicWikiRequest({ type: 'topic', id: 'math.NT' }, 'en');
  assert.ok(es && en);
  assert.equal(es.language, 'es'); assert.equal(en.language, 'en');
  assert.notEqual(es.title, '', 'the local area knows its name without a request');
  assert.equal(en.alternateTitle, es.title, 'in English the Spanish label is the alternate, as in the explorer');
  assert.equal(es.strictTitleMatch, false);
});

test('a query topic is strict, like the explorer; a non-topic is nothing', () => {
  const q = topicWikiRequest({ type: 'concept', id: 'q1', display_name: 'Adversarial ML', _queryTopic: true }, 'en');
  assert.equal(q.title, 'Adversarial ML'); assert.equal(q.strictTitleMatch, true);
  assert.equal(topicWikiRequest({ type: 'author', id: 'A1', display_name: 'X' }, 'en'), null);
  assert.equal(topicWikiRequest(null, 'en'), null);
});

test('SOURCE: the request mirrors EntityExplorer\'s call, argument for argument', async () => {
  const explorer = strip(await read('../components/Explorer/EntityExplorer.jsx'));
  const call = explorer.slice(explorer.indexOf('getEntityWikiInfo({'), explorer.indexOf('}).then', explorer.indexOf('getEntityWikiInfo({')));
  for (const arg of ['title:', 'alternateTitle', 'language', 'strictTitleMatch']) assert.match(call, new RegExp(arg), `explorer passes ${arg}`);
  const alternate = explorer.slice(explorer.indexOf("const alternateTitle = language === 'en'"), explorer.indexOf('getEntityWikiInfo({'));
  assert.match(alternate, /localizedTopicEntity\?\.labelEs[\s\S]*localizedTopicEntity\?\.labelEn/, 'en → labelEs, es → labelEn; the prefetch does the same');
});

test('SOURCE: the card warms the topic on pointer enter and again on the click, before navigating', async () => {
  const card = strip(await read('../components/Feed/PaperCard.jsx'));
  assert.equal((card.match(/onPointerEnter=\{\(\) => warmTopic\(/g) || []).length, 2, 'both pill sites');
  const open = card.slice(card.indexOf('const openTopic = useCallback('), card.indexOf('}, [analyticsSurface, navigate, position, publicMode, trackEvent, warmTopic]);'));
  assert.ok(open.indexOf('warmTopic(topic);') < open.indexOf('navigate(path)'), 'warm first, navigate after');
});
