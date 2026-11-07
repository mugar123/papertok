import test from 'node:test';
import assert from 'node:assert/strict';
import { openPdf } from './open-pdf.ts';

const pdf = (firstPage: () => Promise<{ width: number; height: number }>) => ({
  getPage: async () => {
    const size = await firstPage();
    return { getViewport: () => size };
  },
});

test('a readable PDF opens with its first page ratio', async () => {
  const doc = pdf(async () => ({ width: 100, height: 150 }));
  assert.deepEqual(await openPdf(Promise.resolve(doc)), { doc, ratio: 1.5 });
});

test('a first page that fails to load keeps the document, with no ratio', async () => {
  const doc = pdf(() => Promise.reject(new Error('bad page')));
  assert.deepEqual(await openPdf(Promise.resolve(doc)), { doc, ratio: null });
});

test('a document that cannot be read is unavailable', async () => {
  assert.equal(await openPdf(Promise.reject(new Error('not a PDF'))), null);
});
