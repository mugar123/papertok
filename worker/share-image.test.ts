import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaperShareCard, ShareCard } from './share-card.ts';
import type { ShareOutcome } from './share-pages.ts';
import { createPhotoLoader, handleShareImage } from './share-image.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function memoryCache() {
  const stored = new Map<string, Response>();
  return {
    stored,
    async match(request: Request) {
      const hit = stored.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request: Request, response: Response) {
      stored.set(request.url, response.clone());
    },
  };
}

function cardRequest(path: string, method = 'GET') {
  return new Request(`https://api.papertok.app${path}`, { method, headers: { 'user-agent': 'Twitterbot/1.0' } });
}

function harness(outcome: ShareOutcome, { photo = null as string | null, renderError = null as Error | null } = {}) {
  const calls = { lookups: 0, renders: [] as Array<{ card: ShareCard; photo: string | null }>, photos: [] as string[] };
  return {
    calls,
    deps: {
      cache: memoryCache(),
      admit: async () => true,
      loadRecord: async () => {
        calls.lookups += 1;
        return outcome;
      },
      loadPhoto: async (url: string) => {
        calls.photos.push(url);
        return photo;
      },
      renderCard: async (card: ShareCard, cardPhoto: string | null) => {
        if (renderError) throw renderError;
        calls.renders.push({ card, photo: cardPhoto });
        return PNG;
      },
    },
  };
}

const AUTHOR = { found: true, record: { entity: { name: 'Yiqing Hua', worksCount: 23, citedByCount: 2009 } } };

test('a looked-up author\'s card is drawn once, then answered from the cache', async () => {
  const { calls, deps } = harness(AUTHOR);
  const first = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), deps);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), PNG);
  assert.equal(calls.renders.length, 1);
  assert.equal(calls.renders[0].card.name, 'Yiqing Hua');
  assert.equal(calls.renders[0].card.initials, 'YH');
  assert.deepEqual(calls.photos, [], 'an author has no picture to fetch');

  const again = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), deps);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), PNG);
  assert.equal(calls.renders.length, 1, 'the kept card is not drawn again');
  assert.equal(calls.lookups, 1);
});

test('an institution\'s card carries its Wikimedia picture', async () => {
  const { calls, deps } = harness({
    found: true,
    record: { entity: { name: 'Harvard University', imageUrl: 'https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300' } },
  }, { photo: 'data:image/png;base64,AAAA' });
  const response = await handleShareImage(cardRequest('/share/image/entity/institution/I136199984'), deps);
  assert.equal(response.status, 200);
  assert.equal(calls.photos.length, 1);
  assert.match(calls.photos[0], /^https:\/\/commons\.wikimedia\.org\/w\/index\.php\?.*width=330/);
  assert.equal(calls.renders[0].photo, 'data:image/png;base64,AAAA');
});

test('a card drawn without the picture its entity has is kept an hour, not a day', async () => {
  const { calls, deps } = harness({
    found: true,
    record: { entity: { name: 'Harvard University', imageUrl: 'https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300' } },
  });
  const response = await handleShareImage(cardRequest('/share/image/entity/institution/I136199984'), deps);
  assert.equal(response.status, 200);
  assert.equal(calls.renders[0].photo, null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});

test('a card that cannot be drawn sends its type\'s static image instead', async () => {
  for (const [outcome, renderError] of [
    [{ failed: true }, null],
    [{ found: false }, null],
    [{ found: true, record: { entity: { name: '清华大学' } } }, null],
    [AUTHOR, new Error('the renderer broke')],
  ] as Array<[ShareOutcome, Error | null]>) {
    const { deps } = harness(outcome, { renderError });
    const response = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), deps);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://papertok.app/og/papertok-share-author-0.3.png');
  }
});

test('a fallback is kept too, so a card that cannot be drawn is not drawn on every request', async () => {
  const { calls, deps } = harness(AUTHOR, { renderError: new Error('the renderer broke') });
  let tries = 0;
  const renderCard = async (card: ShareCard, photo: string | null) => {
    tries += 1;
    return deps.renderCard(card, photo);
  };
  const first = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), { ...deps, renderCard });
  const again = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), { ...deps, renderCard });
  assert.equal(first.status, 302);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(tries, 1);
  assert.equal(calls.lookups, 1);
});

test('requests for one card at once draw it once', async () => {
  const { calls, deps } = harness(AUTHOR);
  const responses = await Promise.all([1, 2, 3].map(() => handleShareImage(cardRequest('/share/image/entity/author/A5018713931'), deps)));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.equal(calls.renders.length, 1);
});

test('a kept card drawn without its logo still tells crawlers to ask again within the hour', async () => {
  const { deps } = harness({
    found: true,
    record: { entity: { name: 'Harvard University', imageUrl: 'https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300' } },
  });
  await handleShareImage(cardRequest('/share/image/entity/institution/I136199984'), deps);
  const kept = await handleShareImage(cardRequest('/share/image/entity/institution/I136199984'), deps);
  assert.equal(kept.headers.get('cache-control'), 'public, max-age=3600');
});

test('a project\'s card keeps the funder its page was looked up with', async () => {
  const routes: unknown[] = [];
  const { deps } = harness({ found: true, record: { entity: { name: 'EBRAINS 2.0' } } });
  const response = await handleShareImage(cardRequest('/share/image/entity/project/101147319?funder=EC'), {
    ...deps,
    loadRecord: async (route) => {
      routes.push(route);
      return { found: true, record: { entity: { name: 'EBRAINS 2.0' } } };
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((routes[0] as { lookup: unknown }).lookup, { provider: 'openaire', params: { code: '101147319', fundingShortName: 'EC' } });
});

test('an address with no looked-up entity behind it has no card and spends nothing', async () => {
  for (const path of ['/share/image/entity/author/Wei%20Zhang', '/share/image/list/0123456789abcdef0123456789abcdef', '/share/image/entity/planet/X1', '/share/image/']) {
    const { calls, deps } = harness(AUTHOR);
    const response = await handleShareImage(cardRequest(path), deps);
    assert.equal(response.status, 404, path);
    assert.equal(calls.lookups, 0, path);
  }
});

test('HEAD answers the card\'s status and headers with no body', async () => {
  const { deps } = harness(AUTHOR);
  const response = await handleShareImage(cardRequest('/share/image/entity/author/A5018713931', 'HEAD'), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.body, null);
});

// ------------------------------------------------------------ the picture

function fakeFetch(answers: Record<string, Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected fetch ${url}`);
    return answer;
  }) as typeof fetch;
  return { asked, fetchImpl };
}

const COMMONS = 'https://commons.wikimedia.org/w/index.php?title=Special%3ARedirect%2Ffile%2FLogo.svg&width=330';
const THUMB = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5d/Logo.svg/330px-Logo.svg.png';

test('the picture follows Wikimedia\'s redirect and comes back as a data URL', async () => {
  const { asked, fetchImpl } = fakeFetch({
    [COMMONS]: new Response(null, { status: 301, headers: { location: THUMB } }),
    [THUMB]: new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
  });
  assert.equal(await createPhotoLoader({ fetchImpl })(COMMONS), 'data:image/png;base64,AQID');
  assert.deepEqual(asked, [COMMONS, THUMB]);
});

test('a redirect off Wikimedia, a non-image or an oversized picture is no picture', async () => {
  const offsite = fakeFetch({ [COMMONS]: new Response(null, { status: 302, headers: { location: 'https://example.com/logo.png' } }) });
  assert.equal(await createPhotoLoader({ fetchImpl: offsite.fetchImpl })(COMMONS), null);
  assert.deepEqual(offsite.asked, [COMMONS], 'the other host is never asked');

  const html = fakeFetch({ [THUMB]: new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(await createPhotoLoader({ fetchImpl: html.fetchImpl })(THUMB), null);

  const huge = fakeFetch({ [THUMB]: new Response(new Uint8Array(1_000_001), { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(await createPhotoLoader({ fetchImpl: huge.fetchImpl })(THUMB), null);

  const down = fakeFetch({ [THUMB]: new Response('busy', { status: 503 }) });
  assert.equal(await createPhotoLoader({ fetchImpl: down.fetchImpl })(THUMB), null);

  const insecure = fakeFetch({ [COMMONS]: new Response(null, { status: 301, headers: { location: 'http://upload.wikimedia.org/logo.png' } }) });
  assert.equal(await createPhotoLoader({ fetchImpl: insecure.fetchImpl })(COMMONS), null);
  assert.deepEqual(insecure.asked, [COMMONS]);
});

test('a picture announced as over 1 MB is refused before its body is read', async () => {
  let read = false;
  // No buffering ahead: the stream is pulled only when something reads it.
  const body = new ReadableStream({ pull() { read = true; } }, { highWaterMark: 0 });
  const big = fakeFetch({ [THUMB]: new Response(body, { headers: { 'content-type': 'image/png', 'content-length': '2000000' } }) });
  assert.equal(await createPhotoLoader({ fetchImpl: big.fetchImpl })(THUMB), null);
  assert.equal(read, false);
});

test('more than three redirects is no picture', async () => {
  const hops = [0, 1, 2, 3, 4].map(index => `https://upload.wikimedia.org/hop-${index}.png`);
  const answers = Object.fromEntries(hops.slice(0, 4).map((hop, index) => [hop, new Response(null, { status: 302, headers: { location: hops[index + 1] } })]));
  answers[hops[4]] = new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
  const { asked, fetchImpl } = fakeFetch(answers);
  assert.equal(await createPhotoLoader({ fetchImpl })(hops[0]), null);
  assert.equal(asked.length, 4);
});

const PAPER = { found: true, record: { paper: { title: 'Using thematic analysis in psychology', authors: ['Virginia Braun', 'Victoria Clarke'], journal: 'Qualitative Research in Psychology', year: 2006 } } };
const PAPER_PATH = '/share/image/paper/b3BlbmFsZXg6VzE5NzkyOTAyNjQ';

function paperHarness(outcome: ShareOutcome, renderError: Error | null = null) {
  const { calls, deps } = harness(outcome);
  const cards: PaperShareCard[] = [];
  return {
    calls,
    cards,
    deps: {
      ...deps,
      renderPaperCard: async (card: PaperShareCard) => {
        if (renderError) throw renderError;
        cards.push(card);
        return PNG;
      },
    },
  };
}

test('a paper\'s card is drawn from its record once, then answered from the cache', async () => {
  const { calls, cards, deps } = paperHarness(PAPER);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleShareImage(cardRequest(PAPER_PATH), deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
  }
  assert.equal(calls.lookups, 1);
  assert.deepEqual(cards.map(card => [card.title, card.authors, card.venue]), [
    ['Using thematic analysis in psychology', 'Virginia Braun, Victoria Clarke', 'Qualitative Research in Psychology · 2006'],
  ]);
});

test('a paper that is missing, undrawable or fails to draw sends the default image', async () => {
  for (const [outcome, renderError] of [
    [{ found: false }, null],
    [{ failed: true }, null],
    [{ found: true, record: { paper: { title: 'Readout with α-tuned pulses', authors: [] } } }, null],
    [PAPER, new Error('the renderer broke')],
  ] as Array<[ShareOutcome, Error | null]>) {
    const { deps } = paperHarness(outcome, renderError);
    const response = await handleShareImage(cardRequest(PAPER_PATH), deps);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://papertok.app/og/papertok-share-0.3.png');
  }
});
