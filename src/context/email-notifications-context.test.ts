import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { loadEmailNotificationsProvider } from '../../tests/dom/email-notifications-provider.ts';

// The real provider over the app's own Worker client. The test is the server:
// it answers `fetch` and keeps whether the email is on there.
const STORED = { enabled: false, frequency: 'weekly', maxPapers: 5, language: 'en', email: 'reader@example.com', lastSentAt: null, lastTestAt: null };

interface Sent { path: string; method: string; body: { enabled?: boolean; sync?: boolean; consent?: string } | null }

async function startProvider(t: TestContext, { enabled, pendingYes = false, answer }: {
  /** Whether the server holds the email on as the provider loads. */
  enabled: boolean;
  pendingYes?: boolean;
  /** Answers a write, or returns nothing to let the server model below answer it. */
  answer?: (sent: Sent, server: { enabled: boolean }) => Promise<Response | undefined>;
}) {
  const app = await loadEmailNotificationsProvider();
  t.after(() => app.close());
  const server = { enabled };
  const sent: Sent[] = [];
  const events: unknown[][] = [];
  let settled = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const method = options.method ?? 'GET';
    if (path === '/health/email') return Response.json({ configured: true, available: true });
    if (path === '/notifications/reactivation' || path === '/notifications/visit') return Response.json({ enabled: false, revision: 0 });
    if (method === 'GET') return Response.json({ preferences: { ...STORED, enabled: server.enabled } });
    const request = { path, method, body: typeof options.body === 'string' ? JSON.parse(options.body) : null };
    sent.push(request);
    const scripted = await answer?.(request, server);
    if (scripted) return scripted;
    if (path === '/notifications/opt-in') {
      const outcome = server.enabled ? 'on' : 'created';
      server.enabled = true;
      return Response.json({ outcome, preferences: { ...STORED, enabled: true } });
    }
    // A sync never changes whether the email is on; a save does.
    if (!request.body?.sync) server.enabled = Boolean(request.body?.enabled);
    return Response.json({ preferences: { ...STORED, enabled: server.enabled } });
  });
  const view = app.mount({ pendingYes, settlePendingYes: async () => { settled += 1; }, events });
  t.after(() => view.unmount());
  await waitFor(() => assert.equal(view.settings().loading, false), { timeout: 5_000 });
  const decisions = () => sent.filter(request => !request.body?.sync).map(request => `${request.method} ${request.path}${request.body?.enabled === undefined ? '' : ` enabled:${request.body.enabled}`}`);
  return { settings: view.settings, server, sent, decisions, events, openOverlay: app.openOverlay, settledCount: () => settled };
}

// The outside verifier's sequence (ENG-215). The reader unsubscribed on another
// device; this tab's background sync answers Off; a test email queued behind it
// subscribes again and its answer is lost. The tab shows Off while the server
// holds On. The Off the reader then saves has to reach the server: an earlier
// answer must never stand in for it.
test('after a sync that answered Off and a queued test whose answer was lost, saving Off still reaches the server', async (t) => {
  let releaseSync: (() => void) | undefined;
  const syncHeld = new Promise<void>((resolve) => { releaseSync = resolve; });
  let syncStarted = false;
  const reader = await startProvider(t, {
    enabled: true,
    answer: async (sent, server) => {
      if (sent.body?.sync) {
        syncStarted = true;
        await syncHeld;
        return undefined;
      }
      if (sent.body?.enabled) {
        // The test email's save lands, and its answer never arrives.
        server.enabled = true;
        throw new DOMException('The answer was lost', 'AbortError');
      }
      return undefined;
    },
  });
  await waitFor(() => assert.equal(syncStarted, true), { timeout: 5_000 });
  // Another device cancels while the sync is in flight.
  reader.server.enabled = false;

  await act(async () => {
    const test = reader.settings().sendTest({ ...reader.settings().preferences, enabled: true }).catch((error: unknown) => error);
    releaseSync?.();
    assert.equal(((await test) as { code?: string }).code, 'EMAIL_TIMEOUT');
  });
  assert.equal(reader.settings().preferences.enabled, false, 'the tab shows the sync\'s answer');
  assert.equal(reader.server.enabled, true, 'the lost test did not subscribe the reader on the server');
  const before = reader.decisions().length;

  await act(async () => { await reader.settings().savePreferences({ ...reader.settings().preferences, enabled: false }); });

  assert.deepEqual(reader.decisions().slice(before), ['PUT /notifications/preferences enabled:false'], 'the Off was not sent');
  assert.equal(reader.server.enabled, false);
  assert.equal(reader.settings().preferences.enabled, false);
});

test('a welcome yes is sent once to the opt-in route, and its notice stays, waits out a dialog that opens over it, and can turn the email off', async (t) => {
  const reader = await startProvider(t, { enabled: false });

  act(() => { reader.settings().startWelcomeDigest({ uid: 'reader', interests: ['cs.LG'] }); });
  await waitFor(() => assert.equal(reader.settings().preferences.enabled, true), { timeout: 5_000 });

  assert.deepEqual(reader.sent[0], { path: '/notifications/opt-in', method: 'POST', body: { consent: 'topics-from-signup-1', interests: ['cs.LG'] } });
  const notice = (await screen.findByText('Your weekly email is on')).closest('li');
  assert.ok(notice, 'the notice is not a toast');
  assert.match(notice.textContent ?? '', /It goes to reader@example\.com on Mondays/);
  assert.ok(within(notice).getByRole('button', { name: 'Turn off' }));
  assert.ok(within(notice).getByRole('button', { name: /close/i }), 'the notice cannot be closed');
  // Not a notice that leaves on its own: whoever creates an account on a shared
  // device was never asked. Sonner's own notices leave after four seconds, and
  // this one used to leave after eight.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 8_600)); });
  assert.ok(notice.isConnected && screen.queryByText('Your weekly email is on'), 'the notice left by itself');

  // A dialog opens over the page, as the privacy notice does for a new account:
  // the notice is put away while it is open and comes back when it has left.
  let closeOverlay: (() => void) | undefined;
  act(() => { closeOverlay = reader.openOverlay(); });
  await waitFor(() => assert.ok(!screen.queryByText('Your weekly email is on'), 'the notice stayed over the dialog'), { timeout: 5_000 });
  act(() => { closeOverlay?.(); });
  const back = (await screen.findByText('Your weekly email is on', undefined, { timeout: 5_000 })).closest('li');
  assert.ok(back, 'the dialog ended the notice');
  const turnOff = within(back).getByRole('button', { name: 'Turn off' });

  await act(async () => { fireEvent.click(turnOff); });
  await waitFor(() => assert.equal(reader.settings().preferences.enabled, false), { timeout: 5_000 });

  assert.deepEqual(reader.decisions(), ['POST /notifications/opt-in', 'PUT /notifications/preferences enabled:false']);
  assert.equal(reader.server.enabled, false);
  assert.deepEqual(reader.events, [['newsletter_change', { action: 'subscribe' }], ['newsletter_change', { action: 'unsubscribe' }]]);
  assert.ok(await screen.findByText('Your weekly email is off'));
});

test('an Off saved while the welcome yes is in flight is sent after it, and the email ends off', async (t) => {
  let answerOptIn: (() => void) | undefined;
  const optInHeld = new Promise<void>((resolve) => { answerOptIn = resolve; });
  const reader = await startProvider(t, {
    enabled: false,
    answer: async (sent) => {
      if (sent.path === '/notifications/opt-in') await optInHeld;
      return undefined;
    },
  });

  act(() => { reader.settings().startWelcomeDigest({ uid: 'reader', interests: ['cs.LG'] }); });
  await waitFor(() => assert.equal(reader.sent.length, 1), { timeout: 5_000 });
  let saving: Promise<unknown> | undefined;
  act(() => { saving = reader.settings().savePreferences({ ...reader.settings().preferences, enabled: false }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(reader.decisions(), ['POST /notifications/opt-in'], 'the Off left before the opt-in was answered');

  await act(async () => {
    answerOptIn?.();
    await saving;
  });

  assert.deepEqual(reader.decisions(), ['POST /notifications/opt-in', 'PUT /notifications/preferences enabled:false']);
  assert.equal(reader.server.enabled, false);
  assert.equal(reader.settings().preferences.enabled, false);
  // The opt-in was answered as created, but the email is off: no notice says it is on.
  // (Shown for an instant or not at all, depending on which answer lands first; a toast takes a moment to leave.)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  await waitFor(() => assert.ok(!screen.queryByText('Your weekly email is on'), 'a notice says the email is on after the Off was confirmed'), { timeout: 5_000 });
});

test('saving with the switch off is sent even when the server already answered Off, and retires a yes still waiting from the welcome', async (t) => {
  const reader = await startProvider(t, { enabled: false, pendingYes: true });

  await act(async () => { await reader.settings().savePreferences({ ...reader.settings().preferences, enabled: false }); });

  assert.deepEqual(reader.decisions(), ['PUT /notifications/preferences enabled:false']);
  assert.equal(reader.settledCount(), 1, 'the pending yes stayed in the profile');
  // Nothing changed for the reader, so nothing is reported.
  assert.deepEqual(reader.events, []);
});

test('closing the started-email notice ends it: a dialog opened afterwards does not bring it back, and nothing is sent', async (t) => {
  const reader = await startProvider(t, { enabled: false });
  act(() => { reader.settings().startWelcomeDigest({ uid: 'reader', interests: ['cs.LG'] }); });
  const notice = (await screen.findByText('Your weekly email is on')).closest('li');
  assert.ok(notice);

  await act(async () => { fireEvent.click(within(notice).getByRole('button', { name: /close/i })); });
  await waitFor(() => assert.ok(!screen.queryByText('Your weekly email is on'), 'the notice is still on screen'), { timeout: 5_000 });
  let closeOverlay: (() => void) | undefined;
  act(() => { closeOverlay = reader.openOverlay(); });
  act(() => { closeOverlay?.(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

  assert.ok(!screen.queryByText('Your weekly email is on'), 'the closed notice came back');
  assert.deepEqual(reader.decisions(), ['POST /notifications/opt-in']);
  assert.equal(reader.settings().preferences.enabled, true);
});

test('the started-email notice goes once the server confirms an unsubscribe made in Settings, and no dialog brings it back', async (t) => {
  const reader = await startProvider(t, { enabled: false });
  act(() => { reader.settings().startWelcomeDigest({ uid: 'reader', interests: ['cs.LG'] }); });
  assert.ok(await screen.findByText('Your weekly email is on'));

  await act(async () => { await reader.settings().savePreferences({ ...reader.settings().preferences, enabled: false }); });

  await waitFor(() => assert.ok(!screen.queryByText('Your weekly email is on'), 'the notice still says the email is on'), { timeout: 5_000 });
  let closeOverlay: (() => void) | undefined;
  act(() => { closeOverlay = reader.openOverlay(); });
  act(() => { closeOverlay?.(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  assert.ok(!screen.queryByText('Your weekly email is on'), 'the notice came back');
  assert.equal(reader.server.enabled, false);
});
