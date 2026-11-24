import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AI_USES_PER_DAY,
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
const idsWith = (allowance: HelpAllowance) => entries.filter(({ entry }) => entry.allowance === allowance).map(({ entry }) => entry.id);

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

test('the per-day limits are the ones wrangler.toml sets for the Worker', () => {
  const config = readFileSync(new URL('../../../wrangler.toml', import.meta.url), 'utf8');
  const setting = (name: string) => Number(new RegExp(`^${name}\\s*=\\s*"(\\d+)"`, 'm').exec(config)?.[1]);
  assert.equal(AI_USES_PER_DAY, setting('AI_DAILY_USER_LIMIT'));
  assert.equal(LIST_PUBLISHES_PER_DAY, setting('PUBLIC_LIST_USER_DAILY_LIMIT'));
  assert.match(HELP_OVERVIEW, new RegExp(`${AI_USES_PER_DAY} AI uses a day, renewing at 00:00 UTC`));
  assert.match(HELP_OVERVIEW, /Without an account there is no AI/);
  assert.match(text('publish'), new RegExp(`${LIST_PUBLISHES_PER_DAY} a day`));
});

test('the controls marked as spending an AI use are the five the overview names', () => {
  const spenders = [...idsWith('ai'), ...idsWith('ai-new')];
  assert.deepEqual(spenders.toSorted(), ['explain', 'level', 'plain-words', 'retry', 'write-again']);
  assert.match(HELP_OVERVIEW, /Five things spend one:/);
  assert.equal(allowanceOf('plain-words'), 'ai-new', 'a version already written opens free');
  assert.equal(allowanceOf('write-again'), 'ai');
  assert.equal(allowanceOf('explain'), 'ai');
});

test('the retry row lists the failures that give the use back and the ones that do not', () => {
  const refund = text('retry');
  assert.match(refund, /busy or unavailable/);
  assert.match(refund, /cannot be downloaded/);
  assert.match(refund, /provider’s own daily limit/);
  assert.match(refund, /not given back after a timeout or an empty or unusable answer/);
  assert.doesNotMatch(refund, /fails because of the service gives its AI use back/);
});

test('publishing and stopping to share always count toward the daily limit', () => {
  assert.deepEqual(idsWith('publish'), ['publish', 'stop-sharing']);
});

test('every control that can change a public list says it counts only when the list is public, and a note edit does not', () => {
  assert.deepEqual(idsWith('publish-if-public').toSorted(), ['delete-list', 'edit-list', 'hold-save', 'new-list', 'remove-paper', 'save']);
  assert.match(text('save'), /Taking the paper out of a public list, or adding it to one from the picker, updates that list’s public copy/);
  assert.match(text('save'), new RegExp(`${LIST_PUBLISHES_PER_DAY} public-list changes a day`));
  assert.match(text('new-list'), /Choosing Public publishes the list at once, which counts/);
  assert.match(HELP_ALLOWANCE_RULES['publish-if-public'], /^Free on a private list\./);
  assert.equal(allowanceOf('edit-note'), 'free', 'notes and tags are not in a public list’s copy');
  assert.match(text('delete-list'), /cannot be deleted until it resets/);
});

test('Read article lists every target it tries, in order, and which of them open in the viewer or a new tab', () => {
  const read = text('read');
  assert.match(read, /First, your university’s library, if you linked one and it has the paper: a new tab./);
  assert.match(read, /full text PaperTok finds for the paper, shown in PaperTok’s viewer/);
  assert.match(read, /Only a link on arxiv.org opens in PaperTok’s viewer; every other one, a repository PDF included, opens in a new tab/);
  assert.match(read, /open copy found for the paper \(its PDF, then its page\), the paper’s open-access PDF, its arXiv PDF, its own PDF link, a ChemRxiv page, and its landing page/);
  assert.match(read, /last resort opens the DOI page in a new tab/);
});

test('Filters keeps the sort order apart from the three filters that get chips and that Reset clears', () => {
  const filters = text('filters');
  assert.match(filters, /three filters and a sort order/);
  assert.match(filters, /Reset clears the three filters and closes the panel/);
  assert.match(filters, /On a screen wider than 768px the Filters button also counts them/);
  assert.match(filters, /Sort by, Most cited or Most recent, is set in the same panel but is not a filter: it has no chip, it is not counted, and Reset leaves it as it is/);
});

test('the Settings section says how to reach Settings from an account and that a visitor has none', () => {
  const settings = HELP_SECTIONS.find(section => section.id === 'settings');
  assert.ok(settings?.signedInOnly);
  assert.match(settings.intro, /^Reached from the account menu: your picture or initial, at the right end of the top bar. Only an account has Settings; a visitor does not\./);
  assert.doesNotMatch(settings.intro, /beside this one/);
});

test('the gestures that exist only in the signed-in feed and its bar say they need an account', () => {
  for (const id of ['swipe-tabs', 'pull-refresh', 'arrow-keys', 'tab-menu', 'search-key']) {
    assert.equal(entries.find(({ entry }) => entry.id === id)?.entry.needsAccount, true, id);
  }
});

test('the trial number is a link and the study-type label is information only', () => {
  assert.match(text('trial-number'), /ClinicalTrials\.gov number\. It is a link: it opens that study on ClinicalTrials\.gov in a new tab\./);
  assert.match(text('study-type'), /Randomized controlled trial, Systematic review, Meta-analysis or Practice guideline/);
  assert.match(text('study-type'), /information only: not a button and not a link/);
});

test('the controls that only show or hide something are marked free', () => {
  for (const id of ['ai-highlights', 'annotations', 'viewer-notes', 'contents', 'like']) {
    assert.equal(allowanceOf(id), 'free', id);
  }
});

test('each allowance has a distinct stamp and a rule for the legend', () => {
  const allowances = Object.keys(HELP_ALLOWANCE_RULES) as HelpAllowance[];
  assert.equal(allowances.length, 5);
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
