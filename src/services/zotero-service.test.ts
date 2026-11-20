import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { takePendingZoteroSend, zoteroCitation } from './zotero-service.ts';

const paper = (fields: Partial<Paper> & Pick<Paper, 'id' | 'title'>): Paper => ({
  sources: { primary: 'arxiv', enrichedBy: [] }, abstract: '', authors: [], ...fields,
});

function withSession(value: unknown, run: () => void) {
  const store = new Map<string, string>([['papertok_zotero_pending', JSON.stringify(value)]]);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, removeItem: (key: string) => store.delete(key), setItem: (key: string, v: string) => store.set(key, v) },
  });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

test('files an arXiv paper without a journal as a preprint and sends the source abstract', () => {
  const citation = zoteroCitation(paper({
    id: 'arxiv:2501.00001', title: 'T', arxivId: '2501.00001', abstract: 'Source text.',
    authors: [{ name: 'Ada Lovelace' }, 'Alan Turing'], publishedDate: '2025-01-02T00:00:00Z',
  }));
  assert.equal(citation.preprint, true);
  assert.equal(citation.abstract, 'Source text.');
  assert.deepEqual(citation.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(citation.date, '2025-01-02');
  assert.equal(zoteroCitation(paper({ id: 'x', title: 'T', arxivId: '1', journal: 'Nature' })).preprint, false);
});

test('hands the queued send only to the account that queued it, once, and only to a path of this site', () => {
  const citation = zoteroCitation(paper({ id: 'x', title: 'T' }));
  const fresh = { uid: 'alice', citation, returnTo: '/feed', createdAt: Date.now() };
  withSession(fresh, () => {
    assert.equal(takePendingZoteroSend('bob'), null);
  });
  withSession(fresh, () => {
    assert.equal(takePendingZoteroSend('alice')?.returnTo, '/feed');
    assert.equal(takePendingZoteroSend('alice'), null);
  });
  withSession({ ...fresh, returnTo: '//evil.example/' }, () => {
    assert.equal(takePendingZoteroSend('alice')?.returnTo, '/');
  });
  withSession({ ...fresh, createdAt: Date.now() - 60 * 60 * 1000 }, () => {
    assert.equal(takePendingZoteroSend('alice'), null);
  });
});
