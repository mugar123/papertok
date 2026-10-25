import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DELETE_ACCOUNT_DESCRIPTION } from './delete-account-description.ts';

const ROOT = new URL('../../../', import.meta.url);

test('Settings says what the privacy page says deleting an account leaves behind', () => {
  const policy = readFileSync(fileURLToPath(new URL('privacy.html', ROOT)), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ');
  const summary = policy.match(/<section class="lp-short".*?<\/section>/)?.[0] ?? '';
  const exception = summary.match(/The feed order the server keeps for you [^.]*\./)?.[0];

  assert.ok(exception, 'the policy summary names the feed order the server keeps');
  assert.match(exception, /at most 2 hours after your last page/);
  assert.ok(
    DELETE_ACCOUNT_DESCRIPTION.endsWith(exception),
    `Settings says "${DELETE_ACCOUNT_DESCRIPTION}", the policy says "${exception}"`,
  );
  assert.match(DELETE_ACCOUNT_DESCRIPTION, /^Permanently deletes your account and everything in it\./);
});
