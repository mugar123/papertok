import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paperLegacyAdapter } from '../src/models/paper.ts';
import { seedPaintsWhole } from '../src/utils/paper-seed.ts';
import { DEFAULT_SHARE_IMAGE, encodePaperKey, getShareImage } from '../src/utils/public-navigation.ts';
import { publicPaperMetadata, readShareSeed } from '../src/utils/share-seed.ts';
import {
  createShareLoader,
  createShellLoader,
  handleSharePage,
  matchShareRoute,
  renderSharePage,
  sharePageModel,
  type ShareRoute,
  type ShareProviders,
} from './share-pages.ts';

// The app shell as the repository builds it. Vite leaves the head tags as
// written and only appends its script and style links, so this is the head a
// crawler received for every public page (audit 2026-09-23, issue 5): the
// title «PaperTok», og:url and canonical at /feed, an empty #root.
const SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function invertedIndex(text: string) {
  const index: Record<string, number[]> = {};
  text.split(' ').forEach((word, position) => {
    (index[word] ||= []).push(position);
  });
  return index;
}

const ABSTRACT = 'We study how video creators earn money outside the advertising program of the platform, through sponsorships, merchandise and crowdfunding, across a large sample of channels.';

// A real work (W4304195660, 2026-09-24), with a fixture abstract.
const OPENALEX_WORK = Object.freeze({
  id: 'https://openalex.org/W4304195660',
  doi: 'https://doi.org/10.1145/3555174',
  ids: { openalex: 'https://openalex.org/W4304195660', doi: 'https://doi.org/10.1145/3555174' },
  title: 'Characterizing Alternative Monetization Strategies on YouTube',
  display_name: 'Characterizing Alternative Monetization Strategies on YouTube',
  publication_year: 2022,
  publication_date: '2022-11-07',
  type: 'article',
  language: 'en',
  primary_location: {
    landing_page_url: 'https://doi.org/10.1145/3555174',
    source: { display_name: 'Proceedings of the ACM on Human-Computer Interaction', type: 'journal' },
  },
  best_oa_location: null,
  open_access: { is_oa: false, oa_url: null },
  authorships: [
    { author: { id: 'https://openalex.org/A5018713931', display_name: 'Yiqing Hua' } },
    { author: { id: 'https://openalex.org/A5011195481', display_name: 'Manoel Horta Ribeiro' } },
  ],
  abstract_inverted_index: invertedIndex(ABSTRACT),
});

const DOI_KEY = encodePaperKey('doi', '10.1145/3555174');
const ARXIV_KEY = encodePaperKey('arxiv', '2609.28470');
const SHARE_ID = '0123456789abcdef0123456789abcdef';

// The entry arXiv answered for 2609.28470 on 2026-09-24, shortened: a paper
// from the day before, which OpenAlex had not indexed by any route yet.
const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2609.28470v1</id>
    <title>StudentBench: AI and human tutoring yield
      equivalent GRE learning gains</title>
    <updated>2026-09-23T17:57:45Z</updated>
    <link href="https://arxiv.org/abs/2609.28470v1" rel="alternate" type="text/html"/>
    <summary>We measured learning gains on quantitative and verbal questions across 2,383 participants receiving AI tutoring, human tutoring, or no tutoring (all p &lt; .002).</summary>
    <published>2026-09-23T17:57:45Z</published>
    <arxiv:primary_category term="cs.AI"/>
    <author><name>Curtis Northcutt</name></author>
    <author><name>Inaara Hasmani</name></author>
  </entry>
</feed>`;

function paperRoute(key = DOI_KEY) {
  return matchShareRoute(new URL(`https://api.papertok.app/share/paper/${key}`)) as Extract<ShareRoute, { kind: 'paper' }>;
}

function foundPaper() {
  return createShareLoader({
    openAlex: async () => OPENALEX_WORK,
    arxiv: async () => { throw new Error('not asked'); },
    openAire: async () => { throw new Error('not asked'); },
    firestore: { getDocument: async () => { throw new Error('not asked'); } },
  })(paperRoute());
}

function headOf(html: string) {
  return html.slice(0, html.indexOf('</head>'));
}

function metaContent(html: string, attribute: string, key: string) {
  const match = headOf(html).match(new RegExp(`<meta\\s+${attribute}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content="([^"]*)"`));
  return match ? match[1] : null;
}

function canonicalOf(html: string) {
  const match = headOf(html).match(/<link rel="canonical" href="([^"]*)"/);
  return match ? match[1] : null;
}

function titleOf(html: string) {
  const match = html.match(/<title>([^<]*)<\/title>/);
  return match ? match[1] : null;
}

function jsonLdOf(html: string) {
  const match = html.match(/<script id="papertok-jsonld" type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

function seedOf(html: string) {
  const match = html.match(/<script type="application\/json" id="papertok-share-seed">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

function memoryCache() {
  const stored = new Map<string, Response>();
  return {
    stored,
    async match(request: Request<unknown,CfProperties<unknown>>) {
      const hit = stored.get(String((request).url));
      return hit ? hit.clone() : undefined;
    },
    async put(request: Request<unknown,CfProperties<unknown>>, response: Response) {
      stored.set(String((request).url), response.clone());
    },
  };
}

function shareRequest(path: string, { method = 'GET', language }: { method?: string; language?: string } = {}) {
  return new Request(`https://api.papertok.app${path}`, {
    method,
    headers: {
      'user-agent': 'WhatsApp/2.23.20.0',
      ...(language ? { 'accept-language': language } : {}),
    },
  });
}

// ---------------------------------------------------------------- routes

test('a share path names its kind, its identity and the public page it stands for', () => {
  const paper = paperRoute();
  assert.equal(paper.kind, 'paper');
  assert.deepEqual(paper.identity, { type: 'doi', value: '10.1145/3555174' });
  assert.equal(paper.canonicalPath, `/public/paper/${DOI_KEY}`);

  const list = matchShareRoute(new URL(`https://api.papertok.app/share/list/${SHARE_ID}`)) as Extract<ShareRoute, { kind: 'list' }>;
  assert.equal(list.kind, 'list');
  assert.equal(list.canonicalPath, `/public/list/${SHARE_ID}`);

  const author = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A5018713931')) as Extract<ShareRoute, { kind: 'entity' }>;
  assert.equal(author.kind, 'entity');
  assert.equal(author.type, 'author');
  assert.equal(author.canonicalPath, '/public/entity/author/A5018713931');
});

test('a share path that cannot name a page is refused before anything is fetched', () => {
  for (const path of [
    '/share/paper/not-a-key',
    '/share/list/ZZZ',
    '/share/user/x',
    '/share/entity/planet/earth',
    '/share/entity/author',
    '/share/nothing/here',
  ]) {
    assert.equal(matchShareRoute(new URL(`https://api.papertok.app${path}`))!.invalid, true, path);
  }
  assert.equal(matchShareRoute(new URL('https://api.papertok.app/openalex/works')), null);
});

test('a DOI with a dot segment is refused before admission, so it cannot open another record', async () => {
  for (const doi of ['10.1234/../../works/W2741809807', '10.1234/./abc']) {
    const key = encodePaperKey('doi', doi)!;
    assert.equal(matchShareRoute(new URL(`https://api.papertok.app/share/paper/${key}`))!.invalid, true, doi);
    const asked: string[] = [];
    let admitted = 0;
    const { deps } = handlerDeps({
      loadRecord: createShareLoader({ openAlex: async (path) => { asked.push(path); return OPENALEX_WORK; } }),
      admit: async () => { admitted += 1; return true; },
    });
    const response = await handleSharePage(shareRequest(`/share/paper/${key}`), deps);
    assert.equal(response.status, 404, doi);
    assert.deepEqual(asked, [], doi);
    assert.equal(admitted, 0, doi);
  }
  // Dots inside a segment are part of the DOI.
  assert.deepEqual(paperRoute(encodePaperKey('doi', '10.1234/a..b')).identity, { type: 'doi', value: '10.1234/a..b' });
});

// -------------------------------------------------------------- language

test('the copy is English whatever the reader\'s Accept-Language says', async () => {
  const outcome = await foundPaper();
  // `sharePageModel` takes no language any more; a legacy third argument is ignored.
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome, 'es'));
  assert.match(html, /<html lang="en">/);
  assert.equal(metaContent(html, 'property', 'og:locale'), 'en_US');
  assert.equal(metaContent(html, 'property', 'og:locale:alternate'), null, 'there is no alternate locale');
  assert.doesNotMatch(html, /es_ES|es-ES/);
});

// ------------------------------------------------------------ one head per kind

test('a paper page carries its own title, description, canonical, og and twitter tags', async () => {
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome));
  const url = `https://papertok.app/public/paper/${DOI_KEY}`;

  assert.equal(titleOf(html), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(metaContent(html, 'property', 'og:title'), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(metaContent(html, 'name', 'twitter:title'), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.match(metaContent(html, 'name', 'description')!, /^We study how video creators earn money/);
  assert.equal(metaContent(html, 'property', 'og:description'), metaContent(html, 'name', 'description'));
  assert.equal(canonicalOf(html), url);
  assert.equal(metaContent(html, 'property', 'og:url'), url);
  assert.equal(metaContent(html, 'name', 'twitter:url'), url);
  assert.equal(metaContent(html, 'property', 'og:type'), 'article');
  assert.equal(metaContent(html, 'property', 'og:locale'), 'en_US');
  assert.equal(metaContent(html, 'name', 'robots'), null, 'a found paper is indexable');
  assert.doesNotMatch(headOf(html), /papertok\.app\/feed/, 'nothing in the head still points at /feed');
  assert.match(html, /<html lang="en">/);

  const jsonLd = jsonLdOf(html);
  assert.equal(jsonLd['@type'], 'ScholarlyArticle');
  assert.equal(jsonLd.name, 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.deepEqual(jsonLd.author.map((author: { name: string }) => author.name), ['Yiqing Hua', 'Manoel Horta Ribeiro']);
  assert.equal(jsonLd.datePublished, '2022-11-07');
  assert.equal(jsonLd.url, url);

  // The static fallback a crawler without JavaScript reads, inside #root.
  const root = html.slice(html.indexOf('<div id="root">'), html.indexOf('</div>', html.indexOf('<div id="root">')));
  assert.match(root, /<h1>Characterizing Alternative Monetization Strategies on YouTube<\/h1>/);
  assert.match(root, /Yiqing Hua, Manoel Horta Ribeiro/);
  assert.match(root, /We study how video creators earn money/);
  assert.match(root, /href="https:\/\/doi\.org\/10\.1145\/3555174"/);
});

test('a list page names the list and links every paper in it', async () => {
  const route = matchShareRoute(new URL(`https://api.papertok.app/share/list/${SHARE_ID}`));
  const outcome = await createShareLoader({
    firestore: {
      getDocument: async path => {
        assert.equal(path, `publicLists/${SHARE_ID}`);
        return {
          exists: true,
          id: SHARE_ID,
          data: {
            title: 'Tutoring with language models',
            description: 'What the evidence says about AI tutors.',
            language: 'en',
            paperCount: 2,
            papers: [
              { id: '10.1145/3555174', doi: '10.1145/3555174', title: 'Characterizing Alternative Monetization Strategies on YouTube', authors: ['Yiqing Hua'] },
              { id: 'arxiv:2609.28470', arxivId: '2609.28470', title: 'StudentBench: AI and human tutoring', authors: ['Curtis Northcutt'] },
            ],
          },
        };
      },
    },
  })(route);

  const html = renderSharePage(SHELL, sharePageModel(route, outcome));
  assert.equal(titleOf(html), 'Tutoring with language models | PaperTok public list');
  assert.equal(metaContent(html, 'name', 'description'), 'What the evidence says about AI tutors.');
  assert.equal(canonicalOf(html), `https://papertok.app/public/list/${SHARE_ID}`);
  assert.equal(jsonLdOf(html)['@type'], 'CollectionPage');
  assert.equal(jsonLdOf(html).inLanguage, 'en-US');
  assert.match(html, /<h2>Papers in this list<\/h2>/);
  assert.match(html, new RegExp(`<a href="/public/paper/${DOI_KEY}">Characterizing Alternative Monetization Strategies on YouTube</a>`));
  assert.match(html, new RegExp(`<a href="/public/paper/${ARXIV_KEY}">StudentBench: AI and human tutoring</a>`));
  assert.equal(metaContent(html, 'property', 'og:image'), 'https://papertok.app/og/papertok-share-list-0.3.png');
  assert.equal(metaContent(html, 'name', 'twitter:image:alt'), getShareImage('list').alt);
});

test('an entity page names the entity and what kind of entity it is', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A5018713931'));
  const asked: Array<{ path: string; params: Record<string, string> }> = [];
  const outcome = await createShareLoader({
    openAlex: async (path, params) => {
      asked.push({ path, params });
      return { id: 'https://openalex.org/A5018713931', display_name: 'Yiqing Hua', works_count: 31 };
    },
  })(route);

  const html = renderSharePage(SHELL, sharePageModel(route, outcome));
  assert.equal(asked[0].path, 'authors/A5018713931');
  // Counts only: OpenAlex's last known institution is a guess the card does not print.
  assert.deepEqual(asked[0].params.select.split(',').sort(), ['cited_by_count', 'display_name', 'id', 'works_count']);
  assert.equal(titleOf(html), 'Yiqing Hua - Author | PaperTok');
  assert.equal(
    metaContent(html, 'name', 'description'),
    'Explore scientific papers, citations, and research connected to Yiqing Hua on PaperTok.',
  );
  assert.equal(canonicalOf(html), 'https://papertok.app/public/entity/author/A5018713931');
  assert.equal(metaContent(html, 'name', 'robots'), null);
  // Its own card, drawn by the Worker, which names the author and the count.
  const image = 'https://api.papertok.app/share/image/entity/author/A5018713931';
  assert.equal(metaContent(html, 'property', 'og:image'), image);
  assert.equal(metaContent(html, 'name', 'twitter:image'), image);
  assert.equal(metaContent(html, 'property', 'og:image:alt'), 'Yiqing Hua, author on PaperTok. 31 works.');
  assert.equal(jsonLdOf(html).image, image);
});

// A name-only page takes its name from the URL, so a preview that printed it
// would let anyone mint a papertok.app card saying anything under our name and
// image (review of 2026-09-25). The preview is PaperTok's own; the name stays
// in the page's copy, as the Explorer itself shows it.
test('an entity known only by a name previews as PaperTok, not indexed, and costs no request', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/Wei%20Zhang?paper=doi:10.1000%2Fx'));
  const outcome = await createShareLoader({
    openAlex: async () => { throw new Error('a name is not an identity to look up'); },
  })(route);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome));
  assert.equal(titleOf(html), 'PaperTok — Discover scientific research');
  assert.equal(metaContent(html, 'property', 'og:title'), 'PaperTok — Discover scientific research');
  assert.equal(metaContent(html, 'name', 'description'), 'PaperTok is an application for exploring and discovering scientific papers from multiple sources.');
  assert.doesNotMatch(headOf(html), /Wei Zhang/, 'the URL\'s text is not the preview');
  assert.equal(metaContent(html, 'property', 'og:image'), `https://papertok.app${DEFAULT_SHARE_IMAGE.path}`);
  assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow', 'a name can mix several people');
  assert.match(html, /<h1>Wei Zhang<\/h1>/, 'the page itself still says whom it was opened for');
});

test('text-direction controls from a URL do not reach the page', async () => {
  const override = String.fromCharCode(0x202e);
  const route = matchShareRoute(new URL(`https://api.papertok.app/share/entity/author/Ada${encodeURIComponent(override)}%20Lovelace`));
  const outcome = await createShareLoader({})(route);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome));
  assert.equal(html.includes(override), false);
  assert.match(html, /<h1>Ada Lovelace<\/h1>/);
});

// ------------------------------------------------------------- escaping

test('everything from a provider or a user is escaped, and no replacement pattern leaks', async () => {
  // A public list's title and description are its owner's words.
  const route = matchShareRoute(new URL(`https://api.papertok.app/share/list/${SHARE_ID}`));
  const outcome = await createShareLoader({
    firestore: {
      getDocument: async () => ({
        exists: true,
        id: SHARE_ID,
        data: { title: 'Ada "</title><script>alert(1)</script>', description: 'Costs $& and $1 & <b>bold</b> \u2028 end', papers: [] },
      }),
    },
  })(route);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome));

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.equal(titleOf(html), 'Ada &quot;&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; | PaperTok public list');
  assert.match(metaContent(html, 'name', 'description')!, /^Costs \$&amp; and \$1 &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  const jsonLd = html.match(/<script id="papertok-jsonld" type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
  assert.doesNotMatch(jsonLd, /<\/script|<b>/i, 'the JSON-LD cannot close its own script element');
  assert.doesNotMatch(jsonLd, /\u2028/, 'nor carry a raw line separator');
  assert.equal(JSON.parse(jsonLd).description.startsWith('Costs $& and $1 & <b>bold</b>'), true);
});

test('LaTeX in a title becomes plain text in the head and stays LaTeX in the seed', async () => {
  const outcome = await createShareLoader({
    openAlex: async () => ({ ...OPENALEX_WORK, title: 'On commensurations of pro-$\\mathcal{C}$ groups', display_name: 'x' }),
  })(paperRoute());
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome));
  assert.equal(titleOf(html), 'On commensurations of pro-C groups');
  assert.equal(metaContent(html, 'property', 'og:title'), 'On commensurations of pro-C groups');
  assert.equal(seedOf(html).paper.title, 'On commensurations of pro-$\\mathcal{C}$ groups', 'the card renders the math itself');
});

// ---------------------------------------------------------------- seed

test('a paper page embeds a seed that parses, names its key and can paint the page', async () => {
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome));
  const seed = seedOf(html);

  assert.equal(seed.key, DOI_KEY);
  assert.equal(encodePaperKey(seed.paper), DOI_KEY, 'the seed is the paper the key names');
  assert.equal(seed.paper.title, 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.deepEqual(seed.paper.authors, [{ name: 'Yiqing Hua' }, { name: 'Manoel Horta Ribeiro' }]);
  assert.equal(seedPaintsWhole(seed.paper), true);
  // A module script runs only once the whole document is parsed, wherever it
  // sits (the built shell puts it in the head), so what matters is that the
  // seed is part of the document, beside the root the app mounts on.
  const seedAt = html.indexOf('id="papertok-share-seed"');
  assert.ok(seedAt > html.indexOf('<div id="root">') && seedAt < html.indexOf('</body>'));
});

test('the page reads back the seed the Worker writes, paints from it and indexes it', async () => {
  // Both sides of the contract at once: the element and the key the Worker
  // writes are the ones src/utils/share-seed.ts reads, and what it reads goes
  // through the same adapter and paint rule as a seed handed over in-app.
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome));
  const text = html.match(/<script type="application\/json" id="papertok-share-seed">([\s\S]*?)<\/script>/)![1];
  const documentStub = { getElementById: (id: string) => (id === 'papertok-share-seed' ? { textContent: text } : null) };
  const paper = readShareSeed(DOI_KEY, documentStub);
  assert.ok(paper, 'read for its own key');
  assert.equal(readShareSeed(ARXIV_KEY, documentStub), null, 'and for no other');
  assert.equal(seedPaintsWhole(paperLegacyAdapter(paper)), true);
  assert.equal(publicPaperMetadata(paperLegacyAdapter(paper), `/public/paper/${DOI_KEY}`).noIndex, undefined);
});

test('only a paper page carries a seed', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A1'));
  const outcome = await createShareLoader({ openAlex: async () => ({ id: 'https://openalex.org/A1', display_name: 'X Y' }) })(route);
  assert.equal(seedOf(renderSharePage(SHELL, sharePageModel(route, outcome))), null);
});

// -------------------------------------------------------------- handler

function handlerDeps(overrides = {}) {
  let loads = 0;
  const deps = {
    loadShell: async () => SHELL,
    loadRecord: async (route: ShareRoute|{ kind: string; invalid: true; }|null) => {
      loads += 1;
      return createShareLoader({ openAlex: async () => OPENALEX_WORK })(route);
    },
    admit: async () => true,
    cache: memoryCache(),
    ...overrides,
  };
  return { deps, loads: () => loads };
}

test('a looked-up entity previews with its own card, drawn by this Worker', async () => {
  const asked: Array<{ path: string; params: Record<string, string> }> = [];
  const { deps } = handlerDeps({
    loadRecord: createShareLoader({
      openAlex: async (path, params) => {
        asked.push({ path, params });
        return {
          id: 'https://openalex.org/I136199984',
          display_name: 'Harvard University',
          works_count: 972371,
          cited_by_count: 192037405,
          geo: { city: 'Cambridge', country: 'United States' },
          image_thumbnail_url: 'https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300',
        };
      },
    }),
  });
  const html = await (await handleSharePage(shareRequest('/share/entity/institution/I136199984'), deps)).text();
  assert.deepEqual(asked[0].params.select.split(',').sort(), ['cited_by_count', 'display_name', 'geo', 'id', 'image_thumbnail_url', 'works_count']);
  const card = 'https://api.papertok.app/share/image/entity/institution/I136199984';
  assert.equal(metaContent(html, 'property', 'og:image'), card);
  assert.equal(metaContent(html, 'name', 'twitter:image'), card);
  assert.equal(metaContent(html, 'property', 'og:image:width'), '1200');
  assert.equal(metaContent(html, 'property', 'og:image:height'), '630');
  assert.equal(
    metaContent(html, 'property', 'og:image:alt'),
    'Harvard University, institution on PaperTok. Cambridge, United States. 972,371 works, 192,037,405 citations.',
  );
  assert.equal(jsonLdOf(html).image, card);
});

test('a page found by a name alone keeps PaperTok\'s own preview, card or no card', async () => {
  const { deps } = handlerDeps();
  const html = await (await handleSharePage(shareRequest('/share/entity/author/Wei%20Zhang'), deps)).text();
  assert.equal(metaContent(html, 'property', 'og:image'), `https://papertok.app${DEFAULT_SHARE_IMAGE.path}`);
  assert.equal(metaContent(html, 'property', 'og:image:width'), '2400');
});

test('a found page answers 200 English HTML even to a Spanish-speaking browser', async () => {
  const { deps } = handlerDeps();
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'es-ES,es;q=0.9' }), deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/html; charset=utf-8/);
  // One language, so nothing downstream needs to keep variants apart.
  assert.equal(response.headers.get('vary'), null);
  assert.equal(response.headers.get('content-language'), 'en');
  assert.match(response.headers.get('cache-control')!, /max-age=300/);
  assert.equal(titleOf(await response.text()), 'Characterizing Alternative Monetization Strategies on YouTube');
});

test('a list page is English whatever the browser asks for, from one provider answer', async () => {
  const route = `/share/list/${SHARE_ID}`;
  let reads = 0;
  const { deps } = handlerDeps({
    loadRecord: createShareLoader({
      firestore: {
        getDocument: async () => {
          reads += 1;
          return { exists: true, id: SHARE_ID, data: { title: 'Tutoring', papers: [] } };
        },
      },
    }),
  });

  const fromSpanish = await (await handleSharePage(shareRequest(route, { language: 'es' }), deps)).text();
  const fromEnglish = await (await handleSharePage(shareRequest(route, { language: 'en-GB' }), deps)).text();
  assert.equal(fromSpanish, fromEnglish);
  assert.equal(titleOf(fromSpanish), 'Tutoring | PaperTok public list');
  assert.equal(metaContent(fromSpanish, 'name', 'description'), 'Explore a public scientific reading list curated on PaperTok.');
  assert.doesNotMatch(fromSpanish, /Lista pública|Explora/);
  // Nothing records the language this list was written in, so its content is
  // not marked as anything other than the page's.
  assert.match(fromSpanish, /<main><h1>Tutoring<\/h1>/);
  assert.equal(reads, 1, 'the record is fetched once and served to every reader');
});

test('a list recorded as written in Spanish marks its own content lang="es"', async () => {
  const { deps } = handlerDeps({
    loadRecord: createShareLoader({
      firestore: {
        getDocument: async () => ({ exists: true, id: SHARE_ID, data: { title: 'Tutorías', language: 'es', papers: [] } }),
      },
    }),
  });
  const html = await (await handleSharePage(shareRequest(`/share/list/${SHARE_ID}`), deps)).text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<main lang="es"><h1>Tutorías<\/h1>/);
});


test('a page that does not exist answers 404 and noindex', async () => {
  // An OpenAlex work id OpenAlex does not have: that answer is final.
  const { deps } = handlerDeps({
    loadRecord: createShareLoader({ openAlex: async () => null }),
  });
  const response = await handleSharePage(shareRequest(`/share/paper/${encodePaperKey('openalex', 'W1')}`, { language: 'es' }), deps);
  const html = await response.text();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow');
  assert.equal(titleOf(html), 'We could not find this paper | PaperTok');
  assert.equal(seedOf(html), null);
  assert.equal(canonicalOf(html), null, 'a missing page claims no canonical address');
});

// OpenAlex indexes a DOI or a PMID days after it appears, and a fresh PubMed
// paper is half of what the Medicine feed shows. «We could not find this
// paper» with a 404 was a regression on the generic preview it replaced, and
// platforms keep a preview for a long time (review of 2026-09-25).
test('a DOI or a PMID OpenAlex has not indexed yet previews as PaperTok, not as missing', async () => {
  for (const key of [DOI_KEY, encodePaperKey('pmid', '42774036')]) {
    const { deps } = handlerDeps({ loadRecord: createShareLoader({ openAlex: async () => null }) });
    const response = await handleSharePage(shareRequest(`/share/paper/${key}`, { language: 'en' }), deps);
    const html = await response.text();
    assert.equal(response.status, 200, key!);
    assert.equal(titleOf(html), 'PaperTok — Discover scientific research');
    assert.equal(canonicalOf(html), `https://papertok.app/public/paper/${key}`);
    assert.equal(metaContent(html, 'name', 'robots'), null);
    assert.equal(response.headers.get('x-robots-tag'), null);
    const [kept] = [...deps.cache.stored.values()];
    assert.match(kept.headers.get('cache-control')!, /s-maxage=3600\b/, 'asked again within the hour');
  }
});

// privacy.html: «from then on it is no longer served». A record kept a day
// outlived unpublishing a list or deleting the account by a day (review of
// 2026-09-25).
test('a list is kept five minutes, so its owner\'s switch reaches the preview', async () => {
  const pages: Array<[string, NonNullable<ShareProviders['firestore']>]> = [
    [`/share/list/${SHARE_ID}`, { getDocument: async () => ({ exists: true, id: SHARE_ID, data: { title: 'Tutoring', papers: [] } }) }],
  ];
  for (const [path, firestore] of pages) {
    const { deps } = handlerDeps({ loadRecord: createShareLoader({ firestore }) });
    const response = await handleSharePage(shareRequest(path), deps);
    const [kept] = [...deps.cache.stored.values()];
    assert.match(kept.headers.get('cache-control')!, /s-maxage=300\b/, path);
    assert.match(response.headers.get('cache-control')!, /max-age=60\b/, path);
  }
});

test('a path that names no page answers 404 and noindex without spending a lookup', async () => {
  // Public profiles are gone: an old profile link is a page nobody names now.
  for (const path of ['/share/paper/not-a-key', '/share/user/ada_l']) {
    const { deps, loads } = handlerDeps();
    const response = await handleSharePage(shareRequest(path), deps);
    assert.equal(response.status, 404, path);
    assert.equal(metaContent(await response.text(), 'name', 'robots'), 'noindex, nofollow', path);
    assert.equal(loads(), 0, path);
  }
});

test('HEAD answers the same status and headers with no body', async () => {
  const { deps } = handlerDeps();
  const head = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { method: 'HEAD' }), deps);
  const get = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  assert.equal(head.headers.get('cache-control'), get.headers.get('cache-control'));
  assert.equal(await head.text(), '');
});

test('an upstream failure gives the generic head at the page address, briefly remembered', async () => {
  let loads = 0;
  const { deps } = handlerDeps({
    loadRecord: async () => {
      loads += 1;
      throw Object.assign(new Error('OpenAlex timed out'), { name: 'TimeoutError' });
    },
  });
  const first = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps);
  const html = await first.text();
  assert.equal(first.status, 200, 'a preview bot shows nothing at all for an error status');
  assert.equal(titleOf(html), 'PaperTok — Discover scientific research');
  assert.equal(canonicalOf(html), `https://papertok.app/public/paper/${DOI_KEY}`);
  assert.equal(metaContent(html, 'name', 'robots'), null, 'an outage is not a reason to drop the page from an index');
  assert.equal(seedOf(html), null);
  assert.match(first.headers.get('cache-control')!, /max-age=60/);

  await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps);
  assert.equal(loads, 1, 'the failure is remembered, so a burst of bots is one upstream call');
});

test('a refused admission is a failure, not a lookup', async () => {
  let loads = 0;
  const { deps } = handlerDeps({
    admit: async () => false,
    loadRecord: async () => { loads += 1; return { found: false }; },
  });
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  assert.equal(response.status, 200);
  assert.equal(titleOf(await response.text()), 'PaperTok — Discover scientific research');
  assert.equal(loads, 0);
});

// A burst of crawlers for one link (a Mastodon fan-out) used to spend a
// lookup each, run the ceilings dry, and leave a refusal cached over the page
// another request had just found (review of 2026-09-25).
test('a refused admission is not remembered: the next request asks again', async () => {
  let admits = 0;
  const { deps } = handlerDeps({ admit: async () => { admits += 1; return admits > 1; } });
  const first = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps);
  assert.equal(titleOf(await first.text()), 'PaperTok — Discover scientific research');
  const second = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps);
  assert.equal(titleOf(await second.text()), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(admits, 2);
});

test('a failure never replaces a record another lookup wrote meanwhile', async () => {
  const cache = memoryCache();
  const recordKey = `https://papertok.internal/cache/share/record/paper/${DOI_KEY}`;
  const { deps } = handlerDeps({
    cache,
    loadRecord: async () => {
      // Another isolate found the paper while this lookup was failing.
      await cache.put(new Request(recordKey), new Response(JSON.stringify({
        found: true,
        record: { paper: { title: 'Found elsewhere', abstract: '', authors: [], doi: '10.1145/3555174' } },
      }), { headers: { 'cache-control': 'public, s-maxage=86400' } }));
      throw new Error('OpenAlex timed out');
    },
  });
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps);
  assert.equal(titleOf(await response.text()), 'Found elsewhere');
  const kept = await (await cache.match(new Request(recordKey)))!.json<{ found: boolean }>();
  assert.equal(kept.found, true, 'the found record is still the one kept');
});

test('identical requests at once share one lookup', async () => {
  let loads = 0;
  let release!: (value?: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const { deps } = handlerDeps({
    loadRecord: async (route: ShareRoute|{ kind: string; invalid: true; }|null) => {
      loads += 1;
      await gate;
      return createShareLoader({ openAlex: async () => OPENALEX_WORK })(route);
    },
  });
  const pending = [1, 2, 3].map(() => handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'en' }), deps));
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const pages = await Promise.all(pending);
  assert.equal(loads, 1);
  for (const page of pages) {
    assert.equal(titleOf(await page.text()), 'Characterizing Alternative Monetization Strategies on YouTube');
  }
});

test('a page found once is served from the record cache the next time', async () => {
  const { deps, loads } = handlerDeps();
  await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  assert.equal(loads(), 1);
  const [cached] = [...deps.cache.stored.values()];
  assert.match(cached.headers.get('cache-control')!, /s-maxage=86400/);
});

test('without its shell the page still answers a minimal document with the same head', async () => {
  const { deps } = handlerDeps({ loadShell: async () => { throw new Error('Vercel is down'); } });
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(titleOf(html), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(canonicalOf(html), `https://papertok.app/public/paper/${DOI_KEY}`);
});

// -------------------------------------------------------------- loaders

test('a DOI key asks OpenAlex for the work by DOI', async () => {
  const asked: Array<{ path: string; params: Record<string, string> }> = [];
  await createShareLoader({ openAlex: async (path, params) => { asked.push({ path, params }); return OPENALEX_WORK; } })(paperRoute());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, 'works/doi:10.1145/3555174');
  assert.match(asked[0].params.select, /abstract_inverted_index/);
});

test('an arXiv key asks OpenAlex by landing page, then arXiv when OpenAlex has not indexed it yet', async () => {
  const asked: unknown[] = [];
  const outcome = await createShareLoader({
    openAlex: async (path, params) => { asked.push(['openalex', path, params.filter]); return { results: [] }; },
    arxiv: async (id) => { asked.push(['arxiv', id]); return ARXIV_FEED; },
  })(paperRoute(ARXIV_KEY));

  assert.deepEqual(asked, [
    ['openalex', 'works', 'locations.landing_page_url:http://arxiv.org/abs/2609.28470|https://arxiv.org/abs/2609.28470'],
    ['arxiv', '2609.28470'],
  ]);
  assert.equal(outcome.found, true);
  assert.equal(outcome.record!.paper!.title, 'StudentBench: AI and human tutoring yield equivalent GRE learning gains');
  assert.deepEqual(outcome.record!.paper!.authors, ['Curtis Northcutt', 'Inaara Hasmani']);
  assert.match(outcome.record!.paper!.abstract!, /\(all p < \.002\)\.$/);
  assert.equal(outcome.record!.paper!.published, '2026-09-23');
});

test('an arXiv answer with no entry is a paper that does not exist', async () => {
  const outcome = await createShareLoader({
    openAlex: async () => ({ results: [] }),
    arxiv: async () => '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  })(paperRoute(ARXIV_KEY));
  assert.deepEqual(outcome, { found: false });
});

// Graph's answer for TAILOR on 2026-10-23, trimmed to the fields a share page reads.
const TAILOR_PAGE = {
  header: { numFound: 1, maxScore: 1, queryTime: 8, page: 1, pageSize: 1 },
  results: [{
    id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a',
    code: '952215',
    acronym: 'TAILOR',
    title: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization',
  }],
};

test('a project is looked up in OpenAIRE by its OpenAIRE id', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/project/corda__h2020%3A%3Ab9871e3e08a9db98aaa42bf321ed0f1a?funder=EC'));
  const asked: unknown[] = [];
  const outcome = await createShareLoader({
    openAire: async (params) => {
      asked.push(params);
      return TAILOR_PAGE;
    },
  })(route);
  assert.deepEqual(asked, [{ id: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a' }]);
  assert.equal((route as ShareRoute).cacheId, 'entity/project/corda__h2020%3A%3Ab9871e3e08a9db98aaa42bf321ed0f1a', 'an OpenAIRE id needs no funder');
  const html = renderSharePage(SHELL, sharePageModel(route, outcome));
  assert.equal(titleOf(html), 'TAILOR: Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization - Research project | PaperTok');
});

test("a grant code is looked up with its funder's short name, and a project Graph does not list is not found", async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/project/100010?funder=SNSF'));
  const asked: unknown[] = [];
  const outcome = await createShareLoader({
    openAire: async (params) => {
      asked.push(params);
      return { header: { numFound: 0, maxScore: 0, queryTime: 4, page: 1, pageSize: 1 }, results: [] };
    },
  })(route);
  assert.deepEqual(asked, [{ code: '100010', fundingShortName: 'SNSF' }]);
  assert.equal((route as ShareRoute).cacheId, 'entity/project/100010?funder=SNSF');
  assert.deepEqual(outcome, { found: false });
});

test('a project answer in the retired Search shape is a failure, not a missing project', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/project/corda__h2020%3A%3Ab9871e3e08a9db98aaa42bf321ed0f1a'));
  const searchShaped = { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:project': { acronym: { $: 'TAILOR' } } } } }] } } };
  await assert.rejects(createShareLoader({ openAire: async () => searchShaped })(route), /Invalid OpenAIRE response/);
});

// -------------------------------------------------------------- shell

test('the shell is fetched once and kept for five minutes', async () => {
  let fetches = 0;
  const cache = memoryCache();
  const loadShell = createShellLoader({
    cache,
    fetchShell: async (url) => {
      fetches += 1;
      assert.equal(url, 'https://papertok.app/index.html');
      return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(await loadShell(), SHELL);
  assert.equal(await loadShell(), SHELL);
  assert.equal(fetches, 1);
  assert.match([...cache.stored.values()][0].headers.get('cache-control')!, /s-maxage=300/);
});

test('a shell that is not the app is refused rather than dressed up', async () => {
  const loadShell = createShellLoader({
    cache: memoryCache(),
    fetchShell: async () => new Response('<html><body>Maintenance</body></html>', { status: 200 }),
  });
  await assert.rejects(loadShell());
});
