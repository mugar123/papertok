export const REPORT_OPENALEX_FIELDS = Object.freeze({
  physics: ['31'],
  cs: ['17'],
  math: ['26'],
  stat: ['18', '26'],
  econ: ['20'],
  'q-fin': ['20'],
  eess: ['22'],
  mech: ['22'],
  civil: ['22'],
  chemeng: ['15'],
  med: ['24', '27', '28', '29', '30', '35', '36'],
  bio: ['11', '13', '24'],
});

function unique(values) {
  return [...new Set(values)];
}

export function normalizeReportFilters(filters = {}) {
  return {
    categories: unique((filters.categories || [])
      .filter(category => REPORT_OPENALEX_FIELDS[category]))
      .sort(),
    countries: unique((filters.countries || [])
      .map(country => String(country).toUpperCase())
      .filter(country => /^[A-Z]{2}$/.test(country)))
      .sort(),
  };
}

export function buildOpenAlexTrendFilter(period, filters = {}) {
  const normalized = normalizeReportFilters(filters);
  const clauses = [
    `from_publication_date:${period.fromStr}`,
    `to_publication_date:${period.toStr}`,
    'type:article',
  ];
  const fields = unique(normalized.categories.flatMap(category => REPORT_OPENALEX_FIELDS[category]));
  if (fields.length > 0) clauses.push(`primary_topic.field.id:${fields.join('|')}`);
  if (normalized.countries.length > 0) {
    clauses.push(`authorships.institutions.country_code:${normalized.countries.join('|')}`);
  }
  return clauses.join(',');
}
