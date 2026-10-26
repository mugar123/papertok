# Lane reads measurement

Status: measured on 2026-10-26 (ENG-128, phase 0). The feed is unchanged.

## Context

ENG-128 asks for a decision, based on measurements, on whether a request should
read more of each lane or choose its candidates by fit. The measurements it asks
for are the rows read, vectors read, memory and D1 time per request for readers
of 1, 6 and 12 categories, with and without likes. This record is that
baseline. It covers the store at `1deab473` (main at `00119d13` merged: the
walk of PAP-103, the paper ids kept on the order, and ADS's notable listings),
measured with `worker/test-support/measure-lane-reads.ts` on a local D1 that
holds a synthetic corpus at the sizes the code keeps. No production data was
read.

## Results

Rows read are the local D1's own count (`meta.rows_read`), split by statement:

- lane reads are `readCandidates`;
- the notable scan is `readNotableCandidates`;
- vectors are `readVectors`;
- keys are `findWorks`;
- works are `readWorks`, `unseenNotable` and `keepLiked`.

Page 2 is the next page of the same request: the app's, with page 1's papers
added to the seen filter, served from the order that page 1 kept. Every lane
holds the corpus described under Method: a notable lane of 2,000 rows, as an
arXiv category has with OpenAlex's and ADS's listings.

| Categories | Likes | Page | Rows read | Lane reads | Notable scan | Vectors | Keys | Works | Vectors returned | Rows written |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 23,283 | 4,800 | 16,023 | 0 | 1,200 | 1,260 | 0 | 0 |
| 1 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 1 | 24 | 1 | 38,097 | 4,800 | 16,023 | 14,550 | 1,344 | 1,380 | 4,850 | 24 |
| 1 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 0 | 1 | 104,600 | 4,802 | 96,138 | 0 | 1,200 | 2,460 | 0 | 0 |
| 6 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 24 | 1 | 121,970 | 4,802 | 96,138 | 18,306 | 1,344 | 1,380 | 6,102 | 24 |
| 6 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 0 | 1 | 203,143 | 4,808 | 192,275 | 0 | 1,200 | 4,860 | 0 | 0 |
| 12 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 24 | 1 | 222,631 | 4,808 | 192,275 | 22,824 | 1,344 | 1,380 | 7,608 | 24 |
| 12 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |

The times below are from Node 24.18 on a Windows laptop, with D1 in a local
workerd process. D1 ms is the statements' own time as D1 reports it. Wall and
CPU ms are the medians of three runs. Live MB is the most heap and typed-array
memory the request still held after a garbage collection, so garbage is left
out. In use MB is the most it held with garbage. Both are counted above the
level just before the request.

| Categories | Likes | Page | D1 calls | D1 ms | Wall ms | CPU ms | Live MB | In use MB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 6 | 19 | 511 | 219 | 1.8 | 22.9 |
| 1 | 0 | 2 | 1 | 0 | 89 | 78 | 0.8 | 0 |
| 1 | 24 | 1 | 9 | 73 | 1,564 | 484 | 22.3 | 83.8 |
| 1 | 24 | 2 | 1 | 0 | 83 | 15 | 0.9 | 1.6 |
| 6 | 0 | 1 | 7 | 51 | 1,234 | 93 | 6.1 | 33.7 |
| 6 | 0 | 2 | 1 | 1 | 89 | 15 | 1 | 0 |
| 6 | 24 | 1 | 9 | 105 | 2,420 | 687 | 28.3 | 90.8 |
| 6 | 24 | 2 | 1 | 1 | 84 | 32 | 1.1 | 1.8 |
| 12 | 0 | 1 | 8 | 100 | 1,975 | 156 | 7.3 | 47.6 |
| 12 | 0 | 2 | 1 | 1 | 85 | 0 | 1.2 | 2 |
| 12 | 24 | 1 | 9 | 159 | 3,338 | 766 | 35.6 | 99.1 |
| 12 | 24 | 2 | 1 | 0 | 84 | 0 | 1.2 | 2.1 |

Every page returned 20 papers: its 15 and 5 notable ones. The row counts do not
change between runs. CPU on Windows ticks at about 15.6 ms (every value above
is a multiple of it), so the page 2 CPU figures are 0 to 5 ticks, at the floor
of what it resolves.

## What the numbers show

- **The notable scan is most of a first page's rows.** The local D1 counts
  8,023 rows read for a notable lane of 1,000 papers and 16,023 for one of
  2,000, about 8 per row. The scan is 16,023 of 23,283 rows for a 1-category
  reader without likes, 96,138 of 104,600 for 6 categories, and 192,275 of
  222,631 for 12 categories with likes. The code comment (`paper-store.ts`,
  `NOTABLE_READ_PER_YEAR`) and the README say about 1,000 a lane, 2,000 with
  both listings. The window functions that number each year's rows sort them
  into temporary tables, and D1 counts those rows too. On one lane of 1,000
  rows, a separate local check outside the script gave 1,000 rows read for the
  index range alone, 4,011 with `ROW_NUMBER`, 7,022 with `ROW_NUMBER` and
  `COUNT`, and 8,022 for the whole statement.
- **Lane reads are the shares the code gives.** A reader of 1, 6 or 12
  categories reads 4,800, 4,802 or 4,808 lane rows: `ceil(4,000 / leaves)` from
  each leaf and 800 from the area lanes. Each read stops at its limit.
- **Vectors cost three rows read each.** A reader with 24 likes gets 4,850,
  6,102 or 7,608 vectors (the likes, the candidates not liked or excluded, and
  250 notable candidates a lane). The read looks up its ids with
  `IN (SELECT value FROM json_each(?))`, and D1 counts three rows per id: the
  JSON value, the temporary index built from it and the primary-key row. The
  key lookups and the works reads use the same pattern. The keys of the 200
  excluded papers cost 1,200 rows. The separate local check gave two rows per
  id for a join on `json_each`.
- **A first page of the app's request reads its walk's ids from `works`.**
  With `skipsSeen`, the page is the first papers the filter does not hold. The
  works rows are 60 for the page's 20 papers, 600 for the notable check of 200
  papers, 120 for the liked papers (`keepLiked`), and the walk's paper-id reads
  over the regular ranking, in chunks of 200, 400, 800 ranks and so on. A reader
  with likes finds its unseen papers in the first 200 ranks, because the ranking
  is by similarity. Without likes the ranking starts with the newest papers,
  which the seen filter holds, so the walk passes 200, 600 and 1,400 ranks for
  1, 6 and 12 categories: 600, 1,800 and 4,200 rows.
- **A next page reads its own papers.** It reads 60 rows from `works`, in one D1
  call, and no lane, vector or key rows. The order page 1 kept holds the paper
  id of every rank the walk read, so page 2 reads none of them again.
- **One first page holds 22 to 36 MB with likes and at most 7.3 MB without.**
  Those are per-request figures for the Worker side, live after a garbage
  collection. Garbage included, it is 84 to 99 MB with likes, but V8 collects garbage
  before it fails for lack of memory. They are Node's figures; the Worker's own
  were not measured. They do not show headroom against the 128 MB of an isolate
  (see Limits).
- **CPU is far from `cpu_ms`.** A first page takes 0.5 to 0.8 s of this
  process's CPU with likes and 0.1 to 0.2 s without, against `limits.cpu_ms` of
  120,000 ms in `wrangler.toml`. That CPU includes decoding D1's answers.
- **Time here does not predict production.** D1's own statement time is under
  100 ms. Wall time reaches 3.3 s for 12 categories with likes. D1's statements
  and this process's CPU account for under 1 s of that. The rest is spent
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
  2,000 rows: every leaf measured is an arXiv category, which lists OpenAlex's
  most-cited papers and ADS's (`ADS_NOTABLE_LEAVES`). They go in through
  `ingestPapers`, and every work gets a pseudo-random vector in the stored form
  (`quantize`). No paper is in two lanes.
- **Readers.**
  - 1 category: cs.LG.
  - 6 categories: cs.AI, cs.LG, cs.CV, cs.CL, cs.RO and cs.NE, the reader of
    the 2026-10-25 access audit.
  - 12 categories: those 6 plus cs.CR, cs.SE, cs.DS, cs.DC, cs.IR and cs.HC.

  Their lanes add area:ai and area:cs.
- **Request.** The app's main page (`fetchCorpusPage`) has the categories as one
  group and no follows, and asks with `skipsSeen`. It excludes 200 papers (the
  reader's newest, as if shown), and the seen filter holds the reader's newest
  2,000. It asks for 5 notable papers and pages of 15. It has either no likes or
  24 likes, taken from the papers after the excluded ones. Each first page
  starts from an empty ranking cache that keeps the order as JSON and writes it
  again on `update`, as the Worker's does. Page 2 adds page 1's papers to the
  filter, as the app does.
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
  8,023 scan rows a lane, half of the figures here. A leaf with two (the arXiv
  categories, and the medicine and biology leaves Europe PMC lists) can hold
  2,000. A production lane also keeps rows that left the listings for 14 days,
  so it can exceed 2,000, and the scan grows about 8 rows per row. The run's
  seen filter holds no notable ids, so the notable check always stops after one
  chunk of 200 papers (600 rows). A real filter carries the account's last
  1,200 notable cards, the closest-ranked ones, so a regular reader can need
  further chunks of 400 and 800 papers (1,200 and 2,400 rows) on a page that
  reaches them. A cross-listed paper reads as a row in each of its lanes but
  is one candidate and one vector.
- The seen filter holds the reader's newest 2,000 papers, so a reader without
  likes walks 200, 600 or 1,400 ranks. A reader whose filter holds papers
  anywhere else in the ranking, or none of the newest, walks differently: no
  other filter was run.
- The request has no follows, negatives or extra interest groups, and it
  leaves out the route's sign-in and quota checks. It has no `waitForLikes`
  lookups. The route's first page with likes and no follows also checks the
  likes' vectors (`addMissingPositives`), about 200 more rows by the same
  3-per-id pattern, which the run leaves out. Page 2 serves from the kept order
  only once that follow-up work has finished; the run stores the whole order
  at once, so a page 2 that arrives earlier ranks again.
- An isolate shares its 128 MB across the concurrent requests it serves and its
  own bundle baseline. Three or four concurrent first pages of 12 categories
  with likes (36 MB live, 99 MB with garbage) could reach that limit.
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
page returned. The run takes several minutes. The row counts do not change
between runs; times and memory do. `worker/test-support/measure-lane-reads.test.ts`
runs the same script on a small corpus.
