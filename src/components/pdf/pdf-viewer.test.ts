import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadPaperViewer } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { paperLegacyAdapter } from '../../models/paper.ts';

test('switching between Paper, Listen and AI summary keeps the viewer and the paper mounted', async () => {
  const { Viewer, AuthContext, AnalyticsContext, FeedContext, LanguageContext, firebase, close } = await loadPaperViewer();
  const parser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: window.DOMParser });
  const worker = stubWorker();
  worker.hold('/resources/full-text').answer({
    source: 'arxiv', format: 'latexml', url: 'https://arxiv.org/html/2611.00001',
    document: '<html lang="en"><body><article class="ltx_document"><h1>A paper</h1><section><h2 class="ltx_title">Introduction</h2><p class="ltx_p">A passage for listening and reading.</p></section></article></body></html>',
  });
  worker.hold('/ai/usage');
  const card = { about: null, links: null, isRead: false, shareUrl: '', notInterested() {}, toggleRead() {} };
  const menu = { snapshot: () => card, subscribe: () => () => {} };
  try {
    firebase.auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    let closed = 0;
    const paper = paperLegacyAdapter({ id: '2611.00001', title: 'A paper', abstract: 'An abstract.', pdfUrl: 'https://arxiv.org/pdf/2611.00001' });
    render(createElement(LanguageContext.Provider, { value: { language: 'en', locale: 'en-US' } }, createElement(AuthContext.Provider, { value: { user: { uid: 'reader' }, readingPreferences: { aiExplanationLevel: 'university' } } },
      createElement(AnalyticsContext.Provider, { value: { consent: 'anonymous', trackEvent: async () => true } },
        createElement(FeedContext.Provider, { value: { trackPdfBounce: async () => {} } },
          createElement(Viewer, { paper, menu, onClose: () => { closed += 1; } }))))));
    const dialog = await screen.findByRole('dialog', { name: 'Paper viewer' });
    const stage = dialog.querySelector('.pdf-stage');
    assert.ok(stage);
    assert.equal(stage.hasAttribute('inert'), false, 'the viewer opens on the paper');
    const text = await screen.findByRole('region', { name: 'Paper text' });
    assert.equal(text.tabIndex, 0);
    fireEvent.click(await screen.findByRole('button', { name: 'Listen' }));
    assert.equal(text.tabIndex, -1, 'the covered paper itself is not a keyboard stop under Listen');
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    assert.equal(text.tabIndex, 0, 'the paper becomes a keyboard stop again when shown');
    fireEvent.click(screen.getByRole('button', { name: 'AI summary' }));
    await waitFor(() => assert.ok(dialog.querySelector('.rd--embedded')));
    assert.ok(stage.hasAttribute('inert'), 'the paper waits behind the AI summary');
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    assert.equal(screen.getByRole('dialog', { name: 'Paper viewer' }), dialog, 'the same viewer stays mounted');
    assert.equal(dialog.querySelector('.pdf-stage'), stage, 'the original paper stays mounted');
    assert.equal(stage.hasAttribute('inert'), false);
    assert.equal(dialog.querySelector('.rd--embedded'), null, 'the AI summary goes at once');
    assert.equal(closed, 0);
  } finally {
    cleanup();
    worker.stop();
    if (parser) Object.defineProperty(globalThis, 'DOMParser', parser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
    await close();
  }
});

for (const elapsed of [1000, 6000]) {
  test(`a summary journal link closes before navigation and records a bounce only for a short visit (${elapsed} ms)`, async (t) => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    const { Viewer, AuthContext, AnalyticsContext, FeedContext, LanguageContext, firebase, close } = await loadPaperViewer();
    const parser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
    Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: window.DOMParser });
    const worker = stubWorker();
    worker.hold('/resources/full-text').answer({
      source: 'arxiv', format: 'latexml', url: 'https://arxiv.org/html/2611.00001',
      document: '<html lang="en"><body><article class="ltx_document"><h1>A paper</h1><section><h2 class="ltx_title">Introduction</h2><p class="ltx_p">A passage for listening and reading.</p></section></article></body></html>',
    });
    worker.hold('/ai/usage');
    const card = { about: null, links: null, isRead: false, shareUrl: '', notInterested() {}, toggleRead() {} };
    const menu = { snapshot: () => card, subscribe: () => () => {} };
    try {
      firebase.auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
      let closed = 0;
      const bounced: string[] = [];
      const paper = paperLegacyAdapter({ id: '2611.00001', title: 'A paper', venueId: 'S123', sourceName: 'Test Journal', abstract: 'An abstract.', pdfUrl: 'https://arxiv.org/pdf/2611.00001' });
      const Location = () => createElement('output', { 'aria-label': 'Current path' }, useLocation().pathname);
      render(createElement(MemoryRouter, { initialEntries: ['/feed'] }, createElement(Location), createElement(LanguageContext.Provider, { value: { language: 'en', locale: 'en-US' } }, createElement(AuthContext.Provider, { value: { user: { uid: 'reader' }, readingPreferences: { aiExplanationLevel: 'university' } } },
        createElement(AnalyticsContext.Provider, { value: { consent: 'anonymous', trackEvent: async () => true } },
          createElement(FeedContext.Provider, { value: { trackPdfBounce: async (paper: { id: string }) => { bounced.push(paper.id); } } },
            createElement(Viewer, { paper, menu, onClose: () => { closed += 1; } })))))));
      const dialog = await screen.findByRole('dialog', { name: 'Paper viewer' });
      fireEvent.click(await screen.findByRole('button', { name: 'AI summary' }));
      const journal = await screen.findByRole('link', { name: 'Test Journal' });
      now += elapsed;
      fireEvent.click(journal, { ctrlKey: true });
      assert.deepEqual(bounced, [], 'opening another tab is not a bounce');
      assert.equal(closed, 0, 'opening another tab does not close the viewer');
      assert.equal(screen.getByLabelText('Current path').textContent, '/feed');
      let finishExit = () => {};
      const exit = new Promise<void>(resolve => { finishExit = resolve; });
      Object.defineProperty(dialog, 'getAnimations', { configurable: true, value: () => [{ finished: exit }] });
      fireEvent.click(journal);
      assert.deepEqual(bounced, elapsed < 5000 ? ['2611.00001'] : [], 'only a short visit records a bounce');
      assert.equal(closed, 0, 'the parent is not told to unmount during the exit');
      assert.ok(dialog.hasAttribute('data-closed'), 'the dialog starts its close lifecycle');
      assert.equal(screen.getByLabelText('Current path').textContent, '/feed', 'navigation waits for the exit');
      await act(async () => { finishExit(); });
      await waitFor(() => assert.equal(closed, 1));
      assert.deepEqual(bounced, elapsed < 5000 ? ['2611.00001'] : [], 'exit completion does not record another bounce');
      await waitFor(() => assert.equal(screen.getByLabelText('Current path').textContent, '/explorer/source/S123'));
    } finally {
      cleanup();
      worker.stop();
      if (parser) Object.defineProperty(globalThis, 'DOMParser', parser);
      else Reflect.deleteProperty(globalThis, 'DOMParser');
      await close();
    }
  });
}
