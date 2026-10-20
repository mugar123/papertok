import test from 'node:test';
import assert from 'node:assert/strict';
import { findInstitutionServices, knownInstitutionServices } from './institutionAccessService.ts';
import { fakeIdToken } from '../test-support/firebaseIdToken.ts';

// The client against the Worker's own route, edge cache included. The Worker is
// loaded by path because its modules type-check under the Worker's
// configuration, with Cloudflare's types, which this file's does not have.
const load = (path: string) => import(new URL(path, import.meta.url).href);
const { default: worker } = await load('../../worker/index.ts') as { default: { fetch(request: Request, env: Record<string, string>): Promise<Response> } };
const { SERVICE_CATALOGUE } = await load('../../worker/institution-services.ts') as { SERVICE_CATALOGUE: ReadonlyArray<{ id: string; issn: string }> };

const API = 'https://api.papertok.test';
const PROJECT_ID = 'papertok-168df';
const ROUTE_ENV = { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID };
const TOKEN = fakeIdToken({ aud: PROJECT_ID });
const HOUR = 60 * 60 * 1000;
const SFX_HOST = 'sfx.bib-bvb.de';
const TUM = { domain: 'mytum.de', rorId: 'https://ror.org/02kkvpp62', entityId: null };
const LMU = { domain: 'campus.lmu.de', rorId: 'https://ror.org/05591te55', entityId: null };
// Three platforms the library holds: the first, one past the client's first
// ten pages and the last.
const HELD = [0, 41, SERVICE_CATALOGUE.length - 1].map(index => SERVICE_CATALOGUE[index]);

/**
 * A synthetic SFX answer for `issn`, shaped like TUM's captured ones: a
 * licensed full-text service for the platforms in HELD, none for the rest.
 * `about` is the ISSN the answer resolved to, another journal's when SFX
 * mistakes the one asked about.
 */
const sfxAnswer = (issn: string, about = issn) => `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
  &lt;item key="rft.issn"&gt;${about}&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>${HELD.some(entry => entry.issn === issn) ? `
   <target>
    <target_name>LICENSED_PACKAGE</target_name>
    <target_public_name>Licensed Package</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://journals.example.org/${issn}</target_url>
    <is_related>no</is_related>
   </target>` : ''}
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

/**
 * The Worker's upstreams for a library slow enough that a page holds four
 * titles: every SFX probe moves the clock on by the Worker's 6 s window, so
 * only the four started together run. Records each ISSN asked and the instance.
 * The first probe for an ISSN in `failOnce` fails, which makes its page partial;
 * one in `elsewhere` resolves to another journal, which leaves it unchecked.
 */
function slowLibrary(t: { mock: { timers: { tick(ms: number): void } } }, { failOnce = [], elsewhere = [] }: { failOnce?: string[]; elsewhere?: string[] } = {}) {
  const asked: Array<{ issn: string; instance: string }> = [];
  const edge = new Map<string, Response>();
  const globals = globalThis as unknown as { fetch: typeof fetch; caches?: unknown };
  const originalFetch = globals.fetch;
  const originalCaches = globals.caches;
  globals.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith('accounts:lookup')) return Response.json({ users: [{ localId: 'reader-uid' }] });
    if (url.host !== SFX_HOST) throw new Error(`unexpected upstream ${url}`);
    const issn = url.searchParams.get('rft.issn')!;
    const failing = failOnce.includes(issn) && !asked.some(call => call.issn === issn);
    asked.push({ issn, instance: url.pathname });
    await new Promise(resolve => setTimeout(resolve, 1));
    t.mock.timers.tick(6000);
    if (failing) return new Response('<html>Wartungsarbeiten</html>', { status: 503 });
    return new Response(sfxAnswer(issn, elsewhere.includes(issn) ? '1234-5678' : issn), { headers: { 'content-type': 'text/xml;charset=UTF-8' } });
  };
  globals.caches = {
    default: {
      match: async (key: Request) => edge.get(key.url)?.clone() ?? null,
      put: async (key: Request, response: Response) => { edge.set(key.url, response.clone()); },
    },
  };
  return {
    asked,
    restore() {
      globals.fetch = originalFetch;
      if (originalCaches === undefined) delete globals.caches;
      else globals.caches = originalCaches;
    },
  };
}

/**
 * The client's transport: each request through the Worker as a signed-in
 * reader, with the offsets asked recorded. `block` answers a page instead of
 * the Worker (a failure, a refusal); `rewrite` changes the Worker's page into
 * what another Worker, or a broken one, would have answered.
 */
function reader(uid: string, { block, rewrite }: {
  block?: (offset: number) => Response | null;
  rewrite?: (payload: Record<string, unknown>, offset: number) => Record<string, unknown>;
} = {}) {
  const offsets: number[] = [];
  return {
    offsets,
    apiBase: API,
    currentUid: () => uid,
    request: async (url: string | URL, init: RequestInit = {}) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      offsets.push(offset);
      const blocked = block?.(offset);
      if (blocked) return blocked;
      const response = await worker.fetch(new Request(String(url), {
        ...init,
        headers: { ...(init.headers as Record<string, string>), origin: 'https://papertok.app', authorization: `Bearer ${TOKEN}` },
      }), ROUTE_ENV);
      return rewrite && response.ok ? Response.json(rewrite(await response.json() as Record<string, unknown>, offset)) : response;
    },
  };
}

const ids = (answer: { services: ReadonlyArray<{ id: string }> } | null | undefined) => answer!.services.map(service => service.id);
const pagesFrom = (first: number, count: number) => Array.from({ length: count }, (_, page) => first + 4 * page);

test('a slow library\'s list goes on where the client\'s page limit stopped it, run after run, until the catalogue is checked', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    const alice = reader('alice-continues');
    const first = await findInstitutionServices(TUM, alice);
    // Ten pages of four: the first 40 titles, and the list says it is partial.
    assert.deepEqual(alice.offsets, pagesFrom(0, 10));
    assert.equal(first!.partial, true);
    assert.deepEqual(ids(first), [HELD[0].id]);
    assert.equal(knownInstitutionServices(TUM, alice), first);
    // Once the partial answer expires, the next run goes on from title 40.
    t.mock.timers.tick(HOUR + 1);
    alice.offsets.length = 0;
    const middle = await findInstitutionServices(TUM, alice);
    assert.deepEqual(alice.offsets, pagesFrom(40, 10));
    assert.equal(middle!.partial, true);
    assert.deepEqual(ids(middle), [HELD[0].id, HELD[1].id]);
    t.mock.timers.tick(HOUR + 1);
    alice.offsets.length = 0;
    const second = await findInstitutionServices(TUM, alice);
    assert.deepEqual(alice.offsets, pagesFrom(80, 6));
    assert.equal(second!.partial, false);
    assert.deepEqual(ids(second), HELD.map(entry => entry.id));
    // Every title asked once, in catalogue order: nothing lost, nothing asked twice.
    assert.deepEqual(upstream.asked.map(call => call.issn), SERVICE_CATALOGUE.map(entry => entry.issn));
    assert.equal(knownInstitutionServices(TUM, alice), second);
  } finally {
    upstream.restore();
  }
});

test('a finished list stays what is shown while a later reading is under way, and carries what earlier runs found', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  // A probe on the first page fails once, so that page is partial; two titles,
  // one on each side of the first ten pages, resolve to another journal.
  const upstream = slowLibrary(t, {
    failOnce: [SERVICE_CATALOGUE[2].issn],
    elsewhere: [SERVICE_CATALOGUE[5].issn, SERVICE_CATALOGUE[50].issn],
  });
  try {
    const hana = reader('hana-refresh');
    const first = await findInstitutionServices(TUM, hana);
    assert.equal(first!.unchecked, 1);
    t.mock.timers.tick(HOUR + 1);
    await findInstitutionServices(TUM, hana);
    t.mock.timers.tick(HOUR + 1);
    const done = await findInstitutionServices(TUM, hana);
    // Read to the end, with the first run's partial page and unchecked title in it:
    // still partial, so it is asked again after an hour.
    assert.deepEqual(ids(done), HELD.map(entry => entry.id));
    assert.equal(done!.partial, true);
    assert.equal(done!.unchecked, 2);
    t.mock.timers.tick(HOUR + 1);
    assert.equal(knownInstitutionServices(TUM, hana), undefined);
    // The refresh reads the first ten pages again; the list it shows meanwhile
    // is the finished one, not those ten pages.
    hana.offsets.length = 0;
    const refreshing = await findInstitutionServices(TUM, hana);
    assert.deepEqual(hana.offsets, pagesFrom(0, 10));
    assert.equal(refreshing, done);
    assert.equal(knownInstitutionServices(TUM, hana), done);
    t.mock.timers.tick(HOUR + 1);
    hana.offsets.length = 0;
    assert.equal(await findInstitutionServices(TUM, hana), done);
    assert.deepEqual(hana.offsets, pagesFrom(40, 10));
    t.mock.timers.tick(HOUR + 1);
    hana.offsets.length = 0;
    const refreshed = await findInstitutionServices(TUM, hana);
    assert.deepEqual(hana.offsets, pagesFrom(80, 6));
    assert.deepEqual(ids(refreshed), HELD.map(entry => entry.id));
    assert.equal(refreshed!.unchecked, 2);
  } finally {
    upstream.restore();
  }
});

test('a first reading shows what it has found as it goes on; a finished one stays shown through a refresh page that fails', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t, { failOnce: [SERVICE_CATALOGUE[2].issn] });
  try {
    let down: number | null = 20;
    const ivy = reader('ivy-shown', {
      block: offset => (offset === down ? Response.json({ code: 'ACCESS_LOOKUP_UNAVAILABLE' }, { status: 502 }) : null),
    });
    // Cut at title 20 by a failure, then on past title 41: the list grows with the reading.
    await findInstitutionServices(TUM, ivy);
    t.mock.timers.tick(HOUR + 1);
    down = null;
    const goingOn = await findInstitutionServices(TUM, ivy);
    assert.deepEqual(ids(goingOn), [HELD[0].id, HELD[1].id]);
    assert.equal(goingOn!.partial, true);
    t.mock.timers.tick(HOUR + 1);
    await findInstitutionServices(TUM, ivy);
    t.mock.timers.tick(HOUR + 1);
    const done = await findInstitutionServices(TUM, ivy);
    assert.deepEqual(ids(done), HELD.map(entry => entry.id));
    // The refresh's first run, then its next page down: the finished list stays.
    t.mock.timers.tick(HOUR + 1);
    assert.equal(await findInstitutionServices(TUM, ivy), done);
    t.mock.timers.tick(HOUR + 1);
    down = 40;
    ivy.offsets.length = 0;
    assert.equal(await findInstitutionServices(TUM, ivy), done);
    assert.deepEqual(ivy.offsets, [40]);
  } finally {
    upstream.restore();
  }
});

test('pages served from the edge cache count too, and no other account or institution takes up a list\'s place', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    const alice = reader('alice-shares');
    const bob = reader('bob-shares');
    await findInstitutionServices(TUM, alice);
    const probed = upstream.asked.length;
    // Bob starts his own list at the first title; the edge has his first ten pages.
    const bobFirst = await findInstitutionServices(TUM, bob);
    assert.deepEqual(bob.offsets, pagesFrom(0, 10));
    assert.equal(bobFirst!.partial, true);
    assert.equal(upstream.asked.length, probed);
    // Alice at another university starts that one's list, at its own library.
    const aliceLmu = reader('alice-shares');
    const lmu = await findInstitutionServices(LMU, aliceLmu);
    assert.deepEqual(aliceLmu.offsets, pagesFrom(0, 10));
    assert.equal(lmu!.partial, true);
    assert.deepEqual([...new Set(upstream.asked.slice(probed).map(call => call.instance))], ['/sfx_ubm']);
    // The same mail domain linked to another institution is another list too.
    const aliceOther = reader('alice-shares');
    await findInstitutionServices({ ...TUM, rorId: LMU.rorId }, aliceOther);
    assert.deepEqual(aliceOther.offsets, pagesFrom(0, 10));
    // After the partial lifetime each goes on from its own place: Alice's TUM
    // pages are probed, Bob's then come from the edge.
    t.mock.timers.tick(HOUR + 1);
    alice.offsets.length = 0;
    bob.offsets.length = 0;
    await findInstitutionServices(TUM, alice);
    await findInstitutionServices(TUM, bob);
    assert.deepEqual(alice.offsets, pagesFrom(40, 10));
    assert.deepEqual(bob.offsets, pagesFrom(40, 10));
    t.mock.timers.tick(HOUR + 1);
    alice.offsets.length = 0;
    bob.offsets.length = 0;
    const aliceDone = await findInstitutionServices(TUM, alice);
    const beforeBob = upstream.asked.length;
    const bobDone = await findInstitutionServices(TUM, bob);
    assert.deepEqual(alice.offsets, pagesFrom(80, 6));
    assert.deepEqual(bob.offsets, pagesFrom(80, 6));
    assert.equal(upstream.asked.length, beforeBob);
    assert.deepEqual(ids(aliceDone), HELD.map(entry => entry.id));
    assert.deepEqual(ids(bobDone), HELD.map(entry => entry.id));
    assert.equal(bobDone!.partial, false);
  } finally {
    upstream.restore();
  }
});

test('a place the Worker no longer stands behind is dropped: another catalogue or a refused offset starts the list over', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    // A Worker deployed with another catalogue answers the kept offset: its
    // positions may not be the list's, so the list starts over at title 0.
    let catalogue: string | null = null;
    const moved = reader('carol-catalogue', { rewrite: payload => (catalogue ? { ...payload, catalogue } : payload) });
    await findInstitutionServices(TUM, moved);
    t.mock.timers.tick(HOUR + 1);
    catalogue = 'another-catalogue';
    moved.offsets.length = 0;
    const restarted = await findInstitutionServices(TUM, moved);
    assert.deepEqual(moved.offsets, [40, ...pagesFrom(0, 9)]);
    assert.equal(restarted!.partial, true);
    assert.deepEqual(ids(restarted), [HELD[0].id]);
    // A Worker whose catalogue no longer reaches the kept offset refuses it.
    let refuse = false;
    const shrunk = reader('dave-shrunk', {
      block: offset => (refuse && offset === 40 ? Response.json({ code: 'INVALID_SERVICES_OFFSET' }, { status: 400 }) : null),
    });
    await findInstitutionServices(TUM, shrunk);
    t.mock.timers.tick(HOUR + 1);
    refuse = true;
    shrunk.offsets.length = 0;
    const over = await findInstitutionServices(TUM, shrunk);
    assert.deepEqual(shrunk.offsets, [40, ...pagesFrom(0, 9)]);
    assert.equal(over!.partial, true);
    // The catalogue changes under a run that had found pages, and the page it
    // starts over with fails: nothing of either catalogue is left to show, so
    // the answer is a failure to retry, not an empty list.
    let firstPages = 0;
    const grace = reader('grace-both', {
      rewrite: (payload, offset) => (offset === 8 ? { ...payload, catalogue: 'another-catalogue' } : payload),
      block: offset => (offset === 0 && ++firstPages === 2 ? Response.json({ code: 'ACCESS_LOOKUP_UNAVAILABLE' }, { status: 502 }) : null),
    });
    assert.equal(await findInstitutionServices(TUM, grace), null);
    assert.deepEqual(grace.offsets, [0, 4, 8, 0]);
  } finally {
    upstream.restore();
  }
});

test('an invalid continuation stops the list with what it found and is not followed later', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    // The third page points back at itself.
    let broken = true;
    const erin = reader('erin-invalid', { rewrite: (payload, offset) => (broken && offset === 8 ? { ...payload, nextOffset: 8 } : payload) });
    const first = await findInstitutionServices(TUM, erin);
    assert.deepEqual(erin.offsets, [0, 4, 8]);
    assert.equal(first!.partial, true);
    assert.deepEqual(ids(first), [HELD[0].id]);
    // Nothing is kept to go on from: the next run starts at the first title.
    t.mock.timers.tick(HOUR + 1);
    broken = false;
    erin.offsets.length = 0;
    await findInstitutionServices(TUM, erin);
    assert.deepEqual(erin.offsets, pagesFrom(0, 10));
  } finally {
    upstream.restore();
  }
});

test('a page that fails keeps what was found and the place, and the next ask tries that page again', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    let down: number | null = 20;
    const frank = reader('frank-failure', {
      block: offset => (offset === down ? Response.json({ code: 'ACCESS_LOOKUP_UNAVAILABLE' }, { status: 502 }) : null),
    });
    const first = await findInstitutionServices(TUM, frank);
    assert.deepEqual(frank.offsets, pagesFrom(0, 6));
    assert.equal(first!.partial, true);
    assert.deepEqual(ids(first), [HELD[0].id]);
    // Still down when the partial answer expires: what was found stays, partial,
    // and is not kept as a fresh answer, so asking again is the retry.
    t.mock.timers.tick(HOUR + 1);
    frank.offsets.length = 0;
    const stillDown = await findInstitutionServices(TUM, frank);
    assert.deepEqual(frank.offsets, [20]);
    assert.equal(stillDown!.partial, true);
    assert.deepEqual(ids(stillDown), [HELD[0].id]);
    assert.equal(knownInstitutionServices(TUM, frank), undefined);
    // Back up: the list goes on from title 20, ten pages, then to the end.
    down = null;
    frank.offsets.length = 0;
    await findInstitutionServices(TUM, frank);
    assert.deepEqual(frank.offsets, pagesFrom(20, 10));
    t.mock.timers.tick(HOUR + 1);
    frank.offsets.length = 0;
    const almost = await findInstitutionServices(TUM, frank);
    assert.equal(almost!.partial, true);
    assert.deepEqual(frank.offsets, pagesFrom(60, 10));
    t.mock.timers.tick(HOUR + 1);
    frank.offsets.length = 0;
    const done = await findInstitutionServices(TUM, frank);
    assert.deepEqual(frank.offsets, [100]);
    assert.equal(done!.partial, false);
    assert.deepEqual(ids(done), HELD.map(entry => entry.id));
    assert.deepEqual(upstream.asked.map(call => call.issn), SERVICE_CATALOGUE.map(entry => entry.issn));
  } finally {
    upstream.restore();
  }
});
