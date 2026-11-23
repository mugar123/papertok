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
