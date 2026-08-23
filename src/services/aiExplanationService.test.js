import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIExplanationServiceError,
  canExplainPaper,
  formatAIModelLabel,
  hasUsableAbstract,
  serializePaperForExplanation,
  toServiceError,
} from './aiExplanationService.js';
import { WorkerApiAuthError } from './workerApiClient.js';

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

test('hides AI explanations for a closed paper without an abstract', () => {
  const paper = { openAccess: false, abstract: 'No abstract available.' };

  assert.equal(hasUsableAbstract(paper), false);
  assert.equal(canExplainPaper(paper), false);
});

test('keeps AI explanations for papers with an abstract or open full text', () => {
  assert.equal(canExplainPaper({ openAccess: false, abstract: 'A real abstract.' }), true);
  assert.equal(canExplainPaper({ openAccess: true, abstract: 'Resumen no disponible.', pdfUrl: 'https://arxiv.org/pdf/2607.12345' }), true);
  assert.equal(canExplainPaper({ openAccess: true, abstract: 'Resumen no disponible.', pdfUrl: 'https://example.org/open.pdf' }), false);
});

test('formats the configured AI model for the explanation metadata', () => {
  assert.equal(formatAIModelLabel('gemini-3.5-flash'), 'Gemini 3.5 Flash');
  assert.equal(formatAIModelLabel('moonshotai/Kimi-K3', 'modal-kimi'), 'Kimi K3 · Modal');
  assert.equal(formatAIModelLabel(''), 'Modelo de IA');
});

test('tells an expired session apart from a broken AI service', () => {
  // The sheet has copy for AI_AUTH_REQUIRED and hides the retry button for it:
  // reporting «AI unavailable» sent the reader to retry a request that could
  // only work after signing in again.
  assert.equal(toServiceError(new WorkerApiAuthError()).code, 'AI_AUTH_REQUIRED');
  assert.equal(
    toServiceError({ name: 'FirebaseError', code: 'auth/user-token-expired' }).code,
    'AI_AUTH_REQUIRED',
  );
  // A worker origin that is not allowed is configuration, not a session.
  assert.equal(
    toServiceError(new WorkerApiAuthError('WORKER_ORIGIN_NOT_ALLOWED')).code,
    'AI_NOT_CONFIGURED',
  );
  assert.equal(toServiceError({ name: 'AbortError' }).code, 'AI_TIMEOUT');
  assert.equal(toServiceError(new TypeError('Failed to fetch')).code, 'AI_UNAVAILABLE');
});

test('never rewrites an error the worker already classified', () => {
  const original = new AIExplanationServiceError('AI_QUOTA_EXHAUSTED', 'AI_QUOTA_EXHAUSTED', { scope: 'user' });

  assert.equal(toServiceError(original), original);
  assert.deepEqual(toServiceError(original).quota, { scope: 'user' });
});
