import './dom-environment.ts';
import { act } from '@testing-library/react';

/**
 * What a browser's page translation (Google Translate in Chrome, Edge's and
 * Safari's translators) does to the page: each text node with words in it is
 * taken out and a `<font>` holding the translated words takes its place. React
 * still holds the old text node, so removing it, or inserting a node before
 * it, throws (facebook/react#11538). Text inside `translate="no"` or
 * `.notranslate` is left alone, as the translators do.
 *
 * Returns the number of text nodes replaced.
 */
export function translatePage(root: Node, translate = (text: string) => `[es] ${text}`) {
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim() && !text.parentElement?.closest('[translate="no"], .notranslate')) texts.push(text);
  }
  for (const text of texts) {
    const outer = document.createElement('font');
    const inner = document.createElement('font');
    outer.style.verticalAlign = 'inherit';
    inner.style.verticalAlign = 'inherit';
    inner.textContent = translate(text.data);
    outer.append(inner);
    text.replaceWith(outer);
  }
  return texts.length;
}

/**
 * Runs `update` inside `act` and returns the messages of what React threw
 * while committing the renders it caused: none when the page survived.
 */
export async function renderErrors(update: () => unknown) {
  try {
    await act(async () => { await update(); });
    return [];
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    return errors.map(each => (each instanceof Error ? `${each.name}: ${each.message}` : String(each)));
  }
}
