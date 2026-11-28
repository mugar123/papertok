/**
 * The limits of what For you keeps of the reader's publications (ENG-251),
 * apart from publication-seeds.ts so the Firestore module and the rules tests
 * read them without loading the taxonomy.
 */

/** How many publications the feed ranks by at most: the Worker looks up 10 examples it lacks. */
export const PUBLICATION_SEEDS_MAX = 10;

/**
 * How many names of the reader's works the account keeps to leave them out of
 * For you: about three for each of the 300 works My profile lists
 * (ORCID_LISTED_WORKS_MAX), with room for the works the reader added.
 */
export const OWN_WORK_KEYS_MAX = 1000;
