// `users` sits second, and being in this list at all is the point: an unknown
// section scores 99 in getSearchSectionOrder, so a section missing from here
// silently sinks to the bottom of every search forever.
//
// Second rather than first because a non-empty users section is not on its own
// evidence that somebody was looking for a person — a two-letter prefix matches
// by accident — and first would put strangers above the literature on every
// search. The cases where the intent IS a person are caught above, by exact
// match and by the @ sigil.
const DEFAULT_SECTION_ORDER = ['papers', 'users', 'topics', 'authors', 'institutions', 'projects'];

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

export function normalizeSearchText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
export function isOrganisationAuthorRecord(author = {}) {
  const name = normalizeSearchText(author?.display_name);
  if (!name) return false;
  if (!ORGANISATION_WORDS.test(name)) return false;
  if (name.split(' ').length >= 12) return true;
  if (author?.orcid || author?.institution) return false;
  return true;
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
export function authorProminenceWeight(author) {
  return (author?.cited_by_count || 0) * 1e6 + (author?.works_count || 0);
}

export function scoreSearchMatch(query, values = []) {
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
    if (normalizedValue.startsWith(`${normalizedQuery} `)) {
      bestScore = Math.max(bestScore, 94);
      return;
    }
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

/**
 * `getWeight` breaks ties, it does not create them: the text score decides
 * first and always. Without it `Array.prototype.sort` is stable, so every
 * result that matched equally well kept whatever order the provider sent —
 * which for OpenAlex authors means four one-paper records can sit above the
 * researcher everybody was looking for, all of them scoring exactly 100.
 */
export function filterRelevantSearchResults(
  query,
  results,
  getValues,
  { minimumScore = 55, getWeight = null } = {},
) {
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
 * The values each section votes with, in one place.
 *
 * The page and the palette used to build this separately and had drifted: the
 * palette left out `aliases` and `acronyms`, so it could not see "USAL" on the
 * Salamanca record — and an acronym is the only way an acronym search can win,
 * since "MIT" carries no organisation word for the intent check below to read.
 */
export function buildSearchSectionValues({
  papers = [],
  users = [],
  authors = [],
  institutions = [],
  topics = [],
  projects = [],
} = {}) {
  const clean = values => values.filter(Boolean);
  return {
    // Both fields: an exact handle and an exact display name are each the
    // strongest evidence available that a person was meant.
    users: clean(users.flatMap(person => [person.handle, person.name])),
    papers: clean(papers.map(paper => paper.title)),
    topics: clean(topics.flatMap(concept => [
      concept.display_name,
      concept.label,
      concept.labelEs,
      concept.labelEn,
    ])),
    authors: clean(authors.map(author => author.display_name)),
    institutions: clean(institutions.flatMap(institution => [
      institution.display_name,
      ...Object.values(institution.localized_names || {}),
      ...(institution.aliases || []),
      ...(institution.acronyms || []),
    ])),
    projects: clean(projects.flatMap(project => [project.acronym, project.title])),
  };
}

export function resolvePreferredSearchSection({
  query,
  hint,
  sectionValues = {},
}) {
  const availableSections = new Set(
    Object.entries(sectionValues)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([section]) => section),
  );
  if (hint && availableSections.has(hint)) return hint;

  // A leading @ is a statement of intent no scoring can improve on: nobody
  // types "@" looking for a paper. Checked on the raw query, because
  // normalizeSearchText strips the sigil along with every other symbol.
  if (availableSections.has('users') && /^\s*@/.test(String(query || ''))) return 'users';

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
  const organisationQuery = ORGANISATION_WORDS.test(normalizedQuery);
  const projectQuery = PROJECT_WORDS.test(normalizedQuery);

  // `users` leads in every variant: an exact match on a handle or a display
  // name is the strongest signal available that a person was meant, stronger
  // than a paper whose title happens to be the same words — and a handle that
  // matches "university of salamanca" word for word is not a real collision.
  const exactPriority = organisationQuery
    ? ['users', 'institutions', 'topics', 'authors', 'projects', 'papers']
    : projectQuery
      ? ['users', 'projects', 'topics', 'authors', 'institutions', 'papers']
      : ['users', 'topics', 'authors', 'institutions', 'projects', 'papers'];

  const exactSection = exactPriority.find(section => (
    availableSections.has(section)
    && sectionValues[section].some(value => normalizeSearchText(value) === normalizedQuery)
  ));
  if (exactSection) return exactSection;

  // Same two intents again, now as the fallback they always were: nothing
  // matched exactly, so the wording is all there is to go on.
  if (organisationQuery && availableSections.has('institutions')) return 'institutions';
  if (projectQuery && availableSections.has('projects')) return 'projects';

  return DEFAULT_SECTION_ORDER.find(section => availableSections.has(section)) || null;
}

export function getSearchSectionOrder(section, preferredSection) {
  if (section === preferredSection) return 1;
  const defaultIndex = DEFAULT_SECTION_ORDER.indexOf(section);
  return defaultIndex === -1 ? 99 : 10 + defaultIndex;
}
