import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string | URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the status chips have their own line under the topic tags, and none leaves no gap', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  const topics = jsx.indexOf('className="pc-topics"');
  const chips = jsx.indexOf('<div className="pc-chips">');
  const title = jsx.indexOf('className="pc-title"');
  const authors = jsx.indexOf('className="pc-authors pc-authors--mobile-clickable"');
  assert.ok(topics > 0 && chips > topics && chips < title && chips < authors, 'the chips sit after the tags, above the headline and the byline');
  assert.equal((jsx.match(/<div className="pc-chips">/g) || []).length, 1, 'one row of chips');
  assert.doesNotMatch(jsx, /closest\('\.pc-chips'\)/, 'the byline no longer carries the chips, so it needs no guard for them');

  const css = await read('./PaperCard.css');
  assert.doesNotMatch(css, /\.pc-authors \.pc-chips/);
  assert.match(css, /\.pc-chips:empty \{\s*display: none;\s*\}/);
});


test('SOURCE: the connections empty state uses a smaller Petri and steps down with the panel instead of running past it', async () => {
  const css = await read('./PaperCard.css');
  const shared = await read('../ui/empty-state.css');
  const rem = (source: string, selector: string) => parseFloat(source.match(new RegExp(`${selector} \\{[^}]*width: ([\\d.]+)rem`))?.[1] as string);
  const panelPetri = rem(css, '\\n\\.graph-empty \\.empty-state-art > svg');
  const sharedPetri = rem(shared, '\\.empty-state-art:not\\(\\.empty-state-art--icon\\) > svg');
  assert.ok(panelPetri > 0 && panelPetri < sharedPetri, 'smaller than every other empty state, at every height');
  assert.match(css, /\.related-sheet--inline \{\s*container: related-panel \/ size;\s*\}/, 'measured on the panel itself');
  const steps = [...css.matchAll(/@container related-panel \(max-height: (\d+)px\) \{([\s\S]*?)\n\}/g)]
    .map(([, height, body]) => ({ height: Number(height), body }));
  const shortest = steps.reduce((low, step) => (step.height < low.height ? step : low), steps[0]);
  assert.ok(steps.length >= 2, 'it steps down more than once');
  assert.match(shortest.body, /\.empty-state-art \{\s*display: none;/, 'on the shortest panel Petri steps aside');
  assert.match(css, /\.graph-empty \{[^}]*overflow-y: auto;/, 'as a last resort it scrolls, it is never cut off');
});

test('SOURCE: a missing abstract is the stacked empty state, centred in the room the abstract would take', async () => {
  const jsx = await read('./PaperCard.tsx');
  assert.doesNotMatch(jsx, /layout="row"/, 'stacked, like every other empty state');
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-slot:has\(\.pc-abstract-empty\),\s*\.pc-slot:has\(\.pc-abstract-empty\) > \.pc-slot-track,\s*\.pc-slot-track > \.pc-slot-face:has\(\.pc-abstract-empty\) \{\s*flex-grow: 1;\s*\}/);
  assert.match(css, /\.pc-abstract:has\(> \.pc-abstract-empty\) \{\s*flex-grow: 1;\s*display: flex;\s*flex-direction: column;\s*justify-content: center;\s*\}/);
});

test('SOURCE: on a no-abstract card the rail follows the empty state, kept inside the card, and no other card moves its rail', async () => {
  const jsx = await read('./PaperCard.tsx');
  const effect = jsx.slice(jsx.indexOf("card.style.removeProperty('--rail-shift')") - 120, jsx.indexOf('}, [abstractText, relatedInline]);'));
  assert.match(effect, /if \(abstractText \|\| relatedInline\) \{\s*card\.style\.removeProperty\('--rail-shift'\);/, 'only the no-abstract state shifts it');
  assert.match(effect, /Math\.max\(-room, Math\.min\(room, /, 'clamped so the rail stays on the card');
  assert.match(effect, /observe\(room\)/, 're-measured when the rows above move the state');
  const css = await read('./PaperCard.css');
  const shifts = css.match(/translate: [^;]*var\(--rail-shift, 0px\)/g) || [];
  assert.equal(shifts.length, 2, 'applied by translate on desktop and on the overlaid rail alike');
  assert.doesNotMatch(css, /anchor-name: --pc-state/, 'no anchor positioning, which the desktop rail in flow cannot use');
});
