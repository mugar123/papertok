import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProductionProbe } from './production-smoke.ts';

test('Worker health requires ok and reports deployment metadata', () => {
  assert.deepEqual(classifyProductionProbe('Worker health', 200, {
    ok: true, version: { id: 'version-id', tag: 'b86662bb' },
  }), { passed: true, detail: 'version id version-id, tag b86662bb' });
  assert.equal(classifyProductionProbe('Worker health', 200, {
    ok: true, version: { id: 'version-id', tag: null },
  }).detail, 'version id version-id, tag untagged');
  assert.equal(classifyProductionProbe('Worker health', 200, { ok: 'true' }).passed, false);
  assert.equal(classifyProductionProbe('Worker health', 200, { ok: true }).passed, false);
  assert.equal(classifyProductionProbe('Worker health', 502, { ok: true }).passed, false);
});

test('AI health requires provider availability and reports stable failure codes', () => {
  assert.equal(classifyProductionProbe('AI health', 200, { available: true }).passed, true);
  assert.equal(classifyProductionProbe('AI health', 200, { available: false }).passed, false);
  assert.deepEqual(classifyProductionProbe('AI health', 503, { code: 'AI_NOT_CONFIGURED' }), {
    passed: false, detail: 'HTTP 503 AI_NOT_CONFIGURED',
  });
  assert.equal(classifyProductionProbe('AI health', 503, { code: 'AI_TIMEOUT' }).detail, 'HTTP 503 AI_TIMEOUT');
  assert.deepEqual(classifyProductionProbe('AI health', 502, { code: 'unexpected text' }), {
    passed: false, detail: 'HTTP 502',
  });
});

test('ORCID connect requires an authentication challenge from the configured route', () => {
  assert.equal(classifyProductionProbe('ORCID connect', 401, { code: 'AUTH_REQUIRED' }).passed, true);
  assert.equal(classifyProductionProbe('ORCID connect', 401).passed, false);
  assert.equal(classifyProductionProbe('ORCID connect', 403, { code: 'AUTH_REQUIRED' }).passed, false);
  assert.deepEqual(classifyProductionProbe('ORCID connect', 503, { code: 'ORCID_NOT_CONFIGURED' }), {
    passed: false, detail: 'HTTP 503 ORCID_NOT_CONFIGURED (expected 401 AUTH_REQUIRED)',
  });
});

test('MCP requires a successful tool result containing papers', () => {
  const structuredContent = { papers: [{ id: 'openalex:W1' }] };
  assert.equal(classifyProductionProbe('MCP search', 200, { result: { structuredContent } }).passed, true);
  assert.equal(classifyProductionProbe('MCP search', 200, {
    result: { structuredContent: { papers: [] } },
  }).passed, false);
  assert.equal(classifyProductionProbe('MCP search', 200, {
    result: { isError: true, structuredContent },
  }).passed, false);
  assert.equal(classifyProductionProbe('MCP search', 200, { error: { code: -32603 } }).passed, false);
});

test('Guest discovery requires papers and the website requires an HTTP 200', () => {
  assert.equal(classifyProductionProbe('Guest papers', 200, { papers: [{ id: '2401.00001' }] }).passed, true);
  assert.equal(classifyProductionProbe('Guest papers', 200, { papers: [] }).passed, false);
  assert.equal(classifyProductionProbe('Guest papers', 401).passed, false);
  assert.equal(classifyProductionProbe('Website', 200).passed, true);
  assert.equal(classifyProductionProbe('Website', 302).passed, false);
});
