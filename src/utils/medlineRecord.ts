/**
 * What the two readers of MEDLINE records, the PubMed adapter (esummary) and
 * the Europe PMC search mapper, need beyond the type a record gives itself.
 */

// Methods in Molecular Biology is a book series of laboratory protocols.
// PubMed and Europe PMC file it as a journal and type its chapters "Journal
// Article" (133 of the 139 chapters in the 2026-10-20 audit), so only the
// series identifiers say what these records are: the print and electronic
// ISSN and the NLM catalogue ID.
const PROTOCOL_SERIES_ISSNS = new Set(['1064-3745', '1940-6029']);
const PROTOCOL_SERIES_NLM_IDS = new Set(['9214969']);

export function isProtocolBookSeries(journal: { issn?: string; essn?: string; nlmId?: string } | undefined) {
  return [journal?.issn, journal?.essn].some(issn => PROTOCOL_SERIES_ISSNS.has(String(issn || '').trim()))
    || PROTOCOL_SERIES_NLM_IDS.has(String(journal?.nlmId || '').trim());
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Whether a provider's date begins after today (UTC). A date is read from the
 * start of the period it names, so on 20 October "2026 Oct" has begun and
 * "2026 Nov" and "2027" have not. Reads Europe PMC's `2027-01-01` and
 * PubMed's `2027 Jan 15`; a date it cannot read is not after today.
 */
export function isAfterToday(date: string | number | undefined) {
  const match = /^(\d{4})(?:[-/ ](\d{1,2}|[a-z]{3})[a-z]*(?:[-/ ](\d{1,2}))?)?/i.exec(String(date ?? '').trim());
  if (!match) return false;
  const [, year, monthText, day] = match;
  const month = !monthText ? 1 : /^\d/.test(monthText) ? Number(monthText) : MONTHS.indexOf(monthText.toLowerCase()) + 1;
  const start = [year, String(month || 1).padStart(2, '0'), String(Number(day) || 1).padStart(2, '0')].join('-');
  return start > new Date().toISOString().slice(0, 10);
}
