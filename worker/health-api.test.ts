import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerEnv } from './env.ts';
import { getConfigurationHealth } from './health-api.ts';
import { handleRequest } from './router.ts';
import type { TestNamespace } from './test-types.ts';
import { inMemorySubscriptionStores } from './test-support/email-subscriptions.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

const serviceAccount = {
  FIREBASE_PROJECT_ID: 'paper-test',
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'service@example.test',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: 'fake-private-key',
};

test('AI readiness only checks the selected provider credential', () => {
  const inactiveKeys = { GEMINI_API_KEY: 'gemini-test-key', NAN_API_KEY: 'sk-nan-fixture' };
  for (const env of [
    { ...inactiveKeys, AI_PROVIDER: 'anthropic' },
    { ...inactiveKeys, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-wrong-provider' },
    { AI_PROVIDER: 'nan', NAN_API_KEY: 'wrong-format', ANTHROPIC_API_KEY: 'sk-ant-fixture' },
    { GEMINI_API_KEY: ' \t' },
    { GEMINI_API_KEY: 'two words' },
    { GEMINI_API_KEY: '\u3000gemini-test-key' },
  ]) {
    const { aiConfigured, features } = getConfigurationHealth(env);
    assert.equal(features.ai, false);
    assert.equal(aiConfigured, false);
  }
  for (const env of [
    { AI_PROVIDER: ' Anthropic ', ANTHROPIC_API_KEY: 'sk-ant-fixture' },
    { AI_PROVIDER: 'nan', NAN_API_KEY: 'sk-nan-fixture' },
    { GEMINI_API_KEY: 'gemini-test-key' },
  ]) {
    const { aiConfigured, features } = getConfigurationHealth(env);
    assert.equal(features.ai, true);
    assert.equal(aiConfigured, true);
  }
});

test('ORCID readiness needs a recognized registry, both OAuth credentials, a service account and a quota ledger', () => {
  const configured = {
    ...serviceAccount,
    ORCID_CLIENT_ID: 'APP-fixture',
    ORCID_CLIENT_SECRET: 'fake-orcid-secret',
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
  };
  assert.equal(getConfigurationHealth(configured).features.orcid, true);
  assert.equal(getConfigurationHealth({ ...configured, ORCID_ENVIRONMENT: 'sandbox' }).features.orcid, true);
  for (const missing of [
    { ORCID_ENVIRONMENT: 'invalid' },
    { ORCID_CLIENT_ID: '' },
    { ORCID_CLIENT_SECRET: '' },
    { FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '' },
    { REQUEST_QUOTA_LEDGER: undefined },
  ]) {
    assert.equal(getConfigurationHealth({ ...configured, ...missing }).features.orcid, false);
  }
});

test('the feature flags report missing integrations and their configured counterparts', () => {
  assert.deepEqual(getConfigurationHealth({}).features, {
    ai: false, orcid: false, zotero: false, scopus: false, email: false,
    publishing: false, institutionLink: false, institutionEmailVerification: false,
    accountDeletion: false, openReviewLookup: false, semanticScholar: false, pdf: false, mcp: false,
  });
  const configured = {
    ...serviceAccount,
    ZOTERO_CLIENT_KEY: 'fake-zotero-id',
    ZOTERO_CLIENT_SECRET: 'fake-zotero-secret',
    ZOTERO_TOKEN_KEY: 'fake-zotero-token-key',
    SCOPUS_PROXY_URL: 'https://egress.example.test',
    SCOPUS_PROXY_SECRET: 'fake-egress-secret',
    OPENREVIEW_USERNAME: 'reader@example.test',
    OPENREVIEW_PASSWORD: 'fake-review-password',
    SEMANTIC_SCHOLAR_API_KEY: 'fake-s2-key',
    RESEND_API_KEY: 'fake-resend-key',
    RESEND_FROM_EMAIL: 'from@example.test',
    NOTIFICATION_STORE: {} as WorkerEnv['NOTIFICATION_STORE'],
  };
  const health = getConfigurationHealth(configured);
  assert.deepEqual(health.features, {
    ai: false, orcid: false, zotero: true, scopus: true, email: false,
    publishing: false, institutionLink: true, institutionEmailVerification: false,
    accountDeletion: false, openReviewLookup: true, semanticScholar: true, pdf: false, mcp: false,
  });
  assert.equal(health.emailConfigured, true);
  assert.equal(health.publishingConfigured, true);
  const subscriptionStore = inMemorySubscriptionStores();
  assert.equal(getConfigurationHealth({ ...configured, EMAIL_SUBSCRIPTIONS: subscriptionStore }).features.email, false);
  const emailDeliveryLedger: TestNamespace = {
    idFromName() { throw new Error('Readiness must not resolve an object'); },
    get() { throw new Error('Readiness must not contact the ledger'); },
  };
  const quotaLedger = inMemoryQuotaLedger();
  const withLedgers = {
    ...configured,
    EMAIL_DELIVERY_LEDGER: emailDeliveryLedger as WorkerEnv['EMAIL_DELIVERY_LEDGER'],
    REQUEST_QUOTA_LEDGER: quotaLedger.binding,
  };
  const { features } = getConfigurationHealth(withLedgers);
  for (const source of ['kv', 'object']) {
    const env = { ...withLedgers, EMAIL_SUBSCRIPTION_SOURCE: source };
    const missing = getConfigurationHealth(env);
    assert.equal(missing.emailConfigured, true);
    assert.equal(missing.features.email, false);
    assert.equal(missing.features.accountDeletion, false);
    const ready = getConfigurationHealth({ ...env, EMAIL_SUBSCRIPTIONS: subscriptionStore });
    assert.equal(ready.features.email, true);
    assert.equal(ready.features.accountDeletion, true);
  }
  assert.equal(getConfigurationHealth(serviceAccount).features.accountDeletion, true);
  assert.equal(features.publishing, true);
  assert.equal(features.institutionEmailVerification, true);
  assert.equal(features.pdf, false);
  assert.equal(features.mcp, false);
  const publicFeatures = getConfigurationHealth({ ...withLedgers, PDF_RATE_LIMIT_SECRET: 'x'.repeat(32) }).features;
  assert.equal(publicFeatures.pdf, true);
  assert.equal(publicFeatures.mcp, true);
  assert.deepEqual(quotaLedger.calls, []);
});

test('GET /health sends readiness and legacy fields without contacting providers or returning credentials', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream call'); });
  const key = 'sk-ant-route-fixture';
  const response = await handleRequest(new Request('https://worker.example.test/health'), {
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: key,
    CF_VERSION_METADATA: { id: 'version-id', tag: 'test-tag', timestamp: '2026-11-20T00:00:00Z' },
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body.includes(key), false);
  assert.deepEqual(JSON.parse(body), {
    ok: true,
    aiConfigured: true,
    openAlexConfigured: false,
    adsConfigured: false,
    scopusConfigured: false,
    pubmedKeyConfigured: false,
    semanticScholarKeyConfigured: false,
    emailConfigured: false,
    publishingConfigured: false,
    features: {
      ai: true, orcid: false, zotero: false, scopus: false, email: false,
      publishing: false, institutionLink: false, institutionEmailVerification: false,
      accountDeletion: false, openReviewLookup: false, semanticScholar: false, pdf: false, mcp: false,
    },
    version: { id: 'version-id', tag: 'test-tag' },
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET /health/ai refuses an invalid Gemini credential without a provider call', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream call'); });
  const response = await handleRequest(new Request('https://worker.example.test/health/ai'), {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'two words',
  });
  assert.equal(response.status, 503);
  const result = await response.json<{ configured: boolean; available: boolean; code: string }>();
  assert.equal(result.configured, false);
  assert.equal(result.available, false);
  assert.equal(result.code, 'AI_NOT_CONFIGURED');
  assert.equal(fetchMock.mock.callCount(), 0);
});
