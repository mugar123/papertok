/**
 * MeSH "check tags": the descriptors NLM indexers add to almost every record
 * to say who or what was studied — sex, age group, humans or animals, the
 * model organism, pregnancy, the historical period. They are metadata about
 * the study, not what the paper is about, and they were the first chips of
 * most PubMed cards ("Humans", "Female": 47 of 57 records with MeSH led with
 * one; audit 2026-09-23, issue 7).
 */
const CHECK_TAGS = new Set([
  'humans', 'animals', 'male', 'female', 'pregnancy',
  'infant, newborn', 'infant', 'child, preschool', 'child', 'adolescent',
  'young adult', 'adult', 'middle aged', 'aged', 'aged, 80 and over',
  'cats', 'cattle', 'chick embryo', 'cricetinae', 'dogs', 'guinea pigs',
  'horses', 'mice', 'rabbits', 'rats', 'sheep', 'swine',
  'history, ancient', 'history, medieval',
].map(tag => tag.toLowerCase()));
const HISTORY_CENTURY = /^history, \d{1,2}(?:st|nd|rd|th) century$/;

export function isMeshCheckTag(name) {
  const normalized = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return CHECK_TAGS.has(normalized) || HISTORY_CENTURY.test(normalized);
}

/**
 * Descriptor names in the order a card should show them: the record's major
 * topics first, then the rest, each group in the record's own order, without
 * check tags or repeats.
 */
export function orderMeshDescriptors(descriptors) {
  const kept = (Array.isArray(descriptors) ? descriptors : [])
    .filter(descriptor => descriptor?.name && !isMeshCheckTag(descriptor.name));
  const seen = new Set();
  return [...kept.filter(descriptor => descriptor.major), ...kept.filter(descriptor => !descriptor.major)]
    .map(descriptor => descriptor.name)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
