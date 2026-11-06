import test from 'node:test';
import assert from 'node:assert/strict';
import { startViewerTracking, viewerOutcome } from './viewer-outcome.ts';

const desktopNoText = {
  textSource: null,
  textFailed: false,
  coarsePointer: false,
  hasPdf: true,
  embeddable: true,
  relayable: true,
  iframeLoaded: false,
  embedTimedOut: false,
  pagesDrawn: false,
  relayFailed: false,
  hasLink: true,
};
const phoneNoText = { ...desktopNoText, coarsePointer: true };

test('the viewer outcome is the first thing shown, or why the PDF was not drawn here', () => {
  const cases: [string, Parameters<typeof viewerOutcome>[0], ReturnType<typeof viewerOutcome>][] = [
    ['text still loading', { ...desktopNoText, textSource: undefined }, null],
    ['text shown', { ...desktopNoText, textSource: 'ar5iv' }, { content: 'text', text_status: 'shown', text_source: 'ar5iv' }],
    ['no open copy, a DOI link', { ...desktopNoText, hasPdf: false, embeddable: false }, { content: 'external_link', text_status: 'none', pdf_issue: 'no_open_copy' }],
    ['no open copy and no link', { ...desktopNoText, hasPdf: false, embeddable: false, hasLink: false }, { content: 'none', text_status: 'none', pdf_issue: 'no_open_copy' }],
    ['text failed, no open copy', { ...desktopNoText, textFailed: true, hasPdf: false }, { content: 'external_link', text_status: 'failed', pdf_issue: 'no_open_copy' }],
    ['desktop, iframe loading', desktopNoText, null],
    ['desktop, iframe loaded', { ...desktopNoText, iframeLoaded: true }, { content: 'pdf_embed', text_status: 'none' }],
    ['desktop, iframe timed out', { ...desktopNoText, embedTimedOut: true }, { content: 'external_link', text_status: 'none', pdf_issue: 'timeout' }],
    ['desktop, host refuses framing', { ...desktopNoText, embeddable: false }, { content: 'external_link', text_status: 'none', pdf_issue: 'not_embeddable' }],
    ['phone, pages loading', phoneNoText, null],
    ['phone, pages measured but not drawn', { ...phoneNoText, textFailed: true }, null],
    ['phone, pages drawn', { ...phoneNoText, pagesDrawn: true, textFailed: true }, { content: 'pdf_pages', text_status: 'failed' }],
    ['phone, relay failed', { ...phoneNoText, relayFailed: true }, { content: 'external_link', text_status: 'none', pdf_issue: 'relay_failed' }],
    ['phone, host not relayed', { ...phoneNoText, relayable: false }, { content: 'external_link', text_status: 'none', pdf_issue: 'not_relayable' }],
    ['phone, no open copy', { ...phoneNoText, hasPdf: false, relayable: false }, { content: 'external_link', text_status: 'none', pdf_issue: 'no_open_copy' }],
  ];
  for (const [name, state, expected] of cases) assert.deepEqual(viewerOutcome(state), expected, name);
});

function harness(hiddenAtStart = false) {
  let clock = 1_000;
  let hidden = hiddenAtStart;
  let listener: (() => void) | null = null;
  const sent: [string, Record<string, unknown>][] = [];
  const tracker = startViewerTracking({
    now: () => clock,
    visibility: { hidden: () => hidden, subscribe: next => { listener = next; return () => { listener = null; }; } },
    send: (name, params) => sent.push([name, params]),
  });
  return {
    tracker,
    sent,
    advance: (ms: number) => { clock += ms; },
    setHidden: (next: boolean) => { hidden = next; listener?.(); },
    subscribed: () => listener !== null,
  };
}

test('the viewer sends its opening, its first outcome and its time once each', () => {
  const { tracker, sent, advance, subscribed } = harness();
  assert.deepEqual(sent, [['viewer_open', {}]]);
  advance(1_200);
  tracker.settle({ content: 'pdf_embed', text_status: 'none' });
  tracker.settle({ content: 'external_link', text_status: 'none', pdf_issue: 'timeout' });
  advance(3_800);
  tracker.stop();
  tracker.stop();
  assert.deepEqual(sent.slice(1), [
    ['viewer_content', { content: 'pdf_embed', text_status: 'none', duration_ms: 1_200 }],
    ['viewer_time', { content: 'pdf_embed', seconds: 5, text_seconds: 0 }],
  ]);
  assert.equal(subscribed(), false);
});

test('the viewer time leaves out a hidden tab and splits off the time on the text', () => {
  const { tracker, sent, advance, setHidden } = harness();
  tracker.settle({ content: 'text', text_status: 'shown', text_source: 'arxiv' });
  tracker.showText(true);
  advance(10_000);
  setHidden(true);
  advance(60_000);
  setHidden(false);
  advance(5_000);
  tracker.showText(false);
  advance(4_000);
  tracker.stop();
  assert.deepEqual(sent.at(-1), ['viewer_time', { content: 'text', seconds: 19, text_seconds: 15 }]);
});

test('a viewer opened in a hidden tab and closed before any outcome reports loading', () => {
  const { tracker, sent, advance, setHidden } = harness(true);
  advance(30_000);
  setHidden(false);
  advance(2_000);
  tracker.stop();
  tracker.settle({ content: 'text', text_status: 'shown', text_source: 'arxiv' });
  assert.deepEqual(sent.map(([name]) => name), ['viewer_open', 'viewer_time']);
  assert.deepEqual(sent[1][1], { content: 'loading', seconds: 2, text_seconds: 0 });
});
