import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConferenceEdition } from '../src/data/conferences.ts';

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

function convert(value: unknown, inputField: keyof typeof fields): ConferenceEdition | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const { series, acronym, edition, startsOn, endsOn, dateText, city, country, placeText, online, url, sourceUrl, sourceLicense, checkedOn, notes } = row;
  if (row.field !== inputField || !text(series) || !text(edition) || !/\b202[67]\b/.test(edition)
    || !https(url) || !https(sourceUrl) || !iso(checkedOn)
    || ![acronym, dateText, city, country, placeText, notes].every(item => item === null || text(item))
    || !(typeof online === 'boolean' || online === null)) return null;
  if ([url, sourceUrl].some(link => new URL(link).pathname === '/Xplore/guesthome.jsp')) return null;
  if (startsOn !== null && (!iso(startsOn) || startsOn < '2026-12-01' || startsOn > '2027-12-31')) return null;
  if (endsOn !== null && (!iso(endsOn) || !iso(startsOn) || endsOn < startsOn)) return null;
  const source = sourceLicense === 'MIT (ccf-deadlines)' ? 'ccf'
    : sourceLicense === 'CC BY 4.0 (databio/conferences)' ? 'databio' : undefined;
  if (!source && sourceLicense !== 'official-site') return null;
  const name = (text(acronym) ? acronym : series).replace(/ \? /g, ' – ');
  const slug = slugOf(name);
  const editionSlug = slugOf(edition);
  if (!slug || !editionSlug) return null;
  return {
    id: slug.endsWith('-' + editionSlug) ? slug : slug + '-' + editionSlug,
    name: name.endsWith(edition) ? name : name + ' ' + edition,
    series: series.replace(/ \? /g, ' – '), field: fields[inputField], url, source, sourceUrl, checkedOn, online: online === true,
    dateText: text(dateText) && !dateText.includes('?') ? dateText : undefined,
    placeText: (text(placeText) && !placeText.includes('?') ? placeText : [city, country].filter(text).filter(part => !part.includes('?')).join(', ')) || undefined,
    notes: text(notes) && !notes.includes('?') ? notes : undefined,
    dates: typeof startsOn === 'string' ? [{ start: startsOn, end: typeof endsOn === 'string' ? endsOn : null }] : [],
  };
}

const dir = process.argv[2];
if (!dir) throw new Error('Pass the directory containing the conference field JSON files.');
const rows: ConferenceEdition[] = [];
const launchIds = new Set(['neurips-2026', 'iclr-2026', 'iclr-2027', 'icml-2026', 'colm-2026']);
for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
  const filename = field + '.json';
  const path = join(dir, filename);
  if (!existsSync(path)) {
    console.log(field + ': missing');
    continue;
  }
  const input: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(input)) throw new Error(filename + ': expected an array');
  let imported = 0;
  for (const [index, value] of input.entries()) {
    const row = convert(value, field);
    const sameId = row && rows.find(edition => edition.id === row.id);
    const sameEdition = row && sameId && sameId.dates[0]?.start === row.dates[0]?.start;
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
writeFileSync(new URL('../src/data/conference-editions.ts', import.meta.url),
  "import type { ConferenceEdition } from './conferences.ts';\n\nexport const importedEditions: readonly ConferenceEdition[] = [\n"
  + rows.map(row => '  ' + JSON.stringify(row) + ',\n').join('') + '];\n');
