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
