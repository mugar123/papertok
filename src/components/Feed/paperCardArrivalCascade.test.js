import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * The card entrance is decided by five rule sets that all target the same
 * nine pieces, and three separate rounds on this file each broke a different
 * one of them by changing a selector without working out what it became.
 * Regexes cannot catch that: every one of those rounds left the selector
 * text they pinned intact and still shipped a cascade that resolved the
 * wrong way. So this file resolves the cascade instead of reading it —
 * parse the rules, compute their specificity, apply them in order to a card
 * described by its attributes, and assert the property that actually lands.
 *
 * The four properties it holds, each in its own test below:
 *   1. a card animates when it becomes the active one;
 *   2. the card a back navigation RESUMES onto does not;
 *   3. nothing animates or transitions under `prefers-reduced-motion`;
 *   4. it plays once per card, not on every boundary the reader wobbles over.
 */

const PIECES = [
  'pc-follow-reason', 'pc-meta', 'pc-chips', 'pc-topics', 'pc-title',
  'pc-authors', 'pc-abstract', 'pc-action-bar', 'pc-side-actions',
];
const REDUCE = '@media (prefers-reduced-motion: reduce)';

/** Leaf rule blocks, in document order, each with the at-rules enclosing it. */
function leafRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const stack = [];
  let i = 0;
  let preludeStart = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      const prelude = source.slice(preludeStart, i).trim();
      const nextOpen = source.indexOf('{', i + 1);
      const nextClose = source.indexOf('}', i + 1);
      if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
        rules.push({ at: [...stack], selector: prelude, body: source.slice(i + 1, nextClose) });
        i = nextClose + 1;
        preludeStart = i;
        continue;
      }
      stack.push(prelude);
      i += 1;
      preludeStart = i;
      continue;
    }
    if (ch === '}') { stack.pop(); i += 1; preludeStart = i; continue; }
    i += 1;
  }
  return rules;
}

/**
 * One compound selector: classes and attribute selectors only. Anything else
 * — a child combinator, a pseudo-class, an element name — throws rather than
 * being quietly ignored, so a selector shape this evaluator cannot reason
 * about fails the suite instead of passing it.
 */
function parseCompound(text) {
  const parts = { classes: [], attrs: [] };
  let rest = text;
  while (rest.length > 0) {
    const asClass = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
    if (asClass) { parts.classes.push(asClass[1]); rest = rest.slice(asClass[0].length); continue; }
    const asAttr = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/.exec(rest);
    if (asAttr) { parts.attrs.push([asAttr[1], asAttr[2]]); rest = rest.slice(asAttr[0].length); continue; }
    throw new Error(`this evaluator only understands classes and attributes: ${text}`);
  }
  return parts;
}

const parseSelector = (selector) => selector.trim().split(/\s+/).map(parseCompound);
/** (0, classes + attributes, 0): no ids and no element names anywhere here. */
const specificityOf = (compounds) => compounds.reduce((sum, c) => sum + c.classes.length + c.attrs.length, 0);

const compoundMatches = (compound, node) =>
  compound.classes.every(name => node.classes.includes(name))
  && compound.attrs.every(([name, value]) => (value === undefined
    ? node.attrs[name] !== undefined
    : node.attrs[name] === value));

/** Descendant combinators only, matched from the right over an ancestor path. */
function selectorMatches(compounds, path) {
  if (!compoundMatches(compounds[compounds.length - 1], path[path.length - 1])) return false;
  let cursor = path.length - 2;
  for (let c = compounds.length - 2; c >= 0; c -= 1) {
    while (cursor >= 0 && !compoundMatches(compounds[c], path[cursor])) cursor -= 1;
    if (cursor < 0) return false;
    cursor -= 1;
  }
  return true;
}

/** The `animation`/`transition` declarations of one rule body, in order. */
function animationDeclarations(body) {
  return [...body.matchAll(/(^|[;{\s])(animation|animation-name|transition)\s*:\s*([^;}]+)/g)]
    .map(match => [match[2], match[3].trim()]);
}

/**
 * The card as the browser sees it: the page wrapper that carries the
 * navigation direction, the `.pc` root with its three state attributes, and
 * the piece the animation is actually declared on.
 */
function cardPath({ navDirection = 1, active = true, arrived = false, mountedActive = false, piece }) {
  const attrs = { 'data-active': active ? 'true' : 'false' };
  if (arrived) attrs['data-arrived'] = 'true';
  if (mountedActive) attrs['data-mounted-active'] = 'true';
  return [
    { classes: ['page-transition'], attrs: { 'data-nav-direction': String(navDirection) } },
    { classes: ['pc'], attrs },
    { classes: [piece], attrs: {} },
  ];
}

/** What the cascade actually leaves on `animation-name` and `transition`. */
function resolve(rules, state, reducedMotion) {
  const matching = [];
  rules.forEach((rule, order) => {
    for (const at of rule.at) {
      assert.equal(at, REDUCE, `unmodelled at-rule around an arrival selector: ${at}`);
    }
    if (rule.at.includes(REDUCE) && !reducedMotion) return;
    for (const selector of rule.selector.split(',')) {
      const compounds = parseSelector(selector);
      if (!selectorMatches(compounds, cardPath(state))) continue;
      matching.push({ specificity: specificityOf(compounds), order, declarations: animationDeclarations(rule.body) });
      break;
    }
  });
  matching.sort((a, b) => (a.specificity - b.specificity) || (a.order - b.order));
  const computed = { animationName: 'none', transition: 'none' };
  for (const { declarations } of matching) {
    for (const [property, value] of declarations) {
      // The shorthand resets every animation longhand, the `animation-name`
      // longhand only its own — which is the whole point of `pcArriveAside`
      // sitting where it does.
      if (property === 'animation') computed.animationName = value === 'none' ? 'none' : value.split(/\s+/)[0];
      if (property === 'animation-name') computed.animationName = value;
      if (property === 'transition') computed.transition = value;
    }
  }
  return computed;
}

async function arrivalCascade() {
  const rules = leafRules(await read('./PaperCard.css')).filter(rule =>
    /(^|[;{\s])(animation|transition)[a-z-]*\s*:/.test(rule.body)
    && rule.selector.split(',').some(one => PIECES.some(piece => one.trim().endsWith(`.${piece}`))));
  assert.ok(rules.length >= 5, `expected the five arrival rule sets, found ${rules.length}`);
  return rules;
}

const animationNames = (rules, state, reducedMotion = false) =>
  Object.fromEntries(PIECES.map(piece => [piece, resolve(rules, { ...state, piece }, reducedMotion).animationName]));

test('PROPERTY 1: a card animates when it becomes the active one', async () => {
  const rules = await arrivalCascade();
  // Mounted inactive, activated by the reader's own swipe — on a page
  // reached either way round, because becoming active is what the entrance
  // is tied to now, not how the reader got to the feed.
  for (const navDirection of [1, -1]) {
    assert.deepEqual(
      animationNames(rules, { navDirection, active: true, arrived: false, mountedActive: false }),
      {
        'pc-follow-reason': 'pcArriveAside',
        'pc-meta': 'pcArrive',
        'pc-chips': 'pcArrive',
        'pc-topics': 'pcArrive',
        'pc-title': 'pcArrive',
        'pc-authors': 'pcArrive',
        'pc-abstract': 'pcArrive',
        'pc-action-bar': 'pcArrive',
        'pc-side-actions': 'pcArrive',
      },
      `every piece composes in on a page entered with direction ${navDirection}`,
    );
  }
  // And nothing animates on a card that is not the active one.
  const inactive = animationNames(rules, { navDirection: 1, active: false, arrived: false, mountedActive: false });
  assert.deepEqual(new Set(Object.values(inactive)), new Set(['none']));
});

test('PROPERTY 2: the card a back navigation resumes onto stays at rest', async () => {
  const rules = await arrivalCascade();
  const resumed = animationNames(rules, { navDirection: -1, active: true, arrived: false, mountedActive: true });
  assert.deepEqual(new Set(Object.values(resumed)), new Set(['none']), 'every piece of the resumed card sits still');

  // The same card on a page pushed forward is a card arriving, not a card
  // resumed: only `data-nav-direction="-1"` withholds the entrance.
  const pushed = animationNames(rules, { navDirection: 1, active: true, arrived: false, mountedActive: true });
  assert.equal(pushed['pc-title'], 'pcArrive');

  // The regression this rule caused, and the reason it is qualified: the
  // attribute lives on the page wrapper and stays there for the whole visit,
  // so before it was narrowed it went on suppressing every card the reader
  // swiped to afterwards. That case is PROPERTY 1 above, asserted for
  // `navDirection: -1` as well as `1`; this pins the pair together so the
  // two can never be read apart.
  const swipedToAfterwards = animationNames(rules, { navDirection: -1, active: true, arrived: false, mountedActive: false });
  assert.equal(swipedToAfterwards['pc-title'], 'pcArrive', 'a card activated after the resume is the reader arriving somewhere new');
  assert.notEqual(resumed['pc-title'], swipedToAfterwards['pc-title'], 'the two cases must not collapse into one');
});

test('PROPERTY 3: reduced motion drops both the animation and the transition', async () => {
  const rules = await arrivalCascade();
  const states = [
    { navDirection: 1, active: true, arrived: false, mountedActive: false },
    { navDirection: -1, active: true, arrived: false, mountedActive: false },
    { navDirection: -1, active: true, arrived: false, mountedActive: true },
    { navDirection: 1, active: true, arrived: true, mountedActive: false },
  ];
  for (const state of states) {
    const names = animationNames(rules, state, true);
    assert.deepEqual(new Set(Object.values(names)), new Set(['none']), `reduced motion, ${JSON.stringify(state)}`);
  }
  // `.pc-abstract` is the only one of the nine with a transition of its own —
  // the 0.42s max-height/mask-size travel that opens it on tap — and it must
  // go too, or it comes apart from `toggleExpanded`'s instant scroll-back.
  const abstract = { navDirection: 1, active: true, arrived: false, mountedActive: false, piece: 'pc-abstract' };
  assert.match(resolve(rules, abstract, false).transition, /max-height 0\.42s/, 'the panel travels normally');
  assert.equal(resolve(rules, abstract, true).transition, 'none', 'and not at all under reduced motion');
});

test('PROPERTY 4: the entrance plays once per card, not on every boundary crossing', async () => {
  const rules = await arrivalCascade();
  // `data-arrived` is set the first time the card goes back to inactive. A
  // drag that hovers on the snap line, or a deliberate scroll back to
  // re-read the card, then finds the rule already suppressed.
  for (const navDirection of [1, -1]) {
    const again = animationNames(rules, { navDirection, active: true, arrived: true, mountedActive: false });
    assert.deepEqual(new Set(Object.values(again)), new Set(['none']), `a re-activated card stays still (direction ${navDirection})`);
  }
});

/**
 * The latch the two page-level rules read. Both are one-shots on the card
 * itself, and both are load-bearing in the cascade above: the first says the
 * entrance has already been spent, the second says this card was never
 * arriving in the first place.
 */
test('SOURCE: the card publishes both one-shots, and never clears them', async () => {
  const jsx = (await read('./PaperCard.jsx')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    jsx,
    /if \(isActive !== wasActive\) \{\s*setWasActive\(isActive\);\s*if \(wasActive && !hasArrived\) setHasArrived\(true\);\s*\}/,
    'the arrival latch still flips on the first DEactivation',
  );
  assert.match(
    jsx,
    /const mountedActiveRef = useRef\(isActive\);/,
    'and the second latch is the value of isActive at mount, read once and never written',
  );
  assert.match(jsx, /data-arrived=\{hasArrived \? 'true' : undefined\}/);
  assert.match(jsx, /data-mounted-active=\{mountedActiveRef\.current \? 'true' : undefined\}/);
  assert.doesNotMatch(jsx, /mountedActiveRef\.current\s*=/, 'a latch that can be rewritten is not a latch');
});
