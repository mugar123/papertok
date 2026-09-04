/**
 * What an entity's page is going to look like, decided from the route before a
 * single byte of data arrives.
 *
 * The Explorer served one skeleton to every kind of entity, and the three pages
 * it stands in for are not the same page. An author has no Authors tab and
 * carries an ORCID card; an institution has both a second tab and a Wikipedia
 * block; a project has neither. The single skeleton showed two tabs always —
 * a promise the author and project pages then broke — and reserved nothing for
 * the block below the stats, so the paper list dropped 177px on an author and
 * 242px on an institution the moment the real header replaced it.
 *
 * The route knows all of this before the fetch resolves. `type` is in the URL.
 */

/**
 * Whether the page carries an Authors tab beside Papers.
 *
 * The one place this is decided, called by both the live tab strip and the
 * skeleton that stands in for it — the alternative is two copies of the test,
 * which is exactly how the skeleton came to promise a tab the page would not
 * render.
 *
 * `entity` is optional because the skeleton has to answer this question before
 * there is one. Only the topic types can be narrowed by it: a topic that is a
 * local or free-text query has no author index behind it, and that flag does
 * not exist until the entity resolves. Everything else is decided by `type`.
 */
export function hasAuthorsTab(type, entity = null) {
  // A project's papers come from OpenAIRE, which indexes participants rather
  // than authors — so despite being an organisation-shaped page like an
  // institution, it has no Authors tab either.
  if (type === 'author' || type === 'project') return false;
  if (entity?._localTopic || entity?._queryTopic) return false;
  return true;
}

/**
 * The blocks the loading skeleton should reserve for an entity of this type.
 *
 * - `identity` — the strip under the name: an author's research topics, an
 *   institution's ROR credentials and its related-organisation chips.
 * - `aside` — the block between the stats and the tabs, which is where the two
 *   page shapes differ most: an author's ORCID card, an institution's
 *   Wikipedia paragraph. A project has no block it always carries, so it
 *   reserves none rather than inventing one.
 */
export function explorerSkeletonShape(type) {
  const authorish = type === 'author';
  const institutionish = type === 'institution';
  return {
    tabs: hasAuthorsTab(type) ? 2 : 1,
    identity: authorish ? 'topics' : institutionish ? 'credentials' : 'none',
    aside: authorish ? 'orcid' : institutionish ? 'wiki' : 'none',
    // Every type the Explorer serves can be followed — `followEntity` covers
    // author, institution, project, concept and topic — so the button is part
    // of the spine, not of a variant.
    follow: true,
  };
}
