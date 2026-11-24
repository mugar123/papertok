import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadPaperViewer } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';

test('switching between Paper and AI summary keeps the dialog and the paper mounted', async () => {
  const { Viewer, AuthContext, AnalyticsContext, FeedContext, firebase, close } = await loadPaperViewer();
  const worker = stubWorker();
  worker.hold('/resources/full-text');
  worker.hold('/ai/usage');
  const card = { about: null, links: null, isRead: false, shareUrl: '', notInterested() {}, toggleRead() {} };
  const menu = { snapshot: () => card, subscribe: () => () => {} };
  try {
    firebase.auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    let closed = 0;
    const paper = paperLegacyAdapter({ id: '2611.00001', title: 'A paper', abstract: 'An abstract.', pdfUrl: 'https://arxiv.org/pdf/2611.00001' });
    render(createElement(AuthContext.Provider, { value: { user: { uid: 'reader' }, readingPreferences: { aiExplanationLevel: 'university' } } },
      createElement(AnalyticsContext.Provider, { value: { consent: 'anonymous', trackEvent: async () => true } },
        createElement(FeedContext.Provider, { value: { trackPdfBounce: async () => {} } },
          createElement(Viewer, { paper, menu, onClose: () => { closed += 1; } })))));
    const dialog = await screen.findByRole('dialog');
    const stage = dialog.querySelector('.pdf-stage');
    assert.ok(stage);
    assert.equal(stage.hasAttribute('inert'), false, 'the viewer opens on the paper');
    fireEvent.click(screen.getByRole('button', { name: 'AI summary' }));
    await waitFor(() => assert.ok(dialog.querySelector('.rd--embedded')));
    assert.ok(stage.hasAttribute('inert'), 'the paper waits behind the AI summary');
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    assert.equal(screen.getByRole('dialog'), dialog, 'the same dialog stays mounted');
    assert.equal(dialog.querySelector('.pdf-stage'), stage, 'the original paper stays mounted');
    assert.equal(stage.hasAttribute('inert'), false);
    assert.equal(closed, 0);
  } finally {
    cleanup();
    worker.stop();
    await close();
  }
});
