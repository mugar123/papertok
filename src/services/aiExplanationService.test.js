import test from 'node:test';
import assert from 'node:assert/strict';
import { serializePaperForExplanation } from './aiExplanationService.js';

test('serializes only the scientific fields required by the AI backend', () => {
  const result = serializePaperForExplanation({
    id: 'paper-1',
    title: 'A paper',
    abstract: 'An abstract',
    authors: [{ name: 'Ada' }],
    arxivId: '2401.12345v2',
    concepts: [{ display_name: 'Cosmology' }],
    privateNotes: 'must never leave the browser',
    tags: ['private'],
  });

  assert.equal(result.pdfUrl, 'https://arxiv.org/pdf/2401.12345.pdf');
  assert.deepEqual(result.concepts, [{ name: 'Cosmology' }]);
  assert.equal('privateNotes' in result, false);
  assert.equal('tags' in result, false);
});

test('does not send a subscription-only PDF to the backend', () => {
  const result = serializePaperForExplanation({
    id: 'paper-2',
    title: 'Closed paper',
    abstract: 'Abstract',
    pdfUrl: 'https://publisher.example/closed.pdf',
    openAccess: false,
  });

  assert.equal(result.pdfUrl, '');
});
