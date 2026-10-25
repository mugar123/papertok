import test from 'node:test';
import assert from 'node:assert/strict';
import { emailServiceState } from './email-health.ts';

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
