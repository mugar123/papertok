/**
 * Deciding whether two spellings name the same author.
 *
 * arXiv writes "Nicolás Cuello" where OpenAlex writes "Cuello, N.", so anything
 * that carries an OpenAlex id back to an author a card is already showing has to
 * match on the person rather than on the string. It lives in `utils` rather than
 * beside its first caller because both `PaperBuilder` and `openAlexService` need
 * it, and the service already imports the builder.
 */

function isNameMatch(p, o) {
  if (p === o) return true;
  if (p.length === 1 && o.charAt(0) === p) return true;
  if (o.length === 1 && p.charAt(0) === o) return true;
  if (p.length > 3 && o.length > 3 && (p.startsWith(o) || o.startsWith(p))) return true;
  return false;
}

export function normalizeNameForMatch(name) {
  return String(name).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/-/g, ' ') // Convert hyphens to spaces
    .toLowerCase()
    .replace(/[^a-z\s]/g, '') // Keep only letters and spaces
    .split(/\s+/)
    .filter(Boolean);
}

export function matchesAuthorName(reqName, oaName) {
  if (!reqName || !oaName) return false;
  const reqParts = normalizeNameForMatch(reqName);
  const oaParts = normalizeNameForMatch(oaName);

  const reqInOa = reqParts.length > 0 && reqParts.every(p => oaParts.some(o => isNameMatch(p, o)));
  const oaInReq = oaParts.length > 0 && oaParts.every(o => reqParts.some(p => isNameMatch(p, o)));

  return reqInOa || oaInReq;
}
