import test from 'node:test';
import assert from 'node:assert/strict';
import { paperActions } from './paper-actions.ts';
import type { Paper } from '../../models/paper.ts';
import type { ReaderCard } from './paper-menu.tsx';

const paper = { id: 'arxiv:2401.00001', title: 'A paper' } as Paper;
const handlers = { paper, isRead: false, onAbout: () => {}, onToggleRead: () => {}, onNotInterested: () => {} };
const skipHint = (actions: ReturnType<typeof paperActions>) => actions.find(action => action.id === 'skip')?.hint;

test('"Not interested" promises fewer papers like it unless the feed gives its own hint', () => {
  assert.equal(skipHint(paperActions(handlers)), 'See fewer papers like this');
  assert.equal(skipHint(paperActions({ ...handlers, notInterestedHint: 'Remove it from this feed' })), 'Remove it from this feed');
});

test('the reader passes the card\'s hint on; a card without one keeps the account\'s', () => {
  const card: Pick<ReaderCard, 'notInterestedHint'> = {};
  assert.equal(skipHint(paperActions({ ...handlers, notInterestedHint: card.notInterestedHint })), 'See fewer papers like this');
  const custom: Pick<ReaderCard, 'notInterestedHint'> = { notInterestedHint: 'Remove it from this feed' };
  assert.equal(skipHint(paperActions({ ...handlers, notInterestedHint: custom.notInterestedHint })), 'Remove it from this feed');
});

test('Send to Zotero, when the reader has it, sits after Not interested and before the citation exports', () => {
  const zotero = { id: 'zotero', label: 'Send to Zotero', hint: 'Adds it to your library', Icon: () => null, onSelect: () => {} };
  assert.deepEqual(paperActions({ ...handlers, zotero }).map(action => action.id), ['about', 'read', 'skip', 'zotero', 'bibtex', 'ris']);
  assert.deepEqual(paperActions(handlers).map(action => action.id), ['about', 'read', 'skip', 'bibtex', 'ris']);
});
