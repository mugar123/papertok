import type { Paper } from '../models/paper.ts';
import type { EntityMetrics, OpenAlexAuthor, OpenAlexInstitution, OpenAlexTopic } from '../services/adapters/open-alex-types.ts';

// An unknown section scores 99 in getSearchSectionOrder, so a section missing
// from here silently sinks to the bottom of every search forever.
const DEFAULT_SECTION_ORDER = ['papers', 'topics', 'authors', 'institutions', 'projects'];

/**
 * The words that make a piece of text an organisation.
 *
 * One list, because the two questions it answers are the same question asked
 * of different text: "is this query about an organisation?" and "is this
 * OpenAlex author actually an institution wearing an author's name?".
 *
 * Written against the output of `normalizeSearchText`, which has already
 * stripped accents and punctuation, so `universite` appears here as the stem
 * `universi` and never with its accent.
 *
 * Two halves, and the split is the whole safety argument:
 *
 * - STEMS, matched with a trailing `\w*`. One entry covers a family, including
 *   the German compounds a whole-token match cannot reach —
 *   "Universitätsklinikum Heidelberg" normalises to `universitatsklinikum`.
 *   `universi` stops short of `universal` and `universe`, neither of which
 *   carries the `i`; `laborat` has to reach `laboratoire`, which `laborator`
 *   does not, and the leading `\b` keeps it away from `collaborate`.
 * - WHOLE TOKENS, deliberately not stems. `clinical` and `academic` are
 *   ordinary words in half the queries this app sees, and a `clinic\w*` stem
 *   would turn every clinical-trial search into an institution search.
 *
 * DELIBERATELY ABSENT: collaboration, consortium, group, team, network. Those
 * name working groups, and a working group is a legitimate byline — "CMS
 * Collaboration" writes papers, "University of Salamanca" does not. Their
 * absence is what makes `isOrganisationAuthorRecord` safe, since an
 * organisation word is a NECESSARY condition there.
 */
const ORGANISATION_WORDS = /\b(?:(?:universi|institut|istitut|laborat|hochschul|klinik|politecnic|polytechni)\w*|(?:college|colegio|escuela|escola|ecole|schule|school|faculty|facultad|facultat|faculdade|faculte|hospital|hospitals|hospitalario|hospitalier|clinic|clinica|clinico|clinique|center|centers|centre|centres|centro|centros|zentrum|academy|academia|academie|akademie|council|consejo|conselho|conseil|society|sociedad|sociedade|societe|gesellschaft|foundation|fundacion|fundacio|fundacao|fondation|stiftung|museum|museo|musee|observatory|observatorio|observatoire|agency|agencia|agence|ministry|ministerio|ministere|ministerium|department|departamento|departement)\b)/;

const PROJECT_WORDS = /\b(?:project|projects|proyecto|proyectos|projeto|projet|projekt|grant|grants|horizon|horizonte|erc)\b/;

function getSearchQueryIntent(query: string = '') {
  const normalized = normalizeSearchText(query);
  if (ORGANISATION_WORDS.test(normalized) || /^[A-Z]{2,6}$/.test(query.trim())) return 'institutions';
  if (PROJECT_WORDS.test(normalized)) return 'projects';
  return null;
}

// Letters NFD leaves whole, folded to the letters typed without them as
// accents are: "Lukasz" finds "Łukasz", and "Arık" stays one word. The micro
// sign is the Greek mu that scientific titles mean by it.
const UNDECOMPOSED_LETTERS: Record<string, string> = {
  ı: 'i', ł: 'l', ø: 'o', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', æ: 'ae', œ: 'oe', ħ: 'h',
  ĳ: 'ij', ŀ: 'l', ŧ: 't', µ: 'μ',
};
const UNDECOMPOSED_LETTER = new RegExp(`[${Object.keys(UNDECOMPOSED_LETTERS).join('')}]`, 'g');

// Chinese, Japanese and the Southeast Asian scripts put no spaces between
// words, so a phrase in them can begin or end anywhere in a run of letters.
const UNSPACED = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]`;
const UNSPACED_RUN = new RegExp(`${UNSPACED}+(?: ${UNSPACED}+)*`, 'gu');
const STARTS_UNSPACED = new RegExp(`^${UNSPACED}`, 'u');
const ENDS_UNSPACED = new RegExp(`${UNSPACED}$`, 'u');
const boundaryBefore = (phrase: string) => (STARTS_UNSPACED.test(phrase) ? '' : ' ');
const boundaryAfter = (phrase: string) => (ENDS_UNSPACED.test(phrase) ? '' : ' ');

/**
 * Lowercase words of any script, split on everything else. Latin, Greek and
 * Cyrillic accents fold away; marks of other scripts stay.
 *
 * Modifier letters such as the ʿayn in "Saʿid" and the ʻokina in "Hawaiʻi"
 * separate words like the apostrophe readers type for them; tatweel and
 * variation selectors only change how a letter is drawn. A run of a script
 * written without spaces is one word: "LSTM预测" splits where the scripts
 * meet, and "山田 太郎" joins to "山田太郎".
 */
export function normalizeSearchText(value: unknown = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u0640]|\p{Variation_Selector}/gu, '')
    .toLowerCase()
    .replace(UNDECOMPOSED_LETTER, letter => UNDECOMPOSED_LETTERS[letter])
    .replace(/(?:[^\p{L}\p{M}\p{Nd}]|[\u00aa\u00ba\u02b0-\u02ff])+/gu, ' ')
    .replace(UNSPACED_RUN, run => ` ${run.replaceAll(' ', '')} `)
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Whole-word prefix on already-normalised text: "sam" does not start "samples". */
function startsWithPhrase(normalizedText: string, normalizedPhrase: string) {
  return `${normalizedText} `.startsWith(`${normalizedPhrase}${boundaryAfter(normalizedPhrase)}`);
}

/** Whole-word containment on already-normalised text: "sam" does not find "samples". */
function containsPhrase(normalizedText: string, normalizedPhrase: string) {
  return ` ${normalizedText} `.includes(`${boundaryBefore(normalizedPhrase)}${normalizedPhrase}${boundaryAfter(normalizedPhrase)}`);
}

/**
 * An OpenAlex "author" record that is really an institution.
 *
 * The authors index carries institution-as-author artifacts: a search for
 * "university of salamanca" answers with four records whose display_name IS
 * "University of Salamanca", each with a handful of works, no citations, no
 * ORCID and no institution. They score 100 as exact matches, which put them at
 * the top of the Authors section and — because an exact match also decides
 * which section leads — pushed the real institution to the bottom of the page.
 *
 * The organisation word is NECESSARY and is tested first, which is the entire
 * false-positive argument: the list above holds no group words, so no
 * collaboration can be dropped here whatever its other fields say. Below that
 * the rule stays conjunctive, because a missing ORCID is perfectly normal for
 * a real researcher and must never be evidence on its own:
 *
 *   an ORCID            -> a person. Buildings do not hold one.
 *   a known institution -> a person. The artifact IS the institution, so it has
 *                          no institution of its own to report.
 *
 * The token count catches the other shape of junk in that index: a record whose
 * display_name is an entire sentence naming several universities. It overrides
 * the identity fields, because no person is called a sentence — but it still
 * requires the organisation word, so a long collaboration byline survives it.
 */
export function isOrganisationAuthorRecord(author: Partial<OpenAlexAuthor> = {}) {
  const name = normalizeSearchText(author?.display_name);
  if (!name) return false;
  if (!ORGANISATION_WORDS.test(name)) return false;
  if (name.split(' ').length >= 12) return true;
  if (author?.orcid || author?.institution) return false;
  return true;
}

// Citations scaled clear of any believable works count, so works only ever
// decide between records whose citations already tied.
function prominenceWeight(record: EntityMetrics | null | undefined) {
  return (record?.cited_by_count || 0) * 1e6 + (record?.works_count || 0);
}

/**
 * Prominence as one number, for breaking a tie in `filterRelevantSearchResults`.
 *
 * Citations lead and works decide underneath them: an author with 4 000
 * citations is the one meant, and it would take a million papers to carry into
 * the citation digits. `dedupeAuthors` scores with the same idiom and the two
 * signals swapped, because it asks a different question — which record is the
 * fullest, not which person is the famous one.
 */
export function authorProminenceWeight(author: EntityMetrics) {
  return prominenceWeight(author);
}

/**
 * The same number, asked of a building.
 *
 * Deliberately the same arithmetic, because it is the same question — several
 * rows tied on text, which one did the reader mean? A search for "MIT" gets
 * six organisations carrying MIT as an acronym, all scoring exactly 100, and
 * Massachusetts Institute of Technology sitting seventh in ROR's own order,
 * below the slice.
 *
 * A ROR record on its own weighs 0 here and is meant to: `normalizeRorInstitution`
 * ships all three counting fields as null because ROR does not carry them, so
 * this is only a tie-break once something has filled them in. Un-enriched, every
 * institution weighs the same and the text order stands untouched.
 */
export function institutionProminenceWeight(institution: EntityMetrics) {
  return prominenceWeight(institution);
}

export function authorSearchValues(author: Partial<Pick<OpenAlexAuthor, 'display_name'>>) {
  const words = normalizeSearchText(author.display_name).split(' ');
  return [author.display_name, words.filter((word, index) => index === 0 || index === words.length - 1 || word.length > 1).join(' ')];
}

export function scoreSearchMatch(query: string|undefined, values: unknown[] = []) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  let bestScore = 0;

  values.forEach((value) => {
    const normalizedValue = normalizeSearchText(value);
    if (!normalizedValue) return;
    if (normalizedValue === normalizedQuery) {
      bestScore = Math.max(bestScore, 100);
      return;
    }
    if (startsWithPhrase(normalizedValue, normalizedQuery)) {
      bestScore = Math.max(bestScore, 94);
      return;
    }
    bestScore = Math.max(bestScore, approximatePhraseScore(normalizedQuery, normalizedValue));
    if (normalizedValue.includes(normalizedQuery)) {
      bestScore = Math.max(bestScore, 88);
      return;
    }

    const valueTokens = new Set(normalizedValue.split(' ').filter(Boolean));
    const matchedTokens = queryTokens.filter(token => valueTokens.has(token)).length;
    const coverage = matchedTokens / queryTokens.length;
    bestScore = Math.max(bestScore, Math.round(coverage * 70));
  });

  return bestScore;
}

export function withinOneEdit(left: string, right: string, minimumLength = 5, allowDigits = false) {
  if (left === right) return true;
  if (!(allowDigits ? /^[a-z0-9]+$/ : /^[a-z]+$/).test(left) || left.length < minimumLength || Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  while (i < Math.min(left.length, right.length) && left[i] === right[i]) i += 1;
  if (left.length === right.length) {
    return left.slice(i + 1) === right.slice(i + 1)
      || (left[i] === right[i + 1] && left[i + 1] === right[i]
        && left.slice(i + 2) === right.slice(i + 2));
  }
  return left.length > right.length
    ? left.slice(i + 1) === right.slice(i)
    : left.slice(i) === right.slice(i + 1);
}

/** Match adjacent words, allowing the final word to still be in progress. */
function approximatePhraseScore(query: string, value: string) {
  const words = query.split(' ');
  const target = value.split(' ');
  let best = 0;
  for (let start = 0; start + words.length <= target.length; start += 1) {
    let edits = 0;
    const matches = words.every((word, index) => {
      const candidate = target[start + index];
      if (word === candidate) return true;
      if (index === words.length - 1 && /^[\p{L}\p{M}]+$/u.test(word)
        && word.length >= (words.length > 1 ? 2 : 4) && candidate.startsWith(word)) return true;
      if (!withinOneEdit(word, candidate)) return false;
      edits += 1;
      return edits <= 2;
    });
    if (matches) best = Math.max(best, (edits ? 82 : 90) + 3 * words.length / target.length);
  }
  return best;
}

/**
 * How well a paper answers a query, title first.
 *
 * The providers already rank by their own relevance and the merged list keeps
 * that order for ties; what this adds is the one signal a reader typing a
 * title cares about and a full-text score keeps burying: whether the TITLE is
 * what was typed. "segment anything" used to answer with ten derivative
 * papers because "Segment anything in medical images" scores well on the
 * abstract too, and the paper called exactly that sat outside the slice.
 *
 * Runs on `normalizeSearchText`, so hyphens and case are gone before comparing:
 * "FC-CLIP", "fc clip" and "FC CLIP" are one query, "Llama-2" and "Llama 2"
 * one title, and a lone digit like the "2" is an ordinary token, matched as a
 * whole word rather than dropped as too short.
 *
 *   100  the title IS the query
 * 94-99  the title starts with the query ("Llama 2: Open Foundation...")
 * 88-93  the title contains the query as a phrase, whole words
 *    80  the abstract contains the query as a phrase -- how a paper known by
 *        an acronym its title never uses (FC-CLIP) still beats a title that
 *        only shares scattered words with the query
 * 82-87  a bounded approximate title phrase
 * 90-93  an unfinished title prefix
 *  0-70  the share of query tokens the title has, as words
 *
 * Inside the two phrase tiers the score rises with the share of the title the
 * query covers, so "near-exact" means what it says: of two titles that both
 * start with "Llama 2", the eight-word one is nearer the query than the
 * thirteen-word one. Measured live 2026-09-22: with a flat 94 the order fell
 * to whichever the provider sent first, and that was "Llama 2: Early Adopters'
 * Utilization of Meta's New Open-Source Pretrained Model" over the Llama 2
 * paper itself.
 */
export function scorePaperSearchMatch(query: string|undefined, paper: Partial<Paper> = {}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const title = normalizeSearchText(paper?.title);
  if (title === normalizedQuery) return 100;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const titleTokenList = title.split(' ').filter(Boolean);
  // Strictly below 1 for any title longer than the query, so a tier never
  // reaches the one above it.
  const coveredShare = titleTokenList.length > queryTokens.length
    ? queryTokens.length / titleTokenList.length
    : 0;
  if (startsWithPhrase(title, normalizedQuery)) return 94 + 5 * coveredShare;
  if (containsPhrase(title, normalizedQuery)) return 88 + 5 * coveredShare;
  if (queryTokens.some(token => /^[\p{L}\p{M}]{5,}$/u.test(token))
    && /^[\p{L}\p{M}]+$/u.test(queryTokens.at(-1)!)
    && title.startsWith(normalizedQuery)) return 90 + 3 * queryTokens.length / titleTokenList.length;
  const approximate = approximatePhraseScore(normalizedQuery, title);
  if (approximate) return approximate;

  const titleTokens = new Set(titleTokenList);
  const coverage = queryTokens.filter(token => titleTokens.has(token)).length / queryTokens.length;
  const tokenScore = Math.round(coverage * 70);

  const abstract = normalizeSearchText(paper?.abstract);
  if (abstract && containsPhrase(abstract, normalizedQuery)) return Math.max(tokenScore, 80);
  return tokenScore;
}

/**
 * Papers in the order a reader looking for one expects: the title match
 * first, and among equals the order the providers sent, so a source's own
 * relevance still decides between two titles that match alike. Nothing is
 * dropped here -- a paper found only through its abstract is still a result.
 */
export function rankPaperSearchResults<T extends Partial<Paper>>(query: string, papers: T[] = []) {
  return (papers || [])
    .map((paper, index) => ({ paper, index, score: scorePaperSearchMatch(query, paper) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map(match => match.paper);
}

/**
 * `getWeight` breaks ties, it does not create them: the text score decides
 * first and always. Without it `Array.prototype.sort` is stable, so every
 * result that matched equally well kept whatever order the provider sent —
 * which for OpenAlex authors means four one-paper records can sit above the
 * researcher everybody was looking for, all of them scoring exactly 100.
 */
export function filterRelevantSearchResults<T>(query: string, results: T[], getValues: (result: T) => unknown[], { minimumScore = 55, getWeight = null }: { minimumScore?: number; getWeight?: ((result: T) => number) | null } = {}) {
  const weigh = typeof getWeight === 'function' ? getWeight : null;
  return (results || [])
    .map((result, index) => ({
      result,
      index,
      score: scoreSearchMatch(query, getValues(result)),
      weight: weigh ? Number(weigh(result)) || 0 : 0,
    }))
    .filter(match => match.score >= minimumScore)
    // Text first, always: prominence decides between equals, it never buys a
    // worse match a better place. `index` last keeps the provider's own
    // relevance order for a genuine tie, in the comparator rather than resting
    // on the sort happening to be stable.
    .sort((a, b) => (b.score - a.score) || (b.weight - a.weight) || (a.index - b.index))
    .map(match => match.result);
}

/**
 * What an institution votes with, in one place.
 *
 * Three call sites read this list — the page, the palette, and the ROR search
 * itself — and they had already drifted apart once: the palette was missing
 * `acronyms`, so it could not see "USAL" on the Salamanca record. An acronym is
 * the ONLY way an acronym query can match at all, since "MIT" carries no
 * organisation word for the intent check to read.
 */
export function institutionSearchValues(institution: Partial<OpenAlexInstitution>) {
  return [
    institution.display_name,
    ...Object.values(institution.localized_names || {}),
    ...(institution.aliases || []),
    ...(institution.acronyms || []),
  ];
}

/**
 * The values each section votes with, in one place.
 *
 * The page and the palette used to build this separately and had drifted: the
 * palette left out `aliases` and `acronyms`, so it could not see "USAL" on the
 * Salamanca record — and an acronym is the only way an acronym search can win,
 * since "MIT" carries no organisation word for the intent check below to read.
 */
export function buildSearchSectionValues({
  papers = [],
  authors = [],
  institutions = [],
  topics = [],
  projects = [],
}: { papers?: Partial<Paper>[]; authors?: Partial<OpenAlexAuthor>[]; institutions?: Partial<OpenAlexInstitution>[]; topics?: Partial<OpenAlexTopic>[]; projects?: Array<{ acronym?: string | null; title?: string }> } = {}) {
  const clean = (values: unknown[]) => values.filter(Boolean);
  return {
    papers: clean(papers.map(paper => paper.title)),
    topics: clean(topics.flatMap(concept => [
      concept.display_name,
      concept.label,
      concept.label,
    ])),
    authors: clean(authors.flatMap(authorSearchValues)),
    institutions: clean(institutions.flatMap(institutionSearchValues)),
    projects: clean(projects.flatMap(project => [project.acronym, project.title])),
  };
}

export function resolvePreferredSearchSection({
  query,
  hint,
  sectionValues = {},
}: { query?: string; hint?: string | null; sectionValues?: Record<string, unknown[]> }) {
  const availableSections = new Set(
    Object.entries(sectionValues)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([section]) => section),
  );
  if (hint && availableSections.has(hint)) return hint;

  const normalizedQuery = normalizeSearchText(query);

  // What the WORDS of the query say it is about, read before the exact-match
  // sweep rather than after it.
  //
  // These two checks used to sit below the sweep, which made them dead code for
  // exactly the queries they were written for. "university of salamanca" always
  // found an exact match under `authors` — OpenAlex answers it with records
  // literally named that (see isOrganisationAuthorRecord) — so the sweep
  // returned 'authors' and execution never reached the institution rule. The
  // real university came 5th of 6.
  //
  // The intent does not short-circuit the sweep; it reorders it. An exact match
  // is still the strongest signal about WHICH result was meant. What the query's
  // wording decides is only who gets asked first when several sections can all
  // claim an exact match on the same string.
  const intent = getSearchQueryIntent(query);
  const organisationQuery = intent === 'institutions';
  const projectQuery = intent === 'projects';

  const exactPriority = organisationQuery
    ? ['institutions', 'topics', 'authors', 'projects', 'papers']
    : projectQuery
      ? ['projects', 'topics', 'authors', 'institutions', 'papers']
      : ['topics', 'authors', 'institutions', 'projects', 'papers'];

  const exactSection = exactPriority.find(section => (
    availableSections.has(section)
    && sectionValues[section].some(value => normalizeSearchText(value) === normalizedQuery)
  ));
  if (exactSection) return exactSection;

  // Same two intents again, now as the fallback they always were: nothing
  // matched exactly, so the wording is all there is to go on.
  if (organisationQuery && availableSections.has('institutions')) return 'institutions';
  if (projectQuery && availableSections.has('projects')) return 'projects';

  const closest = DEFAULT_SECTION_ORDER
    .filter(section => availableSections.has(section))
    .map(section => ({ section, score: scoreSearchMatch(query, sectionValues[section]) }))
    .sort((left, right) => right.score - left.score)[0];
  if (closest && closest.score >= 82) return closest.section;
  return DEFAULT_SECTION_ORDER.find(section => availableSections.has(section)) || null;
}

export function getSearchSectionOrder(section: string, preferredSection: string | null) {
  if (section === preferredSection) return 1;
  const defaultIndex = DEFAULT_SECTION_ORDER.indexOf(section);
  return defaultIndex === -1 ? 99 : 10 + defaultIndex;
}
