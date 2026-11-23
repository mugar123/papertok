import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startAppModules } from '../../tests/dom/app-modules.ts';
import { parseArxivHtml } from '../utils/full-text.ts';
import type { useFullPaperTranslation } from './use-full-paper-translation.ts';

test('keeps the original selected across more chunks and drops late results on account switch', async t => {
  const originalParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', { value: window.DOMParser, configurable: true });
  t.after(() => {
    if (originalParser) Object.defineProperty(globalThis, 'DOMParser', originalParser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  });
  const doc = parseArxivHtml(
    '<article class="ltx_document"><div class="ltx_abstract"><p>Abstract source</p></div>'
      + '<p class="ltx_p">Body &amp; source <span class="ltx_font_typewriter">pip install example</span></p></article>',
    'https://arxiv.org/html/1706.03762',
  );
  assert.ok(doc);
  const app = await startAppModules();
  t.after(async () => {
    cleanup();
    await app.close();
  });
  const { useFullPaperTranslation: useTranslation } = await app.load<{ useFullPaperTranslation: typeof useFullPaperTranslation }>('/src/hooks/use-full-paper-translation.ts');
  const { auth } = await app.firebase();
  auth.currentUser = { uid: 'reader-one', getIdToken: async () => 'test-token' };

  const requests: Array<{ stream: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal | null | undefined }> = [];
  const cancelled = new Set<number>();
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    const index = requests.length;
    assert.equal(new URL(url).pathname, '/ai/translate-paper');
    assert.deepEqual(JSON.parse(String(init.body)), {
      query: 'arxiv_id=1706.03762', language: 'es',
      fingerprint: createHash('sha256').update(JSON.stringify([['Abstract source'], ['Body & source ']])).digest('hex'),
    });
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        requests.push({ stream, signal: init.signal });
      },
      cancel() { cancelled.add(index); },
    });
    return Promise.resolve(new Response(body, {
      headers: { 'content-type': 'application/x-ndjson' },
    }));
  });
  const push = (request: number, event: object) => {
    requests[request].stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  };

  function Reader({ uid }: { uid: string }) {
    const { session, translate, toggleOriginal } = useTranslation(doc, 'arxiv_id=1706.03762', uid);
    const text = [...(session?.showing ? session.blocks.values() : [])]
      .flatMap(block => block.t === 'p' ? block.children : [])
      .flatMap(inline => inline.t === 'text' ? [inline.text] : []).join(' ');
    return createElement('div', null,
      createElement('button', { onClick: () => { void translate('es'); } }, 'Translate'),
      createElement('button', { onClick: toggleOriginal }, 'Toggle original'),
      createElement('p', null, session ? `${session.completed} ${session.pending ? 'pending' : 'done'}` : 'No translation'),
      createElement('p', null, text || 'Original article'),
    );
  }

  const view = render(createElement(Reader, { uid: 'reader-one' }));
  fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
  await waitFor(() => assert.equal(requests.length, 1));
  push(0, { type: 'chunk', index: 0, segments: ['Resumen'] });
  assert.ok(await screen.findByText('Resumen'));

  fireEvent.click(screen.getByRole('button', { name: 'Toggle original' }));
  assert.ok(screen.getByText('Original article'));
  push(0, { type: 'chunk', index: 1, segments: ['Cuerpo'] });
  push(0, { type: 'done', count: 2 });
  assert.ok(await screen.findByText('2 done'));
  assert.ok(screen.getByText('Original article'));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle original' }));
  assert.ok(screen.getByText('Resumen Cuerpo'));

  auth.currentUser = { uid: 'reader-two', getIdToken: async () => 'test-token' };
  view.rerender(createElement(Reader, { uid: 'reader-two' }));
  assert.ok(screen.getByText('No translation'));
  fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
  await waitFor(() => assert.equal(requests.length, 2));
  auth.currentUser = { uid: 'reader-three', getIdToken: async () => 'test-token' };
  view.rerender(createElement(Reader, { uid: 'reader-three' }));
  assert.equal(requests[1].signal?.aborted, true);
  push(1, { type: 'chunk', index: 0, segments: ['Resumen anterior'] });
  push(1, { type: 'error', code: 'AI_TIMEOUT' });
  await waitFor(() => assert.ok(cancelled.has(1)));
  assert.ok(screen.getByText('No translation'));
  assert.equal(screen.queryByText('Resumen anterior'), null);

  let finishDigest: (value: ArrayBuffer) => void = () => {};
  const digest = new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; });
  t.mock.method(crypto.subtle, 'digest', () => digest);
  fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
  assert.ok(screen.getByText('0 pending'));
  // Firebase changes before the context has rerendered the reader.
  auth.currentUser = { uid: 'reader-four', getIdToken: async () => 'test-token' };
  finishDigest(new ArrayBuffer(32));
  await digest;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
});
