# Comments Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three comment bugs of the audit: the sheet that opens without a composer while the viewer's profile is still on the wire (C3), the "My comments" page that shows a false "No comments yet" after ten seconds of skeleton (C2), and the "Comment posted" chip that never leaves, has no colour and no motion (C1).

**Architecture:** Each bug gets one small pure module with behaviour tests plus a wiring change in the component it belongs to, pinned by a source test (the repo has no DOM runtime). C3 seeds the composer gate from the account caches the app already warms and reads the profile through `patientRead`, so the footer is never empty and a stalled channel can never say "create your profile". C2 makes the author-page read report `fromCache`, and an empty cached answer becomes a transient error that `patientRead` retries instead of a verdict. C1 gives the notice a sequence number and a lifetime: the persistent live region stays, a keyed chip inside it enters and leaves through the sheet's own `ThreadSlot`, success expires at 2 400 ms, and tones map to the existing tint tokens.

**Tech Stack:** React 19, framer-motion, Firebase Firestore SDK (memory cache only), `node --test` (behaviour tests for pure modules, source tests by regex for JSX/CSS), Vite.

**Spec:** `docs/AUDITORIA-COMENTARIOS-2026-09-05.md` — findings C1, C2, C3 with line references and the server measurement (the author query answers in 90–400 ms and returns one row for @mugar).

**Base:** `3672991` (origin/main), the shadcn/ui-on-Base-UI migration. The audit was written against `ee6b967`; the migration rewrote `CommentsSheet.jsx` (the sheet is now a Base UI `Drawer`, the composer field is the `ui` `Textarea`) and `CommentsSheet.css`, so every line number below is re-derived against `3672991`. All three findings survive the migration unchanged. Baseline: 2140 tests passing.

## Global Constraints

- Tests run with `npm test` (`node --test $(find src worker proxy -name '*.test.js')`) under Node 22 in CI (local is Node 25). There is no DOM runtime: behaviour tests cover pure modules; JSX and CSS are pinned by source tests that strip comments first (`stripComments`, as in `commentsComposerAccessibility.test.js`).
- `src/services/firebase.js` must keep `export const IS_DEMO = false;` in every commit.
- Firestore keeps its in-memory cache on purpose (`firebase.js:49`). Rule from `src/utils/cacheAuthority.js`: **data in hand is data; an absence has to come from the server.** Never treat an empty `fromCache` answer as knowledge.
- Every Firestore read that gates a screen goes through `patientRead` (`src/utils/boundedRead.js`) with an `AbortController` aborted in the effect cleanup; `unavailable` is retried, never shown as a verdict.
- New motion animates only through the sheet's existing `ThreadSlot` (height + opacity, `ARRIVE`/`RESIZE` curves, reduced motion → duration 0). No new curves, no new durations except the notice lifetime.
- Colour comes from `src/styles/variables.css` tint tokens (`--tint-green-*`, `--tint-red-*`, `--tint-neutral-*`), never literals.
- Copy is bilingual through the file's `COPY` table and `text()`; every new string gets `es` and `en`.
- The sheet is a Base UI `Drawer` and `src/components/Comments/commentsSheetDrawer.test.js` pins its seam. Three of its assertions bind every change here: `onClose()` appears **exactly once** in the file (the gates close through `requestClose`), the composer field is `<Textarea …/>` from `../ui/textarea.jsx`, and the words `useDialogFocus`, `asChild`, `is-closing`, `setClosing`, `EXIT_MS`, `comments-sheet-backdrop` and `aria-modal=` must not appear. A `Button` that renders a link uses `render={<Link …/>}`, never `asChild`.
- `Textarea` already carries `disabled:cursor-not-allowed disabled:opacity-50` from its own Tailwind classes; a disabled composer needs the attribute, not new CSS.
- Commit messages in Spanish, `tipo(ámbito): …`, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Another session may be editing the same tree: `git status` before each commit and stage files by name.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/components/Comments/composerGate.js` (new) | Pure: what the composer may do given auth + profile, and the profile seed from the account caches. |
| `src/components/Comments/composerGate.test.js` (new) | Behaviour tests for the gate and the seed. |
| `src/components/Comments/CommentsSheet.jsx` | Uses the gate; reads the profile through `patientRead`; renders a disabled composer while loading; notice with sequence, lifetime and animated chip. |
| `src/components/Comments/CommentsSheet.css` | Disabled composer look; notice chip tones; `.has-text` removed. |
| `src/components/Comments/commentsComposerGate.test.js` (new) | Source test pinning the C3 wiring. |
| `src/components/Comments/noticeLifecycle.js` (new) | Pure: notice sequence, lifetime per tone, expiry. |
| `src/components/Comments/noticeLifecycle.test.js` (new) | Behaviour tests. |
| `src/components/Comments/commentsNoticeLifecycle.test.js` (new) | Source test pinning the C1 wiring and CSS. |
| `src/services/commentService.js` | `readAuthorPage` returns `{ rows, fromCache }`; `fetchMyCommentsPage` exposes `fromCache`. |
| `src/services/commentService.test.js` | Updated override shape; two new tests. |
| `src/components/Settings/myCommentsLoad.js` (new) | Pure: turns an empty cached page into a transient error. |
| `src/components/Settings/myCommentsLoad.test.js` (new) | Behaviour tests. |
| `src/components/Settings/MyCommentsPage.jsx` | `patientRead` load with slow/offline/stalled states and retry. |
| `src/components/Settings/myCommentsPageLoad.test.js` (new) | Source test pinning the C2 wiring. |
| `src/App.jsx` | Preloads the history chunk with the other settings chunks. |

---

### Task 1: The composer gate as a pure module (C3)

**Files:**
- Create: `src/components/Comments/composerGate.js`
- Test: `src/components/Comments/composerGate.test.js`

**Interfaces:**
- Consumes: `profileIsPublic(profile)` from `src/services/userProfileService.js`; `hydrateAccountCaches(uid, { storage })` from `src/services/accountWarmup.js`; `ownProfileCache`, `ownProfileKey(uid)` from `src/utils/profileSessionCaches.js` (entries are `{ profile }` wrappers, `undefined` = never asked, `{ profile: null }` = asked, none).
- Produces:
  - `LOADING_PROFILE` — frozen `{ status: 'loading', profile: null, uid: undefined }`.
  - `ownProfileFrom(profile)` → `{ status: 'ready', profile: profile | null, uid: profile?.uid | undefined }`.
  - `composerStateFor({ isAuthenticated, ownProfile })` → `'signed-out' | 'loading' | 'no-profile' | 'private' | 'ready'`.
  - `seedOwnProfile(uid, { cache?, hydrate? })` → the `ownProfileFrom(...)` shape, or `null` when the caches have never been asked.

- [ ] **Step 1: Write the failing tests**

```js
// src/components/Comments/composerGate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCache } from '../../utils/sessionCache.js';
import { ownProfileKey } from '../../utils/profileSessionCaches.js';
import {
  LOADING_PROFILE,
  composerStateFor,
  ownProfileFrom,
  seedOwnProfile,
} from './composerGate.js';

const PUBLIC = { uid: 'u1', handle: 'alice', visibility: 'public' };
const PRIVATE = { uid: 'u1', handle: 'alice', visibility: 'private' };

test('signed out wins over everything, even a ready profile', () => {
  assert.equal(composerStateFor({ isAuthenticated: false, ownProfile: ownProfileFrom(PUBLIC) }), 'signed-out');
});

test('an unresolved profile is loading, never a refusal', () => {
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: LOADING_PROFILE }), 'loading');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: undefined }), 'loading');
});

test('the three doors: no profile, private, ready', () => {
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(null) }), 'no-profile');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(PRIVATE) }), 'private');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(PUBLIC) }), 'ready');
});

test('ownProfileFrom carries the uid only when there is a profile', () => {
  assert.deepEqual(ownProfileFrom(PUBLIC), { status: 'ready', profile: PUBLIC, uid: 'u1' });
  assert.deepEqual(ownProfileFrom(null), { status: 'ready', profile: null, uid: undefined });
  assert.deepEqual(ownProfileFrom(undefined), { status: 'ready', profile: null, uid: undefined });
});

test('the seed hydrates first, then reads the account cache', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  const calls = [];
  const hydrate = (uid) => { calls.push(uid); cache.set(ownProfileKey(uid), { profile: PUBLIC }); };
  assert.deepEqual(seedOwnProfile('u1', { cache, hydrate }), ownProfileFrom(PUBLIC));
  assert.deepEqual(calls, ['u1']);
});

test('a cached "no profile" seeds as no profile; a never-asked cache seeds nothing', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  cache.set(ownProfileKey('u1'), { profile: null });
  assert.deepEqual(seedOwnProfile('u1', { cache, hydrate: () => {} }), ownProfileFrom(null));
  assert.equal(seedOwnProfile('u2', { cache, hydrate: () => {} }), null);
  assert.equal(seedOwnProfile('', { cache, hydrate: () => { throw new Error('must not hydrate without a uid'); } }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/components/Comments/composerGate.test.js`
Expected: FAIL — `Cannot find module './composerGate.js'`.

- [ ] **Step 3: Write the module**

```js
// src/components/Comments/composerGate.js
import { profileIsPublic } from '../../services/userProfileService.js';
import { hydrateAccountCaches } from '../../services/accountWarmup.js';
import { ownProfileCache, ownProfileKey } from '../../utils/profileSessionCaches.js';

/**
 * Who may write, decided from two facts: whether there is a session, and
 * what the viewer's own profile says. Pure, so the sheet's five-way footer
 * can be pinned without a DOM.
 *
 * The composer used to keep a private one-slot cache of the profile that
 * only filled after the sheet itself had resolved it once. The account
 * caches already hold the same document — hydrated from localStorage the
 * moment a session exists and revalidated by `warmAccountCaches` — so the
 * seed reads those, and the footer paints on open instead of waiting for a
 * channel that may not be up yet.
 */

export const LOADING_PROFILE = Object.freeze({ status: 'loading', profile: null, uid: undefined });

export function ownProfileFrom(profile) {
  return { status: 'ready', profile: profile ?? null, uid: profile?.uid ?? undefined };
}

export function composerStateFor({ isAuthenticated, ownProfile }) {
  if (!isAuthenticated) return 'signed-out';
  if (!ownProfile || ownProfile.status !== 'ready') return 'loading';
  if (!ownProfile.profile) return 'no-profile';
  if (!profileIsPublic(ownProfile.profile)) return 'private';
  return 'ready';
}

/**
 * The profile this device already knows for `uid`, or `null` when the
 * caches were never asked. `{ profile: null }` in the cache is an answer —
 * the server said there is no profile — and seeds as such.
 */
export function seedOwnProfile(uid, { cache = ownProfileCache, hydrate = hydrateAccountCaches } = {}) {
  if (!uid) return null;
  hydrate(uid);
  const entry = cache.get(ownProfileKey(uid));
  if (entry === undefined) return null;
  return ownProfileFrom(entry.profile);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/components/Comments/composerGate.test.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git status
git add src/components/Comments/composerGate.js src/components/Comments/composerGate.test.js
git commit -m "feat(comentarios): la puerta del compositor es un módulo puro sembrado desde las caches de cuenta

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The sheet never opens without a footer (C3)

**Files:**
- Modify: `src/components/Comments/CommentsSheet.jsx` (imports `:28-36`; module cache `:44-46`; state `:391-393`; profile effect `:544-565`; `composerState` `:587-596`; footer `:976-1075`; the duplicate `aria-label` at `:1040`)
- Test: `src/components/Comments/commentsComposerGate.test.js`

**Interfaces:**
- Consumes: Task 1's `LOADING_PROFILE`, `ownProfileFrom`, `composerStateFor`, `seedOwnProfile`; `patientRead`, `isReadTimeout` (already imported at `:32`); `auth` from `src/services/firebase.js`; `rememberOwnProfile(uid, profile)` from `src/utils/profileSessionCaches.js`.
- Produces: nothing new for later tasks. `composerState` keeps its five values and `viewerUid` keeps meaning `ownProfile.uid || null`.

- [ ] **Step 1: Write the failing source test**

```js
// src/components/Comments/commentsComposerGate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE tests for finding C3 of docs/AUDITORIA-COMENTARIOS-2026-09-05.md:
 * the sheet opened with an empty footer while the viewer's profile was on
 * the wire, and a stalled channel ended as "create your profile".
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the composer gate is the pure module, seeded from the account caches', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /from '\.\/composerGate\.js'/);
  assert.match(jsx, /composerStateFor\(\{ isAuthenticated, ownProfile \}\)/);
  assert.match(jsx, /seedOwnProfile\(auth\.currentUser\?\.uid\)/);
  assert.doesNotMatch(jsx, /viewerProfileCache/, 'the private one-slot cache is gone');
});

test('the own profile is read with patience and a stalled read never becomes "no profile"', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const effect = jsx.match(/patientRead\(\(\) => readOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/);
  assert.ok(effect, 'the profile read goes through patientRead and aborts on cleanup');
  assert.match(effect[0], /onLateResult: apply/);
  assert.match(effect[0], /if \(isReadTimeout\(error\)\) return;/);
  // `apply` is declared above the patientRead call, so it is outside the
  // match above; pin it on the whole file.
  assert.match(jsx, /rememberOwnProfile\(uid, profile\)/, 'the answer is written through to the shared cache');
});

test('the footer has a branch for loading: the composer, disabled', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const loading = jsx.match(/composerState === 'loading' && \([\s\S]*?\n\s*\)\}/);
  assert.ok(loading, 'a loading branch exists in the footer');
  assert.match(loading[0], /<Textarea[\s\S]*?className="comments-composer-input"[\s\S]*?disabled/);
  assert.match(loading[0], /placeholder=\{text\(COPY\.loading\)\}/);
  assert.match(loading[0], /aria-busy="true"/);
  assert.doesNotMatch(loading[0], /onClose\(\)/, 'the drawer test allows exactly one onClose() in the file');
  // The accessibility test matches the FIRST <Textarea> in the file and
  // expects the live composer; the placeholder one must come after it.
  const ready = jsx.indexOf("composerState === 'ready' && (");
  assert.ok(ready > -1 && ready < jsx.indexOf("composerState === 'loading' && ("), 'the loading branch sits after the ready branch');
});

test('the composer field carries exactly one aria-label', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const textarea = jsx.match(/<Textarea\b[\s\S]*?\/>/);
  assert.ok(textarea, 'the composer Textarea changed shape; update this test alongside it');
  const labels = textarea[0].match(/aria-label=/g) || [];
  assert.equal(labels.length, 1,
    'the shadcn migration left two aria-label attributes on the composer: the placeholder '
    + 'one and the real label. JSX keeps the last, so the name is right by accident — '
    + 'the dead one goes.');
  assert.match(textarea[0], /aria-label=\{text\(COPY\.composerLabel\)\}/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/components/Comments/commentsComposerGate.test.js`
Expected: FAIL on all four (no import, no `patientRead(() => readOwnUserProfile()`, no loading branch, two `aria-label` attributes).

- [ ] **Step 3: Rewire the imports and drop the private cache**

In `CommentsSheet.jsx`, extend the imports (`:28`):

```js
import { profileIsPublic, readOwnUserProfile } from '../../services/userProfileService.js';
```
becomes
```js
import { readOwnUserProfile } from '../../services/userProfileService.js';
import { auth } from '../../services/firebase.js';
import { rememberOwnProfile } from '../../utils/profileSessionCaches.js';
import { LOADING_PROFILE, composerStateFor, ownProfileFrom, seedOwnProfile } from './composerGate.js';
```

Delete lines `:44-46` (the `// One slot: the signed-in viewer…` comment and `let viewerProfileCache = null;`).

- [ ] **Step 4: Seed the state and read with patience**

Replace the `ownProfile` state (`:391-393`):

```js
  // Painted from what this device already knows (Task 1's seed) so the
  // footer exists on open; the effect below revalidates behind it.
  const [ownProfile, setOwnProfile] = useState(
    () => (isAuthenticated && seedOwnProfile(auth.currentUser?.uid)) || LOADING_PROFILE,
  );
```

Replace the profile effect (`:544-565`) with:

```js
  // The viewer's own profile decides what the composer is allowed to say.
  // Signed out, the composer never consults it (the signed-out gate comes
  // first), so the effect simply has nothing to fetch. Signed in, the read
  // is the one Firestore document the sheet still fetches itself — the
  // thread comes from the Worker — and on a cold channel it is the slow one,
  // so it gets the same patience as the thread: a spent budget is still a
  // wait (the loop keeps reading and `onLateResult` seats the answer), and
  // only a verdict settles the gate.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let active = true;
    const controller = new AbortController();
    const uid = auth.currentUser?.uid;
    const apply = (profile) => {
      if (!active) return;
      rememberOwnProfile(uid, profile);
      setOwnProfile(ownProfileFrom(profile));
    };
    patientRead(() => readOwnUserProfile(), {
      attempts: 2,
      label: 'own profile',
      signal: controller.signal,
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        if (!active) return;
        if (isReadTimeout(error)) return;
        // Not transient (patientRead never settles on those) and not a
        // timeout: permission, demo, a thrown TypeError. Honest answer.
        console.error('The viewer profile could not be read', error);
        setOwnProfile(ownProfileFrom(null));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [isAuthenticated]);
```

Replace the `composerState` ternary (`:587-596`) with:

```js
  const composerState = composerStateFor({ isAuthenticated, ownProfile });
```

- [ ] **Step 5: Add the loading branch to the footer and drop the dead label**

After the closing `)}` of the `composerState === 'ready' && (` block (just before `</footer>`), add:

```jsx
          {/* The profile has not answered yet. The composer is here anyway,
              inert: the footer is the bottom of a column, so a box that
              arrives late pushes everything above it up under the reader's
              thumb. Same box, same height, before and after. */}
          {composerState === 'loading' && (
            <div className="comments-composer" aria-busy="true">
              <div className="comments-composer-row">
                <Textarea
                  className="comments-composer-input"
                  rows={1}
                  disabled
                  placeholder={text(COPY.loading)}
                  aria-label={text(COPY.composerLabel)}
                />
                <Button type="button" className="comments-composer-send" disabled>
                  {text(COPY.send)}
                </Button>
              </div>
            </div>
          )}
```

`Textarea` already dims and blocks the cursor when disabled (its own Tailwind classes), so this needs no CSS.

In the live composer's `<Textarea>` (`:1038-1046`), delete the first of the two `aria-label` lines — `:1040`, `aria-label={text(COPY.placeholder)}` — keeping `placeholder=` and the real `aria-label={text(COPY.composerLabel)}`. JSX keeps the last of two identical attributes, so this changes no behaviour; it removes a dead line the migration left behind.

- [ ] **Step 6: Run the sheet's tests**

Run: `node --test src/components/Comments/*.test.js`
Expected: all passing, including `commentsComposerAccessibility.test.js` (its first `<textarea>` is still the live composer) and `commentsSheetStates.test.js`.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: succeeds; no unused-import warning for `profileIsPublic` (it is no longer imported by the sheet).

- [ ] **Step 8: Commit**

```bash
git status
git add src/components/Comments/CommentsSheet.jsx src/components/Comments/CommentsSheet.css src/components/Comments/commentsComposerGate.test.js
git commit -m "fix(comentarios): la hoja abre con la barra de escribir aunque el perfil siga en camino

El pie no tenía rama para 'loading' y la lectura del perfil iba sin acotar:
el hilo llegaba por el Worker en 200 ms y la barra esperaba al WebChannel.
Ahora se siembra desde las caches de cuenta, se lee con patientRead y un
canal mudo ya no se disfraza de «crea tu perfil». Cierra C3 de la auditoría.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The author page says whether it came from the cache (C2)

**Files:**
- Modify: `src/services/commentService.js:244-258` (`defaultReadAuthorPage`) and `:303-318` (`fetchMyCommentsPage`)
- Modify: `src/services/commentService.test.js:244-253` (existing override) plus two new tests

**Interfaces:**
- Produces: `api.readAuthorPage(database, uid, size, cursor)` resolves `{ rows: Array<{ id, data, paperKey, cursor }>, fromCache: boolean }`; `fetchMyCommentsPage()` resolves `{ comments, cursor, hasMore, fromCache }`.

- [ ] **Step 1: Update the existing test and write the two new ones**

In `commentService.test.js`, change the override at `:246-248` to the new shape and add the tests after it:

```js
test('my comments come back with the thread key their path names', async () => {
  const page = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({
      fromCache: false,
      rows: [{ id: 'c1', paperKey: 'K1', data: { text: 'a', status: 'hidden' }, cursor: 'x' }],
    }),
  }));
  assert.equal(page.comments[0].paperKey, 'K1');
  assert.equal(page.comments[0].status, 'hidden',
    'hidden comments surface here — it is where the author learns of moderation');
  assert.equal(page.fromCache, false);
});

test('an empty answer carries where it came from', async () => {
  const cached = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({ fromCache: true, rows: [] }),
  }));
  assert.deepEqual(cached, { comments: [], cursor: null, hasMore: false, fromCache: true });

  const server = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({ fromCache: false, rows: [] }),
  }));
  assert.equal(server.fromCache, false);
});

test('a missing fromCache flag counts as a server answer', async () => {
  const page = await fetchMyCommentsPage({}, api({ readAuthorPage: async () => ({ rows: [] }) }));
  assert.equal(page.fromCache, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/services/commentService.test.js`
Expected: the three my-comments tests FAIL (`rows.map is not a function` on the object shape).

- [ ] **Step 3: Change the read and the page**

`defaultReadAuthorPage` (`:244-258`):

```js
async function defaultReadAuthorPage(database, uid, pageSize, cursor) {
  const snapshot = await getDocs(query(
    collectionGroup(database, 'comments'),
    where('authorUid', '==', uid),
    orderBy('createdAt', 'desc'),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(pageSize),
  ));
  return {
    // A query never rejects for lack of a backend: against a stalled channel
    // it resolves empty from the in-memory cache at the SDK's ten-second
    // mark. The caller must know, or it will paint that as "no comments".
    fromCache: snapshot.metadata?.fromCache === true,
    rows: snapshot.docs.map(document => ({
      id: document.id,
      data: document.data(),
      // papers/{paperKey}/comments/{id} — the grandparent names the thread.
      paperKey: document.ref.parent.parent?.id ?? null,
      cursor: document,
    })),
  };
}
```

`fetchMyCommentsPage` (`:303-318`):

```js
export async function fetchMyCommentsPage({ cursor = null, pageSize } = {}, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireViewer(api);
  const size = Number.isInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, MY_COMMENTS_PAGE_SIZE)
    : MY_COMMENTS_PAGE_SIZE;
  const { rows, fromCache = false } = await api.readAuthorPage(api.database, uid, size, cursor);
  const comments = rows.map(row => ({ id: row.id, paperKey: row.paperKey, ...row.data }));
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    comments,
    cursor: rows.length >= size ? (last?.cursor ?? null) : null,
    hasMore: rows.length >= size,
    fromCache: fromCache === true,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/services/commentService.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git status
git add src/services/commentService.js src/services/commentService.test.js
git commit -m "feat(comentarios): la página de autor dice si vino de la cache

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: "My comments" waits instead of lying (C2)

**Files:**
- Create: `src/components/Settings/myCommentsLoad.js`
- Test: `src/components/Settings/myCommentsLoad.test.js`
- Modify: `src/components/Settings/MyCommentsPage.jsx` (imports `:1-9`; `COPY` `:18-42`; effect `:67-82`; `loadMore` `:84-100`; render `:130-152`)
- Test: `src/components/Settings/myCommentsPageLoad.test.js`

**Interfaces:**
- Consumes: Task 3's `fetchMyCommentsPage()` → `{ comments, cursor, hasMore, fromCache }`; `patientRead`, `isReadTimeout`, `isTransientReadError` from `src/utils/boundedRead.js`.
- Produces: `authoritativePage(page)` returns `page` or throws `UnconfirmedAbsenceError` (`code: 'unavailable'`, so `isTransientReadError` is true and `patientRead` retries it).

- [ ] **Step 1: Write the failing behaviour tests**

```js
// src/components/Settings/myCommentsLoad.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientReadError } from '../../utils/boundedRead.js';
import { UnconfirmedAbsenceError, authoritativePage } from './myCommentsLoad.js';

const EMPTY = { comments: [], cursor: null, hasMore: false };

test('an empty page from the cache is not an answer, and patientRead will retry it', () => {
  assert.throws(() => authoritativePage({ ...EMPTY, fromCache: true }), UnconfirmedAbsenceError);
  try {
    authoritativePage({ ...EMPTY, fromCache: true });
  } catch (error) {
    assert.equal(error.code, 'unavailable');
    assert.equal(isTransientReadError(error), true);
  }
});

test('an empty page the server vouched for is an answer', () => {
  const page = { ...EMPTY, fromCache: false };
  assert.equal(authoritativePage(page), page);
});

test('data in hand is data, cached or not', () => {
  const page = { comments: [{ id: 'c1' }], cursor: null, hasMore: false, fromCache: true };
  assert.equal(authoritativePage(page), page);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/components/Settings/myCommentsLoad.test.js`
Expected: FAIL — `Cannot find module './myCommentsLoad.js'`.

- [ ] **Step 3: Write the module**

```js
// src/components/Settings/myCommentsLoad.js
/**
 * The one rule this page kept breaking (docs/AUDITORIA-COMENTARIOS-2026-09-05.md,
 * C2): a `getDocs` against a stalled channel does not reject — at the SDK's
 * ten-second mark it resolves empty from the in-memory cache — and the page
 * painted that as "You have not commented on any paper yet". An absence has
 * to come from the server (src/utils/cacheAuthority.js). Here that absence
 * becomes the most retryable error Firestore has, so `patientRead` keeps
 * asking and the eventual server answer heals the screen.
 */
export class UnconfirmedAbsenceError extends Error {
  constructor() {
    super('The empty answer came from the cache, not the server.');
    this.name = 'UnconfirmedAbsenceError';
    this.code = 'unavailable';
  }
}

export function authoritativePage(page) {
  if (page.comments.length === 0 && page.fromCache) throw new UnconfirmedAbsenceError();
  return page;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test src/components/Settings/myCommentsLoad.test.js`
Expected: 3 passing.

- [ ] **Step 5: Write the failing source test for the page**

```js
// src/components/Settings/myCommentsPageLoad.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** SOURCE tests for C2: the history page loads with patience and never paints a cached absence. */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the first page goes through patientRead and the authority check, and aborts on cleanup', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /from '\.\/myCommentsLoad\.js'/);
  const effect = jsx.match(/patientRead\(\(\) => fetchMyCommentsPage\(\)\.then\(authoritativePage\)[\s\S]*?controller\.abort\(\);/);
  assert.ok(effect, 'the load is a patientRead over fetchMyCommentsPage().then(authoritativePage)');
  assert.match(effect[0], /onSlow:/);
  assert.match(effect[0], /onLateResult: apply/);
  assert.match(effect[0], /isReadTimeout\(error\)/);
});

test('the waits have words, and only ready can be empty', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /const WAITING_COPY = \{[\s\S]*?slow:[\s\S]*?offline:[\s\S]*?stalled:[\s\S]*?error:[\s\S]*?\};/);
  assert.match(jsx, /WAITING_COPY\[state\.status\] && \(/);
  assert.match(jsx, /state\.status === 'ready' && state\.rows\.length === 0 && \(/);
  assert.doesNotMatch(jsx, /state\.status === 'error' && \(/, 'the old error-only block is folded into the waits');
});

test('load more also refuses a cached absence', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /fetchMyCommentsPage\(\{ cursor: state\.cursor \}\)\.then\(authoritativePage\)/);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test src/components/Settings/myCommentsPageLoad.test.js`
Expected: FAIL on all three.

- [ ] **Step 7: Rewire the page**

Imports (`:1-9`) — add:

```js
import { isReadTimeout, patientRead } from '../../utils/boundedRead.js';
import { authoritativePage } from './myCommentsLoad.js';
```

`COPY` (`:18-42`) — add after `error:`:

```js
  slowLoad: {
    es: 'Está tardando más de lo normal. Seguimos intentándolo.',
    en: 'This is taking longer than usual. Still trying.',
  },
  noConnection: {
    es: 'Parece que no hay conexión. Seguimos intentándolo.',
    en: 'There seems to be no connection. Still trying.',
  },
  stalledLoad: {
    es: 'Está tardando muchísimo. Seguimos intentándolo por detrás.',
    en: 'This is taking unusually long. We are still trying in the background.',
  },
```

After the `COPY` table:

```js
/**
 * What the page says while it is not showing the list. Three are waits (the
 * retry loop is still running behind them); only `error` is a verdict.
 */
const WAITING_COPY = {
  slow: COPY.slowLoad,
  offline: COPY.noConnection,
  stalled: COPY.stalledLoad,
  error: COPY.error,
};
```

Replace the effect (`:67-82`):

```js
  // The initial state is already 'loading'; the retry button re-arms it in
  // its own handler, so the effect never needs a synchronous setState. The
  // read is the only comments query with no edge path — it is the one that
  // meets a cold WebChannel — so it waits like the sheet does: intermediate
  // timeouts become words, a transient rejection (including an empty cached
  // answer, see myCommentsLoad.js) is retried, and the loop outlives the
  // promise so a late answer still heals the screen.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const apply = (page) => {
      if (!active) return;
      setState({ status: 'ready', rows: page.comments, cursor: page.cursor, hasMore: page.hasMore });
    };
    patientRead(() => fetchMyCommentsPage().then(authoritativePage), {
      attempts: 3,
      label: 'my comments',
      signal: controller.signal,
      onSlow: (attemptNumber, info) => {
        if (active) setState(previous => ({ ...previous, status: info?.offline ? 'offline' : 'slow' }));
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        if (!active) return;
        if (isReadTimeout(error)) {
          console.warn('My comments did not answer in time', error);
          setState(previous => ({ ...previous, status: 'stalled' }));
          return;
        }
        console.error('My comments could not be loaded', error);
        setState({ status: 'error', rows: [], cursor: null, hasMore: false });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);
```

In `loadMore` (`:88`) change the read to:

```js
      const page = await fetchMyCommentsPage({ cursor: state.cursor }).then(authoritativePage);
```

Replace the render blocks for `loading` and `error` (`:130-152`) with:

```jsx
        {state.status === 'loading' && (
          <div className="my-comments-loading" aria-busy="true" aria-label={text(COPY.loading)}>
            <div className="my-comments-skeleton" />
            <div className="my-comments-skeleton" />
            <div className="my-comments-skeleton" />
          </div>
        )}

        {WAITING_COPY[state.status] && (
          // 'slow', 'offline' and 'stalled' keep aria-busy and the retry loop
          // behind them; only 'error' is a verdict.
          <div className="my-comments-state" role="status" aria-busy={state.status !== 'error'}>
            <p>{text(WAITING_COPY[state.status])}</p>
            <button
              type="button"
              className="my-comments-more"
              onClick={() => {
                setState(previous => ({ ...previous, status: 'loading' }));
                setAttempt(value => value + 1);
              }}
            >
              {text(COPY.retry)}
            </button>
          </div>
        )}
```

- [ ] **Step 8: Run the settings tests and the build**

Run: `node --test src/components/Settings/*.test.js && npm run build`
Expected: all passing; build succeeds.

- [ ] **Step 9: Commit**

```bash
git status
git add src/components/Settings/myCommentsLoad.js src/components/Settings/myCommentsLoad.test.js src/components/Settings/MyCommentsPage.jsx src/components/Settings/myCommentsPageLoad.test.js
git commit -m "fix(ajustes): «Mis comentarios» espera con palabras en vez de pintar un vacío de cache

La página tomaba por respuesta el vacío fromCache que Firestore devuelve a
los 10 s contra un canal mudo. Ahora carga con patientRead, un vacío sin
confirmar es un error transitorio que se reintenta, y los estados lento /
sin conexión / atascado tienen copia y botón. Cierra C2 de la auditoría.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The history chunk is preloaded with the other settings chunks (C2, the "tarda")

**Files:**
- Modify: `src/App.jsx:170-171`

**Interfaces:**
- Consumes: `MyCommentsPage` is already `lazyWithPreload(...)` at `App.jsx:56`, so it has `.preload()`.

- [ ] **Step 1: Add the preload**

After `SettingsPage.preload().catch(() => {})` (`:171`) add:

```js
      // One row inside Settings; small chunk, and the first visit used to pay
      // it on top of the cold Firestore read the page then makes.
      MyCommentsPage.preload().catch(() => {})
```

- [ ] **Step 2: Verify and build**

Run: `grep -n "MyCommentsPage.preload" src/App.jsx && npm run build`
Expected: one match; build succeeds.

- [ ] **Step 3: Commit**

```bash
git status
git add src/App.jsx
git commit -m "perf(ajustes): precarga el chunk de «Mis comentarios» con los de ajustes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The notice lifecycle as a pure module (C1)

**Files:**
- Create: `src/components/Comments/noticeLifecycle.js`
- Test: `src/components/Comments/noticeLifecycle.test.js`

**Interfaces:**
- Produces:
  - `NOTICE_SUCCESS_MS = 2400`.
  - `IDLE_NOTICE` — frozen `{ tone: 'status', text: '', seq: 0 }`.
  - `nextNotice(previous, { tone, text })` → `{ tone, text, seq: previous.seq + 1 }`.
  - `clearedNotice(previous)` → same object when already empty, else `{ ...previous, text: '' }` (seq kept).
  - `noticeLifetime(notice)` → `2400` for a success with text, otherwise `null`.
  - `expireNotice(previous, seq)` → `clearedNotice(previous)` when `previous.seq === seq`, else `previous` untouched.

- [ ] **Step 1: Write the failing tests**

```js
// src/components/Comments/noticeLifecycle.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_NOTICE,
  NOTICE_SUCCESS_MS,
  clearedNotice,
  expireNotice,
  nextNotice,
  noticeLifetime,
} from './noticeLifecycle.js';

test('every announcement gets a new sequence number, even the same words twice', () => {
  const first = nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' });
  const second = nextNotice(first, { tone: 'success', text: 'Posted.' });
  assert.deepEqual(first, { tone: 'success', text: 'Posted.', seq: 1 });
  assert.equal(second.seq, 2);
});

test('clearing keeps the sequence and is a no-op on an idle notice', () => {
  const shown = nextNotice(IDLE_NOTICE, { tone: 'error', text: 'Failed.' });
  assert.deepEqual(clearedNotice(shown), { tone: 'error', text: '', seq: 1 });
  assert.equal(clearedNotice(IDLE_NOTICE), IDLE_NOTICE, 'same object, so React skips the render');
});

test('only a success expires on its own', () => {
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' })), NOTICE_SUCCESS_MS);
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'error', text: 'Failed.' })), null);
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'status', text: 'Wait.' })), null);
  assert.equal(noticeLifetime(IDLE_NOTICE), null);
  assert.equal(NOTICE_SUCCESS_MS, 2400);
});

test('an expiry only clears the notice it was armed for', () => {
  const first = nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' });
  const second = nextNotice(first, { tone: 'success', text: 'Saved.' });
  assert.equal(expireNotice(second, first.seq), second, 'a stale timer leaves the newer notice alone');
  assert.deepEqual(expireNotice(second, second.seq), { tone: 'success', text: '', seq: 2 });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/components/Comments/noticeLifecycle.test.js`
Expected: FAIL — `Cannot find module './noticeLifecycle.js'`.

- [ ] **Step 3: Write the module**

```js
// src/components/Comments/noticeLifecycle.js
/**
 * The sheet's one-line confirmations ("Comment posted.", "Changes saved.",
 * "Reported.") and its failures, as a value with a lifecycle.
 *
 * `seq` is what makes two identical confirmations two events: the chip is
 * keyed by it, so posting twice enters twice, and a timer armed for one
 * notice can never clear the next. A success leaves on its own after
 * NOTICE_SUCCESS_MS — long enough to read four words, short enough not to
 * read as stuck. Errors stay until the next action, because a failure is
 * something the reader may need to act on.
 */

export const NOTICE_SUCCESS_MS = 2400;

export const IDLE_NOTICE = Object.freeze({ tone: 'status', text: '', seq: 0 });

export function nextNotice(previous, { tone, text }) {
  return { tone, text, seq: (previous?.seq ?? 0) + 1 };
}

export function clearedNotice(previous) {
  if (!previous?.text) return previous;
  return { ...previous, text: '' };
}

export function noticeLifetime(notice) {
  if (!notice?.text) return null;
  return notice.tone === 'success' ? NOTICE_SUCCESS_MS : null;
}

export function expireNotice(previous, seq) {
  return previous?.seq === seq ? clearedNotice(previous) : previous;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test src/components/Comments/noticeLifecycle.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git status
git add src/components/Comments/noticeLifecycle.js src/components/Comments/noticeLifecycle.test.js
git commit -m "feat(comentarios): el aviso tiene secuencia y vida propia como módulo puro

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The chip arrives, turns green, and leaves (C1)

**Files:**
- Modify: `src/components/Comments/CommentsSheet.jsx` (imports; `notice` state `:397-405`; the clear/announce call sites at `:663`, `:672`, `:687`, `:702`, `:720`, `:723`, `:733`, `:742`, `:747-750`; the long comment `:650-662`; render `:961-973`)
- Modify: `src/components/Comments/CommentsSheet.css:405-424`
- Test: `src/components/Comments/commentsNoticeLifecycle.test.js`

**Interfaces:**
- Consumes: Task 6's `IDLE_NOTICE`, `nextNotice`, `clearedNotice`, `noticeLifetime`, `expireNotice`; the sheet's own `ThreadSlot({ children, reduced })` (`:68-89`) and `prefersReducedMotion`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing source test**

```js
// src/components/Comments/commentsNoticeLifecycle.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE tests for C1 of docs/AUDITORIA-COMENTARIOS-2026-09-05.md: the
 * "Comment posted." chip stayed forever, in neutral grey, with no motion.
 * The live region stays mounted (a region born with its message is often
 * not announced); what moves is a keyed chip inside it.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the notice is the pure lifecycle, and a success expires on a timer armed for its sequence', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /from '\.\/noticeLifecycle\.js'/);
  assert.match(jsx, /useState\(IDLE_NOTICE\)/);
  const effect = jsx.match(/const lifetime = noticeLifetime\(notice\);[\s\S]*?\}, \[notice\]\);/);
  assert.ok(effect, 'an effect keyed on the notice arms its lifetime');
  assert.match(effect[0], /setTimeout\(\(\) => setNotice\(previous => expireNotice\(previous, seq\)\), lifetime\)/);
  assert.match(effect[0], /return \(\) => clearTimeout\(timer\);/);
  assert.doesNotMatch(jsx, /setNotice\(\{/, 'every call site goes through announce()/clearNotice()');
});

test('the live region stays mounted; the chip inside it is keyed and animated by ThreadSlot', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const region = jsx.match(/<div\s+className="comments-sheet-notice"[\s\S]*?<\/div>\s*\n\s*<\/div>\s*\n\s*<footer/);
  assert.ok(region, 'the notice region is a div right before the footer');
  assert.match(region[0], /role=\{notice\.tone === 'error' \? 'alert' : 'status'\}/);
  assert.match(region[0], /aria-live=\{notice\.tone === 'error' \? 'assertive' : 'polite'\}/);
  assert.match(region[0], /<AnimatePresence mode="wait" initial=\{false\}>/);
  assert.match(region[0], /\{notice\.text && \(\s*<ThreadSlot key=\{notice\.seq\} reduced=\{prefersReducedMotion\}>/);
  assert.match(region[0], /className=\{`comments-sheet-notice-chip is-\$\{notice\.tone\}`\}/);
  assert.doesNotMatch(jsx, /has-text/);
});

test('success is green, error is red, the rest neutral — all from tokens', async () => {
  const css = await readFile(new URL('./CommentsSheet.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /has-text/);
  assert.doesNotMatch(css, /\.comments-sheet-notice \{[^}]*line-height: 0/);
  const base = css.match(/\.comments-sheet-notice-chip \{[^}]*\}/)?.[0] || '';
  assert.match(base, /background: var\(--tint-neutral-bg\);/);
  assert.match(base, /margin: var\(--space-3\) 0 var\(--space-4\);/);
  const success = css.match(/\.comments-sheet-notice-chip\.is-success \{[^}]*\}/)?.[0] || '';
  assert.match(success, /border-color: var\(--tint-green-line\);/);
  assert.match(success, /background: var\(--tint-green-bg\);/);
  assert.match(success, /color: var\(--tint-green-fg\);/);
  const error = css.match(/\.comments-sheet-notice-chip\.is-error \{[^}]*\}/)?.[0] || '';
  assert.match(error, /background: var\(--tint-red-bg\);/);
  assert.match(error, /color: var\(--tint-red-fg\);/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Comments/commentsNoticeLifecycle.test.js`
Expected: FAIL on all three.

- [ ] **Step 3: State, helpers and the timer**

Add the import next to the composerGate import:

```js
import { IDLE_NOTICE, clearedNotice, expireNotice, nextNotice, noticeLifetime } from './noticeLifecycle.js';
```

Replace the `notice` state and its comment (`:397-405`) with:

```js
  // { tone: 'status' | 'success' | 'error', text, seq } — see noticeLifecycle.js.
  // The region below is mounted persistently (empty by default) so it exists
  // before an action runs: a live region announces changes to its content,
  // and a node created at the same moment as its message is frequently
  // missed. The chip inside it is keyed by `seq`, so two identical
  // confirmations are two entrances, and a success clears itself.
  const [notice, setNotice] = useState(IDLE_NOTICE);
  const announce = useCallback((tone, message) => {
    setNotice(previous => nextNotice(previous, { tone, text: message }));
  }, []);
  const clearNotice = useCallback(() => setNotice(clearedNotice), []);

  useEffect(() => {
    const lifetime = noticeLifetime(notice);
    if (!lifetime) return undefined;
    const { seq } = notice;
    const timer = setTimeout(() => setNotice(previous => expireNotice(previous, seq)), lifetime);
    return () => clearTimeout(timer);
  }, [notice]);
```

- [ ] **Step 4: Replace every call site**

Replace the long comment in `submit()` (`:650-662`, from `// Cleared here, before the network call below` to `// genuine '' -> text transition each time, not a same-string no-op.`) with:

```js
    // Cleared before the network call so a failure never shows last time's
    // confirmation next to this time's error. The chip is keyed by `seq`,
    // so the same words twice in a row are still two entrances.
```

Then, in order:

| Line | Was | Becomes |
| --- | --- | --- |
| `:663` | `setNotice({ tone: 'status', text: '' });` | `clearNotice();` |
| `:672` | `setNotice({ tone: 'success', text: text(COPY.saved) });` | `announce('success', text(COPY.saved));` |
| `:687` | `setNotice({ tone: 'success', text: text(COPY.posted) });` | `announce('success', text(COPY.posted));` |
| `:702` | `setNotice({ tone: 'status', text: '' });` | `clearNotice();` |
| `:720` | `setNotice({ tone: 'success', text: text(COPY.deleted) });` | `announce('success', text(COPY.deleted));` |
| `:723` | `setNotice({ tone: 'error', text: text(COPY.deleteError) });` | `announce('error', text(COPY.deleteError));` |
| `:733` | `setNotice({ tone: 'status', text: '' });` | `clearNotice();` |
| `:742` | `setNotice({ tone: 'success', text: text(COPY.reported) });` | `announce('success', text(COPY.reported));` |
| `:747-750` | the multi-line `setNotice({ tone: 'error', text: error?.code === … })` | `announce('error', error?.code === 'permission-denied' ? text(COPY.reportThrottled) : text(COPY.writeError));` |

Also shorten the two comments that reference the old mechanism (`:699-701` in `remove()` and `:730-732` in `report()`) to `// Cleared before the write; see submit().`

Confirm with: `grep -n "setNotice(" src/components/Comments/CommentsSheet.jsx` — only the three uses inside the state block and the effect remain.

- [ ] **Step 5: The region and the chip**

Replace the render (`:961-973`, the `{/* Persistent rather than mounted… */}` comment and the `<p …>{notice.text}</p>`) with:

```jsx
          {/* The region is persistent (see the state above); the chip inside
              it is what comes and goes, through the same slot the reply chip
              and the composer error use, so it never shoves the thread by its
              own height in one frame. `mode="wait"`: a confirmation that
              replaces another lets it leave first instead of stacking. */}
          <div
            className="comments-sheet-notice"
            role={notice.tone === 'error' ? 'alert' : 'status'}
            aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
          >
            <AnimatePresence mode="wait" initial={false}>
              {notice.text && (
                <ThreadSlot key={notice.seq} reduced={prefersReducedMotion}>
                  <p className={`comments-sheet-notice-chip is-${notice.tone}`}>{notice.text}</p>
                </ThreadSlot>
              )}
            </AnimatePresence>
          </div>
        </div>

        <footer className="comments-sheet-footer">
```

(The `</div>` closing `.comments-sheet-body` and the `<footer>` line are the existing ones; they are shown so the region's place is unambiguous. In this tree the footer sits inside `DrawerBody`, so do not add or remove any closing tag — only the notice paragraph is replaced.)

- [ ] **Step 6: The CSS tones**

Replace `:405-424` (the comment, `.comments-sheet-notice { line-height: 0; }` and `.comments-sheet-notice.has-text { … }`) with:

```css
/* The confirmation chip. Its wrapper (`.comments-sheet-notice`) is the
   always-mounted live region and has no chrome of its own; the chip is the
   child that ThreadSlot folds in and out, so its margins ride inside the
   fold (the slot is overflow: hidden, a block formatting context). */
.comments-sheet-notice-chip {
  margin: var(--space-3) 0 var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--tint-neutral-line);
  border-radius: var(--radius-sm);
  background: var(--tint-neutral-bg);
  color: var(--tint-neutral-fg);
  font-size: var(--fs-xs);
  line-height: var(--lh-normal);
}

.comments-sheet-notice-chip.is-success {
  border-color: var(--tint-green-line);
  background: var(--tint-green-bg);
  color: var(--tint-green-fg);
}

.comments-sheet-notice-chip.is-error {
  border-color: var(--tint-red-line);
  background: var(--tint-red-bg);
  color: var(--tint-red-fg);
}
```

- [ ] **Step 7: Run the sheet's tests and the build**

Run: `node --test src/components/Comments/*.test.js && npm run build`
Expected: all passing (`commentsSheetStates.test.js` still finds its `popLayout` presence first; the new `mode="wait"` presence does not match its regex); build succeeds.

- [ ] **Step 8: Commit**

```bash
git status
git add src/components/Comments/CommentsSheet.jsx src/components/Comments/CommentsSheet.css src/components/Comments/commentsNoticeLifecycle.test.js
git commit -m "fix(comentarios): «Comentario publicado» llega en verde, se lee y se va

El aviso no tenía temporizador ni salida: se quedaba hasta la siguiente
acción, en gris para éxito y error. La región viva sigue montada (es lo que
hace que se anuncie); dentro, un chip keyed por secuencia entra y sale por
el ThreadSlot de la hoja, el éxito caduca a 2,4 s y los tonos usan los
tints verde y rojo. Cierra C1 de la auditoría.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-suite verification and the hand check

**Files:**
- None modified. Read-only verification; the manual checks need a session and are the user's.

- [ ] **Step 1: Full test run under the CI runtime**

Run: `npm test 2>&1 | tail -20`
Expected: every suite passing, no `cancelled` cases (a hung case under Node 22 shows as cancelled — see `papertok-node22-test-gotchas`).

- [ ] **Step 2: Production build and the guard**

Run: `npm run build && grep -n "export const IS_DEMO = false;" src/services/firebase.js`
Expected: build succeeds; the grep prints one line.

- [ ] **Step 3: Hand check (signed-in session, production preview)**

Report each as seen, not as expected:

1. Open the comments of any paper right after loading the app (cold channel). The footer shows the composer, disabled, with "Cargando..." for at most a moment, then enabled. It never shows "Comentar necesita un perfil público" for an account that has a public profile.
2. Post a comment. The chip enters green below the thread (height + fade), reads "Comentario publicado.", and folds away on its own after about 2.4 s. Post twice quickly: the second confirmation waits for the first to leave, then enters.
3. Delete a comment while offline (DevTools → Network → Offline): the red "No se pudo borrar" chip stays until the next action.
4. Settings → Mis comentarios after a minute of not touching Firestore. Either the list paints, or a "Está tardando más de lo normal" line with a retry button appears — never "Todavía no has comentado" while the read is still unresolved. With the network cut, the copy says there seems to be no connection.
5. Confirm with the account actually used for testing that the server holds the comments you expect: the audit's query returned one row for @mugar.

- [ ] **Step 4: Note the outcome in the audit**

Append to `docs/AUDITORIA-COMENTARIOS-2026-09-05.md` a final section `## Estado` with one line per finding: the closing commit hash and what the hand check showed. Commit it:

```bash
git add docs/AUDITORIA-COMENTARIOS-2026-09-05.md
git commit -m "docs(comentarios): estado de C1–C3 tras el arreglo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
