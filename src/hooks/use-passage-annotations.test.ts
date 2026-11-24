import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { loadPassageAnnotations } from '../../tests/dom/app-modules.ts';
import { stubWorker } from '../../tests/dom/worker-stub.ts';
import { quoteOffsets } from '../components/pdf/passage-range.ts';

test('AI answers retain distinct repeated passages even when saving is unavailable', async () => {
  const app = await loadPassageAnnotations();
  const { usePassageAnnotations } = app.entry;
  const firebase = await app.firebase();
  const worker = stubWorker();
  worker.hold('/ai/annotate').answer({ note: 'An explanation of this occurrence.', model: 'fixture' });
  try {
    firebase.auth.currentUser = { uid: 'reader', getIdToken: async () => 'test-token' };
    const { result } = renderHook(() => usePassageAnnotations({ uid: 'reader', paperId: '2611.00001', level: 'full-text', language: 'en' }));
    for (const occurrence of [0, 1]) {
      await act(async () => result.current.begin({ sectionId: 'b0', paragraphIndex: 0, quote: 'the model', occurrence }));
      await act(async () => { await result.current.ask(); });
    }
    assert.equal(result.current.annotations.length, 2);
    assert.deepEqual(result.current.annotations.map(item => quoteOffsets('the model fails, and the model succeeds', item.quote, item.occurrence)), [[0, 9], [21, 30]]);
    assert.ok(result.current.annotations.every(item => item.unsaved));
    assert.notEqual(result.current.annotations[0].id, result.current.annotations[1].id);
  } finally {
    cleanup(); worker.stop(); await app.close();
  }
});
