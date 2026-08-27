import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The profile page was the last screen still speaking the dark system: pills
 * where the rest of the app has near-square corners, grey cards that lifted on
 * hover, and not one line set in the serif or the mono voice. Direction A
 * ("la ficha") moves it onto the language design.md describes, and these are
 * the parts of that move a stylesheet can be held to.
 *
 * The class-contract half is `listsStyles.test.js`'s check one screen over: a
 * `className` nobody styles renders a bare element and a rule nobody renders is
 * dead weight, and neither produces a warning, a lint error or a build failure.
 * A rewrite this size is exactly where that drift appears.
 */

const JSX = './PublicProfilePage.jsx';
const CSS = './PublicProfilePage.css';

/** Comments name classes in prose; matching them would invent both sides. */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/**
 * Names that legitimately appear on only one side.
 *
 * The two `id` stems wire each tab to its panel with `aria-controls` /
 * `aria-labelledby`; they are built by template literal, so they reach the
 * scan with the interpolation cut off. Anything else added here needs a reason
 * written beside it, or the list becomes cover for the drift this test exists
 * to catch.
 */
const NOT_CLASS_NAMES = new Set([
  'profile-tab-',
  'profile-panel-',
]);

const PATTERN = /(?:public-)?profile-[a-z0-9-]+/g;

const renderedClasses = source => new Set(
  [...stripComments(source).matchAll(PATTERN)]
    .map(match => match[0])
    .filter(name => !NOT_CLASS_NAMES.has(name)),
);

const styledClasses = source => new Set(
  [...stripComments(source).matchAll(/\.((?:public-)?profile-[a-z0-9-]+)/g)].map(match => match[1]),
);

test('every class the profile renders has a rule behind it', async () => {
  const component = await readFile(new URL(JSX, import.meta.url), 'utf8');
  const stylesheet = await readFile(new URL(CSS, import.meta.url), 'utf8');

  const rendered = renderedClasses(component);
  const styled = styledClasses(stylesheet);
  assert.ok(rendered.size > 10, 'expected to have parsed the component');

  const unstyled = [...rendered].filter(name => !styled.has(name)).sort();
  assert.deepEqual(unstyled, [], `classes rendered with no rule behind them: ${unstyled.join(', ')}`);
});

test('every rule in the profile stylesheet is still rendered', async () => {
  const component = await readFile(new URL(JSX, import.meta.url), 'utf8');
  const stylesheet = await readFile(new URL(CSS, import.meta.url), 'utf8');

  const rendered = renderedClasses(component);
  const orphaned = [...styledClasses(stylesheet)].filter(name => !rendered.has(name)).sort();
  assert.deepEqual(orphaned, [], `rules for markup that no longer exists: ${orphaned.join(', ')}`);
});

/**
 * Rule 4 of design.md: radii come from the tokens, and `--radius-full` is for
 * avatars and meters only. Direction A's whole visual claim is that the profile
 * stops being a page of pills — so every remaining round corner has to be
 * something genuinely round.
 */
const ROUND_BY_NATURE = /avatar|spinner|dot|meter/;

test('the profile wears no pills: --radius-full only where a thing is round', async () => {
  const stylesheet = stripComments(await readFile(new URL(CSS, import.meta.url), 'utf8'));

  const offenders = [];
  for (const block of stylesheet.split('}')) {
    if (!block.includes('--radius-full')) continue;
    const selector = block.slice(0, block.indexOf('{')).trim().replace(/\s+/g, ' ');
    if (!ROUND_BY_NATURE.test(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `pill radii left on: ${offenders.join(' | ')}`);
});

/**
 * Rule 1: three voices. The old file used none of them — every line, including
 * the person's name and their bio, was set in the UI sans.
 */
test('the profile speaks the serif and the mono voice', async () => {
  const stylesheet = stripComments(await readFile(new URL(CSS, import.meta.url), 'utf8'));

  assert.ok(
    stylesheet.includes('var(--font-serif)'),
    'nothing is set in the serif: the name, the bio and every title are prose',
  );
  assert.ok(
    stylesheet.includes('var(--mono-label)'),
    'no mono label: counts, kickers and meta lines are machine data',
  );
});

/** Tokens don't reach hardcoded values — design.md's own trap list. */
test('the profile stylesheet carries no colour or radius literal', async () => {
  const stylesheet = stripComments(await readFile(new URL(CSS, import.meta.url), 'utf8'));

  const offences = [];
  stylesheet.split('\n').forEach((line, index) => {
    if (/border-radius:[^;]*\d+(px|rem|em|%)/.test(line)) offences.push(`:${index + 1} hardcoded radius`);
    if (/#[0-9a-f]{3,8}\b/i.test(line)) offences.push(`:${index + 1} hardcoded colour`);
  });
  assert.deepEqual(offences, [], offences.join('; '));
});
