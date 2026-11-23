import type { Paper } from '../src/models/paper.ts';
import { conferences, rules } from './conference-catalogue.generated.ts';

interface Term {
  text: string;
  match: 'strict' | 'distinct' | 'phrase';
  allowed_before?: string[];
  reject_if_comment_has?: string[];
  only_arxiv_categories?: string[];
  not_arxiv_categories?: string[];
  disambiguation?: { keywords: string[]; arxiv_categories: string[]; default: boolean };
}

export interface Conference {
  id: string;
  label: string;
  name: string;
  workshop?: true;
  symposiumNames?: string[];
  aliases?: string[];
  terms: Term[];
}

type Mark = NonNullable<Paper['acceptedConference']>;
// These formats identify main-conference papers at the listed venues. Elsewhere
// a presentation can belong to a separate, non-archival track.
const allFormats = ['poster', 'oral', 'spotlight'];
const presentationFormatsByConference = new Map<string, readonly string[]>([
  ['S4363606243', allFormats], // NeurIPS
  ['S4306419644', allFormats], // ICML
  ['S4306419637', allFormats], // ICLR
  ['S4210176548', ['oral']], // CVPR
  ['S4363607764', ['oral']], // ICCV
  ['S4306418318', ['oral']], // ECCV
]);

// Any mention of a format in a sentence of its own counts ("Poster paper",
// "Oral talk", "Best poster award"): a mark missed for "oral histories" is
// acceptable, a poster at CHI called an accepted paper is not.
const presentationFormat = /\b(poster|oral|spotlight)s?\b/g;
const acceptancePhrase = /\b(?:accepted\s+(?:and\s+presented\s+at|for\s+(?:presentation|publication)\s+(?:at|in)|at|to|by|in|for|@)|to\s+appear\s+(?:in|at)|appears\s+in|published\s+(?:as\s+(?:a\s+)?conference\s+paper\s+)?(?:in|at)|accepted(?=\s+\()|presented\s+at|camera[- ]ready\s+(?:for|of)|(oral|spotlight|poster)(?:\s+presentation)?\s+at)\s+/i;
const paperSubject = /^(?:(?:(?:this|our|the) )?(?:paper|work|article|manuscript) )?(?:has been |was |is )?$/i;
const uncertain = /\b(?:versions?|extend\w*|extensions?|preliminary|earlier|full|journal|review\w*|reject\w*|retract\w*|declin\w*|withdr\w*|not presented|submitted|pending|conditionally)\b/i;

const reject = new RegExp(rules.reject_cues_regex, 'i');
const rejectExceptWorkshop = new RegExp(rules.reject_except_workshop, 'i');
const terms = conferences.flatMap(conference => conference.terms.map(term => {
  const escaped = term.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = `(?<![A-Za-z0-9@-])${escaped}(?![A-Za-z@])`;
  const flags = term.match === 'phrase' ? 'i' : '';
  return { conference, term, lower: term.text.toLowerCase(),
    dated: new RegExp(rules.strict_regex.replace('TERM', () => escaped), flags),
    bare: new RegExp(term.match === 'phrase' ? escaped : boundary, flags) };
}));

const workshopAcronyms = new Set(terms.filter(({ term }) => term.match !== 'phrase').map(({ lower }) => lower + 'w'));

const count = /(?:\d+(?:\s*\+\s*\d+)*|X+)\s*(?:pages?|figures?|tables?)(?:\s*\(\d+(?:\s*\+\s*\d+)+\))?/i.source;
const countPrefix = new RegExp(`^(?:${count},\\s*)+`, 'i');
const countsOnly = new RegExp(`^${count}(?:(?:,\\s*| and )${count})*(?:, including (?:the )?appendi(?:x|ces))?$`, 'i');
const labelledLink = /^(?:code(?: and data)?|project page|data|website):\s*\uFFFC$/i;

function isResourceNote(note: string) {
  return note.split(/(?<=\uFFFC)\s+/).every(part => {
    const label = /^(?:code(?:base)?(?: and data)?|(?:project )?(?:home\s?page|web\s?page|website)|project (?:page|site)|data(?:set)?|video|implementation|supplementary material)(?: link)?\b/i.exec(part);
    if (!label) return false;
    const target = part.slice(label[0].length).trim();
    return /^:\s*[\w./+-]+(?:\s+\uFFFC)?$/.test(target)
      || /^(?:available\s*)?(?:(?:at|on)\s*)?:?\s*\uFFFC$/i.test(target);
  });
}

// An unrecognised subject or a second destination makes the attribution ambiguous.
function arxivDestination(comment: string) {
  let destination: string | undefined;
  const formats: string[] = [];
  const notes: string[] = [];
  for (const sentence of comment.split(/;|[.!](?=\s|$)/)) {
    const clause = sentence.trim();
    if (!clause || /^camera[- ]ready version$/i.test(clause)) continue;
    if (uncertain.test(clause)) return;
    const phrase = acceptancePhrase.exec(clause);
    let venue: string;
    if (phrase) {
      const prefix = clause.slice(0, phrase.index).replace(countPrefix, '');
      if (!paperSubject.test(prefix)) return;
      venue = clause.slice(phrase.index + phrase[0].length);
      if (phrase[0].trim().toLowerCase() === 'accepted' && !/^\([^()]+\)$/.test(venue)) return;
      const comma = venue.indexOf(',');
      if (comma >= 0) {
        const tail = venue.slice(comma + 1).trim();
        if (labelledLink.test(tail) || countsOnly.test(tail)) venue = venue.slice(0, comma);
      }
      if (phrase[1]) formats.push(phrase[1].toLowerCase());
    } else if (/^in\s+(?:the\s+)?proceedings of\s/i.test(clause) || /\((?:oral|spotlight|poster)\)$/i.test(clause)) {
      venue = clause;
    } else {
      if (clause === '\uFFFC' || countsOnly.test(clause) || isResourceNote(clause) || /^equal contribution$/i.test(clause)
        || /^corresponding author:\s*[^,;!?()]+$/i.test(clause)) continue;
      for (const [, format] of clause.toLowerCase().matchAll(presentationFormat)) formats.push(format);
      notes.push(clause);
      continue;
    }
    if (destination === venue) continue;
    if (destination || /[?\uFFFC]/.test(venue)) return;
    destination = venue;
  }
  return destination && { venue: destination, formats, notes };
}

function isOrganisation(token: string) {
  return token.split(/[/-]/).every(part => rules.organisations.includes(part));
}

function eventToken(token: string) {
  return /[a-z][A-Z]|[A-Z]{2}[a-z]|[A-Za-z]\d[A-Za-z]|@/.test(token)
    || (/^[A-Z0-9+-]{3,}$/.test(token) && /[A-Z].*[A-Z]/.test(token) && !rules.plain_uppercase_words.includes(token));
}

function ambiguousNote(note: string, conference: Conference) {
  // An author may give the presentation format separately. Its venue still has to allow it.
  if (/^(?:oral|poster|spotlight)(?: presentation)?$/i.test(note)) return false;
  const words = note.match(/[\p{L}\p{N}@+-]+/gu) ?? [];
  if (words.length <= 3 || words.filter(word => /^[a-z]+$/.test(word)).length < 3) return true;
  if (/\b(?:tracks?|presented|talks?|sessions?)\b/i.test(note)) return true;
  if (/^(?:19|20)\d{2}$/.test(words.at(-1) ?? '') && !/\b(?:is|are|was|were|has|have|had)\b/.test(note)) return true;
  return words.some(word => eventToken(word) && !isOrganisation(word) && !conference.terms.some(term => term.text === word));
}

function otherEventBefore(prefix: string, term: Term) {
  if (/[([]\s*$/.test(prefix)) return false;
  const tokens = prefix.trimEnd().split(/\s+/);
  while (tokens.length && isOrganisation(tokens.at(-1)!.replace(/^[(),;:]+|[(),;:]+$/g, ''))) tokens.pop();
  if (tokens.at(-1) === 'the' && tokens.at(-2) === 'at') tokens.pop();
  const connector = tokens.at(-1) === 'at' || tokens.at(-1) === '@';
  if (connector) tokens.pop();
  const last = tokens.at(-1);
  if (!last || /[.;:]$/.test(last)) return false;
  const token = last.replace(/^[[\]()"',/]+|[[\]()"',/]+$/g, '').replace(/['’]\d\d$/, '');
  if (isOrganisation(token) || token === term.text || term.allowed_before?.includes(token)) return false;
  return (connector && /^(?:19|20)\d\d$/.test(token)) || eventToken(token);
}

function venueWords(value: string) {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// OpenAlex often prefixes a proceedings title with the publisher or “Proceedings -”,
// while the author gives just the conference name.
const venuePrefix = /^(?:(?:the|an?|in the proceedings of|in proceedings of|proceedings of|main conference of|annual|international|int|intl|computer society|ieee|acm|cvf|rsj)(?: |$))+/;
const edition = /^(?:\d+(?:st|nd|rd|th)?|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety) )?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)|twentieth|thirtieth|fortieth|fiftieth)(?: |$)/;

function namesAcceptanceVenue(destination: string, conference: Conference, formats: readonly string[]) {
  const title = conference.name.replace(/^proceedings - /i, '').replace(/\s*\([^()]+\)$/, '').replace(/\/proceedings\b.*/i, '');
  const aliases = conference.terms.map(term => venueWords(term.text));
  const names = new Set([venueWords(title), ...aliases, ...(conference.aliases ?? []).map(venueWords),
    ...(conference.symposiumNames ?? []).map(venueWords)]);
  if (conference.workshop) names.add(venueWords(title).replace(venuePrefix, '').replace(/ workshop$/, ''));
  for (const name of [...names]) names.add(name.replace(venuePrefix, ''));
  names.delete('');

  const allowedFormats = presentationFormatsByConference.get(conference.id);
  if (formats.some(format => !allowedFormats?.includes(format))) return false;
  // An acronym may precede its full symposium title in parentheses.
  const expansion = /\s+\((?:\d+(?:st|nd|rd|th) )?([^()]+)\)$/i.exec(destination);
  if (expansion) {
    const words = expansion[1].trim().split(/\s+/);
    while (words.length && isOrganisation(words[0].toUpperCase())) words.shift();
    const fullName = venueWords(words.join(' '));
    if (conference.symposiumNames?.some(name => venueWords(name) === fullName)) destination = destination.slice(0, expansion.index);
  }
  let rest = venueWords(destination).replace(/ (oral|spotlight|poster)(?: presentation)?$/, (suffix, format: string) =>
    allowedFormats?.includes(format) ? '' : suffix);
  rest = rest.replace(/ (?:(?:in|on) the )?main (?:conference(?: track)?|track)$/, '');
  if (conference.label === 'NeurIPS') rest = rest.replace(/ (?:track on datasets and benchmarks|datasets and benchmarks(?: track)?)$/, '');
  if (conference.label.endsWith(' Findings')) rest = rest.replace(/ track$/, '');
  if (conference.workshop) rest = rest.replace(/ workshop$/, '');
  rest = rest.replace(/(?:19\d{2}|20\d{2}|\d{2})$/, '').trimEnd();
  const sponsors = conference.terms.flatMap(term => term.allowed_before ?? []).map(venueWords);
  const titleWords = venueWords(title).split(' ');
  while (rest) {
    if (names.has(rest)) return true;
    // The full title may be followed by its edition and parenthesised acronym.
    for (const alias of aliases) {
      if (rest.endsWith(' ' + alias) && names.has(rest.slice(0, -alias.length - 1).replace(/ \d+$/, ''))) return true;
    }
    let stripped = rest.replace(venuePrefix, '').replace(edition, '');
    if (conference.workshop) stripped = stripped.replace(/^workshop on /, '');
    if (stripped !== rest) {
      rest = stripped;
      continue;
    }
    const [word, ...tail] = rest.split(' ');
    if (!sponsors.includes(word) && !(rules.organisations.includes(word.toUpperCase()) && titleWords.includes(word))) break;
    rest = tail.join(' ');
  }
  return false;
}

function eventYear(dated: RegExpExecArray | null, term: string) {
  if (!dated) return;
  const digits = dated[0].slice(term.length).match(/\d+$/)![0];
  if (digits.length === 4) return Number(digits);
  // Authors abbreviate the year of modern proceedings, e.g. NIPS'98 or CVPR24.
  return Number(digits) + (Number(digits) >= 70 ? 1900 : 2000);
}

function tieBreak(term: Term, lower: string, category: string) {
  const rule = term.disambiguation;
  if (!rule || rule.keywords.some(word => lower.includes(word))) return 3;
  if (rule.arxiv_categories.includes(category)) return 2;
  return rule.default ? 1 : 0;
}

export function conferenceInText(text: string | null | undefined, category: string | undefined, evidence: 'arxiv-comment' | 'openreview', venueId?: string): Mark | undefined {
  if (!text) return;
  if (evidence === 'arxiv-comment') {
    // Keep a placeholder so a link cannot supply or join parts of a venue.
    let ambiguousLink = false;
    text = text.replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/gi, url => {
      // A run-on comma or semicolon can start a qualifier outside the link.
      if (/[,;]\S/.test(url)) ambiguousLink = true;
      return '\uFFFC' + (url.match(/[.,;!]$/)?.[0] ?? '');
    });
    if (ambiguousLink) return;
    if (text.toLowerCase().match(/\b[a-z0-9]+w(?=\d{2,4}\b|\b)/g)?.some(token => workshopAcronyms.has(token))) return;
  }
  const rejectText = venueId ? `${text} ${venueId}` : text;
  const lower = text.toLowerCase();
  if (evidence === 'openreview' && uncertain.test(text)) return;
  const attribution = evidence === 'openreview' ? { venue: text, formats: [], notes: [] } : arxivDestination(text);
  if (!attribution) return;
  const { venue: destination, formats, notes } = attribution;
  const years = new Set(destination.match(/\b(?:19|20)\d{2}\b/g));
  if (years.size > 1) return;
  const destinationLower = destination.toLowerCase();
  const strictArchive = rules.strict_archives.includes((category ?? '').split('.')[0]);
  if (rejectExceptWorkshop.test(rejectText)) return;
  const mentionsWorkshop = reject.test(rejectText);

  const matches: Array<{ conference: Conference; term: Term; priority: number; start: number; end: number; year?: number }> = [];
  for (const { term, conference, lower: needle, dated, bare } of terms) {
    if (!destinationLower.includes(needle) || (mentionsWorkshop && !conference.workshop)) continue;
    if (term.match === 'strict' && !strictArchive) continue;
    if (term.only_arxiv_categories && !term.only_arxiv_categories.includes(category ?? '')) continue;
    if (term.not_arxiv_categories?.includes(category ?? '') || term.reject_if_comment_has?.some(value => lower.includes(value.toLowerCase()))) continue;
    const withYear = dated.exec(destination);
    const match = withYear ?? (term.match !== 'strict' ? bare.exec(destination) : null);
    if (!match || otherEventBefore(destination.slice(0, match.index), term)) continue;
    const priority = tieBreak(term, lower, category ?? '');
    if (priority) matches.push({ conference, term, priority, start: match.index, end: match.index + term.text.length, year: eventYear(withYear, term.text) });
  }

  // "Findings of ACL 2024" names the Findings proceedings. Two independent
  // venue mentions provide no basis for choosing which accepted this paper.
  const candidates = matches.filter(m => !matches.some(other =>
    (other.start <= m.start && other.end >= m.end && other.term.text.length > m.term.text.length)
    || (other.term.text === m.term.text && other.priority > m.priority)));
  const first = candidates[0];
  if (!first || candidates.some(candidate => candidate.conference.id !== first.conference.id)) return;
  if (notes.some(note => ambiguousNote(note, first.conference))) return;
  if (/\bsymposium\b/.test(lower)) {
    // A symposium can itself be the catalogued venue (VTS, ISWC).
    const named = venueWords(lower.replace(`(${first.term.text.toLowerCase()})`, ''));
    if (!first.conference.symposiumNames?.some(name => !/\bsymposium\b/.test(named.replace(venueWords(name), '')))) return;
  }
  if (/\bfindings\b/i.test(text) && !first.conference.label.endsWith(' Findings')) return;
  if (!namesAcceptanceVenue(destination, first.conference, formats)) return;
  const year = candidates.find(candidate => candidate.year)?.year;
  if (year && years.size && !years.has(String(year))) return;
  if (evidence === 'openreview') {
    const venue = /^([^/]+)\.cc\/((?:19|20)\d{2})\/(Conference|Datasets_and_Benchmarks_Track)$/i.exec(venueId ?? '');
    if (!venue || (years.size && !years.has(venue[2])) || (year && year !== Number(venue[2]))
      || !first.conference.terms.some(term => term.text.toLowerCase() === venue[1].toLowerCase())
      || (venue[3] !== 'Conference' && first.conference.label !== 'NeurIPS')) return;
  }
  return { id: first.conference.id, label: first.conference.label, evidence, ...(year && { year }) };
}
