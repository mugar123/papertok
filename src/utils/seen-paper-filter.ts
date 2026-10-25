/**
 * Overflow filter for the "already seen" paper set.
 *
 * The recommendation aggregate keeps an exact, enumerable list of the papers a
 * user acted on, because those ids drive visible UI (the filled heart, the
 * Favorites list, the reading history). That list is capped so the aggregate
 * document can never approach Firestore's 1 MiB document limit. Whatever falls
 * out of the cap lands here instead: a Bloom filter answers "have I already
 * shown this?" in constant space, and its only error mode is a false positive,
 * which costs the user one unseen paper they will never notice. False negatives
 * are impossible, so an evicted paper can never come back around the feed.
 *
 * The upstream library is pure ESM with no dependencies and touches nothing but
 * ArrayBuffer and typed arrays, so the same code runs in the browser without
 * Node polyfills and under `node --test`.
 */
import { BloomFilter } from 'bloomfilter';

// Sized for ~1% false positives at 50k evicted papers:
//   m = ceil(-n * log2(p) / ln2) = 479_253 bits, rounded up to a 32-bit bucket
//   k = ceil(ln2 * m / n)        = 7 hash functions
// which serialises to 14_977 buckets -> 59_908 bytes -> 79_880 base64 chars.
export const SEEN_FILTER_CAPACITY = 50000;
export const SEEN_FILTER_ERROR_RATE = 0.01;
const bitsFor = (capacity: number) => Math.ceil((-capacity * Math.log2(SEEN_FILTER_ERROR_RATE)) / Math.LN2 / 32) * 32;
export const SEEN_FILTER_BITS = bitsFor(SEEN_FILTER_CAPACITY);
export const SEEN_FILTER_HASHES = Math.ceil((Math.LN2 * SEEN_FILTER_BITS) / SEEN_FILTER_CAPACITY);

// The papers a feed request says the reader has seen, so the corpus can offer
// notable papers they have not and walk its ranking past the ones they have
// (worker/paper-store.ts). Sized for 2,000 ids at 1% false positives: 19,200
// bits, 7 hashes, 3,200 base64 characters whatever it holds. A false positive
// passes over an unseen paper; the filter never offers a seen one. Past its
// capacity the rate climbs fast (about 6% at 3,000 ids, 29% at 5,000), so a
// request holds only the 2,000 most recent ids (`feedSeenIds`): the last 500
// viewed, up to 1,200 viewed notable cards and the session's pages. The corpus
// sends a paper the reader saw before those as unseen when its walk reaches
// it: the app passes over it and makes it the newest (`markSeenLatest`), so
// the next request holds it, and the walks after that start past it.
const FEED_SEEN_CAPACITY = 2000;
const FEED_SEEN_BITS = bitsFor(FEED_SEEN_CAPACITY);
const FEED_SEEN_HASHES = Math.ceil((Math.LN2 * FEED_SEEN_BITS) / FEED_SEEN_CAPACITY);

// Base64 length of the bit array plus headroom for the bucket count growing to
// the next multiple of 32. Rules reject anything larger.
export const MAX_SEEN_FILTER_CHARS = 120000;

const BASE64_CHUNK_BYTES = 0x8000;

function uint32ArrayToBase64(buckets: Uint32Array) {
  const bytes = new Uint8Array(buckets.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < buckets.length; index += 1) {
    // Little endian explicitly: the same profile has to decode identically on
    // whatever device the user next opens the feed on.
    view.setUint32(index * 4, buckets[index] >>> 0, true);
  }

  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function base64ToUint32Array(encoded: string) {
  const binary = atob(encoded);
  if (binary.length % 4 !== 0) {
    throw new RangeError('Serialised seen filter is not a whole number of 32-bit buckets.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(bytes.buffer);
  const buckets = new Uint32Array(binary.length / 4);
  for (let index = 0; index < buckets.length; index += 1) {
    buckets[index] = view.getUint32(index * 4, true);
  }
  return buckets;
}

export function createSeenFilter() {
  return new BloomFilter(SEEN_FILTER_BITS, SEEN_FILTER_HASHES);
}

export function addSeenPaper(filter: BloomFilter | null | undefined, paperId: unknown) {
  if (!filter || typeof paperId !== 'string' || !paperId) return filter;
  filter.add(paperId);
  return filter;
}

export function hasSeenPaper(filter: BloomFilter | null | undefined, paperId: unknown) {
  if (!filter || typeof paperId !== 'string' || !paperId) return false;
  return filter.test(paperId);
}

export function isSeenFilterEmpty(filter: BloomFilter | null | undefined) {
  return !filter || filter.countBits() === 0;
}

/**
 * @returns {string|null} base64 payload, or null when the filter holds nothing
 *   worth storing. Callers must treat an oversized result as a bug, not clamp
 *   it: a truncated filter would start reporting false negatives.
 */
export function serializeSeenFilter(filter: BloomFilter | null | undefined): string|null {
  if (isSeenFilterEmpty(filter)) return null;
  const encoded = uint32ArrayToBase64(filter!.buckets);
  if (encoded.length > MAX_SEEN_FILTER_CHARS) {
    throw new RangeError(
      `Serialised seen filter is ${encoded.length} chars, over the ${MAX_SEEN_FILTER_CHARS} budget.`,
    );
  }
  return encoded;
}

/**
 * @returns {BloomFilter|null} null when the payload is missing, oversized or
 *   corrupt. A null filter degrades to "nothing evicted yet", which is the same
 *   state every user starts in, so a bad payload can never hide the whole feed.
 */
export function deserializeSeenFilter(encoded: unknown): BloomFilter|null {
  if (typeof encoded !== 'string' || !encoded) return null;
  if (encoded.length > MAX_SEEN_FILTER_CHARS) return null;
  try {
    const buckets = base64ToUint32Array(encoded);
    if (buckets.length === 0) return null;
    const filter = new BloomFilter(buckets, SEEN_FILTER_HASHES);
    return filter.m === SEEN_FILTER_BITS ? filter : null;
  } catch {
    return null;
  }
}

/**
 * The ids a feed request holds, from `paperIds` listed oldest first: the
 * `FEED_SEEN_CAPACITY` most recent. A caller that checks the corpus's answer
 * against the papers sent must use these ids, not every id the reader has seen.
 */
export function feedSeenIds(paperIds: Iterable<string>) {
  return [...paperIds].slice(-FEED_SEEN_CAPACITY);
}

/** The seen papers' ids as a feed request carries them (`seen`). */
export function feedSeenFilter(paperIds: Iterable<string>) {
  const filter = new BloomFilter(FEED_SEEN_BITS, FEED_SEEN_HASHES);
  for (const paperId of feedSeenIds(paperIds)) addSeenPaper(filter, paperId);
  return uint32ArrayToBase64(filter.buckets);
}

// The characters `btoa` writes; `atob` would also take whitespace.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A feed request's `seen`, or null when it is not a filter `feedSeenFilter` wrote. */
export function readFeedSeenFilter(encoded: unknown): BloomFilter|null {
  if (typeof encoded !== 'string' || encoded.length > MAX_SEEN_FILTER_CHARS || !BASE64.test(encoded)) return null;
  try {
    const buckets = base64ToUint32Array(encoded);
    return buckets.length * 32 === FEED_SEEN_BITS ? new BloomFilter(buckets, FEED_SEEN_HASHES) : null;
  } catch {
    return null;
  }
}
