import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { loadReadAloudListen } from '../../../tests/dom/component-modules.ts';

test('after a jump the line holds the place asked for until the voice reports it is there', async () => {
  const { ReadAloudListen, close } = await loadReadAloudListen();
  try {
    const chapters = [{ number: '1', title: 'Method', start: 0, end: 200 }];
    const timeline = { passages: [{ start: 0, end: 100 }, { start: 100, end: 200 }], chapters, duration: 200 };
    const queue = [{ passage: 'p0', utterances: ['First.'] }, { passage: 'p1', utterances: ['Second.'] }];
    const seeks: number[] = [];
    const player = (position: number) => ({
      timeline, startup: { start: 0, ready: 2, total: 2, failed: false }, buffering: false, paragraph: null, position,
      playing: false, speed: 1, timings: {}, live: () => ({ seconds: null, fraction: 0 }), setSpeed() {},
      seek: (seconds: number) => { seeks.push(seconds); },
    });
    const tab = (position: number) => createElement(ReadAloudListen, { title: 'Paper', queue, player: player(position), onPlayPause() {} });
    const view = render(tab(10));
    const line = screen.getByRole<HTMLInputElement>('slider', { name: 'Position in the paper' });

    fireEvent.change(line, { target: { value: '150' } });
    fireEvent.blur(line);
    assert.deepEqual(seeks, [150]);
    view.rerender(tab(10));
    assert.equal(line.value, '150', 'the voice still says where it was: the line stays where it was sent');

    view.rerender(tab(150.4));
    view.rerender(tab(160));
    assert.equal(line.value, '160', 'once the voice is there, the line follows it again');
  } finally {
    cleanup();
    await close();
  }
});
