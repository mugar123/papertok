/**
 * Who actually failed when a search comes back incomplete, and how long the
 * outage is expected to last.
 *
 * The search page fans out to three different providers, and the banner used to
 * blame the wrong one: `institutions` comes from ROR and `projects` from
 * OpenAIRE, yet both could produce a sentence about OpenAlex — or, worse, the
 * page would announce that "the search is unavailable" while a list of results
 * sat right underneath it.
 *
 * This module holds the part of that decision that is pure: the section →
 * provider map, the summary of what went down, which filters it is true for,
 * and the wording of the wait. The component keeps the i18n and the rendering;
 * the caller supplies the rate-limit verdict, so nothing here has to import the
 * OpenAlex client.
 */

/** Which provider actually serves each search section. */
export const SECTION_SOURCES = Object.freeze({
  papers: 'openalex',
  authors: 'openalex',
  topics: 'openalex',
  institutions: 'ror',
  projects: 'openaire',
});

export const SOURCE_LABELS = Object.freeze({
  openalex: 'OpenAlex',
  ror: 'ROR',
  openaire: 'OpenAIRE',
});

/** Stable order, so a banner naming two providers never reshuffles them. */
const SOURCE_ORDER = ['openalex', 'ror', 'openaire'];

/**
 * What the banner has to say, as facts rather than sentences. Returns null when
 * there is nothing to report.
 *
 * `involvesOpenAlex` and `rateLimited` are deliberately separate: a plain
 * timeout on papers involves OpenAlex without OpenAlex having limited anything,
 * and the two deserve different sentences — only one of them can promise a
 * time.
 *
 * `rateLimited` comes from the caller's live verdict, not from counting failed
 * sections. That matters because `topics` falls back to local concepts in
 * silence, so a section count underreports an outage; it is why the old
 * `>= 2` heuristic needed papers *and* authors to agree before naming anyone.
 *
 * The wait is returned as `retryAtMs`, an absolute instant. A duration frozen
 * at render time stops being true a second later; an instant lets the caller
 * recompute what is left whenever it repaints.
 */
export function describeSearchOutage({
  sections = [],
  rateLimited = false,
  retryAfterMs = 0,
  now = Date.now(),
} = {}) {
  const failedSections = sections.filter(section => section in SECTION_SOURCES);
  const affected = new Set(failedSections.map(section => SECTION_SOURCES[section]));
  if (rateLimited) affected.add('openalex');

  const sources = SOURCE_ORDER.filter(source => affected.has(source));
  if (sources.length === 0) return null;

  const sectionsBySource = {};
  for (const source of sources) {
    sectionsBySource[source] = failedSections
      .filter(section => SECTION_SOURCES[section] === source);
  }

  const usableRetry = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  return {
    sources,
    sectionsBySource,
    sections: failedSections,
    involvesOpenAlex: affected.has('openalex'),
    rateLimited: Boolean(rateLimited),
    retryAtMs: rateLimited && usableRetry ? now + retryAfterMs : null,
  };
}

/**
 * Whether the outage is still true for the view being looked at. Switching to
 * the Papers pill during an OpenAlex outage must keep the notice — it is
 * exactly the pill it describes — while the Users pill never matches, because
 * people come from Firestore and no provider here serves them.
 */
export function outageAffectsFilter(outage, filter) {
  if (!outage) return false;
  if (filter === 'all') return true;
  const source = SECTION_SOURCES[filter];
  return Boolean(source) && outage.sources.includes(source);
}

/**
 * The wait, in the coarsest unit that still tells the truth ("~45 s", "~15 min",
 * "~8 h"). The units read the same in both languages, so this needs no locale.
 *
 * Returns null when there is no figure to show — the banner then omits the
 * sentence rather than inventing an estimate.
 */
export function formatRetryDelay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `~${Math.max(1, seconds)} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes} min`;

  return `~${Math.round(minutes / 60)} h`;
}

/**
 * "OpenAIRE", "ROR y OpenAIRE", "papers, autores e instituciones".
 *
 * Spanish swaps `y` for `e` before a word that begins with the i sound (i-,
 * hi-), which is precisely the case here: "autores e instituciones". The
 * exception is a diphthong — "hielo", "hierro" — which keeps `y`.
 */
export function joinNames(words, isEnglish = false) {
  const list = (words || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];

  const last = list[list.length - 1];
  const conjunction = isEnglish ? 'and' : spanishAndFor(last);
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${last}`;
}

function spanishAndFor(nextWord) {
  const normalized = String(nextWord)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/^hie/.test(normalized)) return 'y';
  return /^(i|hi)/.test(normalized) ? 'e' : 'y';
}
