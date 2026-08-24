import assert from 'node:assert/strict';
import test from 'node:test';
import { withStubbedFetch } from '../src/test-support/deadlineHarness.js';
import {
  extractFiguresFromHtml,
  fetchPaperFigures,
  isArxivFigureId,
  readHtmlWithinLimit,
} from './paper-figures.js';

const ARXIV = 'https://arxiv.org';
const BASE = 'https://arxiv.org/html/2608.20340';
const HTML_HEADERS = { 'content-type': 'text/html' };

/** The shape a renderer actually answers with: chunked, no declared length. */
function htmlResponse(html) {
  return new Response(html, { headers: HTML_HEADERS });
}

function figureHtml(name) {
  return `<figure class="ltx_figure"><img src="${name}"><figcaption>Figure 1: ${name}</figcaption></figure>`;
}

function rendererOf(url) {
  return String(url).startsWith(ARXIV) ? 'arxiv' : 'ar5iv';
}

/**
 * A body that arrives in chunks and declares no length — the shape the old
 * `content-length` check was blind to. `pulled` records how much of it the
 * reader actually asked for, which is what separates a cap enforced while
 * reading from one that measures a document already held in memory.
 */
function chunkedBody(chunkBytes, chunkCount) {
  const body = { pulled: 0 };
  const chunk = new Uint8Array(chunkBytes).fill(0x78);
  body.stream = new ReadableStream({
    pull(controller) {
      if (body.pulled >= chunkCount) {
        controller.close();
        return;
      }
      body.pulled += 1;
      controller.enqueue(chunk.slice());
    },
  });
  return body;
}

test('accepts well-formed arXiv identifiers, new style and old', () => {
  assert.equal(isArxivFigureId('2608.20340'), true);
  assert.equal(isArxivFigureId('1706.03762'), true);
  // Pre-April-2007 identifiers are exactly the corpus ar5iv exists to render,
  // so rejecting them left the second renderer permanently unreachable.
  assert.equal(isArxivFigureId('math/0211159'), true);
  assert.equal(isArxivFigureId('cond-mat/0102536'), true);
  assert.equal(isArxivFigureId('hep-ph/9901234'), true);
  assert.equal(isArxivFigureId('math.GT/0309136'), true);
  assert.equal(isArxivFigureId('cond-mat.stat-mech/0102536'), true);
  assert.equal(isArxivFigureId('physics.flu-dyn/0512001'), true);
});

test('rejects identifiers that could bend the renderer URL', () => {
  // The identifier is interpolated into a fetched URL, so widening the pattern
  // for the back catalogue must not widen it for anything else.
  assert.equal(isArxivFigureId('../../etc/passwd'), false);
  assert.equal(isArxivFigureId('math/../../etc/passwd'), false);
  assert.equal(isArxivFigureId('math/0309136/../secrets'), false);
  assert.equal(isArxivFigureId('math//0309136'), false);
  assert.equal(isArxivFigureId('a/b/0309136'), false);
  assert.equal(isArxivFigureId('math/0309136?x=1'), false);
  assert.equal(isArxivFigureId('math/0309136#top'), false);
  assert.equal(isArxivFigureId('math/030913'), false);
  assert.equal(isArxivFigureId('math/03091361'), false);
  assert.equal(isArxivFigureId('math@evil/0309136'), false);
  assert.equal(isArxivFigureId('https://evil.example/0309136'), false);
  assert.equal(isArxivFigureId(''), false);
});

test('extracts an image figure with its caption', () => {
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_figure"><img src="2608.20340v1/Fig1.jpg"><figcaption>Figure 1: Schematic of the system.</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures.length, 1);
  assert.equal(figures[0].url, 'https://arxiv.org/html/2608.20340v1/Fig1.jpg');
  assert.equal(figures[0].caption, 'Figure 1: Schematic of the system.');
});

test('extracts vector figures published as <object>', () => {
  // The best diagrams are often SVG, which arXiv emits as an object rather
  // than an img; matching only images lost exactly the figures worth showing.
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_figure"><object type="image/svg+xml" data="2608.20337v1/coalescent_tree.svg"></object><figcaption>Figure 2: A tree.</figcaption></figure>',
    'https://arxiv.org/html/2608.20337', ARXIV,
  );
  assert.equal(figures.length, 1);
  assert.match(figures[0].url, /coalescent_tree\.svg$/);
});

test('skips equations dressed up as figures', () => {
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_equation"><img src="2608.20340v1/eq1.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('skips the page furniture arXiv serves from /static', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="/static/base/1.0.1/images/funders/simons-foundation.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('refuses assets from another origin', () => {
  // A rewritten page must not be able to point the feed at an arbitrary host.
  const figures = extractFiguresFromHtml(
    '<figure><img src="https://evil.example/tracker.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('refuses assets that are not images', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/script.js"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('falls back to alt text when a figure has no caption', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg" alt="Energy levels"></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Energy levels');
});

test('deduplicates a figure repeated across blocks', () => {
  const block = '<figure><img src="2608.20340v1/Fig1.jpg"></figure>';
  assert.equal(extractFiguresFromHtml(block + block, BASE, ARXIV).length, 1);
});

test('caps the number of figures returned', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    `<figure><img src="2608.20340v1/Fig${i}.jpg"></figure>`).join('');
  assert.equal(extractFiguresFromHtml(many, BASE, ARXIV).length, 6);
});

test('a paper with no figures yields an empty list, not an error', () => {
  assert.deepEqual(extractFiguresFromHtml('<p>No figures here.</p>', BASE, ARXIV), []);
  assert.deepEqual(extractFiguresFromHtml('', BASE, ARXIV), []);
});

test('strips markup out of captions', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg"><figcaption>Figure <span class="ltx_tag">1</span>: A <em>bold</em> claim &amp; more.</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Figure 1 : A bold claim & more.');
});

test('keeps escaped markup escaped instead of decoding it twice', () => {
  // Decoding `&amp;` first turned `&amp;lt;` into `&lt;` and the next pass into
  // a real `<`, so a caption that talks about a tag came back carrying one.
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg"><figcaption>Write &amp;lt;div&amp;gt; and &amp;amp; plainly.</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Write &lt;div&gt; and &amp; plainly.');
});

test('decodes entities above the BMP and in hexadecimal', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg"><figcaption>Mood &#128512; span &#x2014; quote &#x201C;x&#x201D;</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Mood \u{1F600} span — quote “x”');
});

test('leaves an unusable numeric entity as literal text', () => {
  // fromCodePoint throws on an out-of-range value or a lone surrogate; one
  // mangled caption must not cost the whole paper its figures.
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg"><figcaption>&#1114112; and &#55296; survive</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, '&#1114112; and &#55296; survive');
});

test('reads a body that fits under the ceiling', async () => {
  const response = htmlResponse('<p>hola</p>');
  assert.equal(response.headers.get('content-length'), null, 'a chunked body declares no length');
  assert.equal(await readHtmlWithinLimit(response, 1024), '<p>hola</p>');
});

test('decodes a character split across two chunks', async () => {
  const bytes = new TextEncoder().encode('café \u{1F600}');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 4));
      controller.enqueue(bytes.slice(4));
      controller.close();
    },
  });
  assert.equal(await readHtmlWithinLimit(new Response(stream), 1024), 'café \u{1F600}');
});

test('stops reading a chunked body once it passes the ceiling', async () => {
  // No `content-length`, so the header check cannot see this coming; the
  // ceiling has to hold while the body is being read.
  const body = chunkedBody(1024, 200);
  const response = new Response(body.stream, { headers: HTML_HEADERS });
  assert.equal(await readHtmlWithinLimit(response, 4 * 1024), null);
  assert.ok(body.pulled <= 8, `buffered ${body.pulled} KiB of a 200 KiB body past a 4 KiB ceiling`);
});

test('refuses a body that declares a length past the ceiling', async () => {
  const body = chunkedBody(1024, 10);
  const response = new Response(body.stream, {
    headers: { ...HTML_HEADERS, 'content-length': String(64 * 1024) },
  });
  assert.equal(await readHtmlWithinLimit(response, 4 * 1024), null);
  // `bodyUsed` rather than the pull counter: a ReadableStream primes its queue
  // with one eager pull on its own, so the honest question is whether anything
  // ever read from the stream.
  assert.equal(response.bodyUsed, false, 'a declared length spares reading the body at all');
});

test('abandons a renderer page that runs past the ceiling without buffering it', async () => {
  // 10 MiB on offer against the module's 4 MiB ceiling, chunked so nothing
  // declares a length. ar5iv is a community service, so an oversized document
  // is a real possibility, and buffering it first costs the worker its memory.
  const bodies = [];
  const stub = async () => {
    const body = chunkedBody(256 * 1024, 40);
    bodies.push(body);
    return new Response(body.stream, { headers: HTML_HEADERS });
  };

  const result = await withStubbedFetch(stub, () => fetchPaperFigures('2608.20340'));
  assert.deepEqual(result.figures, []);
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.ok(body.pulled <= 18, `read ${body.pulled} chunks of 256 KiB past a 4 MiB ceiling`);
  }
});

test('asks both renderers at once and still prefers arXiv', async () => {
  const asked = [];
  let bothInFlight = false;
  const stub = async (url) => {
    asked.push(rendererOf(url));
    if (rendererOf(url) === 'ar5iv') return htmlResponse(figureHtml('ar5iv-copy.png'));
    // arXiv is the slow one here, and ar5iv has long since answered with
    // figures of its own by the time this resolves. Tried in sequence, ar5iv
    // would not even have been asked yet — which is what `bothInFlight` reads.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    bothInFlight = asked.length === 2;
    return htmlResponse(figureHtml('arxiv-preferred.png'));
  };

  const result = await withStubbedFetch(stub, () => fetchPaperFigures('2608.20340'));
  assert.equal(bothInFlight, true, 'both renderers must be in flight together, not one after the other');
  assert.equal(result.source, 'arxiv');
  assert.equal(result.figures.length, 1);
  assert.match(result.figures[0].url, /arxiv-preferred\.png$/);
});

test('falls back to ar5iv when arXiv has not rendered the paper', async () => {
  const asked = [];
  const stub = async (url) => {
    asked.push(String(url));
    if (rendererOf(url) === 'arxiv') return new Response('', { status: 404 });
    return htmlResponse(figureHtml('phase-diagram.png'));
  };

  const result = await withStubbedFetch(stub, () => fetchPaperFigures('cond-mat/0102536'));
  // The slash in an old identifier is a path separator: escaped whole, it
  // becomes %2F and both renderers answer 404.
  assert.deepEqual(asked.sort(), [
    'https://ar5iv.labs.arxiv.org/html/cond-mat/0102536',
    'https://arxiv.org/html/cond-mat/0102536',
  ]);
  assert.equal(result.source, 'ar5iv');
  // Assets resolve against the rendered page, which for an old identifier sits
  // one directory deeper than for a modern one.
  assert.equal(result.figures[0].url, 'https://ar5iv.labs.arxiv.org/html/cond-mat/phase-diagram.png');
});

test('reports no figures when neither renderer has the paper', async () => {
  const stub = async () => new Response('', { status: 404 });
  const result = await withStubbedFetch(stub, () => fetchPaperFigures('2608.20340'));
  assert.deepEqual(result, { id: '2608.20340', figures: [], source: null });
});

test('never touches the network for an identifier it rejects', async () => {
  let calls = 0;
  const stub = async () => { calls += 1; return htmlResponse(''); };

  const result = await withStubbedFetch(stub, () => fetchPaperFigures('math/0309136/../secrets'));
  assert.equal(calls, 0);
  assert.deepEqual(result, { id: 'math/0309136/../secrets', figures: [], source: null });
});
