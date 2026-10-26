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
- works are every statement that reads `works`: `readWorks`, the walk's paper-id
  reads over the regular ranking and the notable order (`unseenRanks`, with
  `walkPastDropped`) and `keepLiked`.

Page 2 is the next page of the same request: the app's, with page 1's papers
added to the seen filter, served from the order that page 1 kept. That holds
only while the kept order is still good, so three more page 2 rows ask for it
when it is not: "after 16 min" 16 minutes after the ranking (past
`RANKING_KEPT_MS`), "after a dismissal" from a reader who has since marked a
card Not interested (a negative), and "after the lean moved" with
`order: 'relevance'`, as a like that moves the lean past -0.3 asks. Each changes
what `readFeedPage` ranks by or the order's age, so it ranks again. Every lane
holds the corpus described under Method: a notable lane of 2,000 rows, as an
arXiv category has with OpenAlex's and ADS's listings. cs.AI is the exception
in production: its notable lane holds only ADS's listing, about 1,000 rows, so
the 6- and 12-category scans here are about 8,000 rows (4% to 8%) above what
current listings can produce.

| Categories | Likes | Page | Rows read | Lane reads | Notable scan | Vectors | Keys | Works | Vectors returned | Rows written |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 23,283 | 4,800 | 16,023 | 0 | 1,200 | 1,260 | 0 | 0 |
| 1 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 1 | 0 | 2 after 16 min | 23,238 | 4,800 | 16,023 | 0 | 1,200 | 1,215 | 0 | 0 |
| 1 | 0 | 2 after a dismissal | 37,794 | 4,800 | 16,023 | 14,550 | 1,206 | 1,215 | 4,850 | 0 |
| 1 | 0 | 2 after the lean moved | 23,238 | 4,800 | 16,023 | 0 | 1,200 | 1,215 | 0 | 0 |
| 1 | 24 | 1 | 38,097 | 4,800 | 16,023 | 14,550 | 1,344 | 1,380 | 4,850 | 24 |
| 1 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 1 | 24 | 2 after 16 min | 38,005 | 4,800 | 16,023 | 14,550 | 1,344 | 1,288 | 4,850 | 0 |
| 1 | 24 | 2 after a dismissal | 38,011 | 4,800 | 16,023 | 14,550 | 1,350 | 1,288 | 4,850 | 0 |
| 1 | 24 | 2 after the lean moved | 38,005 | 4,800 | 16,023 | 14,550 | 1,344 | 1,288 | 4,850 | 0 |
| 6 | 0 | 1 | 104,600 | 4,802 | 96,138 | 0 | 1,200 | 2,460 | 0 | 0 |
| 6 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 0 | 2 after 16 min | 103,598 | 4,802 | 96,138 | 0 | 1,200 | 1,458 | 0 | 0 |
| 6 | 0 | 2 after a dismissal | 121,910 | 4,802 | 96,138 | 18,306 | 1,206 | 1,458 | 6,102 | 0 |
| 6 | 0 | 2 after the lean moved | 103,598 | 4,802 | 96,138 | 0 | 1,200 | 1,458 | 0 | 0 |
| 6 | 24 | 1 | 121,970 | 4,802 | 96,138 | 18,306 | 1,344 | 1,380 | 6,102 | 24 |
| 6 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 6 | 24 | 2 after 16 min | 121,827 | 4,802 | 96,138 | 18,306 | 1,344 | 1,237 | 6,102 | 0 |
| 6 | 24 | 2 after a dismissal | 121,833 | 4,802 | 96,138 | 18,306 | 1,350 | 1,237 | 6,102 | 0 |
| 6 | 24 | 2 after the lean moved | 121,827 | 4,802 | 96,138 | 18,306 | 1,344 | 1,237 | 6,102 | 0 |
| 12 | 0 | 1 | 203,143 | 4,808 | 192,275 | 0 | 1,200 | 4,860 | 0 | 0 |
| 12 | 0 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 0 | 2 after 16 min | 200,539 | 4,808 | 192,275 | 0 | 1,200 | 2,256 | 0 | 0 |
| 12 | 0 | 2 after a dismissal | 223,369 | 4,808 | 192,275 | 22,824 | 1,206 | 2,256 | 7,608 | 0 |
| 12 | 0 | 2 after the lean moved | 200,539 | 4,808 | 192,275 | 0 | 1,200 | 2,256 | 0 | 0 |
| 12 | 24 | 1 | 222,631 | 4,808 | 192,275 | 22,824 | 1,344 | 1,380 | 7,608 | 24 |
| 12 | 24 | 2 | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 |
| 12 | 24 | 2 after 16 min | 222,524 | 4,808 | 192,275 | 22,824 | 1,344 | 1,273 | 7,608 | 0 |
| 12 | 24 | 2 after a dismissal | 222,530 | 4,808 | 192,275 | 22,824 | 1,350 | 1,273 | 7,608 | 0 |
| 12 | 24 | 2 after the lean moved | 222,524 | 4,808 | 192,275 | 22,824 | 1,344 | 1,273 | 7,608 | 0 |

The times below are from Node 24.18 on a Windows laptop, with D1 in a local
workerd process. D1 ms is the statements' own time as D1 reports it. Wall and
CPU ms are the medians of three runs. Live MB is the most heap and typed-array
memory the request still held after a garbage collection, so garbage is left
out. In use MB is the most it held with garbage. Both are counted above the
level just before the request.

| Categories | Likes | Page | Papers | D1 calls | D1 ms | Wall ms | CPU ms | Live MB | In use MB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 20 | 6 | 25 | 576 | 79 | 0.1 | 21.9 |
| 1 | 0 | 2 | 20 | 1 | 1 | 86.7 | 47 | 0.8 | 0 |
| 1 | 0 | 2 after 16 min | 20 | 6 | 21 | 534 | 125 | 3.2 | 22.9 |
| 1 | 0 | 2 after a dismissal | 20 | 8 | 107 | 1,595 | 532 | 23.1 | 82.1 |
| 1 | 0 | 2 after the lean moved | 20 | 6 | 20 | 545 | 156 | 3.1 | 22.8 |
| 1 | 24 | 1 | 20 | 9 | 75 | 1,465 | 625 | 22.2 | 83.8 |
| 1 | 24 | 2 | 20 | 1 | 0 | 79.2 | 16 | 0.9 | 1.5 |
| 1 | 24 | 2 after 16 min | 20 | 9 | 79 | 1,521 | 562 | 23 | 83.7 |
| 1 | 24 | 2 after a dismissal | 20 | 9 | 71 | 1,470 | 656 | 23.1 | 83.6 |
| 1 | 24 | 2 after the lean moved | 20 | 9 | 76 | 1,436 | 609 | 23 | 83.6 |
| 6 | 0 | 1 | 20 | 7 | 55 | 1,217 | 297 | 2.6 | 33.4 |
| 6 | 0 | 2 | 20 | 1 | 1 | 90 | 31 | 1 | 0 |
| 6 | 0 | 2 after 16 min | 20 | 6 | 34 | 1,083 | 109 | 7 | 33.7 |
| 6 | 0 | 2 after a dismissal | 20 | 8 | 146 | 2,189 | 656 | 29.3 | 87.2 |
| 6 | 0 | 2 after the lean moved | 20 | 6 | 37 | 1,082 | 93 | 7 | 33.2 |
| 6 | 24 | 1 | 20 | 9 | 121 | 2,266 | 625 | 28.2 | 90.7 |
| 6 | 24 | 2 | 20 | 1 | 0 | 80.5 | 15 | 0.8 | 1.9 |
| 6 | 24 | 2 after 16 min | 20 | 9 | 113 | 2,343 | 609 | 29.3 | 90.6 |
| 6 | 24 | 2 after a dismissal | 20 | 9 | 119 | 2,343 | 704 | 29.2 | 90.6 |
| 6 | 24 | 2 after the lean moved | 20 | 9 | 121 | 2,342 | 704 | 29.2 | 90.6 |
| 12 | 0 | 1 | 20 | 8 | 94 | 1,955 | 109 | 5.5 | 46.5 |
| 12 | 0 | 2 | 20 | 1 | 0 | 87.1 | 15 | 1.2 | 2 |
| 12 | 0 | 2 after 16 min | 20 | 6 | 92 | 1,772 | 156 | 12.5 | 47.1 |
| 12 | 0 | 2 after a dismissal | 20 | 8 | 180 | 3,186 | 719 | 36.9 | 93.2 |
| 12 | 0 | 2 after the lean moved | 20 | 6 | 80 | 1,752 | 125 | 12.5 | 47 |
| 12 | 24 | 1 | 20 | 9 | 185 | 3,173 | 969 | 35.7 | 99.1 |
| 12 | 24 | 2 | 20 | 1 | 0 | 80.4 | 16 | 1.2 | 2 |
| 12 | 24 | 2 after 16 min | 20 | 9 | 161 | 3,251 | 766 | 36.9 | 98.9 |
| 12 | 24 | 2 after a dismissal | 20 | 9 | 172 | 3,141 | 719 | 36.8 | 98.9 |
| 12 | 24 | 2 after the lean moved | 20 | 9 | 188 | 3,420 | 1,265 | 36.9 | 98.9 |

Every page returned 20 papers: its 15 and 5 notable ones. The row counts repeat
for the same seeded corpus and can move by a row when it changes (one lane of
2,000 reads 16,022 or 16,023). CPU on Windows ticks at about 15.6 ms, so the
values above are close to multiples of it and the page 2 CPU figures are 0 to 3
ticks, at the floor of what it resolves. One run of 12 categories with likes
measured 1,265 ms of CPU against 719 to 969 ms for the others; CPU and wall
times vary from run to run.

## What the numbers show

- **The notable scan is most of a first page's rows.** The local D1 counts
  about 8,020 rows read for a notable lane of 1,000 papers and about 16,020 for
  one of 2,000, about 8 per row. The scan is 16,023 of 23,283 rows for a 1-category
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
- **A next page reads its own papers only from a good kept order.** It reads 60
  rows from `works`, in one D1 call, and no lane, vector or key rows. The order
  page 1 kept holds the paper id of every rank the walk read, so page 2 reads
  none of them again. That assumes the order was ranked less than 15 minutes
  earlier, with the negatives and `order` unchanged. The app builds `negativeIds`
  and `order` again on every load, so a Not interested dismissal, a lean that
  crosses -0.3 or 15 minutes since the ranking makes the next page rank again:
  the lane reads, the notable scan, the vectors (with likes, or with a negative,
  whose vector is read too) and the walk's id reads. It costs about a first
  page's rows: 23,238 to 37,794 for 1 category, 103,598 to 121,910 for 6 and
  200,539 to 223,369 for 12, and the same time and memory as a first page. The
  60-row page 2 is the cheapest case, not the usual one in a session longer than
  15 minutes or with a dismissal.
- **One first page holds 22 to 36 MB with likes and at most 5.5 MB without.** A
  page that ranks again holds 23 to 37 MB with likes, 3 to 12.5 MB without and
  23 to 37 MB after a dismissal, whose vectors are read even without likes.
  Those are per-request figures for the Worker side, live after a garbage
  collection. Garbage included, it is 84 to 99 MB with likes, but V8 collects garbage
  before it fails for lack of memory. They are Node's figures; the Worker's own
  were not measured. They do not show headroom against the 128 MB of an isolate
  (see Limits).
- **CPU is far from `cpu_ms`.** A first page takes 0.6 to 1.0 s of this
  process's CPU with likes and 0.1 to 0.3 s without, against `limits.cpu_ms` of
  120,000 ms in `wrangler.toml`. That CPU includes decoding D1's answers.
- **Time here does not predict production.** D1's own statement time is at
  most 188 ms. Wall time reaches 3.4 s for 12 categories with likes. D1's
  statements and this process's CPU account for 1.5 s or less of that. The rest is spent
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
  8,020 scan rows a lane, half of the figures here. A leaf with two (the arXiv
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
  only once that follow-up work has finished, and only while the order is under
  15 minutes old with unchanged negatives and `order`; the run stores the whole
  order at once, so a page 2 that arrives earlier ranks again, as the rows
  "after 16 min", "after a dismissal" and "after the lean moved" show.
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
page returned. The run takes several minutes. The row counts repeat for the same
seeded corpus; times and memory vary. `worker/test-support/measure-lane-reads.test.ts`
runs the same script on a small corpus.
