import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadPaperViewer } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';

test('a tab asks for its route, and switching between Paper and AI summary keeps the viewer and the paper mounted', async () => {
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
    const asked: string[] = [];
    const tree = (readingView: 'paper' | 'listen' | 'summary') => createElement(AuthContext.Provider, { value: { user: { uid: 'reader' }, readingPreferences: { aiExplanationLevel: 'university' } } },
      createElement(AnalyticsContext.Provider, { value: { consent: 'anonymous', trackEvent: async () => true } },
        createElement(FeedContext.Provider, { value: { trackPdfBounce: async () => {} } },
          createElement(Viewer, { paper, menu, readingView, onViewChange: (view) => { asked.push(view); }, onClose: () => { closed += 1; } }))));
    const view = render(tree('paper'));
    const dialog = await screen.findByRole('region', { name: 'Paper viewer' });
    const stage = dialog.querySelector('.pdf-stage');
    assert.ok(stage);
    assert.equal(stage.hasAttribute('inert'), false, 'the viewer opens on the paper');
    fireEvent.click(screen.getByRole('button', { name: 'AI summary' }));
    assert.deepEqual(asked, ['summary'], 'the tab asks for its route');
    view.rerender(tree('summary'));
    await waitFor(() => assert.ok(dialog.querySelector('.rd--embedded')));
    assert.ok(stage.hasAttribute('inert'), 'the paper waits behind the AI summary');
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    view.rerender(tree('paper'));
    assert.equal(screen.getByRole('region', { name: 'Paper viewer' }), dialog, 'the same viewer stays mounted');
    assert.equal(dialog.querySelector('.pdf-stage'), stage, 'the original paper stays mounted');
    assert.equal(stage.hasAttribute('inert'), false);
    assert.equal(dialog.querySelector('.rd--embedded'), null, 'the AI summary goes at once');
    assert.equal(closed, 0);
  } finally {
    cleanup();
    worker.stop();
    await close();
  }
});
