import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HELP_ALLOWANCE_RULES,
  HELP_OVERVIEW,
  HELP_SECTIONS,
  LIST_PUBLISHES_PER_DAY,
  aiUsesLine,
  allowanceLabel,
  type HelpAllowance,
} from './help-guide.ts';

const entries = HELP_SECTIONS.flatMap(section => section.entries.map(entry => ({ section, entry })));
const text = (id: string) => entries.find(({ entry }) => entry.id === id)?.entry.what ?? '';
const allowanceOf = (id: string) => entries.find(({ entry }) => entry.id === id)?.entry.allowance;

test('every section and every control has its own id, a name and a sentence', () => {
  const sectionIds = HELP_SECTIONS.map(section => section.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);
  const entryIds = entries.map(({ entry }) => entry.id);
  assert.equal(new Set(entryIds).size, entryIds.length);
  for (const section of HELP_SECTIONS) {
    assert.ok(section.title.trim() && section.intro.trim(), `${section.id} has a title and an intro`);
    assert.ok(section.entries.length > 0, `${section.id} lists something`);
  }
  for (const { entry } of entries) {
    assert.ok(entry.name.trim(), `${entry.id} has a name`);
    assert.ok(entry.what.trim().endsWith('.'), `${entry.id} says what it does in a sentence`);
  }
});

test('each glyph the page shows draws an svg, so a row never shows an empty tile', () => {
  const drawn = entries.flatMap(({ entry }) => (entry.icon && entry.icon !== 'zotero' ? [entry] : []));
  assert.ok(drawn.length > 30);
  for (const entry of drawn) {
    const Glyph = entry.icon;
    assert.ok(typeof Glyph !== 'string' && Glyph, `${entry.id} has a component`);
    assert.match(renderToStaticMarkup(createElement(Glyph, { size: 20, 'aria-hidden': true })), /^<svg[^>]*aria-hidden="true"/, entry.id);
  }
});

test('the public-list limit is the one wrangler.toml sets for the Worker', () => {
  const config = readFileSync(new URL('../../../wrangler.toml', import.meta.url), 'utf8');
  const limit = Number(/^PUBLIC_LIST_USER_DAILY_LIMIT\s*=\s*"(\d+)"/m.exec(config)?.[1]);
  assert.equal(LIST_PUBLISHES_PER_DAY, limit);
  assert.match(text('publish'), new RegExp(`${limit} a day`));
});

test('the controls marked as spending an AI use are the five the overview names', () => {
  const spenders = entries.filter(({ entry }) => entry.allowance === 'ai' || entry.allowance === 'ai-new').map(({ entry }) => entry.id);
  assert.deepEqual(spenders.toSorted(), ['explain', 'level', 'plain-words', 'retry', 'write-again']);
  assert.match(HELP_OVERVIEW, /Five things spend one:/);
  assert.equal(allowanceOf('plain-words'), 'ai-new', 'a version already written opens free');
  assert.equal(allowanceOf('write-again'), 'ai');
  assert.equal(allowanceOf('explain'), 'ai');
});

test('the controls that change a list, which updates a public one, are marked as counting toward the daily limit', () => {
  const counted = entries.filter(({ entry }) => entry.allowance === 'publish').map(({ entry }) => entry.id);
  assert.deepEqual(counted, ['publish', 'stop-sharing', 'edit-list', 'delete-list', 'edit-note', 'remove-paper']);
});

test('the controls that only show or hide something are marked free', () => {
  for (const id of ['ai-highlights', 'annotations', 'viewer-notes', 'contents', 'like', 'save']) {
    assert.equal(allowanceOf(id), 'free', id);
  }
});

test('a section behind sign-in does not mark each control as needing an account', () => {
  assert.ok(HELP_SECTIONS.find(section => section.id === 'reader')?.signedInOnly);
  assert.ok(!HELP_SECTIONS.find(section => section.id === 'card')?.signedInOnly);
});

test('each allowance has a distinct stamp and a rule for the legend', () => {
  const allowances: HelpAllowance[] = ['free', 'ai', 'ai-new', 'publish'];
  assert.equal(new Set(allowances.map(allowanceLabel)).size, allowances.length);
  for (const allowance of allowances) assert.ok(HELP_ALLOWANCE_RULES[allowance].endsWith('.'));
  assert.equal(allowanceLabel('free'), 'Free');
});

test('the uses line gives the count and the reset time, and stays silent when it cannot', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const uses = { remainingUses: 7, dailyLimit: 10, resetAt: '2026-11-21T00:00:00Z' };
  assert.match(aiUsesLine(uses, 'en-US', now), /^You have 7 of 10 AI uses left today\. They reset at \d{1,2}:\d{2}\s?(AM|PM)\.$/);
  assert.match(aiUsesLine({ ...uses, remainingUses: 0 }, 'en-US', now), /^You have 0 of 10 AI uses left today\./);
  assert.equal(aiUsesLine(null, 'en-US', now), '');
  assert.equal(aiUsesLine({ ...uses, unlimited: true }, 'en-US', now), '');
  assert.equal(aiUsesLine({ ...uses, dailyLimit: null }, 'en-US', now), '');
  assert.equal(aiUsesLine({ remainingUses: 7, dailyLimit: 10 }, 'en-US', now), '');
  assert.equal(aiUsesLine({ ...uses, resetAt: '2026-11-20T11:00:00Z' }, 'en-US', now), '', 'a reset already past says nothing');
  assert.equal(aiUsesLine({ ...uses, resetAt: 'tomorrow' }, 'en-US', now), '');
});
