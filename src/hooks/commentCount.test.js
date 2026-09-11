import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  forgetCommentCount,
  loadCommentCount,
  watchCommentCount,
} from './useCommentCount.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * `{ id: 'doi:10.1/x', doi: '10.1/x' }` (the fixture this suite started from)
 * yields ZERO local thread keys: `DOI_PATTERN` in paperCanonicalKey.js needs
 * 4-9 digits between `10.` and the slash, and `1` is only one digit, so
 * `normalizeDoi` rejects it, `rawIdentity('doi:10.1/x')` also refuses (it
 * already wears a `doi:` prefix that failed the DOI grammar), and
 * `canonicalPaperIdentity` returns null. `Promise.all([])` then resolves to a
 * total of 0, so `first >= 2` would fail forever — not "pass trivially", it
 * would not pass at all, against a correct implementation or a broken one.
 * Verified empirically (`localThreadKeys(brief fixture)` -> `[]`) before
 * writing this file. Every fixture here carries a syntactically valid DOI
 * (`10.1000/...`, prefix `1000` has 4 digits) plus a distinct arXiv id, so it
 * exercises the actual "sum across local keys" path with TWO keys — which is
 * also the ceiling: `candidateStubIdentities` never returns more than two, so
 * two is the most reads a paper can ever cost.
 *
 * Papers are per-test on purpose: the cache these functions share is module
 * scope by design (it has to survive the feed's remounts), so one fixture per
 * test is what keeps each of them reading its own state and nobody else's.
 */
const fixture = (slug, arxiv) => ({ id: `doi:10.1000/${slug}`, doi: `10.1000/${slug}`, arxivId: arxiv });
const paper = fixture('xyz', '2401.12345');

/** Enough turns of the loop for a promise chain plus its `finally` to land. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('suma las claves locales y cachea por paper', async () => {
  forgetCommentCount(paper.id);
  let calls = 0;
  const countThread = async () => { calls += 1; return 2; };
  const first = await loadCommentCount(paper, { countThread, database: {} });
  const again = await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(first.count >= 2);
  assert.equal(again, first, 'la caché sirve la misma respuesta, sin releer');
  const seen = calls;
  assert.equal(seen, 2, 'dos claves, dos lecturas: el techo del paper');
  forgetCommentCount(paper.id);
  await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(calls > seen, 'olvidar vuelve a contar');
});

test('un fallo de lectura devuelve null y no envenena la caché', async () => {
  const failing = fixture('aaa', '2401.00001');
  const countThread = async () => { throw new Error('unavailable'); };
  assert.equal(await loadCommentCount(failing, { countThread, database: {} }), null);
  let ok = 0;
  const after = await loadCommentCount(failing, { countThread: async () => { ok += 1; return 1; }, database: {} });
  assert.ok(ok >= 1, 'un fallo no se cachea: la siguiente pregunta vuelve a leer');
  assert.equal(after.count, 2);
});

/**
 * The feed's mount window unmounts and remounts the SAME `paper.id` constantly
 * (it slides on a 400ms idle timer). `useCommentCount` re-runs its effect on
 * every mount, but `cache`/`inflight` are declared at module scope — outside
 * the hook function, so they are not component state and a component unmount
 * cannot clear them. This simulates three separate mounts of the same paper
 * (three independent `loadCommentCount` calls, no shared closure between them,
 * exactly what three separate effect runs would do) and asserts only the first
 * one actually reads.
 */
test('remontar la misma tarjeta no repite la lectura (la caché es de módulo, no de componente)', async () => {
  const remounted = fixture('bbb', '2401.00002');
  let calls = 0;
  const overrides = { countThread: async () => { calls += 1; return 3; }, database: {} };
  const mountedOnce = await loadCommentCount(remounted, overrides);
  const callsAfterFirstMount = calls;
  assert.equal(callsAfterFirstMount, 2, 'the first mount reads once per key');
  const mountedAgain = await loadCommentCount(remounted, overrides);
  const mountedYetAgain = await loadCommentCount(remounted, overrides);
  assert.equal(mountedAgain, mountedOnce);
  assert.equal(mountedYetAgain, mountedOnce);
  assert.equal(calls, callsAfterFirstMount, 'a remount must not re-read');
});

/**
 * Task 8's fast swipe: the card becomes active, its effect fires, and a second
 * effect run (a remount, or `enabled` flipping back on) arrives before the
 * first read has landed. WITHOUT awaiting in between — the three tests above
 * all await, so every one of them hits the cache instead of `inflight`, and
 * deleting the `inflight` branch would leave them all green.
 */
test('dos llamadas a la vez comparten la lectura en vuelo (una pasada, no dos)', async () => {
  const raced = fixture('ccc', '2401.00003');
  let reads = 0;
  const countThread = async () => { reads += 1; await sleep(10); return 1; };
  const first = loadCommentCount(raced, { countThread, database: {} });
  const second = loadCommentCount(raced, { countThread, database: {} });
  const third = loadCommentCount(raced, { countThread, database: {} });
  const answers = await Promise.all([first, second, third]);
  assert.equal(answers[1], answers[0], 'la segunda recibe la lectura en vuelo, no otra');
  assert.equal(answers[2], answers[0]);
  assert.equal(reads, 2, 'dos claves, una sola pasada: dos lecturas, no seis');
});

/**
 * I1. The viewer posts a comment while the count is still in flight. The
 * answer already travelling is a pre-post total; `forgetCommentCount` has to
 * win, and permanently — the bug it replaced let that late answer land in the
 * cache after the invalidation had cleared it, so the stale number was served
 * for the rest of the session with nothing left to evict it. Firestore reads
 * in this app have been measured hanging for 96 s against a mute stream, so
 * this window is not milliseconds wide.
 */
test('una invalidación a mitad de vuelo no la deshace la lectura que llega tarde', async () => {
  const posted = fixture('ddd', '2401.00004');
  let reads = 0;
  let perKey = 5;
  const countThread = async () => {
    reads += 1;
    const asIssued = perKey;      // what the thread held when the read was issued
    await sleep(40);
    return asIssued;
  };
  const overrides = { countThread, database: {} };
  const inFlight = loadCommentCount(posted, overrides);
  await sleep(5);
  perKey = 6;                      // the viewer's own comment landed
  forgetCommentCount(posted.id);
  assert.equal(await inFlight, null, 'la respuesta adelantada se tira, no se cachea');
  const readsBefore = reads;
  const answer = await loadCommentCount(posted, overrides);
  assert.equal(answer.count, 12, 'la siguiente pregunta trae el total NUEVO');
  assert.ok(reads > readsBefore, 'y lo trae releyendo, no de una caché revivida');
});

/**
 * I3. The sheet opens over a card that stays mounted, the viewer posts, the
 * sheet closes. Nothing about the card changed — same paper, still active — so
 * an effect keyed on `enabled`/`paper.id` alone never runs again and the badge
 * keeps its pre-post number. `watchCommentCount` is the fix: the module is
 * already the channel between the two siblings, so a mounted card subscribes
 * to it and is told.
 *
 * This drives `watchCommentCount` directly, which is the hook's whole body
 * apart from the React plumbing (`useCommentCount`'s effect is one line:
 * `return watchCommentCount(paper, ...)`). This repo's harness has no DOM —
 * no jsdom, and react-test-renderer is gone in React 19 — so the wiring
 * between the two is pinned by the SOURCE test at the bottom of this file
 * instead of by a real mount.
 */
test('una tarjeta montada repinta cuando su propio hilo cambia', async () => {
  const watched = fixture('eee', '2401.00005');
  let perKey = 2;
  let reads = 0;
  const overrides = { countThread: async () => { reads += 1; return perKey; }, database: {} };
  const painted = [];
  const unmount = watchCommentCount(watched, entry => painted.push(entry), overrides);
  await settle();
  assert.deepEqual(painted.at(-1), { count: 4, capped: false }, 'pinta el número que leyó');
  const readsAfterFirstPaint = reads;

  perKey = 3;                                   // the viewer posted
  forgetCommentCount(watched.id);
  await settle();
  assert.deepEqual(painted.at(-1), { count: 6, capped: false }, 'repinta sin desmontar la tarjeta');
  assert.equal(reads, readsAfterFirstPaint + 2, 'releyó una vez, dos claves');

  unmount();
  forgetCommentCount(watched.id);
  await settle();
  assert.equal(reads, readsAfterFirstPaint + 2, 'una tarjeta desmontada ya no lee nada');
});

/**
 * The other half of the budget: a card re-reads ONLY when its own thread
 * changed. Every invalidation reaches every mounted card — one shared channel,
 * no addressing — so the neighbour has to recognise that the generation that
 * moved was not its own.
 *
 * The card here is one whose count FAILED, which is the case that tells the
 * two behaviours apart: with a fresh answer cached, `loadCommentCount` refuses
 * to read again anyway, so a watcher that asked on every invalidation would
 * look identical. With nothing cached, that watcher would buy a fresh pair of
 * reads every time anyone anywhere posted a comment.
 */
test('la invalidación de otro paper no hace releer a la tarjeta', async () => {
  const mine = fixture('fff', '2401.00006');
  const neighbour = fixture('ggg', '2401.00007');
  let reads = 0;
  const overrides = {
    countThread: async () => { reads += 1; throw new Error('unavailable'); },
    database: {},
  };
  const unmount = watchCommentCount(mine, () => {}, overrides);
  await settle();
  const readsAfterFirstTry = reads;
  assert.equal(readsAfterFirstTry, 2, 'dos claves, un intento');
  forgetCommentCount(neighbour.id);
  await settle();
  assert.equal(reads, readsAfterFirstTry, 'lo de al lado no cuesta ninguna lectura');
  forgetCommentCount(mine.id);
  await settle();
  assert.equal(reads, readsAfterFirstTry + 2, 'lo propio sí');
  unmount();
});

/**
 * The far side of the same window: the overtaken read finishes LAST, after the
 * one that replaced it has taken the in-flight slot. Its `finally` must let go
 * of a slot that is no longer its own, or the next caller finds the slot empty
 * and opens a third pair of reads against a thread already being counted.
 *
 * Every read here is parked on a gate the test opens by hand: no sleeps, so
 * nothing about this depends on how loaded the machine is.
 */
test('la lectura adelantada suelta su sitio, no el de la que la sustituyó', async () => {
  const overtaken = fixture('iii', '2401.00009');
  let reads = 0;
  const gates = [];
  const countThread = async () => {
    reads += 1;
    let open;
    const parked = new Promise(resolve => { open = resolve; });
    gates.push(open);
    await parked;
    return 1;
  };
  const overrides = { countThread, database: {} };

  const overtakenRead = loadCommentCount(overtaken, overrides);
  await settle();
  assert.equal(reads, 2, 'la primera lectura sale, dos claves');
  forgetCommentCount(overtaken.id);
  const replacement = loadCommentCount(overtaken, overrides);
  await settle();
  assert.equal(reads, 4, 'la invalidación paga una lectura nueva');

  gates[0](); gates[1]();                      // la adelantada aterriza, tarde
  assert.equal(await overtakenRead, null);
  await settle();

  const third = loadCommentCount(overtaken, overrides);
  await settle();
  assert.equal(reads, 4, 'la tercera se engancha a la lectura viva, no abre otra');
  gates[2](); gates[3]();
  assert.equal(await third, await replacement);
  assert.equal(reads, 4);
});

/**
 * M2. Each key's aggregation stops at `COMMENT_COUNT_CAP`, so a paper threaded
 * under two keys that are both at the cap would sum to 2000 — a number that
 * exists nowhere. The total is clamped and `capped` travels, so the card can
 * render `1000+` the way the sheet's own header already does.
 */
test('el tope viaja con el total en vez de sumarse dos veces', async () => {
  const busy = fixture('hhh', '2401.00008');
  const answer = await loadCommentCount(busy, { countThread: async () => 1200, database: {} });
  assert.equal(answer.capped, true, 'el tope llega a quien pinta');
  assert.equal(answer.count, 1000, 'y el total se recorta: nunca 2000');
});

test('sin identidad no hay lectura ni suscripción', async () => {
  assert.equal(await loadCommentCount(null, { countThread: async () => 1, database: {} }), null);
  assert.equal(await loadCommentCount({}, { countThread: async () => 1, database: {} }), null);
  let reads = 0;
  const unmount = watchCommentCount({}, () => {}, { countThread: async () => { reads += 1; return 1; }, database: {} });
  await settle();
  assert.equal(reads, 0);
  assert.doesNotThrow(() => unmount());
});

/**
 * The line the I3 test cannot see, because it drives `watchCommentCount`
 * rather than a real mount: that `useCommentCount` actually hands React the
 * subscription (and its unsubscribe, as the effect's cleanup). Without this,
 * the hook could quietly go back to a one-shot `loadCommentCount().then(...)`
 * with every test above still green.
 */
test('SOURCE: el hook monta la suscripción y devuelve su baja', async () => {
  const hook = stripComments(await read('./useCommentCount.js'));
  const opens = hook.indexOf('export function useCommentCount');
  assert.ok(opens > 0, 'useCommentCount must exist');
  // Bounded at both ends by lines of the effect itself — its own dependency
  // array closes the slice, so this can neither miss the body nor run on into
  // whatever is written after the hook.
  const closes = hook.indexOf('}, [enabled, paperId]);', opens);
  assert.ok(closes > opens, 'the effect depends on exactly [enabled, paperId]');
  const effect = hook.slice(opens, closes);
  assert.match(
    effect,
    /return watchCommentCount\(paper,/,
    'the effect returns the subscription, so React unsubscribes on unmount',
  );
  assert.doesNotMatch(effect, /loadCommentCount/, 'the hook subscribes; it does not fire a one-shot read of its own');
});
