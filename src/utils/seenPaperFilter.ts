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
export const SEEN_FILTER_BITS = Math.ceil(
  (-SEEN_FILTER_CAPACITY * Math.log2(SEEN_FILTER_ERROR_RATE)) / Math.LN2 / 32,
) * 32;
export const SEEN_FILTER_HASHES = Math.ceil((Math.LN2 * SEEN_FILTER_BITS) / SEEN_FILTER_CAPACITY);

// Base64 length of the bit array plus headroom for the bucket count growing to
// the next multiple of 32. Rules reject anything larger.
export const MAX_SEEN_FILTER_CHARS = 120000;

const BASE64_CHUNK_BYTES = 0x8000;

function uint32ArrayToBase64(buckets) {
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

function base64ToUint32Array(encoded) {
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

export function addSeenPaper(filter, paperId) {
  if (!filter || typeof paperId !== 'string' || !paperId) return filter;
  filter.add(paperId);
  return filter;
}

export function hasSeenPaper(filter, paperId) {
  if (!filter || typeof paperId !== 'string' || !paperId) return false;
  return filter.test(paperId);
}

export function isSeenFilterEmpty(filter) {
  return !filter || filter.countBits() === 0;
}

/**
 * @returns {string|null} base64 payload, or null when the filter holds nothing
 *   worth storing. Callers must treat an oversized result as a bug, not clamp
 *   it: a truncated filter would start reporting false negatives.
 */
export function serializeSeenFilter(filter) {
  if (isSeenFilterEmpty(filter)) return null;
  const encoded = uint32ArrayToBase64(filter.buckets);
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
export function deserializeSeenFilter(encoded) {
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
