import test from 'node:test';
import assert from 'node:assert/strict';
import { authPromptCopy, normalizeAuthReason } from './authPromptCopy.js';
import { isSignInRequiredError } from '../../utils/signInRequired.js';
import { WorkerApiAuthError } from '../../services/workerApiClient.js';

test('only a known reason is a reason; an event, a paper or nothing is the general door', () => {
  assert.equal(normalizeAuthReason('paper_rewrite'), 'paper_rewrite');
  assert.equal(normalizeAuthReason('related'), 'related');
  assert.equal(normalizeAuthReason('explorer_search'), 'explorer_search');
  // `onClick={requestAuthentication}` hands over a click event, and
  // `onSaveToList={user ? … : requestAuthentication}` a paper.
  assert.equal(normalizeAuthReason({ type: 'click', target: {} }), 'default');
  assert.equal(normalizeAuthReason({ id: 'arxiv:2401.00001', title: 'A paper' }), 'default');
  assert.equal(normalizeAuthReason('other'), 'default');
  assert.equal(normalizeAuthReason('constructor'), 'default');
  assert.equal(normalizeAuthReason(undefined), 'default');
});

test('each door says why it opened, in both languages', () => {
  assert.equal(authPromptCopy('default', 'es').title, 'Haz que PaperTok sea tuyo');
  assert.equal(authPromptCopy('default', 'en').title, 'Make PaperTok yours');
  assert.match(authPromptCopy('paper_rewrite', 'es').title, /Leer en simple/);
  assert.match(authPromptCopy('paper_rewrite', 'en').title, /plain words/i);
  assert.match(authPromptCopy('related', 'es').lede, /grafo de citas/);
  assert.match(authPromptCopy('related', 'en').lede, /citation graph/);
  assert.match(authPromptCopy('explorer_search', 'es').title, /Buscar/);
  assert.match(authPromptCopy('explorer_search', 'en').title, /Search/);
  // A reason the table does not know falls back to the general copy, not to
  // an empty dialog.
  assert.equal(authPromptCopy({ type: 'click' }, 'es').title, 'Haz que PaperTok sea tuyo');
});

test('a missing session is told apart from a failure', () => {
  assert.equal(isSignInRequiredError(new WorkerApiAuthError()), true);
  assert.equal(isSignInRequiredError(Object.assign(new Error('401'), { status: 401 })), true);
  assert.equal(isSignInRequiredError({ code: 'AUTH_REQUIRED' }), true);
  assert.equal(isSignInRequiredError(new WorkerApiAuthError('WORKER_ORIGIN_NOT_ALLOWED')), false);
  assert.equal(isSignInRequiredError(Object.assign(new Error('502'), { status: 502 })), false);
  assert.equal(isSignInRequiredError(null), false);
});
