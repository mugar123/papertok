# Lane reads measurement

Status: measured on 2026-10-26 (ENG-128, phase 0). The feed is unchanged.

## Context

ENG-128 asks for a decision, based on measurements, on whether a request should
read more of each lane or choose its candidates by fit. The measurements it asks
for are the rows read, vectors read, memory and D1 time per request for readers
of 1, 6 and 12 categories, with and without likes. This record is that
baseline. It covers the store of main at `ead96548` (the walk of PAP-103, the
paper ids kept on the order, ADS's notable listings and the works lookup that
holds back a notable paper ADS listed until its enrichment, #391), measured with
`worker/test-support/measure-lane-reads.ts` on a local D1 that holds a synthetic
corpus at the sizes the code keeps. The tables come from a full run at `75ef9e05`,
with the "after a dismissal" rows from a rerun at `9640fe02`. A full run at
`70f7f3c6` gave the same rows read, D1 calls and papers in every row; its times
and memory are not used. No production data was read.

Every row here is the app's main page request alone (`fetchCorpusPage` with the
reader's categories as one group). A For You load also sends other requests to
the same route, which this record does not measure; see Limits.

## Results

Rows read are the local D1's own count (`meta.rows_read`), split by statement:

- lane reads are `readCandidates`;
- the notable scan is `readNotableCandidates`;
- vectors are `readVectors`;
- keys are `findWorks`;
- works are every statement that reads `works`: `readWorks`, the walk's paper-id
  reads over the regular ranking and the notable order (`unseenRanks`, with
  `walkPastDropped`) and `keepLiked`.

The seen filter holds the newest 2,000 papers of every lane the request asks
for, leaf and area, in date order. A feed without likes serves papers in that
order, because the ranking is by recency, and the area articles share the leaf
papers' recency: a filter of leaf papers only, which an earlier version of this
script used, left every area article unseen, so every page without likes was
served from them and its walk stopped at 200 or 600 ranks. A real filter holds
the cards the reader was served. Without likes those are the newest papers, as
here. With likes they are the closest-ranked ones, which this filter is not (see
Limits).

Page 2 is the next page of the same request: the app's, with page 1's papers
added to the seen filter, served from the order that page 1 kept. That holds
only while the kept order is still good, so three more page 2 rows ask for it
when it is not: "after 16 min" 16 minutes after the ranking (past
`RANKING_KEPT_MS`), "after a dismissal" from a reader who has since marked a
card of page 1 Not interested (a negative: page 1's first paper), and "after the lean moved" with
`order: 'relevance'`, as a like that moves the lean past -0.3 asks. Each changes
what `readFeedPage` ranks by or the order's age, so it ranks again. Every lane
holds the corpus described under Method: a notable lane of 2,000 rows, as an
arXiv category has with OpenAlex's and ADS's listings. cs.AI is the exception
in production: its notable lane holds only ADS's listing, about 1,000 rows, so
the 6- and 12-category scans here are about 8,000 rows above what current
listings can produce: about 3.5% to 7% of a first page's rows (8,000 of 225,631
for 12 categories with likes, of 113,300 for 6 without).

| Categories | Likes | Page | Rows read | Lane reads | Notable scan | Vectors | Keys | Works | Vectors returned | Rows written |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 31,666 | 4,800 | 16,273 | 0 | 933 | 9,660 | 0 | 0 |
| 1 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 1 | 0 | 2 after 16 min | 26,689 | 4,800 | 16,273 | 0 | 933 | 4,683 | 0 | 0 |
| 1 | 0 | 2 after a dismissal | 41,245 | 4,800 | 16,273 | 14,550 | 939 | 4,683 | 4,850 | 0 |
| 1 | 0 | 2 after the lean moved | 26,689 | 4,800 | 16,273 | 0 | 933 | 4,683 | 0 | 0 |
| 1 | 24 | 1 | 39,280 | 4,800 | 16,273 | 14,550 | 1,077 | 2,580 | 4,850 | 24 |
| 1 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 1 | 24 | 2 after 16 min | 38,549 | 4,800 | 16,273 | 14,550 | 1,077 | 1,849 | 4,850 | 0 |
| 1 | 24 | 2 after a dismissal | 38,555 | 4,800 | 16,273 | 14,550 | 1,083 | 1,849 | 4,850 | 0 |
| 1 | 24 | 2 after the lean moved | 38,549 | 4,800 | 16,273 | 14,550 | 1,077 | 1,849 | 4,850 | 0 |
| 6 | 0 | 1 | 113,300 | 4,802 | 97,638 | 0 | 1,200 | 9,660 | 0 | 0 |
| 6 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 0 | 2 after 16 min | 108,260 | 4,802 | 97,638 | 0 | 1,200 | 4,620 | 0 | 0 |
| 6 | 0 | 2 after a dismissal | 126,569 | 4,802 | 97,638 | 18,306 | 1,203 | 4,620 | 6,102 | 0 |
| 6 | 0 | 2 after the lean moved | 108,260 | 4,802 | 97,638 | 0 | 1,200 | 4,620 | 0 | 0 |
| 6 | 24 | 1 | 123,470 | 4,802 | 97,638 | 18,306 | 1,344 | 1,380 | 6,102 | 24 |
| 6 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 24 | 2 after 16 min | 123,327 | 4,802 | 97,638 | 18,306 | 1,344 | 1,237 | 6,102 | 0 |
| 6 | 24 | 2 after a dismissal | 123,333 | 4,802 | 97,638 | 18,306 | 1,350 | 1,237 | 6,102 | 0 |
| 6 | 24 | 2 after the lean moved | 123,327 | 4,802 | 97,638 | 18,306 | 1,344 | 1,237 | 6,102 | 0 |
| 12 | 0 | 1 | 210,943 | 4,808 | 195,275 | 0 | 1,200 | 9,660 | 0 | 0 |
| 12 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 0 | 2 after 16 min | 205,540 | 4,808 | 195,275 | 0 | 1,200 | 4,257 | 0 | 0 |
| 12 | 0 | 2 after a dismissal | 228,370 | 4,808 | 195,275 | 22,824 | 1,206 | 4,257 | 7,608 | 0 |
| 12 | 0 | 2 after the lean moved | 205,540 | 4,808 | 195,275 | 0 | 1,200 | 4,257 | 0 | 0 |
| 12 | 24 | 1 | 225,631 | 4,808 | 195,275 | 22,824 | 1,344 | 1,380 | 7,608 | 24 |
| 12 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 24 | 2 after 16 min | 225,521 | 4,808 | 195,275 | 22,824 | 1,344 | 1,270 | 7,608 | 0 |
| 12 | 24 | 2 after a dismissal | 225,527 | 4,808 | 195,275 | 22,824 | 1,350 | 1,270 | 7,608 | 0 |
| 12 | 24 | 2 after the lean moved | 225,521 | 4,808 | 195,275 | 22,824 | 1,344 | 1,270 | 7,608 | 0 |

The times below are from Node 24.18 on a Windows laptop, with D1 in a local
workerd process. D1 ms is the statements' own time as D1 reports it. Wall and
CPU ms are the medians of three runs. Live MB is the most heap and typed-array
memory the request still held after a garbage collection, so garbage is left
out. In use MB is the most it held with garbage. Both are counted above the
level just before the request.

| Categories | Likes | Page | Papers | D1 calls | D1 ms | Wall ms | CPU ms | Live MB | In use MB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 20 | 9 | 52 | 792 | 109 | 0.8 | 25.1 |
| 1 | 0 | 2 | 20 | 1 | 0 | 92.6 | 32 | 0.9 | 0 |
| 1 | 0 | 2 after 16 min | 20 | 6 | 35 | 546 | 109 | 3.3 | 24 |
| 1 | 0 | 2 after a dismissal | 20 | 8 | 96 | 1,394 | 672 | 23.2 | 81.9 |
| 1 | 0 | 2 after the lean moved | 20 | 6 | 29 | 519 | 141 | 3.2 | 23.5 |
| 1 | 24 | 1 | 20 | 10 | 85 | 1,578 | 578 | 22.2 | 83.7 |
| 1 | 24 | 2 | 20 | 1 | 0 | 86.7 | 0 | 0.9 | 1.5 |
| 1 | 24 | 2 after 16 min | 20 | 9 | 72 | 1,436 | 500 | 23.1 | 83.6 |
| 1 | 24 | 2 after a dismissal | 20 | 9 | 71 | 1,417 | 547 | 23.1 | 83.6 |
| 1 | 24 | 2 after the lean moved | 20 | 9 | 92 | 1,454 | 563 | 23.1 | 83.6 |
| 6 | 0 | 1 | 20 | 9 | 93 | 1,423 | 203 | 2.4 | 35.4 |
| 6 | 0 | 2 | 20 | 1 | 0 | 84.3 | 30 | 1.1 | 0 |
| 6 | 0 | 2 after 16 min | 20 | 6 | 82 | 1,152 | 250 | 5 | 34.4 |
| 6 | 0 | 2 after a dismissal | 20 | 8 | 140 | 2,182 | 626 | 29.4 | 87.1 |
| 6 | 0 | 2 after the lean moved | 20 | 6 | 71 | 1,145 | 141 | 7 | 34.2 |
| 6 | 24 | 1 | 20 | 9 | 154 | 2,391 | 656 | 28.2 | 90.7 |
| 6 | 24 | 2 | 20 | 1 | 0 | 82.9 | 31 | 1 | 1.9 |
| 6 | 24 | 2 after 16 min | 20 | 9 | 159 | 2,530 | 750 | 29.3 | 90.6 |
| 6 | 24 | 2 after a dismissal | 20 | 9 | 121 | 2,228 | 703 | 29.2 | 90.6 |
| 6 | 24 | 2 after the lean moved | 20 | 9 | 144 | 2,414 | 687 | 29.3 | 90.6 |
| 12 | 0 | 1 | 20 | 9 | 169 | 2,119 | 391 | 5.4 | 46.6 |
| 12 | 0 | 2 | 20 | 1 | 1 | 88.6 | 63 | 1.2 | 1.9 |
| 12 | 0 | 2 after 16 min | 20 | 6 | 135 | 1,851 | 78 | 8.5 | 48 |
| 12 | 0 | 2 after a dismissal | 20 | 8 | 194 | 3,036 | 672 | 36.9 | 93.1 |
| 12 | 0 | 2 after the lean moved | 20 | 6 | 150 | 1,913 | 313 | 8.5 | 46.8 |
| 12 | 24 | 1 | 20 | 9 | 243 | 3,414 | 1,094 | 35.6 | 99.2 |
| 12 | 24 | 2 | 20 | 1 | 0 | 82.9 | 78 | 1.2 | 2.1 |
| 12 | 24 | 2 after 16 min | 20 | 9 | 224 | 3,224 | 625 | 36.8 | 98.9 |
| 12 | 24 | 2 after a dismissal | 20 | 9 | 209 | 3,217 | 843 | 36.8 | 108 |
| 12 | 24 | 2 after the lean moved | 20 | 9 | 233 | 3,342 | 718 | 36.8 | 98.8 |

Every row but "after a dismissal" comes from the first full run, at `75ef9e05`.
The "after a dismissal" rows come from a second full run at `9640fe02`, which
dismisses a paper page 1 served rather than one the reader never saw: their key
and vector rows moved by at most 3, and their times and memory are that run's.
Every page returned 20 papers: its 15 and 5 notable ones. The row counts repeat
for the same seeded corpus and can move by a row when it changes (one lane of
2,000 reads 16,272 or 16,273). CPU on Windows ticks at about 15.6 ms, so the
values above are close to multiples of it and the page 2 CPU figures from a kept
order are 0 to 5 ticks, at the floor of what it resolves. CPU and wall times
vary from run to run: here the 12-category first page with likes took 1,094 ms
of CPU, and the other pages that rank with the same reader 625 to 843 ms.

## What the numbers show

- **The notable scan is most of a first page's rows from 6 categories on.** The
  local D1 counts about 8,020 rows read for the window-function statement over
  a notable lane of 1,000 papers and about 16,020 over one of 2,000, about 8 per
  row, plus 250 for the lookup in `works` of each row of the day's slice (#391),
  one row each: 16,273 for a lane of 2,000. The scan is 16,273 of 31,666 rows for
  a 1-category reader without likes, 97,638 of 113,300 for 6 categories, and
  195,275 of 225,631 for 12 categories with likes. The code comment
  (`paper-store.ts`, `NOTABLE_READ_PER_YEAR`) and the README say about 1,000 a
  lane, 2,000 with both listings. The window functions that number each year's
  rows sort them into temporary tables, and D1 counts those rows too. On one
  lane of 1,000 rows, a separate local check outside the script, made before
  #391 added the works lookup, gave 1,000 rows read for the index range alone,
  4,011 with `ROW_NUMBER`, 7,022 with `ROW_NUMBER` and `COUNT`, and 8,022 for the
  whole statement.
- **Lane reads are the shares the code gives.** A reader of 1, 6 or 12
  categories reads 4,800, 4,802 or 4,808 lane rows: `ceil(4,000 / leaves)` from
  each leaf and 800 from the area lanes. Each read stops at its limit.
- **Vectors cost three rows read each.** A reader with 24 likes gets 4,850,
  6,102 or 7,608 vectors (the likes, the candidates not liked or excluded, and
  250 notable candidates a lane). The read looks up its ids with
  `IN (SELECT value FROM json_each(?))`, and D1 counts three rows per id: the
  JSON value, the temporary index built from it and the primary-key row. The
  key lookups and the works reads use the same pattern. `findWorks` looks an id
  up under each of its keys, so the 200 excluded papers cost 6 rows for an arXiv
  id (two keys) and 3 for an OpenAlex id (one): 933 rows for the 1-category
  reader, whose newest 200 papers are 111 preprints and 89 articles, and 1,200
  for the others, whose newest 200 are all preprints. The separate local check
  gave two rows per id for a join on `json_each`.
- **A first page of the app's request reads its walk's ids from `works`.**
  With `skipsSeen`, the page is the first papers the filter does not hold. The
  works rows are 60 for the page's 20 papers, 600 for the notable check of 200
  papers, 120 for the liked papers (`keepLiked`), and the walk's paper-id reads
  over the regular ranking. The walk reads a chunk of ids whole, 3 rows a rank,
  as soon as it enters it: ranks up to 200, 400 more, 800 more and 1,600 more
  (`unseenRanks`), which is 600, 1,200, 2,400 and 4,800 rows. Without likes the
  ranking is newest first and this filter holds the newest 2,000 papers of the
  lanes, so the walk passes about 1,800 ranks and reads 3,000: 9,000 rows and 3
  more D1 calls for 1, 6 and 12 categories alike (9,660 works rows in 9 calls).
  That is 28% of the first page's rows for 1 category, 8% for 6 and 4% for 12.
  With likes the ranking is by similarity with a recency weight (the synthetic
  similarity is noise, see Limits), and this filter holds the newest papers, not
  the closest-ranked ones: the walk ended within the first 200 ranks for 6 and
  12 categories (1,380 works rows) and in the second chunk for 1 category
  (2,580 rows, 10 calls). A real filter holds the cards
  the reader was served, the closest-ranked ones, so a reader with likes can
  walk further than here; this run has no figure for it.
- **A next page reads its own papers only from a good kept order, and only while
  its walk stays within the ids already read.** The main request of a next page
  reads 60 rows from `works`, in
  one D1 call, and no lane, vector or key rows. The order page 1 kept holds the
  paper id of every rank the walk read, so page 2 reads none of them again. That
  assumes the order was ranked less than 15 minutes earlier, with the negatives
  and `order` unchanged, and that the page's walk does not enter a chunk the
  walk before it did not. A walk that crosses rank 200, 600, 1,400 or 3,000
  reads the next chunk of ids whole, 1,200, 2,400, 4,800 or 9,600 rows and one
  more D1 call, even from a good kept order, so a session pays that every time
  its walk reaches a new bound. A probe outside the script shows it:
  `measureLaneReads` for 1 category without likes, with `excluded: 10` and
  `seen: 190`, ends page 1's walk at rank 195 (1,260 works rows, 6 calls), and
  page 2, which starts there and crosses rank 200, reads 1,260 rows in 2 calls,
  not 60 in 1. The app builds `negativeIds` and `order` again on every load, so a
  Not interested dismissal, a lean that crosses -0.3 or 15 minutes since the
  ranking makes the next page rank again: the lane reads, the notable scan, the
  vectors (with likes, or with a negative, whose vector is read too) and the
  walk's id reads. It costs about a first page's rows: 26,689 to 41,245 for 1
  category, 108,260 to 126,569 for 6 and 205,540 to 228,370 for 12, and, when it
  reads vectors, a first page's time and memory. The 60-row page 2 is the
  cheapest case, not the usual one in a session longer than 15 minutes or with a
  dismissal.
- **One first page holds 22 to 36 MB with likes and at most 5.4 MB without.** A
  page that ranks again holds 23 to 37 MB with likes, 3 to 8.5 MB without and
  23 to 37 MB after a dismissal, whose vectors are read even without likes.
  Those are per-request figures for the Worker side, live after a garbage
  collection. Garbage included, it is 84 to 108 MB with likes, but V8 collects garbage
  before it fails for lack of memory. They are Node's figures; the Worker's own
  were not measured. They do not show headroom against the 128 MB of an isolate
  (see Limits).
- **CPU is far from `cpu_ms`.** A first page takes 0.6 to 1.1 s of this
  process's CPU with likes and 0.1 to 0.4 s without, against `limits.cpu_ms` of
  120,000 ms in `wrangler.toml`. That CPU includes decoding D1's answers.
- **Time here does not predict production.** D1's own statement time is at
  most 243 ms. Wall time reaches 3.4 s for 12 categories with likes. D1's
  statements and this process's CPU account for 1.4 s or less of that. The rest is spent
  waiting on the local workerd process and the proxy that carries its answers,
  about 7,600 vectors among them. Production replaces that proxy with the
  network between the Worker and D1.

## Method

- **Store.** `getPlatformProxy` from wrangler, with
  `worker/test-support/measure-lane-reads.wrangler.jsonc`, runs D1 in memory
  in a local workerd process, with remote bindings off. That is D1's local
  implementation, which reports `rows_read`, `rows_written` and `duration` in
  each answer's `meta`. The migrations are applied with wrangler's SQL
  splitter.
- **Corpus.** Each asked leaf lane holds 4,000 arXiv records
  (`FEED_CANDIDATE_LIMIT`, the most eviction keeps), 194 a day (cs.LG's
  intake, measured for ENG-127). Each area lane of their areas also holds 4,000
  OpenAlex articles. Each leaf has a notable lane of 200 articles a year for
  2016 to 2025 (`NOTABLE_PER_YEAR` for each of two listings, `NOTABLE_YEARS`),
  2,000 rows: the leaves measured are arXiv categories, which list OpenAlex's
  most-cited papers and ADS's (`ADS_NOTABLE_LEAVES`). Every leaf is given both,
  though cs.AI has only ADS's in the corpus, so its lane here is an upper bound. They go in through
  `ingestPapers`, and every work gets a pseudo-random vector in the stored form
  (`quantize`; see Limits for what that cannot show). No paper is in two lanes.
- **Readers.**
  - 1 category: cs.LG.
  - 6 categories: cs.AI, cs.LG, cs.CV, cs.CL, cs.RO and cs.NE, the reader of
    the 2026-10-25 access audit.
  - 12 categories: those 6 plus cs.CR, cs.SE, cs.DS, cs.DC, cs.IR and cs.HC.

  Their lanes add area:ai and area:cs. The app asks for at most 10 categories
  (`MAIN_CATEGORIES`), so the 12-category rows are the Worker's upper bound
  (`FEED_MAX_CATEGORIES`), not a request the app sends. Likewise 5 notable papers
  is the most a request can ask for (`FEED_MAX_NOTABLE`); the app asks for 3 on a first page and 4 or 5 on later
  pages (`notableRequest`: the places of the largest page the load can show,
  31 cards on a later page, plus `NOTABLE_SPARE`), so 5 is within what it sends.
- **Request.** The app's main page request (`fetchCorpusPage`), not the whole
  load, has the categories as one group and no follows, and asks with `skipsSeen`. It excludes 200 papers and
  its seen filter holds 2,000: the newest papers of every lane it asks for, leaf
  and area, in date order (`shownBy`). The area articles are dated by day, so
  each night's leaf papers come before that night's articles, which is how the
  ranking orders them. It asks for 5 notable papers and
  pages of 15. It has either no likes or 24 likes, taken from the papers after
  the excluded ones. Each first page
  starts from an empty ranking cache that keeps the order as JSON and writes it
  again on `update`, as the Worker's does. Page 2 adds page 1's papers to the
  filter, as the app does. The three later page 2 rows start from a copy of the
  order page 1 kept: one asks with `now` 16 minutes later, one adds a paper to
  `negativeIds`, one asks with `order: 'relevance'`.
- **Memory.** V8's heap plus external memory, which holds the typed arrays
  (`process.memoryUsage`, `v8.GCProfiler`), above the level after a full
  collection just before the request. In use is the most held before any
  collection or at the end. Live comes from a fourth, untimed run, in which
  every collection is a full one (`--gc-global`) and one also follows each D1
  answer. It is the most still held after a collection.

## Limits

- The corpus is an upper bound for lane reads, not strictly for the notable
  scan. Every asked leaf has 4,000 papers and a notable lane of two listings.
  Production has notable lanes only for the leaves its listings cover
  ([worker/README.md](README.md#paper-store), step 3), and quieter leaves hold
  fewer papers. A leaf with one listing holds about 1,000 rows and costs about
  8,270 scan rows a lane (8,020 for the window functions and 250 for the works
  lookups of its slice), about half of the figures here. A leaf with two (the
  arXiv categories, and the medicine and biology leaves Europe PMC lists) can
  hold 2,000. A production lane also keeps rows that left the listings for 14
  days, so it can exceed 2,000, and the scan grows about 8 rows per row. The
  run's seen filter holds no notable ids, so the notable check always stops
  after one chunk of 200 papers (600 rows). A real filter carries the account's
  last 1,200 notable cards, the closest-ranked ones, so a regular reader can need
  further chunks of 400 and 800 papers (1,200 and 2,400 rows) on a page that
  reaches them. A cross-listed paper reads as a row in each of its lanes but
  is one candidate and one vector.
- The seen filter holds the newest 2,000 papers of the asked lanes, which is
  what a reader served newest-first pages holds. A reader with likes is served
  the closest-ranked papers, and a reader who follows entities or changes
  categories holds others: no other filter was run, so the walk lengths here are
  not general. The 9,000 rows of ids a first page without likes reads follow from
  a filter that holds the head of the ranking, and the 1,380 and 2,580 works
  rows of a reader with likes from a filter that does not. A reader who has seen
  fewer papers walks fewer chunks, which cost 600, 1,200, 2,400, 4,800 and 9,600
  rows. Any page whose walk reaches a new bound (rank 200, 600, 1,400, 3,000 or
  6,200) reads the next chunk of ids, even from a good kept order.
- The vectors are pseudo-random (`vectorOf`, 256 dimensions), so any two are
  nearly orthogonal and the corpus has no topics: their cosines have a mean of 0
  and a standard deviation of 1/sqrt(256) = 0.0625. A separate check outside the
  script on 400 of them gave 0.0624, a largest cosine of 0.264 and none above
  0.4. In `rankBySimilarity` the semantic score (zero below a cosine of 0.4),
  the penalty for a rejected paper and the MMR penalty (both from 0.75) are
  therefore always zero, and with likes the order is the largest cosine to a
  like (about 0.12 on average, noise) plus the recency term, not topical fit.
  The vectors read, CPU and memory do not depend on these values. The walk's
  works rows do when the reader has likes (1,380 and 2,580 for a first page),
  and so do the papers served with likes: real vectors cluster, and a reader's
  likes would rank their topic first.
- These rows are the main page's request only, not the cost of a For You
  load. Each load also sends other `/store/papers` requests, none of them
  measured here:
  - An exploration request on every load (`explore`, feed-context.tsx), or two
    when the reader is bored: `fetchCorpusPage` with 3 nearby leaves picked by
    Thompson sampling (`pickExplorationCategories`), a random page, a page size
    of 2 on a reset and 5 to 8 after, the same 200 excluded ids and the
    reader's `negativeIds`. It sends no `seen`, so it has no notable scan and
    no walk. Its ranking cache key holds the sorted lanes and the page size,
    so new random leaves give a new key on most loads and it ranks. Traced
    from the code, not run: for a 6-category cs reader it reads
    `ceil(4,000 / 3) * 3 + 800` = 4,802 lane rows and about 1,200 key rows for
    the excluded ids, about 6,000 rows, and, when the reader has any Not
    interested paper in its profile, about 13,800 vector rows more (3 per id
    for about 4,600 candidates). Likes are not sent.
  - The follows' page when the reader follows someone, which reads the
    follows' own lanes.
  - The related-papers request after a like, save or open (`waitForLikes`,
    feed-context.tsx): one positive, up to 10 categories, 15 papers and the
    reader's negatives, so it reads vectors as a reader with likes does.
  Cloudflare's D1 analytics for `/store/papers` (see Decisions) therefore
  average over all of these requests per route, and are not comparable with the
  tables here without separating them. Concurrent requests of one load share an
  isolate, so the memory limit bullet below counts them too.
- The request has no follows or extra interest groups, and no negatives except
  the one the "after a dismissal" rows send. It leaves out the route's sign-in
  and quota checks. It has no `waitForLikes`
  lookups. The route's first page with likes and no follows also checks the
  likes' vectors (`addMissingPositives`), about 200 more rows by the same
  3-per-id pattern, which the run leaves out. Page 2 serves from the kept order
  only once that follow-up work has finished, and only while the order is under
  15 minutes old with unchanged negatives and `order`; the run stores the whole
  order at once, so a page 2 that arrives earlier ranks again, as the rows
  "after 16 min", "after a dismissal" and "after the lean moved" show.
- An isolate shares its 128 MB across the concurrent requests it serves and its
  own bundle baseline. Three or four concurrent requests of 12 categories with
  likes, first pages or pages that rank again (36 to 37 MB live, 99 to 108 MB
  with garbage), could reach that limit.
- D1-side memory was not measured or reproduced. The production
  `SQLITE_NOMEM` case happens in D1's SQLite, where the notable statement's
  window-function sorts and the `json_each` temporary indexes allocate; this
  measurement cannot see that memory, and the cause of `SQLITE_NOMEM` remains
  unproven.
- The stored papers carry no enrichment, so their JSON is smaller than that of
  production rows. That affects only the 20 papers a page reads and the 200
  that the notable check reads.
- The row counts were not compared with production D1's `meta.rows_read`. No
  production request was made.

## Decisions

Pablo, 2026-10-25. No change to the feed in this phase.

- The notable lane's read cost and the `json_each` JOIN go to ENG-150, before
  ENG-128 phases 2 and 3.
- Production is checked with Cloudflare D1 analytics for `/store/papers`
  (read-only), not with a production statement.
- A Worker-side memory measurement comes before any phase that reads more.
- The workerd measurement test stays in `npm test`.
- Workers observability times `/store/papers` in production before phase 2.

## Reproduce

```bash
node worker/test-support/measure-lane-reads.ts
```

It prints the two tables, without thousands separators, with an Other column
for rows read by any statement of no kind above (none here) and the papers each
page returned. The run takes several minutes. It stops with an error when a page
serves no paper beyond the seen filter, or when a reader's lanes hold fewer
papers than the plan's seen filter, excluded papers and likes need. The row
counts repeat for the same seeded corpus; times and memory vary.
`worker/test-support/measure-lane-reads.test.ts` runs the same script on a small
corpus. The probe under "What the numbers show" is
`measureLaneReads(undefined, { readers: [['cs.LG']], likes: 0, excluded: 10, seen: 190, repetitions: 1 })`,
which seeds the same production-sized corpus.
