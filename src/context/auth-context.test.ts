import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { loadAuthProvider } from '../../tests/dom/app-modules.ts';
import type { StubUser } from '../../tests/dom/firebase-stub.ts';
import { getTranslationLanguageStorageKey } from '../utils/paper-translation.ts';

test('the auth provider clears the stored translation language of the accounts it loads and leaves, and no other', async t => {
  const app = await loadAuthProvider();
  t.after(async () => {
    cleanup();
    localStorage.clear();
    await app.close();
  });
  const { AuthProvider, useAuth } = app.entry;
  const { auth } = await app.firebase();
  const a = { uid: 'reader-a', getIdToken: async () => 'token-a' };
  const b = { uid: 'reader-b', getIdToken: async () => 'token-b' };
  let reportAuth: (user: StubUser | null) => void = () => {};
  t.mock.method(auth, 'onAuthStateChanged', (report: typeof reportAuth) => {
    reportAuth = report;
    return () => {};
  });
  function ActiveAccount() {
    const { user, loading } = useAuth();
    return createElement('output', null, loading ? 'Loading' : user?.uid ?? 'Signed out');
  }
  render(createElement(AuthProvider, null, createElement(ActiveAccount)));

  async function changeAccount(user: StubUser | null) {
    await act(async () => {
      auth.currentUser = user;
      reportAuth(user);
    });
    assert.equal(screen.getByRole('status').textContent, user?.uid ?? 'Signed out');
  }
  function saved(uid: string) {
    return localStorage.getItem(getTranslationLanguageStorageKey(uid));
  }
  function remember(uid: string, language: string) {
    localStorage.setItem(getTranslationLanguageStorageKey(uid), language);
  }

  remember(a.uid, 'es');
  remember(b.uid, 'he');
  remember('reader-c', 'ja');
  await changeAccount(a);
  assert.equal(saved(a.uid), null, 'the account that loads');
  assert.equal(saved(b.uid), 'he');

  remember(a.uid, 'es');
  await changeAccount(null);
  assert.equal(saved(a.uid), null, 'the account that signs out');
  assert.equal(saved(b.uid), 'he');

  await changeAccount(a);
  remember(a.uid, 'es');
  await changeAccount(b);
  assert.equal(saved(a.uid), null, 'the account switched away from');
  assert.equal(saved(b.uid), null, 'the account switched to');
  assert.equal(saved('reader-c'), 'ja', 'an account that never loaded here');
});
