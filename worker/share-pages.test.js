import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paperLegacyAdapter } from '../src/models/Paper.js';
import { seedPaintsWhole } from '../src/utils/paperSeed.js';
import { encodePaperKey } from '../src/utils/publicNavigation.js';
import { publicPaperMetadata, readShareSeed } from '../src/utils/shareSeed.js';
import {
  createShareLoader,
  createShellLoader,
  handleSharePage,
  matchShareRoute,
  renderSharePage,
  shareLanguage,
  sharePageModel,
} from './share-pages.js';

// The app shell as the repository builds it. Vite leaves the head tags as
// written and only appends its script and style links, so this is the head a
// crawler received for every public page (audit 2026-09-23, issue 5): the
// title «PaperTok», og:url and canonical at /feed, an empty #root.
const SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function invertedIndex(text) {
  const index = {};
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
  return matchShareRoute(new URL(`https://api.papertok.app/share/paper/${key}`));
}

function foundPaper() {
  return createShareLoader({
    openAlex: async () => OPENALEX_WORK,
    arxiv: async () => { throw new Error('not asked'); },
    openAire: async () => { throw new Error('not asked'); },
    firestore: { getDocument: async () => { throw new Error('not asked'); } },
  })(paperRoute());
}

function headOf(html) {
  return html.slice(0, html.indexOf('</head>'));
}

function metaContent(html, attribute, key) {
  const match = headOf(html).match(new RegExp(`<meta\\s+${attribute}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content="([^"]*)"`));
  return match ? match[1] : null;
}

function canonicalOf(html) {
  const match = headOf(html).match(/<link rel="canonical" href="([^"]*)"/);
  return match ? match[1] : null;
}

function titleOf(html) {
  const match = html.match(/<title>([^<]*)<\/title>/);
  return match ? match[1] : null;
}

function jsonLdOf(html) {
  const match = html.match(/<script id="papertok-jsonld" type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

function seedOf(html) {
  const match = html.match(/<script type="application\/json" id="papertok-share-seed">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

function memoryCache() {
  const stored = new Map();
  return {
    stored,
    async match(request) {
      const hit = stored.get(String(request.url));
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      stored.set(String(request.url), response.clone());
    },
  };
}

function shareRequest(path, { method = 'GET', language } = {}) {
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

  const list = matchShareRoute(new URL(`https://api.papertok.app/share/list/${SHARE_ID}`));
  assert.equal(list.kind, 'list');
  assert.equal(list.canonicalPath, `/public/list/${SHARE_ID}`);

  const user = matchShareRoute(new URL('https://api.papertok.app/share/user/@Ada_L'));
  assert.equal(user.kind, 'user');
  assert.equal(user.handle, 'ada_l');
  assert.equal(user.canonicalPath, '/public/user/ada_l');

  const author = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A5018713931'));
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
    assert.equal(matchShareRoute(new URL(`https://api.papertok.app${path}`)).invalid, true, path);
  }
  assert.equal(matchShareRoute(new URL('https://api.papertok.app/openalex/works')), null);
});

// -------------------------------------------------------------- language

test('the copy follows Accept-Language: Spanish when asked for, English otherwise', () => {
  assert.equal(shareLanguage('es-ES,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(shareLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(shareLanguage('en;q=0.4, es;q=0.8'), 'es');
  assert.equal(shareLanguage('fr-FR,fr;q=0.9'), 'en');
  assert.equal(shareLanguage(''), 'en');
  assert.equal(shareLanguage(null), 'en');
});

// ------------------------------------------------------------ one head per kind

test('a paper page carries its own title, description, canonical, og and twitter tags', async () => {
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome, 'es'));
  const url = `https://papertok.app/public/paper/${DOI_KEY}`;

  assert.equal(titleOf(html), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(metaContent(html, 'property', 'og:title'), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.equal(metaContent(html, 'name', 'twitter:title'), 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.match(metaContent(html, 'name', 'description'), /^We study how video creators earn money/);
  assert.equal(metaContent(html, 'property', 'og:description'), metaContent(html, 'name', 'description'));
  assert.equal(canonicalOf(html), url);
  assert.equal(metaContent(html, 'property', 'og:url'), url);
  assert.equal(metaContent(html, 'name', 'twitter:url'), url);
  assert.equal(metaContent(html, 'property', 'og:type'), 'article');
  assert.equal(metaContent(html, 'property', 'og:locale'), 'es_ES');
  assert.equal(metaContent(html, 'name', 'robots'), null, 'a found paper is indexable');
  assert.doesNotMatch(headOf(html), /papertok\.app\/feed/, 'nothing in the head still points at /feed');
  assert.match(html, /<html lang="es">/);

  const jsonLd = jsonLdOf(html);
  assert.equal(jsonLd['@type'], 'ScholarlyArticle');
  assert.equal(jsonLd.name, 'Characterizing Alternative Monetization Strategies on YouTube');
  assert.deepEqual(jsonLd.author.map(author => author.name), ['Yiqing Hua', 'Manoel Horta Ribeiro']);
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

  const es = renderSharePage(SHELL, sharePageModel(route, outcome, 'es'));
  const en = renderSharePage(SHELL, sharePageModel(route, outcome, 'en'));
  assert.equal(titleOf(es), 'Tutoring with language models | Lista pública de PaperTok');
  assert.equal(titleOf(en), 'Tutoring with language models | PaperTok public list');
  assert.equal(metaContent(es, 'name', 'description'), 'What the evidence says about AI tutors.');
  assert.equal(canonicalOf(es), `https://papertok.app/public/list/${SHARE_ID}`);
  assert.equal(jsonLdOf(es)['@type'], 'CollectionPage');
  assert.match(es, new RegExp(`<a href="/public/paper/${DOI_KEY}">Characterizing Alternative Monetization Strategies on YouTube</a>`));
  assert.match(es, new RegExp(`<a href="/public/paper/${ARXIV_KEY}">StudentBench: AI and human tutoring</a>`));
});

test('a profile page names the person and their handle', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/user/ada_l'));
  const reads = [];
  const outcome = await createShareLoader({
    firestore: {
      getDocument: async path => {
        reads.push(path);
        if (path === 'handles/ada_l') return { exists: true, id: 'ada_l', data: { uid: 'uid-123' } };
        if (path === 'userProfiles/uid-123') {
          return { exists: true, id: 'uid-123', data: { handle: 'ada_l', displayName: 'Ada Lovelace', bio: 'Analytical engines.', visibility: 'public' } };
        }
        throw new Error(`unexpected read ${path}`);
      },
    },
  })(route);

  const html = renderSharePage(SHELL, sharePageModel(route, outcome, 'en'));
  assert.deepEqual(reads, ['handles/ada_l', 'userProfiles/uid-123']);
  assert.equal(titleOf(html), 'Ada Lovelace (@ada_l) | PaperTok');
  assert.equal(metaContent(html, 'name', 'description'), 'Analytical engines.');
  assert.equal(metaContent(html, 'property', 'og:type'), 'profile');
  assert.equal(jsonLdOf(html)['@type'], 'ProfilePage');
  assert.equal(jsonLdOf(html).mainEntity.name, 'Ada Lovelace');
});

test('an entity page names the entity and what kind of entity it is', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A5018713931'));
  const asked = [];
  const outcome = await createShareLoader({
    openAlex: async (path, params) => {
      asked.push({ path, params });
      return { id: 'https://openalex.org/A5018713931', display_name: 'Yiqing Hua', works_count: 31 };
    },
  })(route);

  const es = renderSharePage(SHELL, sharePageModel(route, outcome, 'es'));
  assert.equal(asked[0].path, 'authors/A5018713931');
  assert.equal(titleOf(es), 'Yiqing Hua - Autor | PaperTok');
  assert.equal(
    metaContent(es, 'name', 'description'),
    'Explora artículos científicos, citas e investigación relacionada con Yiqing Hua en PaperTok.',
  );
  assert.equal(canonicalOf(es), 'https://papertok.app/public/entity/author/A5018713931');
  assert.equal(metaContent(es, 'name', 'robots'), null);
});

test('an entity known only by a name gets a head with the name, not indexed, and costs no request', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/Wei%20Zhang?paper=doi:10.1000%2Fx'));
  const outcome = await createShareLoader({
    openAlex: async () => { throw new Error('a name is not an identity to look up'); },
  })(route);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome, 'en'));
  assert.equal(titleOf(html), 'Wei Zhang - Author | PaperTok');
  assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow', 'a name can mix several people');
});

// ------------------------------------------------------------- escaping

test('everything from a provider or a user is escaped, and no replacement pattern leaks', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/user/ada_l'));
  const outcome = await createShareLoader({
    firestore: {
      getDocument: async path => (path === 'handles/ada_l'
        ? { exists: true, id: 'ada_l', data: { uid: 'u1' } }
        : { exists: true, id: 'u1', data: { handle: 'ada_l', displayName: 'Ada "</title><script>alert(1)</script>', bio: 'Costs $& and $1 & <b>bold</b> \u2028 end' } }),
    },
  })(route);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome, 'en'));

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.equal(titleOf(html), 'Ada &quot;&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; (@ada_l) | PaperTok');
  assert.match(metaContent(html, 'name', 'description'), /^Costs \$&amp; and \$1 &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  const jsonLd = html.match(/<script id="papertok-jsonld" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(jsonLd, /<\/script|<b>/i, 'the JSON-LD cannot close its own script element');
  assert.doesNotMatch(jsonLd, /\u2028/, 'nor carry a raw line separator');
  assert.equal(JSON.parse(jsonLd).mainEntity.description.startsWith('Costs $& and $1 & <b>bold</b>'), true);
});

test('LaTeX in a title becomes plain text in the head and stays LaTeX in the seed', async () => {
  const outcome = await createShareLoader({
    openAlex: async () => ({ ...OPENALEX_WORK, title: 'On commensurations of pro-$\\mathcal{C}$ groups', display_name: 'x' }),
  })(paperRoute());
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome, 'en'));
  assert.equal(titleOf(html), 'On commensurations of pro-C groups');
  assert.equal(metaContent(html, 'property', 'og:title'), 'On commensurations of pro-C groups');
  assert.equal(seedOf(html).paper.title, 'On commensurations of pro-$\\mathcal{C}$ groups', 'the card renders the math itself');
});

// ---------------------------------------------------------------- seed

test('a paper page embeds a seed that parses, names its key and can paint the page', async () => {
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome, 'en'));
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
  // writes are the ones src/utils/shareSeed.js reads, and what it reads goes
  // through the same adapter and paint rule as a seed handed over in-app.
  const outcome = await foundPaper();
  const html = renderSharePage(SHELL, sharePageModel(paperRoute(), outcome, 'en'));
  const text = html.match(/<script type="application\/json" id="papertok-share-seed">([\s\S]*?)<\/script>/)[1];
  const documentStub = { getElementById: id => (id === 'papertok-share-seed' ? { textContent: text } : null) };
  const paper = readShareSeed(DOI_KEY, documentStub);
  assert.ok(paper, 'read for its own key');
  assert.equal(readShareSeed(ARXIV_KEY, documentStub), null, 'and for no other');
  assert.equal(seedPaintsWhole(paperLegacyAdapter(paper)), true);
  assert.equal(publicPaperMetadata(paperLegacyAdapter(paper), `/public/paper/${DOI_KEY}`).noIndex, undefined);
});

test('only a paper page carries a seed', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/author/A1'));
  const outcome = await createShareLoader({ openAlex: async () => ({ id: 'https://openalex.org/A1', display_name: 'X Y' }) })(route);
  assert.equal(seedOf(renderSharePage(SHELL, sharePageModel(route, outcome, 'en'))), null);
});

// -------------------------------------------------------------- handler

function handlerDeps(overrides = {}) {
  let loads = 0;
  const deps = {
    loadShell: async () => SHELL,
    loadRecord: async (route) => {
      loads += 1;
      return createShareLoader({ openAlex: async () => OPENALEX_WORK })(route);
    },
    admit: async () => true,
    cache: memoryCache(),
    ...overrides,
  };
  return { deps, loads: () => loads };
}

test('a found page answers 200 HTML that downstream caches keep apart by language', async () => {
  const { deps } = handlerDeps();
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'es-ES,es;q=0.9' }), deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.match(response.headers.get('vary'), /accept-language/i);
  assert.equal(response.headers.get('content-language'), 'es');
  assert.match(response.headers.get('cache-control'), /max-age=300/);
  assert.equal(titleOf(await response.text()), 'Characterizing Alternative Monetization Strategies on YouTube');
});

test('both languages are served from one provider answer, each with its own copy', async () => {
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

  const es = await (await handleSharePage(shareRequest(route, { language: 'es' }), deps)).text();
  const en = await (await handleSharePage(shareRequest(route, { language: 'en-GB' }), deps)).text();
  assert.equal(titleOf(es), 'Tutoring | Lista pública de PaperTok');
  assert.equal(titleOf(en), 'Tutoring | PaperTok public list');
  assert.equal(metaContent(es, 'name', 'description'), 'Explora una lista pública de lectura científica creada en PaperTok.');
  assert.equal(metaContent(en, 'name', 'description'), 'Explore a public scientific reading list curated on PaperTok.');
  assert.equal(reads, 1, 'the record is the same in both languages; only the copy around it changes');
});

test('a page that does not exist answers 404 and noindex', async () => {
  const { deps } = handlerDeps({
    loadRecord: createShareLoader({ openAlex: async () => null }),
  });
  const response = await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`, { language: 'es' }), deps);
  const html = await response.text();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(metaContent(html, 'name', 'robots'), 'noindex, nofollow');
  assert.equal(titleOf(html), 'No encontramos este paper | PaperTok');
  assert.equal(seedOf(html), null);
  assert.equal(canonicalOf(html), null, 'a missing page claims no canonical address');
});

test('a path that names no page answers 404 and noindex without spending a lookup', async () => {
  const { deps, loads } = handlerDeps();
  const response = await handleSharePage(shareRequest('/share/paper/not-a-key'), deps);
  assert.equal(response.status, 404);
  assert.equal(metaContent(await response.text(), 'name', 'robots'), 'noindex, nofollow');
  assert.equal(loads(), 0);
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
  assert.match(first.headers.get('cache-control'), /max-age=60/);

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

test('a page found once is served from the record cache the next time', async () => {
  const { deps, loads } = handlerDeps();
  await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  await handleSharePage(shareRequest(`/share/paper/${DOI_KEY}`), deps);
  assert.equal(loads(), 1);
  const [cached] = [...deps.cache.stored.values()];
  assert.match(cached.headers.get('cache-control'), /s-maxage=86400/);
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
  const asked = [];
  await createShareLoader({ openAlex: async (path, params) => { asked.push({ path, params }); return OPENALEX_WORK; } })(paperRoute());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, 'works/doi:10.1145/3555174');
  assert.match(asked[0].params.select, /abstract_inverted_index/);
});

test('an arXiv key asks OpenAlex by landing page, then arXiv when OpenAlex has not indexed it yet', async () => {
  const asked = [];
  const outcome = await createShareLoader({
    openAlex: async (path, params) => { asked.push(['openalex', path, params.filter]); return { results: [] }; },
    arxiv: async (id) => { asked.push(['arxiv', id]); return ARXIV_FEED; },
  })(paperRoute(ARXIV_KEY));

  assert.deepEqual(asked, [
    ['openalex', 'works', 'locations.landing_page_url:http://arxiv.org/abs/2609.28470|https://arxiv.org/abs/2609.28470'],
    ['arxiv', '2609.28470'],
  ]);
  assert.equal(outcome.found, true);
  assert.equal(outcome.record.paper.title, 'StudentBench: AI and human tutoring yield equivalent GRE learning gains');
  assert.deepEqual(outcome.record.paper.authors, ['Curtis Northcutt', 'Inaara Hasmani']);
  assert.match(outcome.record.paper.abstract, /\(all p < \.002\)\.$/);
  assert.equal(outcome.record.paper.published, '2026-09-23');
});

test('an arXiv answer with no entry is a paper that does not exist', async () => {
  const outcome = await createShareLoader({
    openAlex: async () => ({ results: [] }),
    arxiv: async () => '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  })(paperRoute(ARXIV_KEY));
  assert.deepEqual(outcome, { found: false });
});

test('a private or unregistered profile is not found, whichever of the two it is', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/user/ada_l'));
  const denied = await createShareLoader({
    firestore: {
      getDocument: async path => {
        if (path === 'handles/ada_l') return { exists: true, id: 'ada_l', data: { uid: 'u1' } };
        throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied', status: 403 });
      },
    },
  })(route);
  const free = await createShareLoader({
    firestore: { getDocument: async () => ({ exists: false, id: 'ada_l', data: null }) },
  })(route);
  assert.deepEqual(denied, { found: false });
  assert.deepEqual(free, { found: false });
});

test('a project is looked up in OpenAIRE by its OpenAIRE id', async () => {
  const route = matchShareRoute(new URL('https://api.papertok.app/share/entity/project/corda__h2020%3A%3Ab9871e3e08a9db98aaa42bf321ed0f1a'));
  const asked = [];
  const outcome = await createShareLoader({
    openAire: async (params) => {
      asked.push(params);
      return {
        response: {
          results: {
            result: [{
              metadata: {
                'oaf:entity': {
                  'oaf:project': {
                    acronym: { $: 'TAILOR' },
                    title: { $: 'Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization' },
                  },
                },
              },
            }],
          },
        },
      };
    },
  })(route);
  assert.deepEqual(asked, [{ openaireProjectID: 'corda__h2020::b9871e3e08a9db98aaa42bf321ed0f1a' }]);
  const html = renderSharePage(SHELL, sharePageModel(route, outcome, 'en'));
  assert.equal(titleOf(html), 'TAILOR: Foundations of Trustworthy AI - Integrating Reasoning, Learning and Optimization - Research project | PaperTok');
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
  assert.match([...cache.stored.values()][0].headers.get('cache-control'), /s-maxage=300/);
});

test('a shell that is not the app is refused rather than dressed up', async () => {
  const loadShell = createShellLoader({
    cache: memoryCache(),
    fetchShell: async () => new Response('<html><body>Maintenance</body></html>', { status: 200 }),
  });
  await assert.rejects(loadShell());
});
