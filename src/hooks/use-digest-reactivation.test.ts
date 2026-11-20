import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { loadDigestReactivation } from '../../tests/dom/digest-reactivation.ts';

test('reactivation keeps confirmed consent through an outage and records a new visit after re-consent', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  let enabled = true;
  let revision = 1;
  let unavailable = false;
  const visits: number[] = [];
  const grants: number[] = [];
  let pendingRead: Promise<Response> | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/notifications/visit' && options?.method === 'POST') {
      assert.ok(typeof options.body === 'string');
      visits.push(JSON.parse(options.body).revision);
      return Response.json({ ok: true });
    }
    assert.equal(path, '/notifications/reactivation');
    if (options?.method === 'PUT') {
      assert.ok(typeof options.body === 'string');
      const body = JSON.parse(options.body);
      if (body.enabled) {
        grants.push(body.revision);
        if (body.revision !== revision) return Response.json({ code: 'EMAIL_REACTIVATION_CHANGED' }, { status: 409 });
      }
      enabled = body.enabled === true;
      return Response.json({ enabled, revision: ++revision });
    }
    if (pendingRead) return pendingRead;
    return unavailable ? Response.json({ code: 'EMAIL_UNAVAILABLE' }, { status: 503 }) : Response.json({ enabled, revision });
  });
  const { useDigestReactivation } = modules;
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 20, 10, 15));
  const { result, unmount } = renderHook(() => useDigestReactivation('reader', true, true));
  try {
    await waitFor(() => assert.deepEqual(visits, [1]));
    unavailable = true;
    await act(async () => { await result.current.refresh(); });
    assert.equal(result.current.unavailable, true);
    assert.equal(result.current.enabled, true);
    unavailable = false;
    await act(async () => { await result.current.refresh(); });
    assert.equal(result.current.unavailable, false);
    const delayed: { resolve?: (response: Response) => void } = {};
    pendingRead = new Promise(resolve => { delayed.resolve = resolve; });
    const retry = result.current.refresh();
    await act(async () => { await result.current.save(false); });
    await act(async () => {
      assert.ok(delayed.resolve);
      delayed.resolve(Response.json({ enabled: true, revision: 1 }));
      await retry;
    });
    pendingRead = undefined;
    assert.equal(result.current.enabled, false);
    revision = 3;
    await act(async () => {
      await assert.rejects(() => result.current.save(true), { code: 'EMAIL_REACTIVATION_CHANGED' });
    });
    assert.deepEqual(grants, [2]);
    assert.equal(result.current.enabled, false);
    await act(async () => { await result.current.save(true); });
    assert.deepEqual(grants, [2, 3]);
    await waitFor(() => assert.deepEqual(visits, [1, 4]));
  } finally {
    unmount();
  }
});

test('Settings can withdraw reminders after the first consent read fails', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  const withdrawals: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, '/notifications/reactivation');
    if (options?.method !== 'PUT') return Response.json({ code: 'EMAIL_UNAVAILABLE' }, { status: 503 });
    assert.ok(typeof options.body === 'string');
    withdrawals.push(JSON.parse(options.body));
    return Response.json({ enabled: false, revision: 2 });
  });
  const view = render(createElement(modules.ReminderSettings));
  try {
    const button = await screen.findByRole('button', { name: 'Turn off reminders' });
    assert.ok(button instanceof HTMLButtonElement);
    fireEvent.click(button);
    await waitFor(() => {
      assert.deepEqual(withdrawals, [{ enabled: false }]);
      assert.ok(screen.getAllByRole('status').some(status => status.textContent?.includes('Reminder turned off.')));
    });
  } finally {
    view.unmount();
  }
});
