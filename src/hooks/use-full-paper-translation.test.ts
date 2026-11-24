import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadFullPaperTranslationHook, loadReaderTranslationControls } from '../../tests/dom/app-modules.ts';
import { parseArxivHtml } from '../utils/full-text.ts';

test('keeps the original selected across more chunks and drops late results on account switch', async t => {
  const originalParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', { value: window.DOMParser, configurable: true });
  t.after(() => {
    if (originalParser) Object.defineProperty(globalThis, 'DOMParser', originalParser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  });
  const abstract = 'Abstract source '.padEnd(5_995, 'a');
  const parsed = parseArxivHtml(
    `<article class="ltx_document"><div class="ltx_abstract"><p>${abstract}</p></div>`
      + '<p class="ltx_p">Body &amp; source <span class="ltx_font_typewriter">pip install example</span></p></article>',
    'https://arxiv.org/html/1706.03762',
  );
  assert.ok(parsed);
  const doc = parsed;
  const { entry: { useFullPaperTranslation: useTranslation }, firebase, close } = await loadFullPaperTranslationHook();
  t.after(async () => {
    cleanup();
    await close();
  });
  const { auth } = await firebase();
  auth.currentUser = { uid: 'reader-one', getIdToken: async () => 'test-token' };

  const requests: Array<{ stream: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal | null | undefined }> = [];
  const cancelled = new Set<number>();
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    const index = requests.length;
    assert.equal(new URL(url).pathname, '/ai/translate-paper');
    assert.deepEqual(JSON.parse(String(init.body)), {
      query: 'arxiv_id=1706.03762', language: 'es',
      fingerprint: createHash('sha256').update(JSON.stringify([[abstract], ['Body & source ']])).digest('hex'),
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
  const push = (request: number, event: object, splitAccent = false) => {
    const bytes = new TextEncoder().encode(JSON.stringify(event) + '\n');
    const split = splitAccent ? bytes.indexOf(0xc3) + 1 : 0;
    if (split) requests[request].stream.enqueue(bytes.slice(0, split));
    requests[request].stream.enqueue(bytes.slice(split));
  };

  function Reader({ uid }: { uid: string }) {
    const { session, translate, toggleOriginal, cancel } = useTranslation(doc, 'arxiv_id=1706.03762', uid);
    const text = [...(session?.showing ? session.blocks.values() : [])]
      .flatMap(block => block.t === 'p' ? block.children : [])
      .flatMap(inline => inline.t === 'text' ? [inline.text] : []).join(' ');
    return createElement('div', null,
      createElement('button', { onClick: () => { void translate('es'); } }, 'Translate'),
      createElement('button', { onClick: toggleOriginal }, 'Toggle original'),
      createElement('button', { onClick: cancel }, 'Cancel translation'),
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

  fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
  await waitFor(() => assert.equal(requests.length, 3));
  push(2, { type: 'chunk', index: 0, segments: ['Traducción'] }, true);
  assert.ok(await screen.findByText('Traducción'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel translation' }));
  assert.equal(requests[2].signal?.aborted, true);
  assert.ok(screen.getByText('Original article'));
  push(2, { type: 'error', code: 'AI_TIMEOUT' });
  await waitFor(() => assert.ok(cancelled.has(2)));

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
  assert.equal(requests.length, 3);
});

test('the reader offers only paper translation and describes the Anthropic transfer', async t => {
  const { entry: { ReaderTranslationControls }, close } = await loadReaderTranslationControls();
  t.after(async () => {
    cleanup();
    await close();
  });
  const onTranslate = t.mock.fn();
  const onCancel = t.mock.fn();
  const props = {
    signedIn: true,
    pending: false,
    message: '',
    onTranslate,
    onCancel,
  };
  const view = render(createElement(ReaderTranslationControls, props));
  const summary = screen.getByText('Translate paper', { selector: 'summary' });
  const disclosure = summary.closest('details');
  assert.ok(disclosure);
  disclosure.open = true;
  const language = screen.getByRole('combobox', { name: 'Translation language' });
  assert.equal(screen.getAllByRole('combobox').length, 1);
  assert.equal(screen.queryByRole('option', { name: 'Title and abstract' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Translate abstract' }), null);
  const button = screen.getByRole('button', { name: 'Translate paper' });
  const link = screen.getByRole('link', { name: 'Privacy policy' });
  assert.equal(link.getAttribute('href'), '/privacy.html');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.parentElement?.id, button.getAttribute('aria-describedby'));
  assert.equal(link.parentElement?.textContent, 'Sends the article text to Anthropic. Privacy policy');
  fireEvent.change(language, { target: { value: 'es' } });
  const form = button.closest('form');
  assert.ok(form);
  fireEvent.submit(form);
  assert.deepEqual(onTranslate.mock.calls.map(call => call.arguments), [['es']]);

  view.rerender(createElement(ReaderTranslationControls, { ...props, pending: true, progress: { completed: 1, total: 2 } }));
  assert.equal(screen.getByRole('progressbar', { name: 'Full-paper translation progress' }).getAttribute('value'), '1');
  fireEvent.submit(form);
  assert.equal(onTranslate.mock.callCount(), 1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel translation' }));
  assert.equal(onCancel.mock.callCount(), 1);
  assert.equal(document.activeElement, button);

  view.rerender(createElement(ReaderTranslationControls, { ...props, unavailable: 'Full-paper translation is currently unavailable.' }));
  assert.equal(screen.queryByRole('button', { name: 'Translate paper' }), null);
  assert.equal(screen.queryByRole('link', { name: 'Privacy policy' }), null);
  assert.ok(screen.getByText('Full-paper translation is currently unavailable.'));
  assert.equal(document.activeElement, summary);
});
