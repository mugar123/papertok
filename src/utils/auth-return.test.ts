import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAuthReturn, isInAppPath, offerAuthReturn, peekAuthReturn, takeAuthReturn } from './auth-return.ts';

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
  for (const unsafe of [
    '//evil.example', 'https://evil.example/x', 'search?q=x', '/login', '/login?returnTo=/lists', '/onboarding', null, undefined, 42,
    // The browser drops the tab or newline, or reads the backslash as a slash,
    // and resolves each of these to //evil.example.
    '/\t/evil.example', '/\n/evil.example', '/\r\\evil.example', '/\\evil.example',
  ]) {
    offerAuthReturn(unsafe);
    assert.equal(takeAuthReturn(), null, String(unsafe));
    assert.equal(isInAppPath(unsafe), false, String(unsafe));
  }
  assert.equal(isInAppPath('/search?q=x'), true);
  assert.equal(isInAppPath('/lists'), true);
});
