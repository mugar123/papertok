import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { startAppModules } from '../../tests/dom/app-modules.ts';
import type { StubUser } from '../../tests/dom/firebase-stub.ts';
import { preferredTranslationLanguage, rememberTranslationLanguage } from '../utils/paper-translation.ts';
import type { AuthProvider as AppAuthProvider, useAuth as useAppAuth } from './auth-context.tsx';

test('the auth provider clears only the outgoing account translation language on sign-out and switch', async t => {
  const app = await startAppModules({ stubFirestore: true });
  t.after(async () => {
    cleanup();
    localStorage.clear();
    await app.close();
  });
  const { AuthProvider, useAuth } = await app.load<{ AuthProvider: typeof AppAuthProvider; useAuth: typeof useAppAuth }>('/src/context/auth-context.tsx');
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
    return preferredTranslationLanguage(uid, [], localStorage);
  }

  rememberTranslationLanguage(b.uid, 'he', localStorage);
  rememberTranslationLanguage('reader-c', 'ja', localStorage);
  for (const next of [null, b]) {
    await changeAccount(a);
    rememberTranslationLanguage(a.uid, 'es', localStorage);
    assert.equal(saved(a.uid), 'es');
    await changeAccount(next);
    assert.equal(saved(a.uid), '');
    assert.equal(saved(b.uid), 'he');
    assert.equal(saved('reader-c'), 'ja');
  }
});
