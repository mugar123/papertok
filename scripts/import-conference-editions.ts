import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConferenceDeadline, ConferenceEdition, ConferenceFormat, ConferenceVenue } from '../src/data/conferences.ts';

const fields = {
  'cs-ai': 'cs',
  mathematics: 'math',
  'economics-finance': 'economics',
  physics: 'physics',
  medicine: 'medicine',
  biology: 'biology',
  statistics: 'statistics',
  engineering: 'engineering',
  chemistry: 'chemistry',
} as const;

function text(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function https(value: unknown): value is string {
  const url = text(value) ? URL.parse(value) : null;
  return url?.protocol === 'https:' && !url.username && !url.password;
}

function slugOf(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The venue, undefined when the row has none, or null when the row's value is not usable. */
function venueOf(value: unknown): ConferenceVenue | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return null;
  const { name, url } = value as Record<string, unknown>;
  if (!text(name)) return null;
  if (url === undefined || url === null) return { name: name.trim() };
  return https(url) ? { name: name.trim(), url: withoutTracking(url) } : null;
}

/** The deadlines in date order, undefined when the row has none, or null when one is not usable. */
function deadlinesOf(value: unknown): ConferenceDeadline[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const deadlines: ConferenceDeadline[] = [];
  for (const item of value as unknown[]) {
    const { label, date } = (item ?? {}) as Record<string, unknown>;
    if (!text(label) || !iso(date)) return null;
    deadlines.push({ label: label.trim(), date });
  }
  return deadlines.length ? deadlines.sort((a, b) => a.date.localeCompare(b.date)) : undefined;
}

const onlineOnly = /^(?:fully\s+)?(?:online|virtual)(?:\s+(?:event|conference|meeting|only|via\s+.+))?$/i;
const onlineTail = /(?:^|[\s,&·/(–-]+)(?:in[ -]person\s+)?(?:(?:and|or)\s+)?(?:fully\s+)?(?:hybrid|online|virtual(?:ly)?)\s*\)?$/i;
const onlineWord = /\b(?:hybrid|online|virtual(?:ly)?)\b/i;
const hybridNote = /\b(?:hybrid conference|partially hybrid|also offered virtually|online attendance is available|virtual option)\b/i;

/** A sentence that denies an online side is not evidence of one. */
function notesSayHybrid(notes: unknown) {
  return text(notes) && notes.split(/[.;]/).some(sentence => hybridNote.test(sentence) && !/\b(?:no|not|without|neither)\b|n['’]t\b/i.test(sentence));
}

/** Editions whose own words say hybrid although their row says "online": false. */
const verifiedHybrid: ReadonlySet<string> = new Set(['ecosta-2027']);

const verifiedSites: Readonly<Record<string, string>> = {
  'aiche-2027': 'https://www.aiche.org/conferences/aiche-annual-meeting/2027',
  asce2027: 'https://www.asce.org/asce2027',
  'cshl-the-biology-of-genomes-2027': 'https://meetings.cshl.edu/meetings.aspx?meet=GENOME',
  'emi-2027': 'https://2027.emi-conference.org/',
  'eshg-2027': 'https://2027.eshg.org/',
  'ewri-modeling-confluence-conference-2027': 'https://www.asce.org/education-and-events/events/meetings/ewri-modeling-confluence-conference',
  'ga4gh-connect-2027': 'https://www.ga4gh.org/event/april-connect-2027/',
  'gcc-2027': 'https://galaxyproject.org/events/gcc2027/',
  'jsm-2027': 'https://ww2.amstat.org/meetings/jsm/2027/',
  'pipelines-2027': 'https://www.pipelinesconference.org/',
  'psb-2027': 'https://psb.stanford.edu/',
  'scitech-2027': 'https://scitech.aiaa.org/',
};

function withoutTracking(link: string) {
  const url = new URL(link);
  if (!url.searchParams.has('trk')) return link;
  url.searchParams.delete('trk');
  return url.href;
}

export function convertConferenceEdition(value: unknown, inputField: keyof typeof fields): ConferenceEdition | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const { series, acronym, edition, startsOn, endsOn, dateText, city, country, placeText: sourcePlace, online, url, sourceUrl, sourceLicense, checkedOn, notes } = row;
  const venue = venueOf(row.venue);
  const deadlines = deadlinesOf(row.deadlines);
  if (row.field !== inputField || !text(series) || !text(edition) || !/\b202[67]\b/.test(edition)
    || !https(url) || !https(sourceUrl) || !iso(checkedOn)
    || ![acronym, dateText, city, country, sourcePlace, notes].every(item => item === null || text(item))
    || !(typeof online === 'boolean' || online === null) || venue === null || deadlines === null) return null;
  if ([url, sourceUrl].some(link => new URL(link).pathname === '/Xplore/guesthome.jsp')) return null;
  if (startsOn !== null && (!iso(startsOn) || startsOn < '2026-12-01' || startsOn > '2027-12-31')) return null;
  if (endsOn !== null && (!iso(endsOn) || !iso(startsOn) || endsOn < startsOn)) return null;
  const source = sourceLicense === 'MIT (ccf-deadlines)' ? 'ccf'
    : sourceLicense === 'CC BY 4.0 (databio/conferences)' ? 'databio' : undefined;
  if (!source && sourceLicense !== 'official-site') return null;
  const year = edition.match(/\b202[67]\b/)?.[0];
  const base = (text(acronym) ? acronym : series).trim().replace(/ \? /g, ' – ');
  const urlHost = new URL(url).hostname;
  if (!year || !slugOf(base)) return null;
  const brandedYear = urlHost === 'www.siam.org' && base.endsWith(year.slice(2));
  const hasEdition = base.endsWith(edition) || (year === edition && (base.includes(year) || brandedYear));
  // A name such as ACC.27 already says its year. Its ID keeps the full year, as published links do.
  const dottedYear = year === edition && base.endsWith('.' + year.slice(2));
  const name = hasEdition || dottedYear ? base : base + ' ' + edition;
  const id = slugOf(hasEdition ? base : base + ' ' + edition);
  const rawPlace = text(sourcePlace) && !sourcePlace.includes('?') ? sourcePlace : [city, country].filter(text).filter(part => !part.includes('?')).join(', ');
  const place = rawPlace.trim().replace(/^(?:(?:in|at|on)\s+)?(?:the\s+)?(?=\p{Lu})/u, '');
  const placeText = onlineOnly.test(place) ? '' : place.replace(onlineTail, '');
  const officialUrl = verifiedSites[id] ?? (source === undefined && !/\.pdf$/i.test(new URL(url).pathname) ? withoutTracking(url) : undefined);
  const meetsOnline = online === true || onlineWord.test(place);
  const format: ConferenceFormat | undefined = (meetsOnline && placeText) || verifiedHybrid.has(id) || (online !== false && notesSayHybrid(notes)) ? 'hybrid'
    : meetsOnline ? 'online' : online === false ? 'in-person' : undefined;
  return {
    id,
    name,
    series: series.replace(/ \? /g, ' – '), acronym: text(acronym) ? acronym.trim().replace(/ \? /g, ' – ') : undefined, year: Number(year), field: fields[inputField], url: officialUrl, source,
    sourceUrl: withoutTracking(sourceUrl), checkedOn, format, venue, deadlines,
    dateText: text(dateText) && !dateText.includes('?') ? dateText : undefined,
    placeText: placeText || undefined,
    dates: typeof startsOn === 'string' ? [{ start: startsOn, end: typeof endsOn === 'string' ? endsOn : null }] : [],
  };
}

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node scripts/import-conference-editions.ts <data-directory> [--partial]');
  const allowPartial = process.argv.includes('--partial');
  const rows: ConferenceEdition[] = [];
  const launchIds = new Set(['neurips-2026', 'iclr-2026', 'iclr-2027', 'icml-2026', 'colm-2026']);
  for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
    const filename = field + '.json';
    const path = join(dir, filename);
    if (!existsSync(path)) {
      if (!allowPartial) throw new Error(filename + ' is missing. Pass --partial to write a snapshot from the available files.');
      console.log(field + ': missing');
      continue;
    }
    const input: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(input)) throw new Error(filename + ': expected an array');
    let imported = 0;
    for (const [index, value] of input.entries()) {
      const row = convertConferenceEdition(value, field);
      const sameId = row && rows.find(edition => edition.id === row.id);
      const sameEdition = row && sameId && sameId.dates[0]?.start === row.dates[0]?.start
        && (slugOf(sameId.series) === slugOf(row.series) || sameId.sourceUrl === row.sourceUrl);
      if (!row || sameEdition || launchIds.has(row.id)) {
        console.warn(filename + ' entry ' + (index + 1) + ': ' + (row ? 'duplicate edition' : 'invalid or unverified input'));
        continue;
      }
      const id = sameId ? row.id + '-' + slugOf(row.series) : row.id;
      if (rows.some(edition => edition.id === id)) {
        console.warn(filename + ' entry ' + (index + 1) + ': duplicate edition');
        continue;
      }
      rows.push({ ...row, id });
      imported++;
    }
    console.log(field + ': imported ' + imported + ' of ' + input.length);
  }
  if (!rows.length) throw new Error('No verified editions to import.');
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  const editions = rows.map(row => (nameCounts.get(row.name) ?? 0) > 1
    ? { ...row, name: row.series + ' (' + row.name + ')' }
    : row);
  writeFileSync(new URL('../src/data/conference-editions.ts', import.meta.url),
    "import type { ConferenceEdition } from './conferences.ts';\n\nexport const importedEditions: readonly ConferenceEdition[] = [\n"
    + editions.map(row => '  ' + JSON.stringify(row) + ',\n').join('') + '];\n');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
