import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripJsComments = (source) => source.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
const stripCssComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE tests: the bar is JSX, which node cannot mount.
 *
 * On the phone, going from Following to For you took several taps (2026-09-05)
 * while the other way took one. The only asymmetry in the bar was the
 * element: Research and Following were NavLinks — an <a href="#/…"> — and
 * For you was a <button> calling navigate('/'). When React's click does not
 * run, an anchor still navigates: the browser follows the href, which is a
 * same-document history navigation and fires `popstate` — the one event
 * react-router's history listens to (it has no `hashchange` listener). A
 * button does nothing. The three tabs are the same element now, so the
 * fallback is the same for all of them.
 */
function linksRow(jsx) {
  const start = jsx.indexOf('className="navbar-links"');
  const end = jsx.indexOf('className="navbar-right"');
  assert.ok(start > 0 && end > start, 'the links row and the right-hand actions must both be in Navbar.jsx');
  return jsx.slice(start, end);
}

test('SOURCE: the three tabs are NavLinks, For you included, so a lost click still navigates through the href', async () => {
  const row = linksRow(stripJsComments(await read('./Navbar.jsx')));
  const navLinks = row.match(/<NavLink\b/g) || [];
  assert.equal(navLinks.length, 3, 'exactly three NavLinks in the links row');
  assert.match(row, /<NavLink\s+to="\/"\s+end\b/, 'For you must be a NavLink to "/" with `end`, or it would match every route');
  assert.match(row, /<NavLink\s+to="\/research"/, 'Research stays a NavLink');
  assert.match(row, /<NavLink\s+to="\/following"/, 'Following stays a NavLink');
  assert.doesNotMatch(row, /<button\b/, 'no <button> in the links row: a button has no href to fall back on');
  assert.doesNotMatch(row, /navigate\(/, 'the tabs must not navigate by hand: the NavLink does, and the href is the fallback');
});

test('SOURCE: For you still keeps the feed in its default mode when tapped', async () => {
  const row = linksRow(stripJsComments(await read('./Navbar.jsx')));
  const forYou = row.match(/<NavLink\s+to="\/"[\s\S]*?<\/NavLink>/);
  assert.ok(forYou, 'the For you NavLink is present');
  assert.match(forYou[0], /setFeedMode\('top'\)/, 'the mode reset rides on the NavLink onClick (React Router runs it before its own)');
  // And on the touch route, where the navigation happens on pointerup and the
  // click that may follow is swallowed: the reset has to happen there too, or
  // a finger would switch tab without it.
  const jsx = stripJsComments(await read('./Navbar.jsx'));
  assert.match(jsx, /if \(tab === 'home'\) setFeedMode\('top'\);/);
});

/**
 * A press is answered by the element itself. On a phone there is no hover
 * and the underline waits for the router; the dip is the same recipe the
 * card's author name uses (paperCardPress.test.js), and it needs `opacity`
 * in the transition list or the dip snaps.
 */
test('SOURCE: a tab dips while pressed, on the compositor, without React', async () => {
  const css = stripCssComments(await read('./Navbar.css'));
  assert.match(css, /\.navbar-link:active \{\s*opacity: 0\.55;\s*\}/, 'the press dip is missing');
  const base = css.match(/^\.navbar-link \{([\s\S]*?)\n\}/m);
  assert.ok(base, 'the .navbar-link base rule exists');
  const transition = base[1].match(/transition:([^;]*);/);
  assert.ok(transition, '.navbar-link declares a transition');
  assert.match(transition[1], /opacity 0\.12s ease-out/, 'opacity must be in the transition list');
  assert.match(transition[1], /background var\(--transition-fast\)/, 'the background fade must survive (transition is a shorthand)');
  assert.match(transition[1], /color var\(--transition-fast\)/, 'the colour fade must survive (transition is a shorthand)');
});

/**
 * Hardened 2026-09-18, after the tabs were reported to need several taps on
 * the phone again. Neither engine loses the tap (Chromium and WebKit, phone
 * emulation, real touch dispatch: click and push within 5ms, centre, edges,
 * after scrolling); what the emulated tap does not model is a thumb, iOS's
 * double-tap window and the ~200ms the bar stays still after the finger
 * lifts while the next page mounts. Three answers, each pinned here.
 */
test('SOURCE: the bar takes no double-tap-to-zoom, so a second quick tap is a click', async () => {
  const css = stripCssComments(await read('./Navbar.css'));
  const bar = css.match(/^\.navbar \{([\s\S]*?)\n\}/m);
  assert.ok(bar, 'the .navbar rule exists');
  assert.match(bar[1], /touch-action: manipulation;/);
});

test('SOURCE: on a touch screen each tab is hit across the whole bar, not only its 30px word', async () => {
  const css = stripCssComments(await read('./Navbar.css'));
  const coarse = css.match(/@media \(pointer: coarse\) \{\s*\.navbar-link::before \{([^}]*)\}/);
  assert.ok(coarse, 'a coarse-pointer hit area on .navbar-link::before');
  assert.match(coarse[1], /content: '';/);
  assert.match(coarse[1], /position: absolute;/);
  assert.match(coarse[1], /top: -11px;/);
  assert.match(coarse[1], /bottom: -11px;/);
  assert.match(coarse[1], /left: 0;/);
  assert.match(coarse[1], /right: 0;/);
  // The anchor is the containing block: it was already `position: relative`
  // for the rule, and the hit area needs the same.
  const base = css.match(/^\.navbar-link \{([\s\S]*?)\n\}/m);
  assert.match(base[1], /position: relative;/);
});

test('SOURCE: the mark moves to the tab under the finger on the press, and the press lapses once the route moves', async () => {
  const jsx = stripJsComments(await read('./Navbar.jsx'));
  const row = linksRow(jsx);
  for (const tab of ['home', 'research', 'following']) {
    assert.match(row, new RegExp(`data-tab="${tab}"`), `${tab} carries its data-tab`);
    assert.match(row, new RegExp(`onPointerDown=\\{\\(event\\) => pressTab\\(event, '${tab}'\\)\\}`), `${tab} presses on pointerdown`);
  }
  assert.equal((row.match(/onPointerCancel=\{releasePress\}/g) || []).length, 3, 'a cancelled press is released on all three');
  // The hook measures the tab it is told, by data-tab, not the router's .active.
  assert.match(jsx, /row\.querySelector\(`\.navbar-link\[data-tab="\$\{tab\}"\]`\)/);
  assert.doesNotMatch(jsx, /querySelector\('\.navbar-link\.active'\)/);
  // Derived, not cleared in an effect: a press counts only while the route is
  // still the one it was made on.
  assert.match(jsx, /const shownTab = pressed && pressed\.on === activeTab \? pressed\.tab : activeTab;/);
  assert.match(jsx, /useActiveTabRule\(linksRef, shownTab, `\$\{shownTab\}:\$\{isEnglish\}`\)/);
  // A press on the tab already current is not a press; a right button is not
  // a press; a press that never becomes a click lapses.
  assert.match(jsx, /if \(event\.button !== 0\) return;/);
  assert.match(jsx, /if \(tab === activeTab\) return;/);
  assert.match(jsx, /setTimeout\(\(\) => setPressed\(\(current\) => \(current === entry \? null : current\)\), 1500\)/);
});

/**
 * The last answer to "the tabs need several taps", after three fixes built on
 * the assumption that the click always arrives.
 *
 * On a phone the click is SYNTHESISED once the finger lifts, and the system
 * may never synthesise it — a gesture recogniser deciding late, a double-tap
 * window, a scroll still settling. The touch pair arrives either way, so the
 * navigation rides `pointerup`. Touch only; a mouse and the keyboard keep the
 * anchor's own click. Guarded so a drag off the bar is not a navigation, and
 * the click that may follow is swallowed or the same route is pushed twice.
 */
test('SOURCE: a finger that lifts on the tab it pressed navigates without waiting for the click', async () => {
  const jsx = stripJsComments(await read('./Navbar.jsx'));
  const row = linksRow(jsx);
  for (const [tab, to] of [['home', '/'], ['research', '/research'], ['following', '/following']]) {
    assert.match(row, new RegExp(`onPointerUp=\\{\\(event\\) => liftTab\\(event, '${tab}', '${to}'\\)\\}`), `${tab} navigates on pointerup`);
  }
  assert.equal((row.match(/swallowSynthesisedClick/g) || []).length, 3, 'all three swallow the click that may follow');
  // Touch only: a mouse keeps the anchor's click, so desktop is untouched.
  assert.match(jsx, /if \(event\.pointerType !== 'touch' \|\| !start \|\| start\.tab !== tab\) return;/);
  // A drag that starts on the bar is not a navigation.
  assert.match(jsx, /Math\.abs\(event\.clientX - start\.x\) > 12 \|\| Math\.abs\(event\.clientY - start\.y\) > 12/);
  assert.match(jsx, /Date\.now\(\) - start\.at > 1500/);
  // And the click that the system may still synthesise is swallowed, or
  // react-router pushes the same route twice and Back needs two presses.
  assert.match(jsx, /handledRef\.current = Date\.now\(\);/);
  assert.match(jsx, /const swallowSynthesisedClick = \(event\) => \{[\s\S]*?event\.preventDefault\(\);/);
  // The pressed tab is only navigated when it is not the one already current.
  assert.match(jsx, /if \(pathname !== to\) navigate\(to\);/);
});
