import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** The viewer around the text: its top bar, where the podcast's round button goes, and the scrolling text. */
function viewerFrame() {
  const viewer = document.createElement('div');
  viewer.className = 'pdf-viewer';
  const topbar = document.createElement('div');
  topbar.className = 'pdf-topbar';
  const scroll = document.createElement('div');
  viewer.append(topbar, scroll);
  document.body.append(viewer);
  return { scroll, topbar, remove: () => viewer.remove() };
}
const LISTEN = 'Listen to the paper as a podcast';

test('shared reading tools: the round button opens the podcast and prepares the voice, leaving it stops the voice, and it goes with the explanation', async () => {
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
  const frame = viewerFrame();
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const spoken = { queue: [{ passage: 'intro:0', utterances: ['An explanation.'] }], chapters: [] };
    const tree = (playable: boolean) => createElement(AuthContext.Provider, { value: { user: { uid: 'listener' }, readingPreferences: { readAloudFromPosition: false } } },
      createElement(AnalyticsContext.Provider, { value: { trackEvent: () => Promise.resolve() } },
        createElement(ReadingDock, {
          title: 'Paper — AI summary', paper: paperLegacyAdapter({ id: '2611.00001', title: 'Paper' }), scroll: frame.scroll, topbar: frame.topbar, contents: null, spoken: playable ? spoken : null,
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
    assert.equal(view.queryByRole('button', { name: 'Voice, read aloud' }), null, 'the dock has no Voice of its own');
    fireEvent.click(screen.getByRole('button', { name: LISTEN }));
    assert.ok(screen.getByRole('region', { name: 'Paper' }), 'the podcast tab opens');
    await audioRoute.requested();
    audioRoute.answer({});
    await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Play' })));
    assert.equal(Clip.instances.some(clip => clip.preload !== 'metadata'), false);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Pause' })));
    await waitFor(() => assert.ok(Clip.instances.some(clip => clip.preload !== 'metadata')));
    const player = Clip.instances.find(clip => clip.preload !== 'metadata');
    assert.ok(player);
    const before = player.pauses;
    fireEvent.click(screen.getByRole('button', { name: LISTEN }));
    assert.ok(player.pauses > before, 'leaving the podcast stops the voice');
    assert.equal(screen.queryByRole('region', { name: 'Paper' }), null);
    assert.equal(screen.queryByRole('button', { name: 'Pause' }), null, 'no player is left behind');
    assert.ok(view.getByRole('button', { name: 'Explanation level' }), 'the dock is back');
    assert.equal(view.getByRole('button', { name: 'Send to Zotero' }).getAttribute('aria-busy'), 'true', 'a send in flight survived the podcast');
    await act(async () => zoteroSend.answer({ sentAt: '2026-11-23T12:00:00Z', highlights: 0 }));
    fireEvent.click(screen.getByRole('button', { name: LISTEN }));
    await act(async () => view.rerender(tree(false)));
    assert.equal(screen.queryByRole('button', { name: LISTEN }), null);
    assert.equal(screen.queryByRole('region', { name: 'Paper' }), null);
    assert.ok(view.getByRole('button', { name: 'Explanation level' }));
  } finally {
    cleanup();
    frame.remove();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    if (originalAnimation) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimation);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    Clip.instances = [];
  }
});

test('the podcast tab rings the audio still to come, then lists the chapters to jump to and the sentence being read', async () => {
  const { ReadingDock, AuthContext, AnalyticsContext, firebase, close } = await loadReadingDock();
  const worker = stubWorker();
  const audioRoute = worker.hold('/tts/paragraph');
  worker.hold('/zotero/status');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalAnimation = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel() {} }) });
  const frame = viewerFrame();
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const spoken = {
      queue: [
        { passage: 'b0', utterances: ['1. Method.', 'We fit the model.'], heading: '1. Method.' },
        { passage: 'b1', utterances: ['1.1. Data.', 'The data is public.'], heading: '1.1. Data.' },
        { passage: 'b2', utterances: ['2. Results.', 'It fits.'], heading: '2. Results.' },
      ],
      chapters: [{ number: '1', title: 'Method', first: 0 }, { number: '1.1', title: 'Data', first: 1 }, { number: '2', title: 'Results', first: 2 }],
    };
    const view = render(createElement(AuthContext.Provider, { value: { user: { uid: 'listener' }, readingPreferences: { readAloudFromPosition: false } } },
      createElement(AnalyticsContext.Provider, { value: { trackEvent: () => Promise.resolve() } },
        createElement(ReadingDock, {
          title: 'Paper', scroll: frame.scroll, topbar: frame.topbar, contents: null, spoken, canListen: true, originalUrl: '', notes: null,
        }))));
    fireEvent.click(screen.getByRole('button', { name: LISTEN }));
    const tab = view.getByRole('region', { name: 'Paper' });
    const chapterList = () => within(view.getByRole('navigation', { name: 'All chapters' }));
    assert.match(tab.textContent ?? '', /Preparing the first passages, 0%/);
    const status = within(tab).getByRole('status');
    await waitFor(() => assert.equal(status.textContent, 'Preparing the first passages', 'the player tells a screen reader it is preparing'));
    assert.equal(chapterList().getByRole('button', { name: /^2 Results, / }).hasAttribute('disabled'), true, 'no jumps before the audio is there');
    await audioRoute.requested();
    audioRoute.answer({});
    await act(async () => {
      for (const clip of Clip.instances.filter(clip => clip.preload === 'metadata')) clip.onloadedmetadata?.();
    });
    await waitFor(() => assert.equal(chapterList().getByRole('button', { name: /^2 Results, / }).hasAttribute('disabled'), false));
    assert.equal(status.textContent, 'Paused');
    fireEvent.click(within(tab).getByRole('button', { name: 'Play' }));
    await waitFor(() => assert.match(tab.textContent ?? '', /1\. Method\./));
    await waitFor(() => assert.equal(status.textContent, 'Reading 1 Method', 'and then the section the voice is reading'));
    assert.equal(tab.querySelectorAll('.rd-listen-part').length, 2, 'the line has a block per section, the subsection inside its section');
    assert.ok(chapterList().getByRole('button', { name: /^1\.1 Data, / }), 'the chapter list still names the subsection');
    assert.equal(chapterList().getByRole('button', { name: /^1 Method, / }).getAttribute('aria-current'), 'true');
    fireEvent.click(chapterList().getByRole('button', { name: /^2 Results, / }));
    await waitFor(() => assert.equal(chapterList().getByRole('button', { name: /^2 Results, / }).getAttribute('aria-current'), 'true'));
  } finally {
    cleanup();
    frame.remove();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    if (originalAnimation) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimation);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    Clip.instances = [];
  }
});
