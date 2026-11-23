import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { loadDigestReactivation } from '../../../tests/dom/digest-reactivation.ts';

// The dialog reads the stored preferences again as it opens: another tab or
// device may have turned the email on or off since this tab last read it.
async function openEmailSettings(t: TestContext, reading: { refreshing?: boolean; refreshPreferences?: () => Promise<void> }) {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  t.mock.method(globalThis, 'fetch', async () => Response.json({ enabled: false, revision: 1 }));
  const view = render(createElement(modules.ReminderSettings, { reading }));
  t.after(() => view.unmount());
  return within(await screen.findByRole('dialog'));
}

test('while the email settings are read again on opening, the switch keeps focus but cannot be changed, Save and Send test wait, and the wait is announced', async (t) => {
  const dialog = await openEmailSettings(t, { refreshing: true, refreshPreferences: () => new Promise<void>(() => {}) });

  const toggle = dialog.getByRole('switch', { name: /Enable email updates/ });
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.hasAttribute('disabled'), false, 'a disabled switch would drop the focus the dialog gives it');
  assert.equal(toggle.getAttribute('aria-readonly'), 'true');
  assert.equal(toggle.getAttribute('aria-busy'), 'true');
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true', 'the switch changed during the read');

  assert.equal(dialog.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled'), true);
  assert.equal(dialog.getByRole('button', { name: /Send test/ }).hasAttribute('disabled'), true);
  const announced = dialog.getAllByRole('status').map(status => status.textContent ?? '');
  assert.ok(announced.some(text => text.includes('Checking your email settings')), announced.join(' | '));
});

test('once the read on opening is done, the settings can be changed and saved', async (t) => {
  const dialog = await openEmailSettings(t, { refreshing: false, refreshPreferences: async () => {} });

  const toggle = dialog.getByRole('switch', { name: /Enable email updates/ });
  assert.notEqual(toggle.getAttribute('aria-readonly'), 'true');
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(dialog.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled'), false);
  assert.equal(dialog.queryByText(/Checking your email settings/), null);
});

test('a read that fails on opening says the settings shown may be out of date', async (t) => {
  const dialog = await openEmailSettings(t, { refreshPreferences: async () => { throw new Error('offline'); } });

  const line = await dialog.findByText("We couldn't check your email settings, so what you see may be out of date.");
  assert.ok(line.closest('[role="status"]'), 'the message is outside the announced line');
});
