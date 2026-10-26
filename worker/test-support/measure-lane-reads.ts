// What one For You request reads from D1 and costs the Worker, for readers of
// 1, 6 and 12 categories with and without likes: ENG-128's measurement before
// any change to how lanes are read. Node only, and nothing leaves the machine:
// the store is wrangler's local D1, in memory in workerd, which reports the rows
// each statement read and wrote as D1 does, seeded with synthetic papers at the
// sizes the code keeps. The results and how to read them:
// worker/lane-reads-measurement.md.
//
//   node worker/test-support/measure-lane-reads.ts
//
// The corpus. Each asked leaf lane holds FEED_CANDIDATE_LIMIT papers, the most
// eviction keeps, PAPERS_PER_DAY apart; each area lane of their areas as many;
// each leaf's notable lane NOTABLE_PER_YEAR papers of each of the NOTABLE_YEARS
// years. No paper is in two lanes, so every lane row is a distinct candidate:
// the most a request of that size reads. Papers go in through `ingestPapers`,
// the store's own writer, and each gets a vector in the stored form
// (`quantize`), pseudo-random from its work id.
//
// The request is the app's main page (`fetchCorpusPage`): the categories as one
// group, no follows, `excluded` papers (the reader's newest, as if shown), the
// same papers as the seen filter, NOTABLE_ASKED notable papers, pages of
// PAGE_SIZE, and no likes or `likes` of the papers after the excluded ones. A
// first page is ranked with an empty ranking cache, and the second is read from
// the order it kept.
//
// Reported per request: D1 calls (a batch is one); rows read, as D1 counts them,
// by kind of statement; rows written; the rows the lane and vector reads
// returned; D1's own duration over its statements; wall and CPU time in this
// process (the median of `repetitions` runs); and memory (`request`) from one
// more, untimed run. Times and memory are Node's on this machine, without the
// network between a Worker and D1.
import type { GCProfilerResult } from 'node:v8';
import type { FeedRequestBody, KeptRanking, RankingCache } from '../paper-store.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { getPlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

import { getAllLeafCategories } from '../../src/data/category-taxonomy.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from '../../src/utils/feed-interactions.ts';
import { mapOpenAlexWork } from '../../src/utils/open-alex-work.ts';
import { feedSeenFilter } from '../../src/utils/seen-paper-filter.ts';
import { NOTABLE_PER_YEAR, arxivRecordPaper } from '../paper-sources.ts';
import {
  AREA_LANE_AREAS, FEED_CANDIDATE_LIMIT, NOTABLE_LANE_PREFIX, NOTABLE_YEARS, STORED_DIMENSIONS,
  areaLane, daysFromNow, ingestPapers, parseFeedRequest, quantize, readFeedPage,
} from '../paper-store.ts';

interface Corpus { leafRows: number; areaRows: number; notablePerYear: number }
interface Plan { readers: string[][]; likes: number; excluded: number; repetitions: number }

const SIX = ['cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'cs.RO', 'cs.NE'];
const PRODUCTION: Corpus = { leafRows: FEED_CANDIDATE_LIMIT, areaRows: FEED_CANDIDATE_LIMIT, notablePerYear: NOTABLE_PER_YEAR };
// The six are the 2026-10-25 access audit's reader (ENG-128). The app asks for
// at most 10 categories (MAIN_CATEGORIES); 12 is the most the Worker reads. A
// request carries at most 24 likes and 200 excluded papers (fetchCorpusPage).
const PLAN: Plan = {
  readers: [['cs.LG'], SIX, [...SIX, 'cs.CR', 'cs.SE', 'cs.DS', 'cs.DC', 'cs.IR', 'cs.HC']],
  likes: SEMANTIC_PROFILE_POSITIVE_CAP,
  excluded: 200,
  repetitions: 3,
};
const NOW = Date.parse('2026-10-25T12:00:00Z');
// cs.LG's papers a day, measured for ENG-127 on 2026-10-24.
const PAPERS_PER_DAY = 194;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 15;
// The most notable papers the Worker adds to a page (FEED_MAX_NOTABLE).
const NOTABLE_ASKED = 5;
const WRITE_CHUNK = 1_000;

const LEAF_AREA = new Map(getAllLeafCategories().map(leaf => [leaf.id, leaf.area]));
const AUTHORS = ['Ana Pérez', 'Li Wei', 'Sam Okafor', 'Mira Shah', 'Jon Berg', 'Eva Novak'];
// About 1,000 characters, an arXiv abstract's usual length.
const WORDS = 'we study how sparse attention models learn representations from noisy data and show that the method improves accuracy on standard benchmarks while reducing the cost of training'.split(' ');
const ABSTRACT = Array.from({ length: 160 }, (_, index) => WORDS[index % WORDS.length]).join(' ');
const INVERTED_ABSTRACT: Record<string, number[]> = {};
ABSTRACT.split(' ').forEach((word, position) => (INVERTED_ABSTRACT[word] ??= []).push(position));

const recent = (index: number, now: number) => new Date(now - 3_600_000 - (index * DAY_MS) / PAPERS_PER_DAY).toISOString();

const preprint = (leaf: string, number: number, published: string) => arxivRecordPaper({
  arxivId: `2610.${String(number).padStart(5, '0')}`,
  title: `Synthetic preprint ${number} of ${leaf} for measuring lane reads`,
  abstract: ABSTRACT,
  authors: AUTHORS,
  categories: [leaf],
  doi: null,
  journalRef: null,
  comments: null,
  published,
  updated: published,
});

function article(number: number, date: string) {
  const paper = mapOpenAlexWork({
    id: `https://openalex.org/W${4_400_000_000 + number}`,
    doi: `https://doi.org/10.5555/lane-reads.${number}`,
    title: `Synthetic journal article ${number} for measuring lane reads`,
    type: 'article',
    publication_date: date,
    publication_year: Number(date.slice(0, 4)),
    cited_by_count: 100 + (number % 900),
    authorships: AUTHORS.map(display_name => ({ author: { display_name } })),
    abstract_inverted_index: INVERTED_ABSTRACT,
    primary_location: { is_oa: true, landing_page_url: `https://doi.org/10.5555/lane-reads.${number}`, source: { id: 'https://openalex.org/S1', display_name: 'A core journal', type: 'journal' } },
    open_access: { is_oa: true, oa_status: 'gold', oa_url: null },
  });
  if (!paper) throw new Error(`OpenAlex work ${number} did not map to a paper`);
  return paper;
}

// A deterministic value in [-0.5, 0.5) for each work and dimension.
const noise = (value: number) => {
  const scaled = Math.sin(value) * 43_758.5453;
  return scaled - Math.floor(scaled) - 0.5;
};
const vectorOf = (workId: number) => quantize(Array.from({ length: STORED_DIMENSIONS }, (_, index) => noise((workId % 1_000_003) * 1.618 + index * 12.9898)));

async function applyMigrations(db: D1Database) {
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    const statements = splitSqlQuery(readFileSync(new URL(file, migrations), 'utf8'));
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
}

/** Seeds the readers' lanes and returns each leaf's app ids, newest first. */
async function seed(db: D1Database, corpus: Corpus, readers: string[][], now: number) {
  const env = { PAPER_STORE: db } as Parameters<typeof ingestPapers>[0];
  const ingest = async (items: Parameters<typeof ingestPapers>[1], options: Parameters<typeof ingestPapers>[2] = {}) => {
    for (let start = 0; start < items.length; start += WRITE_CHUNK) await ingestPapers(env, items.slice(start, start + WRITE_CHUNK), { now, ...options });
  };
  const leaves = [...new Set(readers.flat())];
  const areas = AREA_LANE_AREAS.filter(area => leaves.some(leaf => LEAF_AREA.get(leaf) === area));
  let number = 0;
  const papersOf = new Map<string, string[]>();
  for (const leaf of leaves) {
    const papers = Array.from({ length: corpus.leafRows }, (_, index) => preprint(leaf, (number += 1), recent(index, now)));
    await ingest(papers.map(paper => ({ paper, lanes: [] })));
    papersOf.set(leaf, papers.map(paper => paper.id));
  }
  for (const area of areas) {
    await ingest(Array.from({ length: corpus.areaRows }, (_, index) => ({ paper: article((number += 1), recent(index, now).slice(0, 10)), lanes: [areaLane(area)] })));
  }
  const year = new Date(now).getUTCFullYear();
  for (const leaf of leaves) {
    const listed = Array.from({ length: NOTABLE_YEARS * corpus.notablePerYear }, (_, index) => {
      const date = `${year - NOTABLE_YEARS + Math.floor(index / corpus.notablePerYear)}-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`;
      return { paper: article((number += 1), date), lanes: [`${NOTABLE_LANE_PREFIX}${leaf}`] };
    });
    await ingest(listed, { keepUntil: daysFromNow(14, now) });
  }
  const { results } = await db.prepare('SELECT id FROM works').all<{ id: number }>();
  for (let start = 0; start < results.length; start += WRITE_CHUNK) {
    const vectors = results.slice(start, start + WRITE_CHUNK).map(({ id }) => ({ id, vector: Buffer.from(vectorOf(id).buffer).toString('hex') }));
    await db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT value ->> 'id', unhex(value ->> 'vector') FROM json_each(?)").bind(JSON.stringify(vectors)).run();
  }
  return papersOf;
}

// What the store's statements read, told apart by their SQL.
const KINDS = [
  ['notable', /\bROW_NUMBER\(\)/],
  ['lanes', /\bFROM work_lanes WHERE lane = \?/],
  ['vectors', /\bFROM work_vectors\b/],
  ['keys', /\bFROM work_keys\b/],
  ['works', /\bFROM works\b|\bUPDATE works\b/],
] as const;
type Kind = typeof KINDS[number][0] | 'other';
const byKind = (): Record<Kind, number> => ({ lanes: 0, notable: 0, vectors: 0, keys: 0, works: 0, other: 0 });
const kindOf = (sql: string): Kind => KINDS.find(([, pattern]) => pattern.test(sql))?.[0] ?? 'other';

// `answered` runs once a call's answer is counted, while the store has not yet
// taken it: the memory run collects garbage there.
interface Tally { calls: number; rowsRead: Record<Kind, number>; returned: Record<Kind, number>; rowsWritten: number; d1Ms: number; answered: () => void }

function count<T>(tally: Tally, sql: string, result: D1Result<T>) {
  const kind = kindOf(sql);
  tally.rowsRead[kind] += result.meta.rows_read;
  tally.returned[kind] += result.results.length;
  tally.rowsWritten += result.meta.rows_written;
  tally.d1Ms += result.meta.duration;
  return result;
}

// The calls the paper store makes, counted. Any other call fails rather than
// go uncounted.
class MeteredStatement {
  readonly statement: D1PreparedStatement;
  readonly sql: string;
  readonly tally: Tally;
  constructor(statement: D1PreparedStatement, sql: string, tally: Tally) {
    this.statement = statement;
    this.sql = sql;
    this.tally = tally;
  }

  bind(...values: unknown[]) {
    return new MeteredStatement(this.statement.bind(...values), this.sql, this.tally);
  }

  async all<T>() {
    this.tally.calls += 1;
    const result = count(this.tally, this.sql, await this.statement.all<T>());
    this.tally.answered();
    return result;
  }

  async run<T>() {
    this.tally.calls += 1;
    const result = count(this.tally, this.sql, await this.statement.run<T>());
    this.tally.answered();
    return result;
  }
}

function metered(db: D1Database, tally: Tally) {
  const binding = {
    prepare: (sql: string) => new MeteredStatement(db.prepare(sql), sql, tally),
    async batch(statements: MeteredStatement[]) {
      tally.calls += 1;
      const results = await db.batch(statements.map(({ statement }) => statement));
      results.forEach((result, index) => count(tally, statements[index].sql, result));
      tally.answered();
      return results;
    },
  };
  return binding as unknown as D1Database;
}

// The order a first page keeps, as the Worker's cache keeps it: as JSON.
function keptRankings(): RankingCache {
  const kept = new Map<string, string>();
  return {
    get: async key => {
      const json = kept.get(key);
      return json === undefined ? null : JSON.parse(json) as KeptRanking;
    },
    put: async (key, ranking) => { kept.set(key, JSON.stringify(ranking)); },
  };
}

type HeapStatistics = GCProfilerResult['statistics'][number]['afterGC']['heapStatistics'];
const held = ({ usedHeapSize, externalMemory }: HeapStatistics) => usedHeapSize + externalMemory;
const MB = 2 ** 20;

/**
 * One request, measured. Memory is V8's heap and external memory (typed
 * arrays) above what it held after a full collection just before: `inUseMb`,
 * the most it held, garbage included, which is before a collection or at the
 * end; `liveMb`, the most it still held after one. In the memory run every
 * collection is a full one (`--gc-global`) and one also follows each D1
 * answer, so `liveMb` comes close to the most the request holds at once,
 * garbage left out; its times are not used.
 */
async function request(db: D1Database, body: FeedRequestBody, cache: RankingCache, collectGarbage: () => void, memoryRun: boolean) {
  const tally: Tally = { calls: 0, rowsRead: byKind(), returned: byKind(), rowsWritten: 0, d1Ms: 0, answered: memoryRun ? collectGarbage : () => {} };
  const env = { PAPER_STORE: metered(db, tally) } as Parameters<typeof readFeedPage>[0];
  collectGarbage();
  const { heapUsed, external } = process.memoryUsage();
  const before = heapUsed + external;
  const profiler = new GCProfiler();
  profiler.start();
  if (memoryRun) setFlagsFromString('--gc-global');
  const cpu = process.cpuUsage();
  const started = performance.now();
  const papers = await readFeedPage(env, parseFeedRequest(body), { now: NOW, cache })
    .finally(() => { if (memoryRun) setFlagsFromString('--no-gc-global'); });
  const wallMs = performance.now() - started;
  const { user, system } = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const collections = profiler.stop().statistics;
  return {
    tally,
    papers: papers.length,
    wallMs,
    cpuMs: (user + system) / 1_000,
    inUseMb: (Math.max(before, after.heapUsed + after.external, ...collections.map(({ beforeGC }) => held(beforeGC.heapStatistics))) - before) / MB,
    liveMb: (Math.max(before, ...collections.map(({ afterGC }) => held(afterGC.heapStatistics))) - before) / MB,
  };
}

type Run = Awaited<ReturnType<typeof request>>;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Rows from the first timed run (a later one writes no like again), times as
// the timed runs' median, memory in use as their most, and live memory from
// the memory run.
function summary(categories: number, likes: number, page: number, timed: Run[], memory: Run) {
  const [{ tally, papers }] = timed;
  return {
    categories,
    likes,
    page,
    papers,
    calls: tally.calls,
    rowsRead: Object.values(tally.rowsRead).reduce((sum, value) => sum + value, 0),
    rowsReadBy: tally.rowsRead,
    returned: tally.returned,
    rowsWritten: tally.rowsWritten,
    d1Ms: median(timed.map(run => run.tally.d1Ms)),
    wallMs: median(timed.map(run => run.wallMs)),
    cpuMs: median(timed.map(run => run.cpuMs)),
    inUseMb: Math.max(...timed.map(run => run.inUseMb)),
    liveMb: memory.liveMb,
  };
}

// The leaves' papers taking turns, each leaf's newest first, as a feed shows them.
const inTurns = (lists: string[][]) => Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, index) => lists.flatMap(list => list.slice(index, index + 1))).flat();

export async function measureLaneReads(corpus: Corpus = PRODUCTION, plan: Plan = PLAN) {
  // The local D1 needs no request metadata; without this, Miniflare asks
  // Cloudflare for it.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
  setFlagsFromString('--expose-gc');
  const collectGarbage: () => void = runInNewContext('gc');
  const proxy = await getPlatformProxy<{ PAPER_STORE: D1Database }>({
    configPath: fileURLToPath(new URL('./measure-lane-reads.wrangler.jsonc', import.meta.url)),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  try {
    const db = proxy.env.PAPER_STORE;
    await applyMigrations(db);
    const papersOf = await seed(db, corpus, plan.readers, NOW);
    const rows: Array<ReturnType<typeof summary>> = [];
    for (const categories of plan.readers) {
      const shown = inTurns(categories.map(leaf => papersOf.get(leaf) ?? []));
      const excludedIds = shown.slice(0, plan.excluded);
      for (const likes of [0, plan.likes]) {
        const body = { categories, positiveIds: shown.slice(plan.excluded, plan.excluded + likes), excludedIds, pageSize: PAGE_SIZE, seen: feedSeenFilter(excludedIds), notable: NOTABLE_ASKED };
        // Each run pages from an empty cache: the timed runs, then the memory run.
        const timed: Run[][] = [[], []];
        for (let repetition = 0; repetition < plan.repetitions; repetition += 1) {
          const cache = keptRankings();
          for (const page of [0, 1]) timed[page].push(await request(db, { ...body, page }, cache, collectGarbage, false));
        }
        const cache = keptRankings();
        const memory: Run[] = [];
        for (const page of [0, 1]) memory.push(await request(db, { ...body, page }, cache, collectGarbage, true));
        rows.push(...memory.map((run, page) => summary(categories.length, likes, page, timed[page], run)));
      }
    }
    return rows;
  } finally {
    await proxy.dispose();
  }
}

const round = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

function tables(rows: Awaited<ReturnType<typeof measureLaneReads>>) {
  const line = (cells: Array<string | number>) => `| ${cells.join(' | ')} |`;
  return [
    line(['Categories', 'Likes', 'Page', 'Rows read', 'Lane reads', 'Notable scan', 'Vectors', 'Keys', 'Works', 'Other', 'Vectors returned', 'Rows written']),
    line(Array.from({ length: 12 }, () => '---:')),
    ...rows.map(row => line([
      row.categories, row.likes, row.page + 1, row.rowsRead, row.rowsReadBy.lanes, row.rowsReadBy.notable, row.rowsReadBy.vectors,
      row.rowsReadBy.keys, row.rowsReadBy.works, row.rowsReadBy.other, row.returned.vectors, row.rowsWritten,
    ])),
    '',
    line(['Categories', 'Likes', 'Page', 'Papers', 'D1 calls', 'D1 ms', 'Wall ms', 'CPU ms', 'Live MB', 'In use MB']),
    line(Array.from({ length: 10 }, () => '---:')),
    ...rows.map(row => line([
      row.categories, row.likes, row.page + 1, row.papers, row.calls, round(row.d1Ms), round(row.wallMs), round(row.cpuMs), round(row.liveMb), round(row.inUseMb),
    ])),
  ].join('\n');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${tables(await measureLaneReads())}\n`);
}
