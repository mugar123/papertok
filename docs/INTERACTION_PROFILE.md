# Interaction profile aggregate

## The problem

`FeedContext` used to build its recommendation profile by reading
`users/{uid}/interactions` in full on every feed load, with no `limit()`. There
is one document per paper the account has ever touched, and *touched* includes
scrolling past: `trackSkips` and `trackViewTime` both write one. So the cost of
a feed load grew with the age of the account — 3.000 papers seen meant 3.000
Firestore reads, every load, forever.

That was the only unbounded read in the project.

## The shape of what that read produced

The scan produced seven things, and they do not all have the same requirements:

| Output | Consumer | Needs |
| --- | --- | --- |
| `categoryAffinities` | `scorePaperForRecommendation` | a few hundred numbers |
| `categoryCooldowns` | `scorePaperForRecommendation` | one timestamp per category |
| `likedPaperIds` | filled heart in 6 components, Favorites list | **exact, enumerable** |
| `savedPaperIds` | saved icon, `markSaved` guard | **exact, enumerable** |
| `readPaperIds` | read icon, reading history, report ranking | **exact, enumerable** |
| `notInterestedIds` | feed filter, report exclusion | **exact, enumerable** |
| `personalLibrary` | the whole reading library UI | **exact, with a paper per record** |

This matters because it rules out the obvious fix. Replacing the scan with
affinities plus a Bloom filter for "already seen" would put false positives into
`likedPaperIds`, and a false positive there is a filled heart on a paper the
user never liked. That is a visible product change, not an optimisation.

The other thing the scan revealed: a document whose only fields are `skip` and
`viewTime` lands in *none* of the four id sets. The persistent exclusion set is
only ever the four deliberate-action sets. Papers the user merely scrolled past
can already come back around the feed, bounded by a 500-entry `localStorage`
window. That is existing behaviour and this change keeps it.

## The design

A single derived document at **`users/{uid}/aggregates/interactions`**, read
once per feed load.

A dedicated document rather than a field on `users/{uid}`, because that user
document is read on every auth state change and already carries up to 280 KB of
profile photo. Bolting a second large payload onto it would slow the auth
bootstrap for the benefit of a screen the user may never open. A separate
document also gets its own rules block, its own size bounds, and can be deleted
and rebuilt without touching the account.

```
users/{uid}/aggregates/interactions
  schemaVersion    int     1
  updatedAt        string  ISO
  affinities       string  JSON: category cohorts + cooldowns
  curated          string  JSON: exact id lists, recency ordered
  seenFilter       string  base64 Bloom filter (optional)
  interactionCount int
  evictedCount     int
  sourceDocCount   int
  truncated        bool
```

Payloads are JSON strings rather than nested maps: it keeps the rules validation
down to size checks, sidesteps map keys containing dots (`cs.AI`, `math.NT`),
and makes the 1 MiB budget something you can assert on directly.

### Affinities that survive being incremental

The full scan weighted every interaction by `max(0.2, exp(-ageDays/30))`, a
factor that changes every second. A running total cannot reproduce that.

Exponential decay is separable, though, so each category keeps one bucket per
day for the ~48 days where the exponential is above the 0.2 floor. A bucket
holds `Σ impact · exp((t - dayStart)/30d)`; reading multiplies it by
`exp(-cohortAge/30d)`, which reconstructs each item's own decay factor exactly.
Once a bucket falls entirely past the floor, its raw impact merges into one aged
accumulator weighted at the flat 0.2 and the bucket is dropped.

That bounds a category at ~50 numbers regardless of history, and it is exact
rather than approximate. `interactionProfile.test.js` asserts it against a
reference implementation of the old scan: agreement to 1e-9 over a 40-day
history, and within 1% over two years (the residual is day-granularity at the
floor boundary).

### "Already seen": exact ids, with a Bloom filter behind them

Chose option (a) from the brief, with one adjustment forced by the table above.

The four exclusion sets are stored as **exact id lists**, capped per set
(4.000 read, 3.000 not-interested, 2.000 liked, 2.000 saved, 1.000 read-later)
and ordered newest first. Anything evicted past a cap goes into a **Bloom
filter** serialised as base64.

Sizing, for ~1% false positives at 50.000 evicted items:

```
m = ceil(-n · log2(p) / ln2) = 479.264 bits  (58,5 KiB raw)
k = ceil(ln2 · m / n)        = 7
base64                       = 79.880 chars  (78,0 KiB)
```

Measured: 0 false negatives and 0,94% false positives at 50.000 items.

The filter holds **only evictions**, never every interacted paper. If it held
everything, un-liking a paper could not make it eligible for the feed again,
which is a behaviour change. Restricting it to the overflow tier means the
Bloom filter is empty for every realistic account today and only ever engages
past the caps, where the ids are too old to appear in any UI list anyway.

Library: `bloomfilter@1.1.0`. Pure ESM, zero dependencies, touches nothing but
`ArrayBuffer` and typed arrays, last published 2026-03. Verified in the browser
against the dev server with no Node polyfills. Serialisation is our own — the
library's `toJSON` emits a JSON array of 14.977 integers (~150 KB) where base64
of the same bits is 78 KB — and it is explicitly little-endian so a profile
written on one device decodes on the next.

### Who writes it

**The browser, directly**, like every other write in the app.

A Worker round trip would add latency to every swipe and needs a secret that a
derived document does not justify. The rules bound its shape and every payload
size, so a client cannot park an arbitrary blob in its own tree.

The risk the brief flags — a corrupt aggregate degrades the feed without
breaking it visibly — is handled by making corruption *loud to the code* rather
than by moving the write:

- `schemaVersion` must match exactly; anything else is treated as unreadable.
- A payload that fails to parse returns `null`, not a partial profile.
- Either case takes the same path as a missing document: rebuild once, bounded.
- A profile that failed to load is marked unhydrated and is **never written
  back**, so a timed-out read cannot overwrite a good aggregate with an empty
  one.

To force a global rebuild, bump `INTERACTION_PROFILE_SCHEMA_VERSION`.

### The interaction documents stay

Untouched, and still the source of truth. Nothing is deleted. The aggregate is
derived and reconstructible, which is exactly what makes every recovery path
above safe.

### Three outcomes, three shapes

`loadInteractionProfile` returns a tagged union, because the first version of
this code returned `{ profile, rebuildSuppressed }` and a refusal to load handed
back an empty profile that was indistinguishable from a new account's.
FeedContext could not tell them apart, wrote it into React state, and a user
with 39 likes saw none of them.

| status | carries a profile | meaning |
| --- | --- | --- |
| `LOADED` | yes | real data, from the aggregate or a rebuild |
| `EMPTY` | yes | determined with certainty that there is nothing yet |
| `UNAVAILABLE` | **no `profile` key at all** | could not be determined |

`UNAVAILABLE` is structurally missing the `profile` property, so code that skips
the status check gets `undefined` rather than a plausible lie. FeedContext
handles it by returning without touching a single setter: whatever is on screen
for that account stays, and the aggregate stays unwritten.

The only place allowed to blank the id sets is an account change, which must
clear them so one account never sees another's papers.

### Drift, and repairing it

The aggregate can fall behind its subcollection. A session whose profile came
back `UNAVAILABLE` still writes interaction documents but is barred from writing
the aggregate, because writing an unhydrated profile would overwrite a good one;
two tabs open at once resolve to last-write-wins. Neither loses data, but both
leave likes the aggregate has never seen, and the user watches them vanish on
the next load.

`sourceDocCount` is the aggregate's own count of the interaction documents it
accounts for: exact after a rebuild, and incremented for every paper new to the
profile. Comparing it against a Firestore `count()` of the subcollection catches
both cases, and a rebuild repairs them.

Two things keep this from undoing the whole point of the change:

- **It is throttled.** A count aggregation is billed per batch of index entries
  rather than per document, so it is far cheaper than the scan it avoids, but it
  is not free — running it on every load would take a feed load from one read to
  three. Each device checks at most once a week, tracked in `localStorage` so
  the throttle needs no Firestore write and no schema change.
- **It fails safe.** `sourceDocCount` is biased upwards, because a paper touched
  in an earlier session with nothing but skips gets counted again. The drift
  estimate therefore under-reports, and a rebuild only happens past
  `max(25 documents, 2%)`. A failed count changes nothing.

In development React StrictMode runs the load twice; the run that detects the
drift repairs the stored aggregate, while the run whose result reaches the
screen may still show the pre-repair profile until the next load. Production
renders once and applies the repaired profile immediately.

### The fallback

If the aggregate is missing, stale or corrupt, it is rebuilt once from
`interactions`, paginated 500 at a time by document id — not by `timestamp`,
which is an optional field an `orderBy` would silently filter on — with a hard
ceiling of **5.000 documents**. Past the ceiling the profile is written with
`truncated: true` rather than the read continuing.

The path cannot become the unbounded scan again:

- the ceiling caps a single rebuild;
- a per-session cache holds the in-flight or settled rebuild per account, so
  concurrent loads share one scan and later loads reuse its result for free;
- a rebuild that throws stays cached as a rejection, so repeated failures short
  circuit to `UNAVAILABLE` instead of rescanning;
- success persists the aggregate, so it does not run twice.

Sharing rather than suppressing matters: React StrictMode mounts effects twice,
so two loads race on every development page load. Both now receive the same real
profile and only one pays for the scan.

### The reading library

It carries a serialised paper per record and was the largest thing riding along
on every feed load. It is now fetched on demand by the two screens that render
it (`ListsPage`, `SaveToListModal`) via `ensurePersonalLibrary()`, from the ids
the aggregate already holds, in `in` batches of 10, capped at 600 records.

## Cost

For an account with 3.000 interactions:

| | Reads per feed load |
| --- | --- |
| Before | 3.000 |
| After | **1** |
| After, first load only | 3.001 (one-off rebuild, or 0 extra if backfilled) |

Writes go from one per interaction to one per interaction plus one coalesced
aggregate write per 4 seconds of activity. A burst of skips already batches into
a single `writeBatch`, and the aggregate flush is debounced on top of that.

## Known limits

Two paths can still make an already-earned like or save stop showing, both of
them needing thousands of kept papers to reach. Neither loses data.

1. **Curated caps.** Past 2.000 likes or 2.000 saves the oldest ids move into
   the Bloom filter, which keeps them out of the feed but drops them from the
   Favorites list.
2. **The 320 KB curated byte budget.** If the id lists somehow exceed it, the
   largest set is trimmed by a quarter. Needs roughly 8.000 ids to trigger.

The 5.000 document rebuild ceiling is separate: an account with more history
gets a partial profile until `scripts/backfill-user-profiles.js` runs, which has
no such ceiling.
