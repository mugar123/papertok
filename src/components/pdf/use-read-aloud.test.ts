import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { loadReadAloud } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import type { SpokenPassage } from './read-aloud.ts';

// The browser decodes clips asynchronously; these tests control when metadata arrives.
class Clip {
  static instances: Clip[] = [];
  constructor() { Clip.instances.push(this); }
  preload = '';
  src = '';
  duration = 10;
  currentTime = 0;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  play() { return Promise.resolve(); }
  pause() {}
}

test('prepared passages update with clip metadata and queue changes, while seeking keeps their durations', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  let unmount = () => {};
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const chapters = [{ number: '1', title: 'Results', first: 0 }];
    const queue: SpokenPassage[] = [
      { passage: 'b0', utterances: ['The first result.'] },
      { passage: 'b1', utterances: ['The second result.'] },
    ];
    const view = renderHook(({ passages }) => useReadAloud(passages, chapters, {
      title: 'Results paper',
      onFallback: () => assert.fail('audio should be available'),
      onError: () => assert.fail('audio should play'),
      onBlocked: () => assert.fail('the start should not be blocked'),
    }), { initialProps: { passages: queue } });
    unmount = view.unmount;
    assert.equal(view.result.current.prepared.ready, 0);
    act(() => view.result.current.play(0));
    await route.requested();
    route.answer({});
    await waitFor(() => assert.equal(Clip.instances.filter(clip => clip.preload === 'metadata').length, 2));
    await act(async () => {
      for (const clip of Clip.instances.filter(clip => clip.preload === 'metadata')) clip.onloadedmetadata?.();
    });
    assert.deepEqual(view.result.current.prepared, { ready: 2, total: 2, failed: false });
    assert.equal(view.result.current.timeline.duration, 20);
    act(() => view.result.current.pause());
    act(() => view.result.current.seek(15));
    assert.equal(view.result.current.position, 15);
    assert.equal(view.result.current.paragraph, 1);
    assert.equal(view.result.current.prepared.ready, 2);
    view.rerender({ passages: [{ passage: 'b2', utterances: ['Another result.'] }] });
    assert.equal(view.result.current.prepared.ready, 0);
    assert.equal(view.result.current.prepared.total, 1);
    assert.equal(view.result.current.timeline.duration, 2);
  } finally {
    unmount();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    Clip.instances = [];
  }
});


test('a refused passage is asked for again once the voice is back, and a blocked start pauses instead of falling back', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  let blocked = false;
  const play = Clip.prototype.play;
  Clip.prototype.play = function () { return blocked ? Promise.reject(new DOMException('No gesture.', 'NotAllowedError')) : Promise.resolve(); };
  let unmount = () => {};
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const queue: SpokenPassage[] = [{ passage: 'b0', utterances: ['The only result.'] }];
    const failures: string[] = [];
    let stopsForPress = 0;
    const view = renderHook(() => useReadAloud(queue, [], {
      title: 'Results paper',
      onFallback: () => failures.push('fallback'),
      onError: () => failures.push('error'),
      onBlocked: () => { stopsForPress += 1; },
    }));
    unmount = view.unmount;
    act(() => view.result.current.play(0));
    await route.requested();
    route.refuse(503, 'AI_UNAVAILABLE');
    await waitFor(() => assert.equal(failures.length, 1));

    route.answer({});
    act(() => view.result.current.play(0));
    await waitFor(() => assert.ok(Clip.instances.some(clip => clip.src.startsWith('blob:'))));
    assert.equal(view.result.current.playing, true);

    act(() => view.result.current.pause());
    blocked = true;
    act(() => view.result.current.play(0));
    await waitFor(() => assert.equal(view.result.current.playing, false));
    assert.equal(view.result.current.paragraph, 0);
    assert.equal(failures.length, 1);
    assert.equal(stopsForPress, 1);
  } finally {
    unmount();
    worker.stop();
    await close();
    Clip.prototype.play = play;
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    Clip.instances = [];
  }
});

test('the voice starts once every passage has arrived, and plays at the chosen speed', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  let unmount = () => {};
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const queue: SpokenPassage[] = [
      { passage: 'b0', utterances: ['The first result.'] },
      { passage: 'b1', utterances: ['The second result.'] },
    ];
    const view = renderHook(() => useReadAloud(queue, [], {
      title: 'Results paper',
      onFallback: () => assert.fail('audio should be available'),
      onError: () => assert.fail('audio should play'),
      onBlocked: () => assert.fail('the start should not be blocked'),
    }));
    unmount = view.unmount;
    act(() => { view.result.current.setSpeed(1.5); });
    act(() => view.result.current.play(0));
    await route.requested();
    const playing = () => Clip.instances.find(clip => clip.src.startsWith('blob:'));
    assert.equal(playing(), undefined, 'nothing plays while the audio is being prepared');
    route.answer({});
    await waitFor(() => assert.ok(playing()));
    assert.equal((playing() as Clip & { playbackRate?: number }).playbackRate, 1.5);
    act(() => { view.result.current.setSpeed(0.75); });
    assert.equal((playing() as Clip & { playbackRate?: number }).playbackRate, 0.75);
  } finally {
    unmount();
    worker.stop();
    await close();
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    Clip.instances = [];
  }
});

test('system controls resume and seek the paper, and hidden playback advances to the next passage', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalMetadata = Object.getOwnPropertyDescriptor(globalThis, 'MediaMetadata');
  const handlers = new Map<string, (details: { action: string; seekTime?: number }) => void>();
  const session = {
    metadata: null,
    playbackState: 'none',
    position: undefined as { duration: number; position: number } | undefined,
    setActionHandler(action: string, handler: ((details: { action: string; seekTime?: number }) => void) | null) {
      if (action === 'stop') throw new DOMException('Unsupported', 'NotSupportedError');
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
    setPositionState(position?: { duration: number; position: number }) { this.position = position; },
  };
  const audioSession = { type: 'auto' };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: audioSession });
  Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: class {
    constructor(data: object) { Object.assign(this, data); }
  } });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  let unmount = () => {};
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const queue: SpokenPassage[] = [
      { passage: 'b0', utterances: ['First passage.'] },
      { passage: 'b1', utterances: ['Second passage.'] },
    ];
    const view = renderHook(({ title }) => useReadAloud(queue, [], {
      title,
      onFallback: () => assert.fail('audio should be available'),
      onError: () => assert.fail('audio should play'),
      onBlocked: () => assert.fail('the start should not be blocked'),
    }), { initialProps: { title: 'A podcast paper' } });
    unmount = view.unmount;
    assert.equal(session.metadata, null);
    act(() => view.result.current.play(0));
    await route.requested();
    route.answer({});
    await waitFor(() => assert.equal(Clip.instances.filter(clip => clip.preload === 'metadata').length, 2));
    await act(async () => {
      for (const clip of Clip.instances.filter(clip => clip.preload === 'metadata')) clip.onloadedmetadata?.();
    });
    assert.equal(audioSession.type, 'playback');
    assert.deepEqual(JSON.parse(JSON.stringify(session.metadata)), { title: 'A podcast paper', artist: 'PaperTok' });
    assert.equal(session.playbackState, 'playing');
    act(() => handlers.get('pause')?.({ action: 'pause' }));
    assert.equal(view.result.current.playing, false);
    assert.equal(session.playbackState, 'paused');
    act(() => handlers.get('seekto')?.({ action: 'seekto', seekTime: 5 }));
    assert.equal(view.result.current.position, 5);
    view.rerender({ title: 'Updated paper title' });
    assert.equal(session.playbackState, 'paused');
    assert.equal(session.position?.position, 5);
    assert.deepEqual(JSON.parse(JSON.stringify(session.metadata)), { title: 'Updated paper title', artist: 'PaperTok' });
    await act(async () => handlers.get('play')?.({ action: 'play' }));
    assert.equal(view.result.current.playing, true);
    const player = Clip.instances.find(clip => clip.preload !== 'metadata');
    assert.ok(player);
    assert.equal(player.currentTime, 5);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
      player.onended?.();
    });
    assert.equal(view.result.current.paragraph, 1);
    assert.equal(view.result.current.playing, true);
    assert.equal(session.position?.position, 10);
    view.unmount();
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, 'none');
    assert.equal(session.position, undefined);
    assert.equal(handlers.size, 0);
    assert.equal(audioSession.type, 'auto');
  } finally {
    unmount();
    worker.stop();
    await close();
    for (const [key, descriptor] of [['Audio', originalAudio], ['MediaMetadata', originalMetadata]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    Reflect.deleteProperty(navigator, 'mediaSession');
    Reflect.deleteProperty(navigator, 'audioSession');
    Reflect.deleteProperty(document, 'hidden');
    Clip.instances = [];
  }
});

test('a browser voice that ends a sentence without starting it stops the reading instead of racing through the paper', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const spoken: Array<{ text: string; onend: (() => void) | null }> = [];
  const originalSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (utterance: (typeof spoken)[number]) => spoken.push(utterance), cancel: () => {} } });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: class { text: string; lang = ''; onstart = null; onboundary = null; onend = null; onerror = null; constructor(text: string) { this.text = text; } },
  });
  let unmount = () => {};
  let errors = 0;
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const view = renderHook(() => useReadAloud([{ passage: 'b0', utterances: ['Agents read untrusted text.', 'They follow it.'] }], [], {
      title: 'Agents paper',
      onFallback: () => {},
      onError: () => { errors += 1; },
      onBlocked: () => assert.fail('the start should not be blocked'),
    }));
    unmount = view.unmount;
    act(() => view.result.current.play(0));
    route.refuse(429, 'AI_QUOTA_EXHAUSTED');
    await waitFor(() => assert.equal(spoken.length, 1));

    act(() => spoken[0].onend?.());
    assert.equal(errors, 1);
    assert.equal(view.result.current.playing, false);
    assert.equal(spoken.length, 1, 'the next sentence is not handed to a voice that said nothing');
  } finally {
    unmount();
    worker.stop();
    await close();
    for (const [target, name, original] of [[window, 'speechSynthesis', originalSynthesis], [globalThis, 'SpeechSynthesisUtterance', originalUtterance], [globalThis, 'Audio', originalAudio]] as const) {
      if (original) Object.defineProperty(target, name, original);
      else Reflect.deleteProperty(target, name);
    }
  }
});

test('the browser voice\'s place moves with time when it reports no words, and follows its word boundaries when it does', async () => {
  const { useReadAloud, firebase, close } = await loadReadAloud();
  const worker = stubWorker();
  const route = worker.hold('/tts/paragraph');
  const spoken: Array<{ text: string; onstart: (() => void) | null; onboundary: ((event: { name: string; charIndex: number }) => void) | null }> = [];
  const originalSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Clip });
  let now = 5_000;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (utterance: (typeof spoken)[number]) => spoken.push(utterance), cancel: () => {} } });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: class { text: string; lang = ''; onstart = null; onboundary = null; onend = null; onerror = null; constructor(text: string) { this.text = text; } },
  });
  let unmount = () => {};
  try {
    firebase.auth.currentUser = { uid: 'listener', getIdToken: async () => 'test-token' };
    const sentence = 'Agents read untrusted text from the web every day.';
    const view = renderHook(() => useReadAloud([{ passage: 'b0', utterances: [sentence] }], [], {
      title: 'Agents paper',
      onFallback: () => {},
      onError: () => assert.fail('the browser voice should read'),
      onBlocked: () => assert.fail('the start should not be blocked'),
    }));
    unmount = view.unmount;
    act(() => view.result.current.play(0));
    route.refuse(429, 'AI_QUOTA_EXHAUSTED');
    await waitFor(() => assert.equal(spoken.length, 1));
    const utterance = spoken[0];
    const fraction = () => view.result.current.live().fraction;

    utterance.onstart?.();
    now = 6_000;
    assert.equal(fraction(), 15 / sentence.length);
    utterance.onboundary?.({ name: 'sentence', charIndex: 0 });
    assert.equal(fraction(), 15 / sentence.length);
    now = 65_000;
    assert.equal(fraction(), 1);
    utterance.onboundary?.({ name: 'word', charIndex: 7 });
    assert.equal(fraction(), 7 / sentence.length);
  } finally {
    unmount();
    worker.stop();
    await close();
    for (const [target, name, original] of [[window, 'speechSynthesis', originalSynthesis], [globalThis, 'SpeechSynthesisUtterance', originalUtterance], [performance, 'now', originalNow], [globalThis, 'Audio', originalAudio]] as const) {
      if (original) Object.defineProperty(target, name, original);
      else Reflect.deleteProperty(target, name);
    }
  }
});
