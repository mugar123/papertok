/**
 * Deciding whether two spellings name the same author.
 *
 * arXiv writes "Nicolás Cuello" where OpenAlex writes "Cuello, N.", and PubMed
 * writes "Li WN" for Wan-Ning Li, so anything that carries an OpenAlex id back
 * to an author a card is already showing has to match on the person rather
 * than on the string. It lives in `utils` rather than beside its first caller
 * because both `PaperBuilder` and `openAlexService` need it, and the service
 * already imports the builder.
 *
 * The surname is the anchor and the given names must agree with it in order,
 * a given name matching its initial. The matcher before this one accepted any
 * subset of loosely equal parts: "Li WN" matched "Po-Wn Li" and not
 * "Wan-Ning Li", and "Chen YC" matched "Y. C. Pan" (audit 2026-09-23).
 */

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function words(value) {
  return value.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

export function normalizeNameForMatch(name) {
  return words(normalizeText(name).replace(/\./g, ' '));
}

// "WN", "V.K.", "J" -> ['w', 'n'] … : a run of capitals written as initials.
function initialsOf(token) {
  const letters = token.replace(/\./g, '');
  return /^[A-Z]{1,3}$/.test(letters) ? letters.toLowerCase().split('') : null;
}

// Given-name parts, with initials split: "Wan-Ning" -> ['wan', 'ning'], "A." -> ['a'].
function givenParts(tokens) {
  return tokens.flatMap(token => initialsOf(token) || normalizeNameForMatch(token));
}

/**
 * The readings a written name allows, each `{ surname: string[], given: string[] }`.
 * "Surname, Given" has one; PubMed's "Surname INITIALS" has one; a plain
 * name has "given… surname", and a two-word name also the reverse, because
 * Chinese names reach us in both orders ("Wei Zhang", "Zhang Wei").
 */
function readings(name) {
  const text = normalizeText(name).replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.includes(',')) {
    const [surname, ...rest] = text.split(',');
    return [{ surname: normalizeNameForMatch(surname), given: givenParts(rest.join(' ').split(/\s+/).filter(Boolean)) }];
  }
  const tokens = text.split(' ');
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && initialsOf(last)) {
    return [{ surname: normalizeNameForMatch(tokens.slice(0, -1).join(' ')), given: initialsOf(last) }];
  }
  const plain = { surname: normalizeNameForMatch(last), given: givenParts(tokens.slice(0, -1)) };
  // A hyphenated first word is a given name ("Yong-Wei Zhang"), never a
  // surname written first.
  if (tokens.length !== 2 || initialsOf(tokens[0]) || tokens[0].includes('-')) return [plain];
  return [plain, { surname: normalizeNameForMatch(tokens[0]), given: givenParts([tokens[1]]) }];
}

function sameSurname(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(' ') === b.join(' ')) return true;
  // A compound surname written whole on one side and in part on the other
  // ("García-Márquez" / "Márquez") is still one surname.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every(part => longer.includes(part));
}

function sameGivenPart(a, b) {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a));
}

// Given names agree in order as far as both go; a side with fewer (or none)
// does not contradict the other.
function sameGiven(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameGivenPart(a[index], b[index])) return false;
  }
  return true;
}

export function matchesAuthorName(reqName, oaName) {
  if (!reqName || !oaName) return false;
  const left = readings(reqName);
  const right = readings(oaName);
  return left.some(a => right.some(b => sameSurname(a.surname, b.surname) && sameGiven(a.given, b.given)));
}
