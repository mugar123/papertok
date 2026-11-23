import assert from 'node:assert/strict';
import test from 'node:test';
import { callerSubject } from './caller-quota.ts';

const env = { PDF_RATE_LIMIT_SECRET: 'test-only-pdf-rate-limit-key-32-bytes' };
const subjectOf = (ip: string) => callerSubject(
  new Request('https://papertok-report-api.example/oa', { headers: { 'cf-connecting-ip': ip } }), env, 'oa:2026-11-22T10:00',
);

// ENG-225: every per-address allowance hashed the full IPv6 address, and a
// network hands one subscriber a /64 of them, so one machine had as many
// allowances as addresses it cared to use.
test('addresses in one IPv6 /64 are one caller, and another /64 is another', async () => {
  const caller = await subjectOf('2001:db8:1:2::1');
  assert.match(caller!, /^[a-f0-9]{64}$/);
  for (const ip of ['2001:db8:1:2::2', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0DB8:0001:0002:0:0:0:9', '2001:db8:1:2::']) {
    assert.equal(await subjectOf(ip), caller, ip);
  }
  for (const ip of ['2001:db8:1:3::1', '2001:db8:1::1', '2001:db8::1:2:0:0:1', '::1']) {
    assert.notEqual(await subjectOf(ip), caller, ip);
  }
});

test('an IPv4 address is its own caller, also when written as an IPv4-mapped IPv6 address', async () => {
  const caller = await subjectOf('192.0.2.1');
  assert.equal(await subjectOf('::ffff:192.0.2.1'), caller);
  assert.equal(await subjectOf('::ffff:c000:201'), caller);
  assert.notEqual(await subjectOf('192.0.2.2'), caller);
  assert.notEqual(await subjectOf('::ffff:192.0.2.2'), caller);
});

test('an address that is not one has no subject', async () => {
  for (const ip of ['', 'unknown', '192.0.2', '2001:db8:::1', '2001:db8::g']) {
    assert.equal(await subjectOf(ip), null, ip);
  }
});
