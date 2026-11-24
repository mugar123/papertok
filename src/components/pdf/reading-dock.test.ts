import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { loadReadingDock } from '../../../tests/dom/component-modules.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';

class Clip {
  static instances: Clip[] = [];
  constructor() { Clip.instances.push(this); }
  src = '';
  preload = '';
  duration = 10;
  currentTime = 0;
  pauses = 0;
  onloadedmetadata: (() => void) | null = null;
  play() { return Promise.resolve(); }
  pause() { this.pauses += 1; }
}

test('shared reading tools open the voice player, restore focus, and stop when the explanation changes', async () => {
  const { ReadingDock, AuthContext, AnalyticsContext, firebase, close } = await loadReadingDock();
  const worker = stubWorker();
  const audioRoute = worker.hold('/tts/paragraph');
  const zoteroStatus = worker.hold('/zotero/status');
  const zoteroSend = worker.hold('/zotero/send');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalAnimation = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel() {} }) });
  let notesOpened = false;
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const spoken = { queue: [{ passage: 'intro:0', utterances: ['An explanation.'] }], chapters: [] };
    const tree = (playable: boolean) => createElement(AuthContext.Provider, { value: { user: { uid: 'listener' }, readingPreferences: { readAloudFromPosition: false } } },
      createElement(AnalyticsContext.Provider, { value: { trackEvent: () => Promise.resolve() } },
        createElement(ReadingDock, {
          title: 'Paper — In plain words', paper: paperLegacyAdapter({ id: '2611.00001', title: 'Paper' }), scroll: null, contents: null, spoken: playable ? spoken : null,
          canListen: playable, originalUrl: 'https://doi.org/10.1234/paper',
          notes: { id: 'reader-notes', open: false, count: 2, onOpenChange: open => { notesOpened = open; } },
          children: createElement('button', {}, 'Explanation level'),
        })));
    const view = render(tree(true));
    await zoteroStatus.requested();
    await act(async () => zoteroStatus.answer({ connected: true, username: 'fixture', sentAt: null }));
    fireEvent.click(view.getByRole('button', { name: 'Send to Zotero' }));
    await zoteroSend.requested();
    fireEvent.click(view.getByRole('button', { name: 'Notes' }));
    assert.equal(notesOpened, true);
    assert.equal(view.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href'), 'https://doi.org/10.1234/paper');
    fireEvent.click(view.getByRole('button', { name: 'Voice, read aloud' }));
    await audioRoute.requested();
    audioRoute.answer({});
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Pause' })));
    await waitFor(() => assert.equal(Clip.instances.length, 2));
    assert.equal(view.queryByRole('button', { name: 'Explanation level' }), null);
    fireEvent.keyDown(view.getByRole('button', { name: 'Pause' }), { key: 'Escape' });
    await waitFor(() => assert.ok(document.activeElement === view.getByRole('button', { name: 'Voice, read aloud' }), 'Voice receives focus when the player closes'));
    assert.equal(view.getByRole('button', { name: 'Send to Zotero' }).getAttribute('aria-busy'), 'true');
    await act(async () => zoteroSend.answer({ sentAt: '2026-11-23T12:00:00Z', highlights: 0 }));
    fireEvent.click(view.getByRole('button', { name: 'Voice, read aloud' }));
    const player = Clip.instances.find(clip => clip.preload !== 'metadata');
    assert.ok(player);
    const before = player.pauses;
    await act(async () => view.rerender(tree(false)));
    assert.ok(player.pauses > before);
    assert.equal(view.queryByRole('button', { name: 'Voice, read aloud' }), null);
    assert.equal(view.queryByRole('button', { name: 'Pause' }), null);
    assert.ok(view.getByRole('button', { name: 'Explanation level' }));
  } finally {
    cleanup();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    if (originalAnimation) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimation);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    Clip.instances = [];
  }
});

test('the listening view rings the audio still to come, then the sections to jump to and the sentence being read', async () => {
  const { ReadingDock, AuthContext, AnalyticsContext, firebase, close } = await loadReadingDock();
  const worker = stubWorker();
  const audioRoute = worker.hold('/tts/paragraph');
  worker.hold('/zotero/status');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalAnimation = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel() {} }) });
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const spoken = {
      queue: [{ passage: 'b0', utterances: ['1. Method.', 'We fit the model.'], heading: '1. Method.' }],
      chapters: [{ number: '1', title: 'Method', first: 0 }],
    };
    const view = render(createElement(AuthContext.Provider, { value: { user: { uid: 'listener' }, readingPreferences: { readAloudFromPosition: false } } },
      createElement(AnalyticsContext.Provider, { value: { trackEvent: () => Promise.resolve() } },
        createElement(ReadingDock, {
          title: 'Paper', scroll: null, contents: null, spoken, canListen: true, originalUrl: '', notes: null,
        }))));
    fireEvent.click(view.getByRole('button', { name: 'Voice, read aloud' }));
    fireEvent.click(view.getByRole('button', { name: 'Open the listening view' }));
    const dialog = await waitFor(() => view.getByRole('dialog', { name: 'Paper' }));
    assert.match(dialog.textContent ?? '', /Preparing the audio, 0%/);
    assert.equal(view.queryByRole('button', { name: 'Go to 1 Method' }), null, 'no jumps before the audio is there');
    await audioRoute.requested();
    audioRoute.answer({});
    await act(async () => {
      for (const clip of Clip.instances.filter(clip => clip.preload === 'metadata')) clip.onloadedmetadata?.();
    });
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Go to 1 Method' })));
    assert.match(dialog.textContent ?? '', /1\. Method\./);
    assert.ok(view.getAllByRole('button', { name: 'Pause' }).length > 0);
  } finally {
    cleanup();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    if (originalAnimation) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimation);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    Clip.instances = [];
  }
});
