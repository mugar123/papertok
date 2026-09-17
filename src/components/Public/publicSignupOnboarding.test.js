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
  // Every public route the router declares is covered by the prefixes.
  const publicPaths = [...code.matchAll(/path="(\/(?:public|explorer)\/[^"]*)"/g)].map(m => m[1]);
  assert.ok(publicPaths.length >= 5, `expected the five public routes, found ${publicPaths.length}`);
  for (const path of publicPaths) {
    assert.ok(path.startsWith('/public/') || path.startsWith('/explorer/'), `${path} is not covered by PUBLIC_ROUTE_PREFIXES`);
  }
});
