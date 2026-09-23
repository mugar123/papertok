import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clearAuthReturn, isInAppPath, offerAuthReturn, peekAuthReturn, takeAuthReturn } from './authReturn.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE: App and ProtectedRoute are React this suite cannot mount. The trip
 * was verified end to end in the browser (guest on /search?q=… → sign-in → the
 * onboarding → the search); these pin the three pieces that made it work.
 */
test('SOURCE: the destination lives outside the tree the sign-in remounts', async () => {
  const code = stripComments(await read('../App.jsx'));
  assert.doesNotMatch(code, /pendingReturn/, 'no copy of the destination in AppContent state');
  const block = bounded(code, 'const authArrivalKey = ', 'onboardingComplete || profileLoadError) return', 'the arrival and trip effects', 30);
  assert.match(block, /useEffect\(\(\) => \{\s*if \(!authArrivalKey\) return\s*offerAuthReturn\(arrivalReturnTo\)\s*navigate\(`\$\{location\.pathname\}\$\{location\.search\}`, \{ replace: true, state: null \}\)/);
  assert.match(block, /useEffect\(\(\) => \{\s*if \(!user \|\| authLoading\) return\s*const destination = takeAuthReturn\(\)\s*if \(destination\) navigate\(destination, \{ replace: true \}\)/);
});

test('SOURCE: a door opened from the page drops the trip an earlier bounce left', async () => {
  const code = stripComments(await read('../App.jsx'));
  const block = bounded(code, 'const requestAuthentication = useCallback(', '}, [])', 'requestAuthentication', 6);
  assert.match(block, /clearAuthReturn\(\)\s*setAuthPromptOpen\(true\)/);
});

test('SOURCE: every redirect to the onboarding carries the destination the sign-in brought', async () => {
  const code = stripComments(await read('../components/Auth/ProtectedRoute.jsx'));
  assert.match(code, /const \[carriedDestination\] = useState\(peekAuthReturn\);\s*const onboardingReturnTo = carriedDestination \?\? requestedPath;\s*const onboardingState = useMemo\(\(\) => \(\{ returnTo: onboardingReturnTo \}\), \[onboardingReturnTo\]\);/);
  assert.match(code, /<Navigate to="\/onboarding" replace state=\{onboardingState\} \/>/);
});

test('reading the destination for the onboarding does not use up the trip', () => {
  offerAuthReturn('/search?q=graphene');
  assert.equal(peekAuthReturn(), '/search?q=graphene');
  assert.equal(peekAuthReturn(), '/search?q=graphene');
  assert.equal(takeAuthReturn(), '/search?q=graphene');
  assert.equal(peekAuthReturn(), null);
});

test('a destination offered before sign-in is taken exactly once', () => {
  offerAuthReturn('/search?q=transformers%20attention');
  assert.equal(takeAuthReturn(), '/search?q=transformers%20attention');
  assert.equal(takeAuthReturn(), null, 'a second session event must not travel again');
});

test('a later arrival replaces the destination of an earlier one', () => {
  offerAuthReturn('/lists');
  offerAuthReturn('/search?q=graphene');
  assert.equal(takeAuthReturn(), '/search?q=graphene');
});

test('a new door forgets the destination a bounced guest left behind', () => {
  // The guest closed the dialog and later tapped Save on a card: that sign-in
  // has to leave them on the card, not carry them to the old search.
  offerAuthReturn('/search?q=graphene');
  clearAuthReturn();
  assert.equal(takeAuthReturn(), null);
});

test('only an in-app path is honoured as a destination', () => {
  for (const unsafe of ['//evil.example', 'https://evil.example/x', 'search?q=x', '/login', '/login?returnTo=/lists', '/onboarding', null, undefined, 42]) {
    offerAuthReturn(unsafe);
    assert.equal(takeAuthReturn(), null, String(unsafe));
    assert.equal(isInAppPath(unsafe), false, String(unsafe));
  }
  assert.equal(isInAppPath('/search?q=x'), true);
  assert.equal(isInAppPath('/lists'), true);
});
