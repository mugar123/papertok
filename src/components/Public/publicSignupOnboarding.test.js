import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: a new account that signed in from a public page is sent to the onboarding, with the page as the way back', async () => {
  // The public routes are not behind ProtectedRoute, and their doors (like,
  // save, follow) only open the AuthPrompt: nothing used to take a brand-new
  // account from there to choose its interests (audit of 2026-09-16,
  // hallazgo 2).
  const code = stripComments(await readFile(new URL('../../App.jsx', import.meta.url), 'utf8'));
  assert.match(code, /const PUBLIC_ROUTE_PREFIXES = \['\/public\/', '\/explorer\/'\]/);
  assert.match(code, /function isPublicRoute\(path\) \{\s*return PUBLIC_ROUTE_PREFIXES\.some\(prefix => path\.startsWith\(prefix\)\)\s*\}/);
  const effect = code.match(
    /useEffect\(\(\) => \{\s*if \(!user \|\| authLoading \|\| onboardingComplete \|\| profileLoadError\) return\s*if \(!isPublicRoute\(location\.pathname\)\) return\s*navigate\('\/onboarding', \{ replace: true, state: \{ returnTo: `\$\{location\.pathname\}\$\{location\.search\}` \} \}\)\s*\}, \[user, authLoading, onboardingComplete, profileLoadError, location\.pathname, location\.search, navigate\]\)/,
  );
  assert.ok(effect, 'the public-page arrival effect is missing or reshaped');
  // Every route the router declares, and whether it sits behind ProtectedRoute.
  // Deriving the list from `path="/public/..."` — as this test first did — was
  // circular: the extraction already guaranteed what the assertion checked. A
  // guest-reachable route added later under some other prefix would have
  // slipped through in silence, which is the very gap this task exists to
  // close. Now every declared route justifies itself: behind the guard, a
  // redirect with no page to strand anyone on, or covered by a prefix the
  // effect actually reads.
  const declaredPrefixes = code.match(/const PUBLIC_ROUTE_PREFIXES = \[([^\]]*)\]/);
  assert.ok(declaredPrefixes, 'PUBLIC_ROUTE_PREFIXES is gone or reshaped');
  const covered = [...declaredPrefixes[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(covered.length > 0, 'no prefixes are declared, so nothing is covered');

  const REDIRECT_ONLY = ['*', '/login', '/report'];
  const declared = code.split(/<Route\b/).slice(1)
    .map(chunk => ({
      path: (chunk.match(/path="([^"]*)"/) || [])[1],
      guarded: chunk.split(/<\/Route>|\/>/)[0].includes('ProtectedRoute'),
    }))
    .filter(route => route.path);
  assert.equal(declared.length, 20, `expected the whole route table, found ${declared.length}`);

  const guestReachable = declared.filter(route => !route.guarded && !REDIRECT_ONLY.includes(route.path));
  assert.equal(
    guestReachable.length,
    5,
    `expected the five public pages, found ${guestReachable.length}: ${guestReachable.map(route => route.path).join(', ')}`,
  );
  for (const route of guestReachable) {
    assert.ok(
      covered.some(prefix => route.path.startsWith(prefix)),
      `${route.path} is guest-reachable but no PUBLIC_ROUTE_PREFIXES entry covers it: an account created there would never reach the onboarding`,
    );
  }
});
