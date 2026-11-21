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

test('Settings can withdraw reminders when the digest preferences read fails, and cannot grant them', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push(`${options?.method ?? 'GET'} ${path} ${typeof options?.body === 'string' ? options.body : ''}`.trim());
    assert.equal(path, '/notifications/reactivation');
    if (options?.method === 'PUT') return Response.json({ enabled: false, revision: 2 });
    return Response.json({ enabled: true, revision: 1 });
  });
  const view = render(createElement(modules.ReminderSettings, { subscribed: null }));
  try {
    const checkbox = await screen.findByRole('checkbox', { name: 'Weekly digest reminder' });
    await waitFor(() => assert.equal(checkbox.getAttribute('aria-checked'), 'true'));
    assert.ok(screen.getAllByRole('status').some(status => status.textContent?.includes('You can still turn reminders off.')));
    fireEvent.click(checkbox);
    await waitFor(() => assert.equal(checkbox.getAttribute('aria-checked'), 'false'));
    // No visit is recorded and nothing is granted without a confirmed subscription.
    assert.deepEqual(requests, ['GET /notifications/reactivation', 'PUT /notifications/reactivation {"enabled":false}']);
    assert.ok(checkbox.hasAttribute('data-disabled') || checkbox.getAttribute('aria-disabled') === 'true');
  } finally {
    view.unmount();
  }
});

test('Settings can withdraw reminders when both the digest preferences and the consent reads fail', async t => {
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
  const view = render(createElement(modules.ReminderSettings, { subscribed: null }));
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off reminders' }));
    await waitFor(() => {
      assert.deepEqual(withdrawals, [{ enabled: false }]);
      assert.ok(screen.getAllByRole('status').some(status => status.textContent?.includes('Reminder turned off.')));
    });
  } finally {
    view.unmount();
  }
});

test('a reader whose digest preferences could not be read cannot grant reminders', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, options?: RequestInit) => {
    methods.push(options?.method ?? 'GET');
    return Response.json({ enabled: false, revision: 1 });
  });
  const { result, unmount } = renderHook(() => modules.useDigestReactivation('reader', null, true));
  try {
    await waitFor(() => assert.equal(result.current.known, true));
    await act(async () => {
      await assert.rejects(() => result.current.save(true), { code: 'EMAIL_REACTIVATION_REQUIRES_DIGEST' });
    });
    assert.deepEqual(methods, ['GET']);
  } finally {
    unmount();
  }
});

test('opening Settings reads reminders again, so a grant from another tab can be withdrawn, even when that read fails', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  let enabled = false;
  let revision = 1;
  let failReads = false;
  const withdrawals: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/notifications/visit') return Response.json({ ok: true });
    assert.equal(path, '/notifications/reactivation');
    if (options?.method === 'PUT') {
      assert.ok(typeof options.body === 'string');
      const body = JSON.parse(options.body);
      if (!body.enabled) withdrawals.push(body);
      enabled = body.enabled === true;
      return Response.json({ enabled, revision: ++revision });
    }
    if (failReads) return Response.json({ code: 'EMAIL_UNAVAILABLE' }, { status: 503 });
    return Response.json({ enabled, revision });
  });
  // The first tab loads with reminders off and its dialog closed.
  const first = render(createElement(modules.ReminderSettings, { isOpen: false }));
  // A second instance for the same account turns reminders on.
  const second = renderHook(() => modules.useDigestReactivation('reader', true, true));
  try {
    await waitFor(() => assert.equal(second.result.current.known, true));
    await act(async () => { await second.result.current.save(true); });
    assert.equal(enabled, true);

    first.rerender(createElement(modules.ReminderSettings, { isOpen: true }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Weekly digest reminder' });
    await waitFor(() => assert.equal(checkbox.getAttribute('aria-checked'), 'true'));
    fireEvent.click(checkbox);
    await waitFor(() => assert.deepEqual(withdrawals, [{ enabled: false }]));

    // The other tab turns them on again; this time the first tab's read on opening fails.
    await act(async () => { await second.result.current.refresh(); });
    await act(async () => { await second.result.current.save(true); });
    first.rerender(createElement(modules.ReminderSettings, { isOpen: false }));
    failReads = true;
    first.rerender(createElement(modules.ReminderSettings, { isOpen: true }));
    const turnOff = await screen.findByRole('button', { name: 'Turn off reminders' });
    // A browser click focuses the button first.
    turnOff.focus();
    fireEvent.click(turnOff);
    await waitFor(() => assert.deepEqual(withdrawals, [{ enabled: false }, { enabled: false }]));
    assert.equal(enabled, false);
    // The button unmounts once the withdrawal lands; focus moves to the reminder checkbox.
    await waitFor(() => assert.ok(screen.queryByRole('button', { name: 'Turn off reminders' }) === null, 'the withdraw button is gone'));
    const box = screen.getByRole('checkbox', { name: 'Weekly digest reminder' });
    assert.ok(document.activeElement === box, `focus is on ${document.activeElement?.tagName ?? 'nothing'}, not the checkbox`);
  } finally {
    second.unmount();
    first.unmount();
  }
});

test('a tab that read the digest as off can still see and withdraw reminders another tab turned on', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  let enabled = false;
  let revision = 1;
  const reads: string[] = [];
  const withdrawals: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/notifications/visit') return Response.json({ ok: true });
    assert.equal(path, '/notifications/reactivation');
    if (options?.method === 'PUT') {
      assert.ok(typeof options.body === 'string');
      const body = JSON.parse(options.body);
      if (!body.enabled) withdrawals.push(body);
      enabled = body.enabled === true;
      return Response.json({ enabled, revision: ++revision });
    }
    reads.push('GET');
    return Response.json({ enabled, revision });
  });
  // The first tab read the digest as off and has its dialog closed: it asks nothing.
  const first = render(createElement(modules.ReminderSettings, { subscribed: false, isOpen: false }));
  // A second instance for the same account subscribed and turns reminders on.
  const second = renderHook(() => modules.useDigestReactivation('reader', true, true));
  try {
    await waitFor(() => assert.equal(second.result.current.known, true));
    await act(async () => { await second.result.current.save(true); });
    assert.deepEqual(reads, ['GET']);

    first.rerender(createElement(modules.ReminderSettings, { subscribed: false, isOpen: true }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Weekly digest reminder' });
    await waitFor(() => assert.equal(checkbox.getAttribute('aria-checked'), 'true'));
    assert.ok(screen.getAllByRole('status').some(status => status.textContent?.includes('You can turn them off here,')));
    fireEvent.click(checkbox);
    await waitFor(() => assert.deepEqual(withdrawals, [{ enabled: false }]));
    await waitFor(() => assert.equal(checkbox.getAttribute('aria-checked'), 'false'));
    assert.equal(enabled, false);
  } finally {
    second.unmount();
    first.unmount();
  }
});

test('a tab that read the digest as off can still withdraw reminders when the read on opening fails', async t => {
  const modules = await loadDigestReactivation();
  t.after(() => modules.close());
  const withdrawals: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, '/notifications/reactivation');
    if (options?.method !== 'PUT') return Response.json({ code: 'EMAIL_UNAVAILABLE' }, { status: 503 });
    assert.ok(typeof options.body === 'string');
    withdrawals.push(JSON.parse(options.body));
    return Response.json({ enabled: false, revision: 3 });
  });
  const view = render(createElement(modules.ReminderSettings, { subscribed: false, isOpen: false }));
  try {
    view.rerender(createElement(modules.ReminderSettings, { subscribed: false, isOpen: true }));
    const button = await screen.findByRole('button', { name: 'Turn off reminders' });
    assert.ok(screen.getAllByRole('status').some(status => status.textContent?.includes('temporarily unavailable')));
    // A browser click focuses the button first.
    button.focus();
    fireEvent.click(button);
    await waitFor(() => assert.deepEqual(withdrawals, [{ enabled: false }]));
    await waitFor(() => assert.ok(screen.queryByRole('button', { name: 'Turn off reminders' }) === null, 'the withdraw button is gone'));
    const box = screen.getByRole('checkbox', { name: 'Weekly digest reminder' });
    assert.ok(document.activeElement === box, `focus is on ${document.activeElement?.tagName ?? 'nothing'}, not the checkbox`);
  } finally {
    view.unmount();
  }
});
