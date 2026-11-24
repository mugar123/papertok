import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadPaperViewer } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';

for (const plainOnly of [true, false]) test(plainOnly ? 'closing Plain words does not record a PDF bounce' : 'switching to Paper keeps the dialog and starts paper engagement', async (t) => {
  const { Viewer, AuthContext, AnalyticsContext, FeedContext, firebase, close } = await loadPaperViewer();
  const worker = stubWorker();
  worker.hold('/resources/full-text');
  worker.hold('/ai/usage');
  const card = { about: null, links: null, isRead: false, shareUrl: '', notInterested() {}, toggleRead() {} };
  const menu = { snapshot: () => card, subscribe: () => () => {} };
  try {
    firebase.auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    let closed = 0;
    let paperOpened = 0;
    let bounced = 0;
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const paper = paperLegacyAdapter({ id: '2611.00001', title: 'A paper', abstract: 'An abstract.', pdfUrl: 'https://arxiv.org/pdf/2611.00001' });
    render(createElement(AuthContext.Provider, { value: { user: { uid: 'reader' }, readingPreferences: { aiExplanationLevel: 'university' } } },
      createElement(AnalyticsContext.Provider, { value: { consent: 'anonymous', trackEvent: async () => true } },
        createElement(FeedContext.Provider, { value: { trackPdfBounce: async () => { bounced += 1; } } },
          createElement(Viewer, { paper, menu, initialView: 'plain', onPaperOpen: () => { paperOpened += 1; }, onClose: () => { closed += 1; } })))));
    const dialog = await screen.findByRole('dialog');
    const stage = dialog.querySelector('.pdf-stage');
    assert.ok(stage);
    assert.ok(stage.hasAttribute('inert'), 'the original paper starts behind Plain words');
    await waitFor(() => assert.ok(dialog.querySelector('.rd--embedded')));
    assert.equal(paperOpened, 0);
    if (plainOnly) {
      fireEvent.click(screen.getByRole('button', { name: 'Close paper' }));
      assert.equal(bounced, 0);
      return;
    }
    now += 30_000;
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    assert.equal(screen.getByRole('dialog'), dialog, 'the same dialog stays mounted');
    assert.equal(dialog.querySelector('.pdf-stage'), stage, 'the original paper stays mounted');
    assert.equal(stage.hasAttribute('inert'), false);
    assert.equal(dialog.querySelector('.rd--embedded'), null);
    assert.equal(closed, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Plain words' }));
    await waitFor(() => assert.ok(dialog.querySelector('.rd--embedded')));
    assert.equal(screen.getByRole('dialog'), dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    assert.equal(paperOpened, 1, 'only the first switch to Paper records opening the original');
    assert.equal(closed, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Close paper' }));
    assert.equal(bounced, 1, 'time spent in Plain words does not hide a quick Paper bounce');
  } finally {
    cleanup();
    worker.stop();
    await close();
  }
});
