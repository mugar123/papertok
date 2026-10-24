import test from 'node:test';
import assert from 'node:assert/strict';
import { findInstitutionServices, knownInstitutionServices } from './institutionAccessService.ts';
import { fakeIdToken } from '../test-support/firebaseIdToken.ts';

// The client against the Worker's own route and its store. The Worker's modules
// type-check only with Cloudflare's types, which this file's configuration does
// not have, so they load through a URL that TypeScript does not resolve.
const { default: worker } = await import(new URL('../../worker/index.ts', import.meta.url).href) as { default: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> } };
const { SERVICE_CATALOGUE } = await import(new URL('../../worker/institution-services.ts', import.meta.url).href) as { SERVICE_CATALOGUE: ReadonlyArray<{ id: string; issn: string }> };

const API = 'https://api.papertok.test';
const PROJECT_ID = 'papertok-168df';
const ROUTE_ENV = { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID };
const TOKEN = fakeIdToken({ aud: PROJECT_ID });
const HOUR = 60 * 60 * 1000;
const SFX_HOST = 'sfx.bib-bvb.de';
// TUM, by two of its mail domains: one library, one record in the store.
const TUM = { domain: 'mytum.de', rorId: 'https://ror.org/02kkvpp62', entityId: null };
const TUM_ALIAS = { ...TUM, domain: 'tum.de' };
// Three platforms the library holds: the first, one past the client's first
// run and the last.
const HELD = [0, 70, SERVICE_CATALOGUE.length - 1].map(index => SERVICE_CATALOGUE[index]);

/**
 * A synthetic SFX answer for `issn`, shaped like TUM's captured ones: a
 * licensed full-text service for the platforms in HELD, none for the rest.
 */
const sfxAnswer = (issn: string) => `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
  &lt;item key="rft.issn"&gt;${issn}&lt;/item&gt;
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
 * The Worker's upstreams for a library slow enough that a request holds six
 * titles: every SFX probe moves the clock on by the Worker's 6 s window, so
 * only the six started together run. Records each ISSN asked.
 */
function slowLibrary(t: { mock: { timers: { tick(ms: number): void } } }) {
  const asked: string[] = [];
  const globals = globalThis as unknown as { fetch: typeof fetch; caches?: unknown };
  const originalFetch = globals.fetch;
  const originalCaches = globals.caches;
  globals.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith('accounts:lookup')) return Response.json({ users: [{ localId: 'reader-uid' }] });
    if (url.host !== SFX_HOST) throw new Error(`unexpected upstream ${url}`);
    const issn = url.searchParams.get('rft.issn')!;
    asked.push(issn);
    await new Promise(resolve => setTimeout(resolve, 1));
    t.mock.timers.tick(6000);
    return new Response(sfxAnswer(issn), { headers: { 'content-type': 'text/xml;charset=UTF-8' } });
  };
  // The identity check keeps its answers at the edge.
  globals.caches = { default: { match: async () => null, put: async () => {} } };
  return {
    asked,
    restore() {
      globals.fetch = originalFetch;
      if (originalCaches === undefined) delete globals.caches;
      else globals.caches = originalCaches;
    },
  };
}

/** The store the Worker keeps its verdicts in, as the route's KV binding. */
function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string, type?: string) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { values.set(key, value); },
  };
}

/** The client's transport: each request through the Worker as a signed-in reader. */
function reader(store: ReturnType<typeof memoryStore>) {
  const requests = { count: 0 };
  return {
    requests,
    apiBase: API,
    request: async (url: string | URL, init: RequestInit = {}) => {
      requests.count += 1;
      return worker.fetch(new Request(String(url), {
        ...init,
        headers: { ...(init.headers as Record<string, string>), origin: 'https://papertok.app', authorization: `Bearer ${TOKEN}` },
      }), { ...ROUTE_ENV, INSTITUTION_SERVICES_STORE: store });
    },
  };
}

const ids = (answer: { services: ReadonlyArray<{ id: string }> } | null | undefined) => answer!.services.map(service => service.id);

test('a slow library\'s list goes on from the Worker\'s store, run after run, until the catalogue is checked; then it is served without a probe', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 12) });
  const upstream = slowLibrary(t);
  try {
    const store = memoryStore();
    const alice = reader(store);
    const first = await findInstitutionServices(TUM, alice);
    // Ten requests of six titles: the first 60, and the list says it is partial.
    assert.equal(alice.requests.count, 10);
    assert.equal(first!.partial, true);
    assert.deepEqual(ids(first), [HELD[0].id]);
    assert.equal(upstream.asked.length, 60);
    assert.equal(knownInstitutionServices(TUM), first);
    // Once the partial answer expires, the next run goes on from title 60.
    t.mock.timers.tick(HOUR + 1);
    const middle = await findInstitutionServices(TUM, alice);
    assert.equal(alice.requests.count, 20);
    assert.equal(middle!.partial, true);
    assert.deepEqual(ids(middle), [HELD[0].id, HELD[1].id]);
    t.mock.timers.tick(HOUR + 1);
    const later = await findInstitutionServices(TUM, alice);
    assert.equal(later!.partial, true);
    t.mock.timers.tick(HOUR + 1);
    const whole = await findInstitutionServices(TUM, alice);
    assert.equal(whole!.partial, false);
    assert.deepEqual(ids(whole), HELD.map(entry => entry.id));
    // Every title asked once, in catalogue order: nothing lost, nothing asked twice.
    assert.deepEqual(upstream.asked, SERVICE_CATALOGUE.map(entry => entry.issn));
    assert.equal(knownInstitutionServices(TUM), whole);
    // The same library under another of its domains: one request, answered
    // from the store, no probe.
    const bob = reader(store);
    const shared = await findInstitutionServices(TUM_ALIAS, bob);
    assert.equal(bob.requests.count, 1);
    assert.deepEqual(ids(shared), HELD.map(entry => entry.id));
    assert.equal(shared!.partial, false);
    assert.equal(upstream.asked.length, SERVICE_CATALOGUE.length);
  } finally {
    upstream.restore();
  }
});
