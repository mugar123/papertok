import type { BloomFilter } from 'bloomfilter';
import type { Paper } from '../models/paper.ts';
export type CuratedSetName = 'liked' | 'saved' | 'read' | 'notInterested' | 'readLater';
export interface DecayedAffinity { value: number; at: number; }
export interface CategoryExposure { shown: number; engaged: number; }
export interface PositiveExample { id: string; category: string; }
export interface WeightedConcept { id: string; score?: number; }
/**
 * One kind of For You card: how many of them the reader was shown, and how
 * many likes, saves and opened PDFs they got. Halving (TEMPORAL_HALVE_AT)
 * makes both fractional.
 */
export interface KindCounts { shown: number; engaged: number; }
/**
 * The notable and the other (recent) For You cards' counts, and the lean, from
 * -1 (classic) to +1 (recent), that likes, saves and long reads move. The feed
 * samples each page's share of notable places from the two kinds' rates
 * (sampleNotableEvery).
 */
export interface TemporalSignal { notable: KindCounts; recent: KindCounts; lean: number; }
// What one like, save or opened PDF of a paper added: to which kind, if any
// (`notable`), at which halving (`epoch`), and the lean step it moved.
interface CountedEngagement { notable?: boolean; epoch: number; lean: number; }
type EngagementSignal = 'like' | 'save' | 'openedPdf';
type EngagedPaper = Partial<Record<EngagementSignal, CountedEngagement>>;
interface TemporalState extends TemporalSignal {
  // How many times the counts were halved.
  halvings: number;
  // The papers whose like, save or opened PDF counted, oldest first, so that
  // each counts once and an unlike or unsave takes back what it added.
  papers: Map<string, EngagedPaper>;
}
export interface InteractionProfile {
  version: number; updatedAt: string | null;
  categories: Map<string, { cohorts: Map<number, { weighted: number; raw: number }>; aged: number }>;
  concepts: Map<string, DecayedAffinity>;
  authors: Map<string, DecayedAffinity>;
  exposure: Map<string, CategoryExposure>;
  dwell: { median: number };
  positives: PositiveExample[];
  // In memory only: what this session has engaged with, faded on every event.
  session: Map<string, number>;
  curated: Map<CuratedSetName, { order: string[]; members: Set<string> }>;
  // The papers this account really viewed, newest first. Not a curated set: it
  // is never known to the feed and never reaches the seen filter.
  viewed: string[];
  // The notable cards (`_notable`) among them, newest first and kept longer.
  // The interaction documents do not say which views those were, so a
  // rebuild starts it empty.
  viewedNotable: string[];
  // The interaction documents do not say which cards were notable either, so
  // a rebuild starts this empty too.
  temporal: TemporalState;
  seenFilter: BloomFilter | null;
  counters: { interactions: number; evicted: number }; countedPapers: Set<string>;
  // In memory only: the papers this session first viewed off For You, which
  // the viewed list holds without a For You card counted (countShown).
  viewedOffForYou: Set<string>;
  sourceDocCount: number; truncated: boolean;
}
export interface InteractionEvent {
  paperId: string; kind: string; category?: string; timestamp?: number | string; viewTime?: number; value?: boolean;
  concepts?: WeightedConcept[]; authorIds?: string[];
  // Whether the For You card was notable (forYouCardNotable), on a view, a
  // skip, a like, a save or an opened PDF. Left out for a paper off that feed.
  notable?: boolean;
  // The paper's publication date, which a like, a save or a long read moves
  // the lean by. The feed leaves it out for a notable card (profileEvent).
  published?: string | null;
  // The card's area (areaKeyForPaper), for a card whose category is no leaf.
  area?: string | null;
}
export interface ProfileSignals {
  categoryAffinities: Record<string, number>;
  conceptAffinities: Record<string, number>;
  authorAffinities: Record<string, number>;
  sessionAffinities: Record<string, number>;
  categoryExposure: Record<string, CategoryExposure>;
  interactionCount: number;
  dwellMedianSeconds: number;
  // The likes, saves and long reads the reader keeps, newest first, up to
  // MAX_POSITIVE_EXAMPLES_PER_AREA for each area.
  positiveExamples: PositiveExample[];
  temporal: TemporalSignal;
}
export interface StoredInteractionProfile {
  schemaVersion: number; updatedAt: string; affinities: string; curated: string; seenFilter?: string;
  interactionCount: number; evictedCount: number; sourceDocCount: number; truncated: boolean;
}
export interface InteractionDocumentData {
  liked?: boolean; saved?: boolean; read?: boolean; notInterested?: boolean; readLater?: boolean;
  openedPdf?: boolean; viewTime?: number; skip?: boolean | number; pdfBounce?: boolean; paperCategory?: string;
  timestamp?: number | string; libraryUpdatedAt?: string;
  paper?: Partial<Paper>; paperTitle?: string; paperAuthors?: Paper['authors'];
  paperAbstract?: string; note?: string; tags?: string[]; readAt?: string | number | null;
}
export interface InteractionDocument { id: string; data: InteractionDocumentData; }

/**
 * Derived aggregate of `users/{uid}/interactions`.
 *
 * The feed used to rebuild its whole recommendation profile by reading that
 * subcollection in full on every load, which costs one Firestore read per paper
 * the user has ever scrolled past. This module holds the same information in a
 * single document that is maintained incrementally, so a feed load costs one
 * read no matter how old the account is.
 *
 * The individual interaction documents remain the source of truth for the
 * curated sets and the category affinities. Those are reconstructible from them,
 * which is what makes it safe for the browser to write the aggregate directly:
 * a corrupt or stale aggregate is repaired by bumping the schema version and
 * letting the bounded rebuild path run once. Concept and author affinities are
 * the exception: the documents store neither, so a rebuild starts them empty and
 * `seedLearnedAffinities` refills them from the liked and saved papers.
 *
 * ── How the category affinities survive being incremental ──
 * The old full scan weighted every interaction by `max(0.2, exp(-ageDays/30))`,
 * a factor that changes every second, so a plain running total cannot
 * reproduce it. Exponential decay is separable, though: an interaction's weight
 * at read time is its weight at its own cohort's day start times a factor that
 * depends only on the cohort. So each category keeps one bucket per day for the
 * ~48 days where the exponential is above the 0.2 floor, holding the sum of
 * `impact * exp((t - dayStart)/30d)`. Reading multiplies each bucket by
 * `exp(-cohortAgeDays/30)`, which reproduces the original per-item decay
 * exactly. Once a whole bucket falls past the floor its raw impact merges into
 * a single aged accumulator weighted at the flat 0.2, and the bucket is
 * dropped. That bounds a category at ~50 numbers regardless of history.
 *
 * Concepts and authors are far more numerous than categories, so they cannot
 * afford fifty numbers each. They keep one value and the time it was last
 * moved, decayed by the same 30-day exponential with no floor: a narrow
 * interest that is never touched again fades out instead of lasting forever.
 */
import { readStoredClassification } from '../models/paper.ts';
import { areaKeyForCategory, areaKeyForPaper } from './area-accent.ts';
import { getCategoryArea } from '../data/category-taxonomy.ts';
import {
  addSeenPaper,
  createSeenFilter,
  deserializeSeenFilter,
  hasSeenPaper,
  isSeenFilterEmpty,
  serializeSeenFilter,
} from './seen-paper-filter.ts';

export const INTERACTION_PROFILE_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DECAY_DAYS = 30;
const DECAY_FLOOR = 0.2;
// exp(-age/30) crosses the 0.2 floor here; buckets older than this plus a full
// day have every item past the floor and can be merged away.
const FLOOR_AGE_DAYS = DECAY_DAYS * Math.log(1 / DECAY_FLOOR);
const MAX_COHORT_AGE_DAYS = FLOOR_AGE_DAYS + 1;

export const AFFINITY_MIN = -10;
export const AFFINITY_MAX = 100;

const IMPACT_LIKED = 5;
const IMPACT_SAVED = 8;
const IMPACT_OPENED_PDF = 4;
const IMPACT_SKIP = -1;
const IMPACT_PDF_BOUNCE = -2;
const IMPACT_NOT_INTERESTED = -10;
// A rejection is about this paper's topics and authors, which take the full
// penalty. Its category keeps only a mild one: refusing one paper on LLM
// benchmarks used to sink every cs.CL paper and its sibling categories for two
// weeks.
const IMPACT_NOT_INTERESTED_CATEGORY = -3;

// Dwell is judged against the reader's own typical dwell rather than in raw
// seconds: a long abstract earns seconds a short one cannot, and two seconds
// used to count as interest. At the median a view says nothing; each doubling
// above it is worth half the old 60-second cap, and a view under half the
// median weighs what a skip does.
const DEFAULT_DWELL_MEDIAN_SECONDS = 6;
const DWELL_MEDIAN_MIN_SECONDS = 2;
const DWELL_MEDIAN_MAX_SECONDS = 60;
// The median is tracked online: each view nudges it by this fraction towards
// its own side, so one tab left open for an hour moves it by 5% and no more.
const DWELL_MEDIAN_STEP = 0.05;
const IMPACT_VIEW_TIME_MAX = 15;
const IMPACT_VIEW_TIME_MIN = IMPACT_SKIP;
// Twice the reader's median is the read the personal recommendations treat as
// an example of what they want, alongside likes and saves.
const STRONG_READ_RATIO = 2;

// What the personal recommendations are asked about: the most recent examples
// of each area, newest first. The cap is per area so an area the reader
// deselects keeps its examples while they read others; the examples whose
// category has no area share one allowance of their own.
export const MAX_POSITIVE_EXAMPLES_PER_AREA = 24;

// Each event fades what the session held before it by this factor, so the last
// dozen cards dominate and an interest from twenty cards ago is nearly gone.
const SESSION_DECAY = 0.85;
const SESSION_MIN_WEIGHT = 0.05;

export const CURATED_SETS = Object.freeze(['liked', 'saved', 'read', 'notInterested', 'readLater'] as const);

// Caps chosen so the serialised curated payload stays far below the 1 MiB
// document limit even with long DOI-shaped ids. Anything evicted moves into the
// Bloom filter, so the feed still never repeats it.
export const CURATED_ID_CAPS = Object.freeze({
  liked: 2000,
  saved: 2000,
  read: 4000,
  notInterested: 3000,
  readLater: 1000,
});

// The ring of viewed papers a second device skips on load. About 13 kB inside
// `curated`, and the first thing the curated budget gives up.
export const MAX_VIEWED_IDS = 500;
// The viewed notable cards the feed passes over as well. The corpus offers a
// reader's unseen notable papers in one order, so one that only the ring
// remembered would come back, once the ring forgot it, before any the reader
// never saw. As many as the weekly listings of the 12 categories a page can
// ask for (NOTABLE_PER_LANE in worker/paper-sources.ts); about 30 kB inside
// `curated`, given up after the ring.
export const MAX_VIEWED_NOTABLE_IDS = 1_200;

export const MAX_CURATED_JSON_BYTES = 320000;
export const MAX_AFFINITY_JSON_BYTES = 120000;
export const MAX_TRACKED_CATEGORIES = 300;
const MAX_TRACKED_CONCEPTS = 400;
const MAX_TRACKED_AUTHORS = 300;
// Below this a learned concept or author no longer moves a score.
const NEGLIGIBLE_AFFINITY = 0.01;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function dayIndexOf(timestampMs: number) {
  return Math.floor(timestampMs / DAY_MS);
}

function toTimestampMs(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function emptyTemporal(): TemporalState {
  return { notable: { shown: 0, engaged: 0 }, recent: { shown: 0, engaged: 0 }, lean: 0, halvings: 0, papers: new Map() };
}

export function createEmptyInteractionProfile(): InteractionProfile {
  return {
    version: INTERACTION_PROFILE_SCHEMA_VERSION,
    updatedAt: null,
    categories: new Map(),
    concepts: new Map(),
    authors: new Map(),
    exposure: new Map(),
    dwell: { median: DEFAULT_DWELL_MEDIAN_SECONDS },
    positives: [],
    session: new Map(),
    curated: new Map(CURATED_SETS.map(name => [name, { order: [], members: new Set() }])),
    viewed: [],
    viewedNotable: [],
    temporal: emptyTemporal(),
    seenFilter: null,
    counters: { interactions: 0, evicted: 0 },
    // Papers already counted towards sourceDocCount in this session. In memory
    // only: it exists to stop one session counting the same paper twice.
    countedPapers: new Set(),
    viewedOffForYou: new Set(),
    sourceDocCount: 0,
    truncated: false,
  };
}

/**
 * The category impact of a view lasting `seconds`, against the reader's
 * median: 0 at the median, +7.5 at twice it, +15 from four times it on, and
 * down to a skip's -1 at half of it and below.
 */
function viewTimeImpact(seconds: number, medianSeconds = DEFAULT_DWELL_MEDIAN_SECONDS) {
  if (!(seconds > 0) || !(medianSeconds > 0)) return 0;
  const doublings = Math.log2(seconds / medianSeconds);
  return doublings >= 0
    ? Math.min(doublings, 2) * (IMPACT_VIEW_TIME_MAX / 2)
    : Math.max(doublings, -1) * -IMPACT_VIEW_TIME_MIN;
}

function observeDwell(dwell: InteractionProfile['dwell'], seconds: number) {
  const step = dwell.median * DWELL_MEDIAN_STEP;
  const direction = Math.sign(seconds - dwell.median);
  dwell.median = clamp(dwell.median + direction * step, DWELL_MEDIAN_MIN_SECONDS, DWELL_MEDIAN_MAX_SECONDS);
}

function categoryBucket(profile: InteractionProfile, category: string) {
  let bucket = profile.categories.get(category);
  if (!bucket) {
    bucket = { cohorts: new Map(), aged: 0 };
    profile.categories.set(category, bucket);
  }
  return bucket;
}

/**
 * Adds `impact` to `category`, dated at `timestampMs`. Interactions with no
 * usable timestamp keep the full scan's behaviour of an undecayed weight of 1,
 * which is modelled as a cohort dated now.
 */
function addImpact(profile: InteractionProfile, category: string, impact: number, timestampMs: number) {
  if (typeof category !== 'string' || !category) return;
  const bucket = categoryBucket(profile, category);
  if (impact === 0) return;

  const day = dayIndexOf(timestampMs);
  const dayStart = day * DAY_MS;
  // Rebase to the cohort's own day start so the stored exponent stays inside
  // [0, 1/30] and no global re-basing pass is ever needed.
  const rebased = impact * Math.exp((timestampMs - dayStart) / (DECAY_DAYS * DAY_MS));
  const cohort = bucket.cohorts.get(day) || { weighted: 0, raw: 0 };
  cohort.weighted += rebased;
  cohort.raw += impact;
  bucket.cohorts.set(day, cohort);
}

function compactCategories(profile: InteractionProfile, now: number) {
  const oldestLiveDay = dayIndexOf(now - MAX_COHORT_AGE_DAYS * DAY_MS);
  profile.categories.forEach((bucket) => {
    bucket.cohorts.forEach((cohort, day) => {
      if (day < oldestLiveDay) {
        bucket.aged += cohort.raw;
        bucket.cohorts.delete(day);
      }
    });
  });

  if (profile.categories.size <= MAX_TRACKED_CATEGORIES) return;
  // Keep the categories that actually move the ranking.
  const ranked = [...profile.categories.keys()]
    .map(category => [category, Math.abs(categoryAffinityAt(profile, category, now))] as const)
    .sort((a, b) => b[1] - a[1]);
  ranked.slice(MAX_TRACKED_CATEGORIES).forEach(([category]) => profile.categories.delete(category));
}

function categoryAffinityAt(profile: InteractionProfile, category: string, now: number) {
  const bucket = profile.categories.get(category);
  if (!bucket) return 0;
  let total = DECAY_FLOOR * bucket.aged;
  bucket.cohorts.forEach((cohort, day) => {
    const ageDays = (now - day * DAY_MS) / DAY_MS;
    const decay = Math.exp(-ageDays / DECAY_DAYS);
    total += decay >= DECAY_FLOOR ? cohort.weighted * decay : DECAY_FLOOR * cohort.raw;
  });
  return total;
}

function decayOver(elapsedMs: number) {
  return Math.exp(-Math.max(0, elapsedMs) / (DECAY_DAYS * DAY_MS));
}

function decayedValueAt(entry: DecayedAffinity, now: number) {
  return entry.value * decayOver(now - entry.at);
}

/**
 * One exponential, kept as a value and the moment it was last moved. An event
 * older than that moment (a rebuild replaying history, two tabs out of order)
 * is decayed into the present value rather than moving the clock back.
 */
function addDecayedImpact(map: Map<string, DecayedAffinity>, key: string, impact: number, timestampMs: number) {
  if (!key || !impact) return;
  const entry = map.get(key);
  if (!entry) {
    map.set(key, { value: impact, at: timestampMs });
  } else if (timestampMs >= entry.at) {
    entry.value = entry.value * decayOver(timestampMs - entry.at) + impact;
    entry.at = timestampMs;
  } else {
    entry.value += impact * decayOver(entry.at - timestampMs);
  }
}

function compactDecayed(map: Map<string, DecayedAffinity>, cap: number, now: number) {
  map.forEach((entry, key) => {
    if (Math.abs(decayedValueAt(entry, now)) < NEGLIGIBLE_AFFINITY) map.delete(key);
  });
  if (map.size <= cap) return;
  [...map.entries()]
    .map(([key, entry]) => [key, Math.abs(decayedValueAt(entry, now))] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(cap)
    .forEach(([key]) => map.delete(key));
}

// OpenAlex reports how strongly a work belongs to each concept. A concept
// without a score (some topic fallbacks) counts in full.
function conceptWeight(concept: WeightedConcept) {
  return Number.isFinite(concept.score) ? clamp(concept.score!, 0, 1) : 1;
}

function usableConcepts(concepts: unknown): WeightedConcept[] {
  if (!Array.isArray(concepts)) return [];
  return concepts.filter((concept): concept is WeightedConcept => (
    typeof concept?.id === 'string' && concept.id.length > 0
  ));
}

function usableAuthorIds(authorIds: unknown): string[] {
  if (!Array.isArray(authorIds)) return [];
  return [...new Set(authorIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

// What a card's exposure and examples count under (ENG-137, R14): its leaf,
// or its area when its category names no leaf. An area lane's article (all
// of Chemistry's cards) is filed under no category at all, and would teach
// nothing. Its category affinity keeps the category it has.
function learnedUnder(category: string, area: string | null | undefined) {
  return getCategoryArea(category) || !area ? category : area;
}

function recordExposure(profile: InteractionProfile, category: string, engaged: boolean) {
  if (!category) return;
  const entry = profile.exposure.get(category) || { shown: 0, engaged: 0 };
  entry.shown += 1;
  if (engaged) entry.engaged += 1;
  profile.exposure.set(category, entry);
  if (profile.exposure.size <= MAX_TRACKED_CATEGORIES) return;
  // The least shown category has the least evidence to lose.
  const leastShown = [...profile.exposure.entries()].sort((a, b) => a[1].shown - b[1].shown)[0];
  if (leastShown) profile.exposure.delete(leastShown[0]);
}

// Keeps the first (newest) MAX_POSITIVE_EXAMPLES_PER_AREA examples of each
// area, in their order. A category that names no area counts toward one shared
// allowance, as the area of its own.
function capExamplesPerArea(examples: PositiveExample[]) {
  const kept = new Map<string, number>();
  return examples.filter((example) => {
    const area = areaKeyForCategory(example.category) ?? '';
    const count = kept.get(area) ?? 0;
    kept.set(area, count + 1);
    return count < MAX_POSITIVE_EXAMPLES_PER_AREA;
  });
}

function addPositive(profile: InteractionProfile, paperId: string, category: string) {
  profile.positives = capExamplesPerArea([
    { id: paperId, category },
    ...profile.positives.filter(example => example.id !== paperId),
  ]);
}

function removePositive(profile: InteractionProfile, paperId: string) {
  profile.positives = profile.positives.filter(example => example.id !== paperId);
}

// Undoing a like leaves the paper an example while it is still saved, and the
// other way round, as a rebuild from its document would.
function removeUnkeptPositive(profile: InteractionProfile, paperId: string) {
  if (curatedSet(profile, 'liked')!.members.has(paperId) || curatedSet(profile, 'saved')!.members.has(paperId)) return;
  removePositive(profile, paperId);
}

// How far a like, a save and a read of LEAN_READ_SECONDS or more move the lean.
const LEAN_STEP = { like: 0.1, save: 0.15, read: 0.05 };
const LEAN_READ_SECONDS = 10;

/**
 * The lean moved by `step`: toward recent for a paper a week old or less,
 * toward classic for one a year old or more. A notable card leaves it as it
 * is: the feed chose that card for its citations, and it is years old by that
 * choice. A paper without a date says nothing about age. A guest's feed keeps
 * its own lean for the session with it (FeedContext).
 */
export function leanAfterEngaging(lean: number, event: Pick<InteractionEvent, 'notable' | 'published'>, step: number, now = Date.now()) {
  const published = toTimestampMs(event.published);
  if (event.notable === true || published === null) return lean;
  const daysOld = (now - published) / DAY_MS;
  if (daysOld <= 7) return Math.min(1, lean + step);
  if (daysOld >= 365) return Math.max(-1, lean - step);
  return lean;
}

/**
 * A guest's lean after `event`: a like, a save or a read of LEAN_READ_SECONDS
 * or more moves it, as on a profile, and nothing takes it back (a guest's
 * lean lasts the session only).
 */
export function leanAfterEvent(lean: number, event: InteractionEvent, now = Date.now()) {
  if (event.kind === 'like') return leanAfterEngaging(lean, event, LEAN_STEP.like, now);
  if (event.kind === 'save') return leanAfterEngaging(lean, event, LEAN_STEP.save, now);
  if (event.kind === 'viewTime' && Number(event.viewTime) >= LEAN_READ_SECONDS) return leanAfterEngaging(lean, event, LEAN_STEP.read, now);
  return lean;
}

// Once the cards shown of both kinds reach this many, every count is halved:
// the account's last two thousand or so cards weigh as much as all before
// them, so what the reader engages with now can overturn years of history.
const TEMPORAL_HALVE_AT = 2000;
// The papers whose engagement the account remembers, to count each once and
// undo it exactly. An unlike of a paper older than these takes nothing back.
const MAX_ENGAGED_PAPERS = 200;

function halveWhenFull(temporal: TemporalState) {
  while (temporal.notable.shown + temporal.recent.shown >= TEMPORAL_HALVE_AT) {
    for (const kind of [temporal.notable, temporal.recent]) {
      kind.shown /= 2;
      kind.engaged /= 2;
    }
    temporal.halvings += 1;
  }
}

const countsOf = (temporal: TemporalState, notable: boolean) => (notable ? temporal.notable : temporal.recent);

// A view or a skip of a For You card counts it shown, once while the viewed
// lists remember it. The viewed list also holds views off For You, such as in
// Search, which counted no card. A notable card counts once while its own list
// remembers it. A recent card counts once, even when its paper was first viewed
// off For You in this session; one viewed off For You in an earlier session
// counts no card. Runs before addViewed records the view.
function countShown(profile: InteractionProfile, event: InteractionEvent) {
  const { paperId } = event;
  const remembered = profile.viewed.includes(paperId) || profile.viewedNotable.includes(paperId);
  if (typeof event.notable !== 'boolean') {
    if (!remembered) profile.viewedOffForYou.add(paperId);
    return;
  }
  const counted = event.notable
    ? profile.viewedNotable.includes(paperId)
    : remembered && !profile.viewedOffForYou.has(paperId);
  profile.viewedOffForYou.delete(paperId);
  if (counted) return;
  countsOf(profile.temporal, event.notable).shown += 1;
  halveWhenFull(profile.temporal);
}

/**
 * A like, a save or an opened PDF of a paper: once per paper and signal, it
 * counts toward its kind when it is a For You card, and moves the lean by
 * `step`. What it added is kept, for an unlike or unsave to take back.
 */
function countEngagement(profile: InteractionProfile, event: InteractionEvent, signal: EngagementSignal, step: number, now: number) {
  const { temporal } = profile;
  const paper = temporal.papers.get(event.paperId) ?? {};
  if (paper[signal]) return;
  const lean = leanAfterEngaging(temporal.lean, event, step, now);
  const counted: CountedEngagement = { epoch: temporal.halvings, lean: lean - temporal.lean };
  temporal.lean = lean;
  if (typeof event.notable === 'boolean') {
    counted.notable = event.notable;
    countsOf(temporal, event.notable).engaged += 1;
  }
  if (counted.notable === undefined && counted.lean === 0) return;
  paper[signal] = counted;
  temporal.papers.delete(event.paperId);
  temporal.papers.set(event.paperId, paper);
  while (temporal.papers.size > MAX_ENGAGED_PAPERS) temporal.papers.delete(temporal.papers.keys().next().value!);
}

// An unlike or unsave: takes back what the like or save added, halved as the
// counts were since.
function undoEngagement(profile: InteractionProfile, paperId: string, signal: EngagementSignal) {
  const { temporal } = profile;
  const paper = temporal.papers.get(paperId);
  const counted = paper?.[signal];
  if (!paper || !counted) return;
  if (typeof counted.notable === 'boolean') {
    const kind = countsOf(temporal, counted.notable);
    kind.engaged = Math.max(0, kind.engaged - 0.5 ** (temporal.halvings - counted.epoch));
  }
  temporal.lean = clamp(temporal.lean - counted.lean, -1, 1);
  delete paper[signal];
  if (Object.keys(paper).length === 0) temporal.papers.delete(paperId);
}

function recordSessionImpact(
  profile: InteractionProfile,
  category: string,
  categoryImpact: number,
  concepts: WeightedConcept[],
  impact: number,
) {
  profile.session.forEach((value, key) => {
    const faded = value * SESSION_DECAY;
    if (Math.abs(faded) < SESSION_MIN_WEIGHT) profile.session.delete(key);
    else profile.session.set(key, faded);
  });
  const add = (key: string, amount: number) => {
    if (key && amount) profile.session.set(key, (profile.session.get(key) || 0) + amount);
  };
  add(category, categoryImpact);
  concepts.forEach(concept => add(concept.id, impact * conceptWeight(concept)));
}

/**
 * Materialises every map `scorePaperForRecommendation` consumes. Each call
 * builds new objects, so a re-rank after an interaction never meets a map an
 * earlier scoring run cached against.
 */
export function readProfileSignals(profile: InteractionProfile | null | undefined, now = Date.now()): ProfileSignals {
  const signals: ProfileSignals = {
    categoryAffinities: {},
    conceptAffinities: {},
    authorAffinities: {},
    sessionAffinities: {},
    categoryExposure: {},
    interactionCount: 0,
    dwellMedianSeconds: DEFAULT_DWELL_MEDIAN_SECONDS,
    positiveExamples: [],
    temporal: { notable: { shown: 0, engaged: 0 }, recent: { shown: 0, engaged: 0 }, lean: 0 },
  };
  if (!profile) return signals;

  profile.categories.forEach((_bucket, category) => {
    // A key that names no field is a concept name an OpenAlex card carried
    // where its category belongs (PAP-60). Concepts are learned by their
    // OpenAlex ids in `concepts`; as a category it would only boost cards
    // listing the same name.
    if (!areaKeyForCategory(category)) return;
    signals.categoryAffinities[category] = clamp(categoryAffinityAt(profile, category, now), AFFINITY_MIN, AFFINITY_MAX);
  });
  profile.concepts.forEach((entry, key) => {
    signals.conceptAffinities[key] = clamp(decayedValueAt(entry, now), AFFINITY_MIN, AFFINITY_MAX);
  });
  profile.authors.forEach((entry, key) => {
    signals.authorAffinities[key] = clamp(decayedValueAt(entry, now), AFFINITY_MIN, AFFINITY_MAX);
  });
  profile.session.forEach((value, key) => {
    signals.sessionAffinities[key] = value;
  });
  profile.exposure.forEach((entry, category) => {
    signals.categoryExposure[category] = { ...entry };
  });
  signals.interactionCount = profile.counters.interactions;
  signals.dwellMedianSeconds = profile.dwell.median;
  signals.positiveExamples = profile.positives.map(example => ({ ...example }));
  const { notable, recent, lean } = profile.temporal;
  signals.temporal = { notable: { ...notable }, recent: { ...recent }, lean };
  return signals;
}

/**
 * Concept and author affinities cannot be rebuilt from the interaction
 * documents, which store neither. A profile loaded without any — an aggregate
 * written before they existed, or one just rebuilt — needs them seeded from
 * the enrichment of the reader's liked and saved papers.
 */
export function lacksLearnedAffinities(profile: InteractionProfile) {
  return profile.concepts.size === 0 && profile.authors.size === 0;
}

/**
 * Adds each example as a like made now. The caller decides, when the profile
 * loads, whether it needs seeding: by the time the enrichment comes back the
 * reader may already have added entries of their own, which the seed joins.
 */
export function seedLearnedAffinities(
  profile: InteractionProfile,
  examples: Array<{ concepts?: WeightedConcept[]; authorIds?: string[] }>,
  now = Date.now(),
) {
  examples.forEach((example) => {
    usableConcepts(example.concepts).forEach((concept) => {
      addDecayedImpact(profile.concepts, concept.id, IMPACT_LIKED * conceptWeight(concept), now);
    });
    usableAuthorIds(example.authorIds).forEach((authorId) => {
      addDecayedImpact(profile.authors, authorId, IMPACT_LIKED, now);
    });
  });
  compactDecayed(profile.concepts, MAX_TRACKED_CONCEPTS, now);
  compactDecayed(profile.authors, MAX_TRACKED_AUTHORS, now);
}

function curatedSet(profile: InteractionProfile, name: CuratedSetName) {
  return profile.curated.get(name);
}

function ensureSeenFilter(profile: InteractionProfile) {
  if (!profile.seenFilter) profile.seenFilter = createSeenFilter();
  return profile.seenFilter;
}

function addCurated(profile: InteractionProfile, name: CuratedSetName, paperId: string) {
  const set = curatedSet(profile, name);
  if (!set || typeof paperId !== 'string' || !paperId) return;
  if (set.members.has(paperId)) {
    // Refresh recency so the newest action stays inside the cap.
    const position = set.order.indexOf(paperId);
    if (position > 0) {
      set.order.splice(position, 1);
      set.order.unshift(paperId);
    }
    return;
  }
  set.members.add(paperId);
  set.order.unshift(paperId);

  const cap = CURATED_ID_CAPS[name];
  while (set.order.length > cap) {
    const evicted = set.order.pop()!;
    set.members.delete(evicted);
    addSeenPaper(ensureSeenFilter(profile), evicted);
    profile.counters.evicted += 1;
  }
}

function addNewest(ids: string[], paperId: string, cap: number) {
  const position = ids.indexOf(paperId);
  if (position === 0) return;
  if (position > 0) ids.splice(position, 1);
  ids.unshift(paperId);
  if (ids.length > cap) ids.length = cap;
}

// A view and a skip both mean the card was on screen. Unlike a curated set, the
// oldest id simply falls off: the feed may show a paper again, it must only not
// do so right after the reader saw it.
function addViewed(profile: InteractionProfile, paperId: string, notable = false) {
  if (typeof paperId !== 'string' || !paperId) return;
  addNewest(profile.viewed, paperId, MAX_VIEWED_IDS);
  if (notable) addNewest(profile.viewedNotable, paperId, MAX_VIEWED_NOTABLE_IDS);
}

/** The viewed papers the feed passes over: the ring and the notable cards. */
export function viewedIds(profile: InteractionProfile | null | undefined) {
  return profile ? [...new Set([...profile.viewed, ...profile.viewedNotable])] : [];
}

function removeCurated(profile: InteractionProfile, name: CuratedSetName, paperId: string) {
  const set = curatedSet(profile, name);
  if (!set || !set.members.has(paperId)) return;
  set.members.delete(paperId);
  const position = set.order.indexOf(paperId);
  if (position >= 0) set.order.splice(position, 1);
}

export function curatedIds(profile: InteractionProfile | null | undefined, name: CuratedSetName) {
  const set = profile && curatedSet(profile, name);
  return set ? [...set.order] : [];
}

/**
 * True when the paper is already known to the profile and must stay out of the
 * feed. Exact for everything inside the caps; beyond them the Bloom filter can
 * only err towards hiding a paper the user has not seen, never towards
 * repeating one they have.
 */
export function isPaperKnown(profile: InteractionProfile | null | undefined, paperId: unknown) {
  if (!profile || typeof paperId !== 'string' || !paperId) return false;
  for (const name of CURATED_SETS) {
    if (name === 'readLater') continue;
    if (curatedSet(profile, name)!.members.has(paperId)) return true;
  }
  return hasSeenPaper(profile.seenFilter, paperId);
}

/**
 * Whether this paper's interaction document is already reflected in
 * `sourceDocCount`.
 *
 * Membership of a curated set proves the rebuild counted its document. Beyond
 * that we only know what this session has seen, so a paper touched in an
 * earlier session with nothing but skips gets counted again. That biases
 * `sourceDocCount` upwards, which is the safe direction: the drift check
 * subtracts it from the true document count, so an over-count can only
 * under-report drift, never invent it and trigger a needless rebuild.
 */
function isPaperAccountedFor(profile: InteractionProfile, paperId: string) {
  if (profile.countedPapers.has(paperId)) return true;
  return CURATED_SETS.some(name => curatedSet(profile, name)!.members.has(paperId));
}

/**
 * Folds one interaction into the profile.
 *
 * `kind` is one of like, unlike, save, unsave, read, unread, readLater,
 * notInterested, undoNotInterested, openedPdf, pdfBounce, skip, viewTime,
 * metadata. `category` is the paper's primary category, `concepts` and
 * `authorIds` its OpenAlex concepts and authors, already keyed the way the
 * ranking reads them.
 * `viewTime` is in seconds and `value` belongs to the toggles that carry one.
 *
 * An event's impact lands in full on its concepts, its authors and the
 * session. Its category takes the same impact, except for a rejection.
 */
export function recordInteractionEvent(profile: InteractionProfile, event: InteractionEvent, now = Date.now()) {
  if (!profile || !event || typeof event.paperId !== 'string' || !event.paperId) return profile;
  const timestampMs = toTimestampMs(event.timestamp) ?? now;
  const category = typeof event.category === 'string' ? event.category : '';
  const learned = learnedUnder(category, event.area);
  // Sampled before the switch: applying the event may add the id to a curated
  // set, which would make it look accounted for when it is not yet.
  const alreadyAccountedFor = isPaperAccountedFor(profile, event.paperId);
  // null for the kinds that say nothing about what the reader wants.
  let impact: number | null = null;
  let categoryImpact: number | null = null;

  switch (event.kind) {
    case 'like':
      addCurated(profile, 'liked', event.paperId);
      addPositive(profile, event.paperId, learned);
      countEngagement(profile, event, 'like', LEAN_STEP.like, now);
      impact = IMPACT_LIKED;
      break;
    case 'unlike':
      removeCurated(profile, 'liked', event.paperId);
      removeUnkeptPositive(profile, event.paperId);
      undoEngagement(profile, event.paperId, 'like');
      impact = -IMPACT_LIKED;
      break;
    case 'save':
      addCurated(profile, 'saved', event.paperId);
      addPositive(profile, event.paperId, learned);
      countEngagement(profile, event, 'save', LEAN_STEP.save, now);
      impact = IMPACT_SAVED;
      break;
    case 'unsave':
      removeCurated(profile, 'saved', event.paperId);
      removeUnkeptPositive(profile, event.paperId);
      undoEngagement(profile, event.paperId, 'save');
      impact = -IMPACT_SAVED;
      break;
    case 'read':
      addCurated(profile, 'read', event.paperId);
      break;
    case 'unread':
      removeCurated(profile, 'read', event.paperId);
      break;
    case 'readLater':
      if (event.value === false) removeCurated(profile, 'readLater', event.paperId);
      else addCurated(profile, 'readLater', event.paperId);
      break;
    case 'notInterested':
      addCurated(profile, 'notInterested', event.paperId);
      removePositive(profile, event.paperId);
      impact = IMPACT_NOT_INTERESTED;
      categoryImpact = IMPACT_NOT_INTERESTED_CATEGORY;
      break;
    // The rejection taken back: its impact is returned, and a paper that is
    // still liked or saved is an example again, as a rebuild from its
    // document would make it.
    case 'undoNotInterested':
      removeCurated(profile, 'notInterested', event.paperId);
      if (curatedSet(profile, 'liked')!.members.has(event.paperId) || curatedSet(profile, 'saved')!.members.has(event.paperId)) {
        addPositive(profile, event.paperId, learned);
      }
      impact = -IMPACT_NOT_INTERESTED;
      categoryImpact = -IMPACT_NOT_INTERESTED_CATEGORY;
      break;
    case 'openedPdf':
      countEngagement(profile, event, 'openedPdf', 0, now);
      impact = IMPACT_OPENED_PDF;
      break;
    case 'pdfBounce':
      impact = IMPACT_PDF_BOUNCE;
      break;
    case 'skip':
      countShown(profile, event);
      addViewed(profile, event.paperId, event.notable === true);
      recordExposure(profile, learned, false);
      impact = IMPACT_SKIP;
      break;
    case 'viewTime': {
      const seconds = Number(event.viewTime);
      if (!Number.isFinite(seconds) || seconds <= 0) return profile;
      countShown(profile, event);
      addViewed(profile, event.paperId, event.notable === true);
      // Judged against the median as it stood before this view moved it.
      const median = profile.dwell.median;
      impact = viewTimeImpact(seconds, median);
      recordExposure(profile, learned, seconds >= median);
      if (seconds >= median * STRONG_READ_RATIO && !curatedSet(profile, 'notInterested')!.members.has(event.paperId)) {
        addPositive(profile, event.paperId, learned);
      }
      observeDwell(profile.dwell, seconds);
      if (seconds >= LEAN_READ_SECONDS) profile.temporal.lean = leanAfterEngaging(profile.temporal.lean, event, LEAN_STEP.read, now);
      break;
    }
    case 'metadata':
      break;
    default:
      return profile;
  }

  if (impact !== null) {
    addImpact(profile, category, categoryImpact ?? impact, timestampMs);
    if (impact !== 0) {
      const concepts = usableConcepts(event.concepts);
      concepts.forEach((concept) => {
        addDecayedImpact(profile.concepts, concept.id, impact * conceptWeight(concept), timestampMs);
      });
      usableAuthorIds(event.authorIds).forEach((authorId) => {
        addDecayedImpact(profile.authors, authorId, impact, timestampMs);
      });
      recordSessionImpact(profile, category, categoryImpact ?? impact, concepts, impact);
    }
  }

  if (!alreadyAccountedFor) {
    profile.countedPapers.add(event.paperId);
    // One interaction document per paper, so a paper new to this profile means
    // one more document the aggregate now accounts for.
    profile.sourceDocCount += 1;
  }
  profile.counters.interactions += 1;
  profile.updatedAt = new Date(now).toISOString();
  compactCategories(profile, now);
  compactDecayed(profile.concepts, MAX_TRACKED_CONCEPTS, now);
  compactDecayed(profile.authors, MAX_TRACKED_AUTHORS, now);
  return profile;
}

/**
 * Category impact of one interaction document from its final state. The view
 * time's share depends on the median at the moment it was read, so the caller
 * computes it while replaying the history in order.
 */
function documentCategoryImpact(data: InteractionDocumentData, viewImpact: number) {
  let impact = viewImpact;
  if (data.liked) impact += IMPACT_LIKED;
  if (data.saved) impact += IMPACT_SAVED;
  if (data.openedPdf) impact += IMPACT_OPENED_PDF;
  if (data.skip) impact += IMPACT_SKIP;
  if (data.pdfBounce) impact += IMPACT_PDF_BOUNCE;
  if (data.notInterested) impact += IMPACT_NOT_INTERESTED_CATEGORY;
  return impact;
}

/**
 * The category an interaction document counts under. Beside the flag it kept
 * the category the card showed, which was often the one the feed had asked
 * for; a document that also kept the paper's copy says which value can be
 * trusted (`readStoredClassification`), so the copy decides (PAP-60).
 */
function documentCategory(id: string, data: InteractionDocumentData) {
  if (data.paper && typeof data.paper === 'object') return readStoredClassification({ ...data.paper, id }).primaryCategory;
  return typeof data.paperCategory === 'string' ? data.paperCategory : '';
}

// The area a document shows: its stored copy's, which only a like or a save
// keeps, or else its category's. A view or a skip of a card filed under no
// category shows none, so a rebuild cannot count it under its area.
function documentArea(id: string, data: InteractionDocumentData) {
  return areaKeyForPaper(data.paper && typeof data.paper === 'object'
    ? readStoredClassification({ ...data.paper, id })
    : { primaryCategory: documentCategory(id, data) });
}

/**
 * Rebuilds a profile from raw interaction documents. Used by the one-off client
 * fallback and by the offline backfill script, and it is the reference the unit
 * tests compare the incremental path against.
 *
 * @param {Array<{id: string, data: object}>} documents ordered newest first
 */
export function buildProfileFromInteractionDocuments(documents: Array<{ id: string; data: InteractionDocumentData; }>, { now = Date.now() } = {}) {
  const profile = createEmptyInteractionProfile();
  const viewImpacts = new Map<string, number>();

  // addCurated puts each id in front, which is newest first when events arrive
  // one by one. The documents come newest first, so they are replayed oldest
  // first: the newest ids end up in front and a cap evicts the oldest. The
  // dwell median, the exposure counts and the positive examples are built in
  // the same pass because each depends on what came before it.
  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const { id, data } = documents[index];
    if (typeof id !== 'string' || !id || !data) continue;
    if (data.liked) addCurated(profile, 'liked', id);
    if (data.saved) addCurated(profile, 'saved', id);
    if (data.read) addCurated(profile, 'read', id);
    if (data.notInterested) addCurated(profile, 'notInterested', id);
    if (data.readLater) addCurated(profile, 'readLater', id);

    const learned = learnedUnder(documentCategory(id, data), documentArea(id, data));
    const seconds = Number(data.viewTime);
    let strongRead = false;
    if (Number.isFinite(seconds) && seconds > 0) {
      const median = profile.dwell.median;
      addViewed(profile, id);
      viewImpacts.set(id, viewTimeImpact(seconds, median));
      recordExposure(profile, learned, seconds >= median);
      strongRead = seconds >= median * STRONG_READ_RATIO;
      observeDwell(profile.dwell, seconds);
    } else if (data.skip) {
      addViewed(profile, id);
      recordExposure(profile, learned, false);
    }
    if (!data.notInterested && (data.liked || data.saved || strongRead)) addPositive(profile, id, learned);
  }

  documents.forEach(({ id, data }) => {
    if (typeof id !== 'string' || !id || !data) return;
    profile.sourceDocCount += 1;

    const category = documentCategory(id, data);
    if (!category) return;

    // Mirror the full scan: a category seen at all exists, even at zero.
    categoryBucket(profile, category);

    // No timestamp meant an undecayed weight of 1, which is a cohort dated now.
    const timestampMs = toTimestampMs(data.timestamp) ?? now;
    addImpact(profile, category, documentCategoryImpact(data, viewImpacts.get(id) ?? 0), timestampMs);
  });

  documents.forEach(({ id }) => profile.countedPapers.add(id));
  profile.counters.interactions = profile.sourceDocCount;
  profile.updatedAt = new Date(now).toISOString();
  compactCategories(profile, now);
  return profile;
}

type SerializedDecayed = Record<string, [number, number]>;

function serializeDecayed(map: Map<string, DecayedAffinity>): SerializedDecayed {
  const serialized: SerializedDecayed = {};
  // Whole minutes are precision enough for a 30-day decay.
  map.forEach((entry, key) => {
    serialized[key] = [Number(entry.value.toPrecision(6)), Math.round(entry.at / MINUTE_MS)];
  });
  return serialized;
}

function weakestHalfRemoved(serialized: SerializedDecayed) {
  const kept = Object.entries(serialized)
    .sort((a, b) => Math.abs(b[1][0]) - Math.abs(a[1][0]))
    .slice(0, Math.floor(Object.keys(serialized).length / 2));
  return Object.fromEntries(kept);
}

// Each kind as [shown, engaged]; each paper as [id, like, save, openedPdf],
// a signal that did not count as 0 and one that did as [kind, epoch, lean],
// kind being 1 (notable), 0 (recent) or null (off the For You feed).
type SerializedEngagement = 0 | [number | null, number, number];
interface SerializedTemporal { n: [number, number]; r: [number, number]; lean: number; h: number; p: Array<[string, ...SerializedEngagement[]]>; }
const ENGAGEMENT_SIGNALS: EngagementSignal[] = ['like', 'save', 'openedPdf'];
const precise = (value: number) => Number(value.toPrecision(6));

function serializeTemporal(temporal: TemporalState): SerializedTemporal {
  const kind = ({ shown, engaged }: KindCounts): [number, number] => [precise(shown), precise(engaged)];
  return {
    n: kind(temporal.notable),
    r: kind(temporal.recent),
    lean: precise(temporal.lean),
    h: temporal.halvings,
    p: [...temporal.papers].map(([id, paper]) => [id, ...ENGAGEMENT_SIGNALS.map((signal): SerializedEngagement => {
      const counted = paper[signal];
      if (!counted) return 0;
      return [counted.notable === undefined ? null : Number(counted.notable), counted.epoch, precise(counted.lean)];
    })]),
  };
}

function serializeAffinities(profile: InteractionProfile) {
  const categories: Record<string, { c: Record<number, [number, number]>; a: number }> = {};
  profile.categories.forEach((bucket, category) => {
    const cohorts: Record<number, [number, number]> = {};
    bucket.cohorts.forEach((cohort, day) => {
      // Six significant digits keeps the payload small; the values feed a
      // ranking that is clamped and shuffled afterwards.
      cohorts[day] = [Number(cohort.weighted.toPrecision(6)), Number(cohort.raw.toPrecision(6))];
    });
    categories[category] = { c: cohorts, a: Number(bucket.aged.toPrecision(6)) };
  });
  const exposure: Record<string, [number, number]> = {};
  profile.exposure.forEach((entry, category) => {
    exposure[category] = [entry.shown, entry.engaged];
  });
  const payload = {
    categories,
    concepts: serializeDecayed(profile.concepts),
    authors: serializeDecayed(profile.authors),
    exposure,
    dwell: Number(profile.dwell.median.toPrecision(6)),
    positives: profile.positives.map(example => [example.id, example.category]),
    temporal: serializeTemporal(profile.temporal),
  };
  let serialized = JSON.stringify(payload);
  // The oldest engaged papers go first, since concepts and authors move scores.
  // Losing one costs what a paper past MAX_ENGAGED_PAPERS costs: an unlike no
  // longer takes its count back, and a like after that counts again.
  while (serialized.length > MAX_AFFINITY_JSON_BYTES && payload.temporal.p.length > 0) {
    payload.temporal.p = payload.temporal.p.slice(Math.ceil(payload.temporal.p.length / 2));
    serialized = JSON.stringify(payload);
  }
  // Then concepts and authors, the part that can grow with use; the weakest go
  // first. The categories are left to the check below, as they always were.
  while (serialized.length > MAX_AFFINITY_JSON_BYTES
    && Object.keys(payload.concepts).length + Object.keys(payload.authors).length > 0) {
    payload.concepts = weakestHalfRemoved(payload.concepts);
    payload.authors = weakestHalfRemoved(payload.authors);
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

type CuratedPayload = Record<CuratedSetName, string[]> & { viewed?: string[]; viewedNotable?: string[] };

function trimCuratedToBudget(payload: CuratedPayload) {
  let serialized = JSON.stringify(payload);
  // The ring only spares a device one skip, and the notable cards one notable
  // card shown again, so they go before any set that keeps a paper out of the
  // feed, the ring first. What they drop is not sent to the filter.
  for (const list of ['viewed', 'viewedNotable'] as const) {
    while (serialized.length > MAX_CURATED_JSON_BYTES && payload[list]) {
      const kept = payload[list].slice(0, Math.floor(payload[list].length * 0.75));
      if (kept.length > 0) payload[list] = kept;
      else delete payload[list];
      serialized = JSON.stringify(payload);
    }
  }
  while (serialized.length > MAX_CURATED_JSON_BYTES) {
    const largest = CURATED_SETS
      .map(name => [name, payload[name].length] as const)
      .sort((a, b) => b[1] - a[1])[0];
    if (!largest || largest[1] === 0) break;
    // Drop the oldest quarter of the biggest set; the Bloom filter already
    // holds anything evicted, so the feed still cannot repeat these.
    payload[largest[0]] = payload[largest[0]].slice(0, Math.floor(largest[1] * 0.75));
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

/**
 * @returns {object} the Firestore document body.
 */
export function serializeInteractionProfile(profile: InteractionProfile): StoredInteractionProfile {
  const curatedPayload = {} as CuratedPayload;
  CURATED_SETS.forEach((name) => {
    curatedPayload[name] = curatedIds(profile, name);
  });
  if (profile.viewed.length > 0) curatedPayload.viewed = [...profile.viewed];
  if (profile.viewedNotable.length > 0) curatedPayload.viewedNotable = [...profile.viewedNotable];

  const curatedJson = trimCuratedToBudget(curatedPayload);
  // Everything the budget trimmer dropped has to reach the Bloom filter too.
  CURATED_SETS.forEach((name) => {
    const kept = new Set(curatedPayload[name]);
    curatedIds(profile, name).forEach((paperId) => {
      if (!kept.has(paperId)) {
        addSeenPaper(ensureSeenFilter(profile), paperId);
        profile.counters.evicted += 1;
      }
    });
  });

  const affinitiesJson = serializeAffinities(profile);
  if (affinitiesJson.length > MAX_AFFINITY_JSON_BYTES) {
    throw new RangeError(
      `Serialised affinities are ${affinitiesJson.length} bytes, over the ${MAX_AFFINITY_JSON_BYTES} budget.`,
    );
  }

  const document: StoredInteractionProfile = {
    schemaVersion: INTERACTION_PROFILE_SCHEMA_VERSION,
    updatedAt: profile.updatedAt || new Date().toISOString(),
    affinities: affinitiesJson,
    curated: curatedJson,
    interactionCount: profile.counters.interactions,
    evictedCount: profile.counters.evicted,
    sourceDocCount: profile.sourceDocCount,
    truncated: Boolean(profile.truncated),
  };

  const seenFilter = isSeenFilterEmpty(profile.seenFilter)
    ? null
    : serializeSeenFilter(profile.seenFilter);
  if (seenFilter) document.seenFilter = seenFilter;
  return document;
}

function deserializeDecayed(serialized: unknown, map: Map<string, DecayedAffinity>) {
  if (!serialized || typeof serialized !== 'object') return;
  Object.entries(serialized).forEach(([key, pair]) => {
    if (!Array.isArray(pair)) return;
    const value = Number(pair[0]);
    const minutes = Number(pair[1]);
    if (Number.isFinite(value) && Number.isFinite(minutes)) map.set(key, { value, at: minutes * MINUTE_MS });
  });
}

interface SerializedAffinities {
  categories?: Record<string, { c?: Record<string, unknown>; a?: number }>;
  concepts?: unknown; authors?: unknown; exposure?: Record<string, unknown>;
  dwell?: unknown; positives?: unknown; temporal?: unknown;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function storedKind(stored: unknown): KindCounts {
  return Array.isArray(stored) && isCount(stored[0]) && isCount(stored[1])
    ? { shown: stored[0], engaged: stored[1] }
    : { shown: 0, engaged: 0 };
}

function storedEngagement(stored: unknown, halvings: number): CountedEngagement | null {
  if (!Array.isArray(stored)) return null;
  const [kind, epoch, lean] = stored as unknown[];
  if (!(kind === null || kind === 0 || kind === 1) || !Number.isSafeInteger(epoch) || !isCount(epoch) || epoch > halvings) return null;
  if (typeof lean !== 'number' || !Number.isFinite(lean)) return null;
  const counted: CountedEngagement = { epoch, lean: clamp(lean, -1, 1) };
  if (kind !== null) counted.notable = kind === 1;
  return counted;
}

// The stored counts, lean and papers, or none for an aggregate written before
// them; a value out of range is dropped. Counts past TEMPORAL_HALVE_AT are
// halved here as well.
function storedTemporal(stored: unknown): TemporalState {
  const temporal = emptyTemporal();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return temporal;
  const { n, r, lean, h, p } = stored as Partial<Record<keyof SerializedTemporal, unknown>>;
  temporal.notable = storedKind(n);
  temporal.recent = storedKind(r);
  if (typeof lean === 'number' && Number.isFinite(lean)) temporal.lean = clamp(lean, -1, 1);
  if (Number.isSafeInteger(h) && isCount(h)) temporal.halvings = h;
  if (Array.isArray(p)) {
    p.slice(-MAX_ENGAGED_PAPERS).forEach((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0]) return;
      const paper: EngagedPaper = {};
      ENGAGEMENT_SIGNALS.forEach((signal, index) => {
        const counted = storedEngagement(entry[index + 1], temporal.halvings);
        if (counted) paper[signal] = counted;
      });
      if (Object.keys(paper).length > 0) temporal.papers.set(entry[0], paper);
    });
  }
  halveWhenFull(temporal);
  return temporal;
}

/**
 * @returns {object|null} null when the payload is missing, from another schema
 *   version or unparseable, which sends the caller down the rebuild path.
 */
export function deserializeInteractionProfile(data: Partial<StoredInteractionProfile> | null | undefined): InteractionProfile | null {
  if (!data || typeof data !== 'object') return null;
  if (data.schemaVersion !== INTERACTION_PROFILE_SCHEMA_VERSION) return null;

  const profile = createEmptyInteractionProfile();
  try {
    const affinities = JSON.parse(data.affinities || '{}') as SerializedAffinities;
    Object.entries(affinities.categories || {}).forEach(([category, bucket]) => {
      const cohorts = new Map<number, { weighted: number; raw: number }>();
      Object.entries(bucket?.c || {}).forEach(([day, pair]) => {
        if (!Array.isArray(pair)) return;
        cohorts.set(Number(day), { weighted: Number(pair[0]) || 0, raw: Number(pair[1]) || 0 });
      });
      profile.categories.set(category, { cohorts, aged: Number(bucket?.a) || 0 });
    });
    deserializeDecayed(affinities.concepts, profile.concepts);
    deserializeDecayed(affinities.authors, profile.authors);
    Object.entries(affinities.exposure || {}).forEach(([category, pair]) => {
      if (!Array.isArray(pair)) return;
      const shown = Math.max(0, Math.floor(Number(pair[0]) || 0));
      const engaged = Math.min(shown, Math.max(0, Math.floor(Number(pair[1]) || 0)));
      if (shown > 0) profile.exposure.set(category, { shown, engaged });
    });
    const median = Number(affinities.dwell);
    if (affinities.dwell !== undefined && Number.isFinite(median)) {
      profile.dwell.median = clamp(median, DWELL_MEDIAN_MIN_SECONDS, DWELL_MEDIAN_MAX_SECONDS);
    }
    profile.temporal = storedTemporal(affinities.temporal);

    const curated = JSON.parse(data.curated || '{}') as Partial<Record<CuratedSetName | 'viewed' | 'viewedNotable', unknown[]>>;
    CURATED_SETS.forEach((name) => {
      const ids = Array.isArray(curated[name]) ? curated[name] : [];
      const set = curatedSet(profile, name);
      ids.forEach((paperId) => {
        if (typeof paperId !== 'string' || !paperId || set!.members.has(paperId)) return;
        set!.members.add(paperId);
        set!.order.push(paperId);
      });
    });

    const storedIds = (ids: unknown[] | undefined, cap: number) => (Array.isArray(ids)
      ? [...new Set(ids.filter((paperId): paperId is string => typeof paperId === 'string' && paperId.length > 0))].slice(0, cap)
      : []);
    profile.viewed = storedIds(curated.viewed, MAX_VIEWED_IDS);
    profile.viewedNotable = storedIds(curated.viewedNotable, MAX_VIEWED_NOTABLE_IDS);

    if (Array.isArray(affinities.positives)) {
      profile.positives = capExamplesPerArea(affinities.positives
        .filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].length > 0)
        .map(([id, category]) => ({ id, category: typeof category === 'string' ? category : '' })));
    } else {
      // An aggregate written before the examples were kept: its likes and
      // saves are the examples, with no category on record for them.
      const liked = curatedIds(profile, 'liked');
      const saved = curatedIds(profile, 'saved');
      profile.positives = [...new Set([...liked, ...saved])]
        .slice(0, MAX_POSITIVE_EXAMPLES_PER_AREA)
        .map(id => ({ id, category: '' }));
    }
  } catch {
    return null;
  }

  profile.seenFilter = deserializeSeenFilter(data.seenFilter);
  profile.counters.interactions = Number(data.interactionCount) || 0;
  profile.counters.evicted = Number(data.evictedCount) || 0;
  profile.sourceDocCount = Number(data.sourceDocCount) || 0;
  profile.truncated = Boolean(data.truncated);
  profile.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  return profile;
}
