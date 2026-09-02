import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lazyWithPreload } from './lazyPreload.js';

/**
 * Under `AnimatePresence mode="wait"` the incoming screen first renders the
 * moment the outgoing one has finished leaving, and a `React.lazy` that has
 * not rendered before suspends there even with its chunk in the module cache.
 * React then commits the fallback and holds it for its 300 ms throttle: a
 * blank beat between exit and entrance, once per screen per session. A route
 * that has been preloaded must render synchronously, without a fallback.
 */
const Screen = ({ label = 'screen' }) => createElement('p', null, label);

function paint(Route, props) {
  return renderToStaticMarkup(
    createElement(Suspense, { fallback: createElement('i', null, 'fallback') }, createElement(Route, props)),
  );
}

test('a preloaded route renders its screen on the first paint, with no fallback', async () => {
  let loads = 0;
  const Route = lazyWithPreload(async () => { loads += 1; return { default: Screen }; });
  await Route.preload();
  assert.equal(paint(Route, { label: 'research' }), '<p>research</p>');
  assert.equal(loads, 1);
});

test('a cold route still goes through the fallback, exactly as React.lazy does', async () => {
  const Route = lazyWithPreload(async () => ({ default: Screen }));
  assert.equal(paint(Route), '<i>fallback</i>');
  await Route.preload();
  assert.equal(paint(Route), '<p>screen</p>', 'and lands once the module is in');
});

test('preload shares one load between the prefetch and the render, and forgets a failure', async () => {
  let attempts = 0;
  const Route = lazyWithPreload(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('chunk unreachable');
    return { default: Screen };
  });
  await assert.rejects(Route.preload(), /chunk unreachable/);
  assert.equal(Route.preload(), Route.preload(), 'the retry is one promise, however many ask');
  await Route.preload();
  assert.equal(attempts, 2);
  assert.equal(paint(Route), '<p>screen</p>');
});
