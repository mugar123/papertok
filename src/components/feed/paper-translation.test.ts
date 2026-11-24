import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { loadAbstractSheet, loadPaperTranslation } from '../../../tests/dom/component-modules.ts';
import { stubWorker } from '../../../tests/dom/worker-stub.ts';
import type { Paper } from '../../models/paper.ts';
import { defaultTranslationLanguage, preferredTranslationLanguage, rememberTranslationLanguage, translationSource } from '../../utils/paper-translation.ts';
import { parseTranslationText } from '../../utils/paper-translation-contract.ts';

const paper: Paper = {
  id: 'arxiv:2611.00829',
  arxivId: '2611.00829v2',
  title: 'An estimate of stellar distances',
  abstract: 'We measure stellar distances using two independent methods.',
  authors: [],
  sources: { primary: 'arxiv', enrichedBy: [] },
};

test('eligibility follows arXiv provenance, canonical ID and usable text', () => {
  assert.deepEqual(translationSource(paper), { arxivId: '2611.00829', title: paper.title, abstract: paper.abstract });
  assert.equal(translationSource({ ...paper, abstractSource: 'crossref' }), null);
  assert.equal(translationSource({ ...paper, arxivId: 'bad-id' }), null);
  assert.equal(translationSource({ ...paper, abstract: 'No abstract available.' }), null);
  assert.equal(translationSource({ ...paper, sources: { primary: 'openalex', enrichedBy: [] } }), null);
});

test('the language default uses the first supported browser preference', () => {
  assert.equal(defaultTranslationLanguage(['en-US', 'pt-BR', 'es']), 'pt');
  for (const tag of ['zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN']) {
    assert.equal(defaultTranslationLanguage([tag, 'ur-PK']), 'zh-Hant', tag);
  }
  for (const tag of ['zh-CN', 'zh-SG', 'zh-Hans-TW']) {
    assert.equal(defaultTranslationLanguage([tag]), 'zh-Hans', tag);
  }
  assert.equal(defaultTranslationLanguage(['iw-IL']), 'he');
  assert.equal(defaultTranslationLanguage(['he-IL']), 'he');
  assert.equal(defaultTranslationLanguage(['ca-ES']), 'ca');
  assert.equal(defaultTranslationLanguage(['gl-ES']), 'gl');
  assert.equal(defaultTranslationLanguage(['eu-ES']), 'eu');
  assert.equal(defaultTranslationLanguage(['en-GB', 'sv']), '');
});

test('the translation parser rejects an oversized title or abstract', () => {
  const text = { title: 'x'.repeat(1_500), abstract: 'x'.repeat(9_000) };
  assert.deepEqual(parseTranslationText(text), text);
  assert.equal(parseTranslationText({ ...text, title: text.title + 'x' }), null);
  assert.equal(parseTranslationText({ ...text, abstract: text.abstract + 'x' }), null);
});

test('the abstract sheet names both translation toggle states', async t => {
  const { AbstractSheet, close } = await loadAbstractSheet();
  t.after(async () => {
    cleanup();
    await close();
  });
  function Sheet() {
    const [showing, setShowing] = useState(true);
    return createElement(AbstractSheet, {
      paper,
      onClose: () => {},
      translation: {
        scope: 'reader', eligible: true, signedIn: true,
        current: { scope: 'reader', showing, translation: { language: 'es', title: 'Distancias estelares', abstract: 'Medimos distancias con dos métodos.' } },
        chooseLanguage: () => 'es' as const,
        translate: async () => { setShowing(true); },
        showOriginal: () => setShowing(false),
      },
    });
  }
  render(createElement(Sheet));
  const original = await screen.findByRole('button', { name: 'Show original title and abstract' });
  assert.equal(original.textContent, 'Show original');
  fireEvent.click(original);
  const translation = screen.getByRole('button', { name: 'Show translation of title and abstract' });
  assert.equal(translation.textContent, 'Show translation');
  fireEvent.click(translation);
  assert.ok(screen.getByRole('button', { name: 'Show original title and abstract' }));
});

test('reader can translate, see the original again and switch accounts without sharing a result or preference', async t => {
  const app = await loadPaperTranslation();
  const worker = stubWorker();
  t.after(async () => {
    cleanup();
    worker.stop();
    localStorage.clear();
    await app.close();
  });
  const route = worker.hold('/ai/translate');
  const firebase = await app.firebase();
  firebase.auth.currentUser = { uid: 'reader-1', getIdToken: async () => 'test-token' };
  const { usePaperTranslation, PaperTranslationButton, PaperTranslationPicker, PaperTranslationStatus, TranslatedPaperText } = app;

  let signInPrompts = 0;
  const onAuthRequired = () => { signInPrompts++; };
  function Reader({ uid }: { uid?: string }) {
    const state = usePaperTranslation(paper, uid, true, onAuthRequired);
    const [expanded, setExpanded] = useState(false);
    const [focusRequested, setFocusRequested] = useState(false);
    return createElement('div', null,
      createElement('button', { type: 'button', onClick: () => setExpanded(true) }, 'Read full abstract'),
      createElement(PaperTranslationButton, { state, onAuthRequired, onChooseLanguage: () => {
        setFocusRequested(true);
        setExpanded(true);
      } }),
      expanded && createElement(PaperTranslationPicker, { key: state.scope, state, focusRequested }),
      createElement(PaperTranslationStatus, { state }),
      state.current.showing && state.current.translation
        ? createElement(TranslatedPaperText, { translation: state.current.translation })
        : paper.abstract,
    );
  }
  rememberTranslationLanguage('reader-1', 'ja', localStorage);
  const view = render(createElement(Reader, { uid: 'reader-1' }));
  function pickerSubmit() {
    const form = screen.getByRole('combobox').closest('form');
    assert.ok(form);
    return within(form).getByRole('button', { name: 'Translate title and abstract' });
  }
  assert.equal(screen.queryByRole('combobox'), null);
  const translateButton = screen.getByRole('button', { name: 'Translate title and abstract' });
  assert.equal(translateButton.textContent, 'Translate');
  assert.ok(translateButton.querySelector('svg[aria-hidden="true"]'));
  fireEvent.click(translateButton);
  await route.requested();
  assert.match(screen.getByRole('status').textContent ?? '', /Translating title and abstract/);
  const title = '恒星までの距離の推定';
  route.answer({ title, abstract: '2つの独立した方法で恒星までの距離を測定する。', language: 'ja', sourceLanguage: 'en' });
  await waitFor(() => assert.equal(screen.getByText(title).closest('[lang]')?.getAttribute('lang'), 'ja'));
  assert.ok(screen.getByText('AI translation · English to Japanese'));
  assert.equal(screen.getByText(title).closest('[translate]')?.getAttribute('translate'), 'no');
  assert.match(screen.getByRole('status').textContent ?? '', /Showing AI translation of the title and abstract in Japanese/);

  const showOriginal = screen.getByRole('button', { name: 'Show original title and abstract' });
  assert.equal(showOriginal.textContent, 'Show original');
  fireEvent.click(showOriginal);
  assert.ok(screen.getByText(paper.abstract ?? ''));
  assert.equal(screen.queryByText(title), null);
  fireEvent.click(screen.getByRole('button', { name: 'Translate title and abstract' }));
  assert.ok(screen.getByText(title));
  fireEvent.click(screen.getByRole('button', { name: 'Read full abstract' }));
  assert.equal(screen.getByRole<HTMLSelectElement>('combobox').value, 'ja');
  assert.equal(pickerSubmit().textContent?.trim(), 'Translate');
  assert.equal(screen.getAllByRole('option').length, 26);
  for (const name of ['Chinese (Traditional)', 'Catalan', 'Hebrew', 'Galician', 'Basque']) {
    assert.ok(screen.getByRole('option', { name }));
  }

  const late = worker.hold('/ai/translate');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } });
  fireEvent.click(pickerSubmit());
  await late.requested();
  assert.equal(preferredTranslationLanguage('reader-1', [], localStorage), 'ja');
  // The SDK can switch accounts before React commits the new account context.
  firebase.auth.currentUser = { uid: 'reader-2', getIdToken: async () => 'new-test-token' };
  await act(async () => { late.refuse(401, 'AI_AUTH_REQUIRED'); });
  assert.equal(signInPrompts, 0);
  assert.equal(preferredTranslationLanguage('reader-1', [], localStorage), 'ja');

  view.rerender(createElement(Reader, { uid: 'reader-2' }));
  firebase.auth.currentUser = { uid: 'reader-1', getIdToken: async () => 'test-token' };
  view.rerender(createElement(Reader, { uid: 'reader-1' }));
  const lateSuccess = worker.hold('/ai/translate');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } });
  fireEvent.click(pickerSubmit());
  await lateSuccess.requested();
  firebase.auth.currentUser = { uid: 'reader-2', getIdToken: async () => 'new-test-token' };
  view.rerender(createElement(Reader, { uid: 'reader-2' }));
  assert.equal(screen.queryByText(title), null);
  await act(async () => {
    lateSuccess.answer({ title: 'Entfernung zu Sternen', abstract: 'Zwei Methoden messen die Entfernung.', language: 'de' });
  });
  assert.equal(screen.queryByText('Entfernung zu Sternen'), null);
  assert.equal(signInPrompts, 0);
  const cardTranslate = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Translate title and abstract' })
    .find(button => button.type === 'button');
  assert.ok(cardTranslate);
  fireEvent.click(cardTranslate);
  assert.equal(screen.getByRole<HTMLSelectElement>('combobox').value, '');
  assert.equal(document.activeElement, screen.getByRole('combobox'));

  view.rerender(createElement(Reader));
  fireEvent.click(screen.getByRole('button', { name: 'Translate title and abstract' }));
  assert.equal(signInPrompts, 1);
  assert.equal(screen.queryByRole('combobox'), null);

  render(createElement(TranslatedPaperText, { translation: { title, abstract: '短い要約。', language: 'ja' } }));
  assert.ok(screen.getByText('AI translation · Japanese'));

  const hebrew = { title: 'מרחקים לכוכבים', abstract: 'מדדנו מרחקים בשתי שיטות.', language: 'he', sourceLanguage: 'en' } as const;
  render(createElement(TranslatedPaperText, { translation: hebrew }));
  assert.ok(screen.getByText('AI translation · English to Hebrew'));
  for (const text of [hebrew.title, hebrew.abstract]) {
    const translated = screen.getByText(text).closest('[lang]');
    assert.equal(translated?.getAttribute('lang'), 'he');
    assert.equal(translated?.getAttribute('dir'), 'auto');
  }
});
