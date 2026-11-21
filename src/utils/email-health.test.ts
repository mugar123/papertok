import test from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_NOT_CONFIGURED_REASON, emailDownStatus, emailProviderProblemText, emailServiceState } from './email-health.ts';
import { emailNudgeProblem } from './nudges.ts';

test('a health check the Worker refused to run leaves email updates usable', () => {
  // DeepSec review, probe D: another location spends the window's six email
  // probes, and /health/email answers 429 `{"code":"HEALTH_PROBE_LIMITED"}`
  // without asking Resend. getEmailNotificationHealth maps that to this
  // health. The switch, Save, the test send and the welcome opt-in stay on
  // unless the state is 'down'.
  assert.equal(emailServiceState({ available: false, code: 'HEALTH_PROBE_LIMITED' }), 'unknown');
});

test('a quota ledger that is missing or failing leaves the email service unknown', () => {
  // DeepSec review, probe F: with the ledger answering 500, /health/email
  // answers 503 `{"code":"PROVIDER_QUOTA_NOT_CONFIGURED"}` and never calls
  // Resend.
  assert.equal(emailServiceState({ available: false, code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }), 'unknown');
});

test('a provider that answered with a fault still blocks turning updates on', () => {
  assert.equal(emailServiceState({ available: false, code: 'EMAIL_PROVIDER_AUTH_FAILED' }), 'down');
  assert.equal(emailServiceState({ available: false, code: 'EMAIL_PROVIDER_UNAVAILABLE' }), 'down');
  assert.equal(emailServiceState({ available: false, code: 'EMAIL_NOT_CONFIGURED' }), 'down');
  assert.equal(emailServiceState({ available: true, code: null }), 'available');
});

test('a service that is not configured says so in Settings and in the Email updates dialog, as the notice does', () => {
  const health = { available: false, configured: false, code: 'EMAIL_NOT_CONFIGURED' };
  // The notice in the feed can be hidden on a very short window, so its reason must be reachable elsewhere.
  assert.equal(emailNudgeProblem({ health }), 'not-configured');
  const sentence = 'The email service is not connected yet, so no digest will go out';
  assert.equal(EMAIL_NOT_CONFIGURED_REASON, sentence, 'the notice in the feed uses this sentence (nudge-host.tsx) and so do Settings and the dialog');
  assert.deepEqual(emailDownStatus(health), { label: 'Not connected', description: sentence });
  assert.equal(emailProviderProblemText(health.code), `${sentence}.`);
});

test('any other fault is still described as unavailable in Settings, and by its own reason in the dialog', () => {
  assert.deepEqual(emailDownStatus({ code: 'EMAIL_UNAVAILABLE' }), { label: 'Unavailable', description: 'The email service is not responding right now' });
  assert.deepEqual(emailDownStatus(null), { label: 'Unavailable', description: 'The email service is not responding right now' });
  assert.equal(emailProviderProblemText('EMAIL_PROVIDER_AUTH_FAILED'), 'The email provider did not accept the saved credential.');
  assert.equal(emailProviderProblemText('EMAIL_SENDER_NOT_VERIFIED'), 'Resend has not verified the configured sender domain yet.');
  assert.equal(emailProviderProblemText('EMAIL_SENDER_STATUS_UNKNOWN'), 'PaperTok cannot confirm the sender domain with the current Resend key.');
  assert.equal(emailProviderProblemText('EMAIL_PROVIDER_UNAVAILABLE'), 'The email provider is not available right now.');
  assert.equal(emailProviderProblemText(null), 'The email provider is not available right now.');
});
