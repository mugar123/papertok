#!/usr/bin/env node
/**
 * Census of university Alma link resolvers, for `worker/institution-resolvers.ts`.
 *
 * A library's Alma resolver is reached at
 * `https://<region>.alma.exlibrisgroup.com/view/uresolver/<CODE>/openurl`, and
 * no public registry maps a university to its code or region. This script
 * finds the code by reading the library's own pages (its Primo catalogue
 * carries it as `vid=<CODE>:<VIEW>`), then finds the host by probing the
 * hosts its pages and code suggest and the regions in `ALMA_REGIONS`: only
 * the right one lists a service for a probe journal.
 *
 * Usage, from the repository root:
 *   node scripts/diagnostics/alma-resolver-census.mjs --countries US --limit 150
 *   node scripts/diagnostics/alma-resolver-census.mjs --countries EU --limit 250
 *   node scripts/diagnostics/alma-resolver-census.mjs --countries ES
 *   node scripts/diagnostics/alma-resolver-census.mjs --verify
 *
 * `--countries` takes ISO codes or `EU` (Europe); `--limit` keeps the most
 * productive institutions of that group, by OpenAlex works count. Every run
 * merges into `alma-resolver-census.json` (the census record, with misses and
 * how each code was found) and regenerates the Worker table from the verified
 * rows. `--verify` re-probes every known or seeded code without discovery.
 * Codes found elsewhere (by hand, or in Zotero's public directory of OpenURL
 * resolvers) go in `alma-resolver-seeds.json` as `{ rorId, source, code?,
 * host?, url?, product? }` and are verified here like any other: a `url` is
 * read first when there is no code and a `host` is probed first. `product`
 * is what the directory lists (alma, sfx, 360link, ebsco, worldcat, libkey,
 * webbridge, other); a product other than Alma does not prove the library lacks an Alma
 * resolver, so discovery still runs, and an institution left without one is
 * `compatibility-pending`, with the product kept for a later adapter. A seed
 * with `resolverProduct: "sfx"` names an SFX instance in `url` that the Worker
 * reads itself; it is verified through the Worker's own SFX request and
 * reading, without discovery, and ships as a row with `product: 'sfx'`. Only
 * the seeds that say so are read this way: the other SFX libraries stay pending.
 * `--only <ror>` restricts a run to one institution; `--dry` probes without
 * writing anything. `--skip-known` leaves out the institutions the census has
 * already met, so a wider `--limit` only probes the new ones. `--inventory`
 * prints the coverage inventory (per country: met, shipped, and where the
 * rest stand) from the census record, without any request.
 *
 * Every host is asked at most once per second, with an identifying user agent.
 * Only public endpoints are used: OpenAlex, ROR, library web pages and the
 * resolvers themselves. OpenAlex charges its free daily budget per request.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { promises as dns } from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The Worker's own reading of a resolver answer: a row is verified only by
// an answer the Worker would read as one.
import { parseResolverAnswer, parseSfxAnswer, sfxRequestUrl } from '../../worker/institution-access.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENSUS_FILE = path.join(HERE, 'alma-resolver-census.json');
const SEEDS_FILE = path.join(HERE, 'alma-resolver-seeds.json');
const TABLE_FILE = path.join(HERE, '..', '..', 'worker', 'institution-resolvers.ts');

const USER_AGENT = 'PaperTok resolver census (app@papertok.io)';
const MAILTO = 'app@papertok.io';
// eu06 (Ghent) and na08 (Ohio State) answered on 2026-10-19; the list grows
// as Ex Libris adds regions.
const ALMA_REGIONS = ['eu00', 'eu01', 'eu02', 'eu03', 'eu04', 'eu05', 'eu06', 'na01', 'na02', 'na03', 'na04', 'na05', 'na06', 'na07', 'na08', 'ca01', 'ap01', 'ap02'];
const EUROPE = ['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'UA'];
// Journals a host is asked about, in order: Nature, then a Springer journal
// most libraries hold, for the few that lack Nature (Drexel, Burgos, seen
// on 2026-10-19). A host is verified by an answer that lists a service.
const PROBE_JOURNALS = [{ issn: '0028-0836', year: 2020 }, { issn: '0022-2461', year: 2021 }];
const probeQuery = ({ issn, year }) => `openurl?svc_dat=CTO&rft.genre=article&rft.issn=${issn}&rft.date=${year}`;
const PRIMO_SLUG = /\b([a-z0-9-]+)\.primo\.exlibrisgroup\.com/i;
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML = 600 * 1024;
const PER_HOST_INTERVAL_MS = 1000;
const INSTITUTION_CONCURRENCY = 6;
// Subdomains that commonly host a library's site or catalogue.
const LIBRARY_HOSTS = ['library', 'lib', 'libraries', 'biblioteca', 'bibliotecas', 'biblio', 'bib', 'ub', 'crai', 'bibliotheek', 'bibliothek', 'bibliotheque', 'biblioteket', 'kirjasto', 'search.library', 'library-search', 'catalog', 'catalogue', 'discover', 'discovery', 'search', 'primo', 'hollis', 'solo'];
const LIBRARY_LINK = /librar|bibliot|biblio|kirjasto|catalog|cat[àa]leg|discover|primo|buscador|\bcerca\b|hollis|\bsolo\b/i;
const ASSET_LINK = /\.(?:svg|png|jpe?g|gif|webp|pdf|css|js|ico|xml)(?:[?#]|$)/i;
// Pages read per institution before giving up: six catalogue-looking links
// from the homepage, then the library subdomains that exist in DNS.
const MAX_PAGES = 24;
const CODE_PATTERNS = [
  /[?&]vid=([A-Z0-9]+_[A-Z0-9_]+)(?::|%3A)/i,
  /\/uresolver\/([A-Z0-9]+_[A-Z0-9_]+)\//i,
  /[?&]institution=([A-Z0-9]+_[A-Z0-9_]+)\b/i,
  // Primo VE's own OpenURL entry point: /openurl/<CODE>/<CODE>:<VIEW>.
  /\/openurl\/([A-Z0-9]+_[A-Z0-9_]+)(?::|%3A|\/|$)/i,
];
// An Alma host named in a page: a region, or a library's own slug (udl.alma…).
// Primo answers name their region in the `Report-To` header.
const REGION_PATTERN = /\b([a-z0-9-]+)\.alma\.exlibrisgroup\.com/i;
const PRIMO_LINK = /https?:\/\/[^"'\s<>)]*(?:primo\.exlibrisgroup\.com|alma\.exlibrisgroup\.com|primo-|\/primo\/|\/discovery\/search)[^"'\s<>)]*/gi;

const args = parseArgs(process.argv.slice(2));

// --- polite fetching ---------------------------------------------------------

const hostTimers = new Map();
async function politely(host) {
  const now = Date.now();
  const next = Math.max(now, (hostTimers.get(host) || 0) + PER_HOST_INTERVAL_MS);
  hostTimers.set(host, next);
  if (next > now) await new Promise(resolve => setTimeout(resolve, next - now));
}

let requestCount = 0;
/** Fetches text, following redirects, with the final URL; null on any failure. */
async function fetchPage(url, { accept = 'text/html,application/xhtml+xml' } = {}) {
  let host;
  try { host = new URL(url).host; } catch { return null; }
  await politely(host);
  requestCount += 1;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept },
    });
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      while (text.length < MAX_HTML) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    }
    if (args.debug) console.log(`    ${response.status} ${Date.now() - started} ms ${url} -> ${response.url}`);
    const reportTo = response.headers.get('report-to') || '';
    return { url: response.url || url, status: response.status, text, reportTo };
  } catch (error) {
    if (args.debug) console.log(`    fail ${Date.now() - started} ms ${url}: ${error.cause?.code || error.name}`);
    return null;
  }
}

async function fetchJson(url) {
  const page = await fetchPage(url, { accept: 'application/json' });
  if (!page || page.status !== 200) return null;
  try { return JSON.parse(page.text); } catch { return null; }
}

async function resolves(host) {
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

// --- institutions ------------------------------------------------------------

async function listInstitutions(countries, limit) {
  const filter = `type:education,country_code:${countries.join('|')}`;
  const perPage = 200;
  const pages = Math.ceil((limit || 1000) / perPage);
  const results = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = `https://api.openalex.org/institutions?filter=${encodeURIComponent(filter)}&sort=works_count:desc&per-page=${perPage}&page=${page}&select=id,ror,display_name,country_code,homepage_url,works_count&mailto=${MAILTO}`;
    const payload = await fetchJson(url);
    if (!payload?.results) throw new Error(`OpenAlex did not answer for ${countries.join(',')} page ${page}`);
    results.push(...payload.results.filter(item => item.ror));
    if (payload.results.length < perPage) break;
  }
  return results.slice(0, limit || results.length).map(item => ({
    rorId: item.ror,
    name: item.display_name,
    country: item.country_code,
    worksCount: item.works_count,
    homepage: item.homepage_url || null,
  }));
}

async function rorRecord(rorId) {
  const payload = await fetchJson(`https://api.ror.org/v2/organizations/${encodeURIComponent(rorId.replace('https://ror.org/', ''))}`);
  if (!payload) return { domains: [], links: [], name: null };
  const domains = [...new Set((payload.domains || []).map(value => String(value).toLowerCase()))];
  const links = (payload.links || []).filter(link => link.type === 'website').map(link => link.value);
  const name = (payload.names || []).find(entry => entry.types?.includes('ror_display'))?.value || null;
  return { domains, links, name };
}

// --- discovery of the institution code -------------------------------------

function codeIn(text) {
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function regionIn(text) {
  const match = text.match(REGION_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function sameSite(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/** What a fetched page says: a code, a region, and Primo links worth following. */
function inspect(page) {
  const haystack = `${page.url}\n${page.reportTo || ''}\n${page.text}`;
  const code = codeIn(haystack);
  const region = regionIn(haystack);
  // The Primo slug usually names the library's own Alma host too
  // (unipv.primo… and unipv.alma…), which the regional host may not stand in for.
  const primoSlug = (haystack.match(PRIMO_SLUG) || [])[1]?.toLowerCase() || null;
  const primoLinks = [...new Set([...haystack.matchAll(PRIMO_LINK)].map(match => match[0].replace(/&amp;/g, '&')))].slice(0, 3);
  return { code, region, primoSlug, primoLinks };
}

/**
 * The institution code and, when a page named it, the region. Pages are
 * read in order of likelihood and the search stops at the first code.
 */
async function discoverCode(institution, ror) {
  const seen = new Set();
  const found = { code: null, region: null, primoSlug: null, route: null, evidence: null };
  const visit = async (url, route) => {
    if (!url || found.code || seen.size >= MAX_PAGES || ASSET_LINK.test(url)) return;
    const key = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    const page = await fetchPage(url);
    if (!page) return;
    const { code, region, primoSlug, primoLinks } = inspect(page);
    if (region && !found.region) found.region = region;
    if (primoSlug && !found.primoSlug) found.primoSlug = primoSlug;
    if (code) {
      Object.assign(found, { code, route, evidence: page.url });
      return;
    }
    for (const link of primoLinks) await visit(link, `${route}>primo`);
    return page;
  };

  const domains = ror.domains;
  // A resolver address from a directory is the best first page: a Primo
  // link answers with the institution code in its redirect or its HTML.
  if (institution.seedUrl) {
    await visit(institution.seedUrl, `${institution.seedSource || 'seed'}-url`);
    if (found.code) return found;
  }
  const homepages = [institution.homepage, ...ror.links].filter(Boolean);
  for (const homepage of homepages) {
    const page = await visit(homepage, 'homepage');
    if (found.code) return found;
    if (!page) continue;
    const links = [...page.text.matchAll(/href=["']([^"']+)["']/gi)]
      .map(match => { try { return new URL(match[1], page.url).href; } catch { return null; } })
      .filter(link => link && LIBRARY_LINK.test(link) && (sameSite(link, domains) || /exlibrisgroup\.com/.test(link)));
    for (const link of [...new Set(links)].slice(0, 6)) {
      await visit(link, 'homepage>link');
      if (found.code) return found;
    }
  }
  for (const domain of domains) {
    for (const prefix of LIBRARY_HOSTS) {
      const host = `${prefix}.${domain}`;
      if (found.code) return found;
      if (!(await resolves(host))) continue;
      const page = await visit(`https://${host}/`, 'subdomain');
      if (found.code || !page) continue;
      const links = [...page.text.matchAll(/href=["']([^"']+)["']/gi)]
        .map(match => { try { return new URL(match[1], page.url).href; } catch { return null; } })
        .filter(link => link && /catalog|cataleg|catálogo|discover|primo|search|buscador|cerca/i.test(link) && (sameSite(link, domains) || /exlibrisgroup\.com/.test(link)));
      for (const link of [...new Set(links)].slice(0, 4)) {
        await visit(link, 'subdomain>link');
        if (found.code) return found;
      }
    }
  }
  return found;
}

// --- verification against the Alma regions ---------------------------------

/**
 * One probe of one host: the page, the Worker's reading of it, and what Alma
 * listed, or null. A wrong region answers 200 with an empty body. An answer
 * without a `full_text_indicator` (Harvard, seen 2026-10-14) is read from the
 * services it lists, as the Worker reads it, so it can verify a host.
 */
async function probeHost(host, code, journal) {
  const page = await fetchPage(`https://${host}/view/uresolver/${code}/${probeQuery(journal)}`, { accept: 'text/xml' });
  if (!page || !page.text.includes('<uresolver_content')) return null;
  const answer = parseResolverAnswer(page.text);
  const listed = (page.text.match(/<context_service /g) || []).length;
  const packages = [...page.text.matchAll(/<key id="package_public_name">([^<]*)<\/key>/g)].map(match => match[1]).slice(0, 2);
  return { host, answer, listed, packages, journal };
}

/**
 * The host that answers for the code with a service listed, or the best
 * answer short of that. Hosts are tried in order of likelihood: the slug
 * of the library's Primo (unipv.alma…), the region a page named, the slug
 * derived from the code (01OHIOLINK_CWRU → ohiolink-cwru.alma…), the
 * labels of the mail domains, then every region. A host that knows the
 * code but not the journal (no `rft.mms_id`, nothing listed) is not this
 * library's host: eu03 answered that way for Pavia while unipv.alma… listed
 * five services (2026-10-19). A host that resolves the journal and lists
 * nothing is asked about the next journal; a library with nothing for
 * either is recorded as `answers-without-services`, not shipped.
 */
async function probeRegions(code, { host: known = null, region = null, primoSlug = null, domains = [], country = null } = {}) {
  const codeSlug = code.replace(/^\d+/, '').toLowerCase().replace(/_/g, '-');
  const labels = domains.map(domain => domain.split('.')[0]).filter(label => label.length > 2);
  const slugs = [...new Set([primoSlug, region, codeSlug, ...labels, ...ALMA_REGIONS].filter(Boolean))];
  // Alma in mainland China lives under exlibrisgroup.com.cn (Tsinghua answers on
  // tsinghua.alma.exlibrisgroup.com.cn and on no .com host, 2026-10-19), so a
  // known host is probed as given, and a Chinese institution's slugs on both.
  const hosts = [known, ...slugs.map(slug => `${slug}.alma.exlibrisgroup.com`)];
  if (country === 'CN') hosts.push(...slugs.map(slug => `${slug}.alma.exlibrisgroup.com.cn`), 'cn01.alma.exlibrisgroup.com.cn');
  let resolved = null;
  for (const host of [...new Set(hosts.filter(Boolean))]) {
    for (const journal of PROBE_JOURNALS) {
      const probe = await probeHost(host, code, journal);
      if (!probe) break;
      if (!probe.answer) break;
      if (!probe.answer.matched && probe.listed === 0) break;
      if (probe.listed > 0) return { ...probe, status: 'verified' };
      resolved ||= probe;
    }
  }
  return resolved ? { ...resolved, status: 'answers-without-services' } : null;
}

/**
 * An SFX instance a seed names (`https://<host>/<instance>`), verified as an
 * Alma host is: the answer must be one the Worker reads, through the request
 * the Worker sends, and list a service from the library for a probe journal
 * itself. Free collections do not count, and SFX resolves an unknown ISSN to
 * some journal of its knowledge base (2026-10-20), which the reading rejects.
 * An instance that does not verify stays `compatibility-pending`.
 */
async function verifySfx(entry, seed) {
  const { host, pathname } = new URL(seed.url);
  const resolver = { host, institution: pathname.replace(/^\/+|\/+$/g, ''), product: 'sfx' };
  const row = { ...entry, code: resolver.institution, host, resolverProduct: 'sfx', route: 'seed', evidence: seed.evidence || entry.evidence || null };
  for (const journal of PROBE_JOURNALS) {
    const page = await fetchPage(sfxRequestUrl(resolver, journal), { accept: 'text/xml' });
    const answer = page?.status === 200 ? parseSfxAnswer(page.text, journal.issn) : null;
    if (answer?.services.length) {
      return { ...row, status: 'verified', services: answer.services.length, packages: answer.services.slice(0, 2).map(service => service.name), journal: journal.issn };
    }
  }
  return { ...row, status: 'compatibility-pending' };
}

// --- the census record and the Worker table --------------------------------

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function generatedTable(entries) {
  const rows = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map(entry => `  { rorId: ${quote(entry.rorId)}, domains: [${entry.domains.map(quote).join(', ')}], name: ${quote(entry.name)}, host: ${quote(entry.host)}, institution: ${quote(entry.code)}${entry.resolverProduct ? `, product: ${quote(entry.resolverProduct)} as const` : ''} },`);
  return `// Generated by scripts/diagnostics/alma-resolver-census.mjs from
// scripts/diagnostics/alma-resolver-census.json; do not edit by hand.
// Each row is a library's link resolver, verified by a probe of that host and
// institution code whose answer the Worker reads and lists a service: Alma,
// or an SFX instance (\`institution\` is its path) where \`product\` says so.

export interface InstitutionResolverEntry {
  rorId: string;
  domains: readonly string[];
  name: string;
  host: string;
  institution: string;
  product?: 'sfx';
}

export const INSTITUTION_RESOLVERS: readonly InstitutionResolverEntry[] = Object.freeze([
${rows.join('\n')}
].map(entry => Object.freeze({ ...entry, domains: Object.freeze([...entry.domains]) })));
`;
}

async function processInstitution(institution, record, seeds, verifyOnly) {
  const entry = { ...record, ...institution, probedAt: new Date().toISOString() };
  if (!entry.domains?.length || !entry.links) {
    const ror = await rorRecord(entry.rorId);
    entry.domains = ror.domains;
    entry.links = ror.links;
    if (!entry.name || entry.name === entry.rorId) entry.name = ror.name || entry.rorId;
  }
  const seed = seeds.get(entry.rorId);
  if (seed) {
    entry.source = seed.source || 'seed';
    if (seed.url) entry.resolverUrl = seed.url;
    if (seed.product) entry.product = seed.product;
  }
  // A library consortium answers for its network, not for one university;
  // OpenAlex lists some as education institutions. They are kept out of the
  // table by a seed with `exclude`, with the reason.
  if (seed?.exclude) return { ...entry, code: record?.code || null, host: record?.host || null, status: 'excluded', exclude: seed.exclude };
  if (seed?.resolverProduct === 'sfx') return verifySfx(entry, seed);
  // An address for another product (SFX, EBSCO…) is not a page to read for
  // an Alma code; an Alma or unknown one is the best first page.
  const almaLike = !seed?.product || seed.product === 'alma' || seed.product === 'other';
  let code = seed?.code || record?.code || null;
  let route = seed?.code ? 'seed' : record?.route || null;
  let region = (seed?.host || record?.host || '').split('.')[0] || null;
  let primoSlug = record?.primoSlug || null;
  const discover = async () => {
    const found = await discoverCode({ ...entry, seedUrl: almaLike ? seed?.url : null, seedSource: seed?.source }, { domains: entry.domains, links: entry.links });
    if (found.code) {
      code = found.code;
      route = found.route;
      entry.evidence = found.evidence;
    }
    region = found.region || region;
    primoSlug = found.primoSlug || primoSlug;
  };
  // A directory address without a code is read even in a verify run.
  if (!code && (!verifyOnly || (seed?.url && almaLike))) await discover();
  if (!code) {
    // A product seen on the library's pages places the institution even
    // when no resolver address was published (NUS, USP, UNAM on 2026-10-19).
    const status = seed?.product && !almaLike ? 'compatibility-pending' : seed?.url ? 'address-located' : 'unresolved';
    return { ...entry, code: null, host: null, status };
  }
  const known = seed?.host || record?.host || null;
  let probe = await probeRegions(code, { host: known, region, primoSlug, domains: entry.domains, country: entry.country });
  // A host that lists nothing may be the regional one standing in for the
  // library's own: the library's pages name that host through its Primo.
  if (probe?.status !== 'verified' && !primoSlug) {
    await discover();
    if (primoSlug) probe = await probeRegions(code, { host: known, region, primoSlug, domains: entry.domains, country: entry.country });
  }
  if (!probe) return { ...entry, code, route, host: null, primoSlug, status: 'code-without-region' };
  return {
    ...entry, code, route, primoSlug, host: probe.host, status: probe.status,
    services: probe.listed, packages: probe.packages, journal: probe.journal.issn,
  };
}

/**
 * The coverage inventory, as Markdown, from the census record alone: per
 * country, how many institutions were met, how many ship, and where the
 * rest stand (an Alma answer the Worker cannot read, another product, a
 * candidate still unverified, nothing found). Reproducible: a report that
 * quotes it can be regenerated after any run.
 */
function inventory(census) {
  const all = Object.values(census.institutions);
  const statusGroup = (entry) => {
    if (entry.status === 'verified') return 'shipped';
    if (entry.status === 'answers-without-services') return 'almaUnreadable';
    if (entry.status === 'compatibility-pending') return 'otherProduct';
    if (entry.status === 'address-located' || entry.status === 'code-without-region') return 'candidate';
    if (entry.status === 'excluded') return 'excluded';
    return 'unresolved';
  };
  const rows = new Map();
  for (const entry of all) {
    const row = rows.get(entry.country) || { total: 0, shipped: 0, almaUnreadable: 0, otherProduct: 0, candidate: 0, excluded: 0, unresolved: 0, products: {} };
    row.total += 1;
    row[statusGroup(entry)] += 1;
    if (entry.status === 'compatibility-pending' && entry.product) row.products[entry.product] = (row.products[entry.product] || 0) + 1;
    rows.set(entry.country, row);
  }
  const lines = [
    `Census of ${all.length} institutions, generated ${new Date().toISOString().slice(0, 10)} from alma-resolver-census.json.`,
    '',
    '| Country | Met | Shipped | Alma, unreadable answer | Other product | Candidate, unverified | Excluded | Unresolved |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [country, row] of [...rows].sort((a, b) => b[1].shipped - a[1].shipped || b[1].total - a[1].total)) {
    const products = Object.entries(row.products).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ');
    lines.push(`| ${country || '?'} | ${row.total} | ${row.shipped} | ${row.almaUnreadable} | ${row.otherProduct}${products ? ` (${products})` : ''} | ${row.candidate} | ${row.excluded} | ${row.unresolved} |`);
  }
  const totals = [...rows.values()].reduce((sum, row) => { for (const key of Object.keys(sum)) sum[key] += row[key]; return sum; }, { total: 0, shipped: 0, almaUnreadable: 0, otherProduct: 0, candidate: 0, excluded: 0, unresolved: 0 });
  lines.push(`| **All** | ${totals.total} | ${totals.shipped} | ${totals.almaUnreadable} | ${totals.otherProduct} | ${totals.candidate} | ${totals.excluded} | ${totals.unresolved} |`);
  lines.push('', 'Shipped rows answered a live probe with a service listed. "Alma, unreadable answer" is a library on Alma whose answer lists nothing for either probe journal. "Other product" is the resolver product the library publishes instead (SFX, EBSCO, 360 Link, WorldCat, LibKey). "Candidate" is an address or code still without a verified host. Excluded rows are consortia or shared libraries, with the reason in the seeds.');
  return lines.join('\n');
}

async function main() {
  const census = await readJson(CENSUS_FILE, { institutions: {} });
  const seeds = new Map((await readJson(SEEDS_FILE, [])).map(seed => [seed.rorId, seed]));
  if (args.inventory) {
    console.log(inventory(census));
    return;
  }

  let targets;
  if (args.verify) {
    // A verified row is not probed again (`--all` does); what gets probed is
    // every code or seed still without a verified answer.
    targets = Object.values(census.institutions).filter(entry => (entry.code || seeds.has(entry.rorId)) && (args.all || entry.status !== 'verified' || seeds.get(entry.rorId)?.exclude));
  } else {
    const countries = (args.countries || '').split(',').flatMap(code => (code.toUpperCase() === 'EU' ? EUROPE : [code.toUpperCase()])).filter(Boolean);
    if (!countries.length) throw new Error('pass --countries (ISO codes or EU) or --verify');
    targets = await listInstitutions(countries, args.limit ? Number(args.limit) : 0);
    if (args['skip-known']) targets = targets.filter(entry => !census.institutions[entry.rorId]);
  }
  // A seed the census has never met is processed in every run, so that a
  // code found by hand reaches the table without waiting for its country.
  for (const [rorId, seed] of seeds) {
    if (!census.institutions[rorId] && !targets.some(entry => entry.rorId === rorId)) {
      targets.push({ rorId, name: seed.name || rorId, country: seed.country || null, worksCount: 0, homepage: null });
    }
  }
  if (args.only) targets = targets.filter(entry => entry.rorId === args.only);
  console.log(`${targets.length} institutions to process`);

  const started = Date.now();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < targets.length) {
      const institution = targets[next++];
      const record = census.institutions[institution.rorId] || null;
      try {
        const result = await processInstitution(institution, record, seeds, Boolean(args.verify));
        census.institutions[institution.rorId] = result;
        done += 1;
        console.log(`[${done}/${targets.length}] ${result.status.padEnd(19)} ${result.name} ${result.code ? `${result.code}@${result.host || '?'} (${result.route})` : ''}`);
      } catch (error) {
        console.log(`[${done}/${targets.length}] error               ${institution.name}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: INSTITUTION_CONCURRENCY }, worker));

  census.generatedAt = new Date().toISOString();
  // A verified row ships even without ROR domains: the lookup goes by ROR id first.
  const verified = Object.values(census.institutions).filter(entry => entry.status === 'verified');
  if (!args.dry) {
    await writeFile(CENSUS_FILE, `${JSON.stringify(census, null, 2)}\n`);
    await writeFile(TABLE_FILE, generatedTable(verified));
  }

  const all = Object.values(census.institutions);
  const count = (predicate) => all.filter(predicate).length;
  console.log(`\n${Math.round((Date.now() - started) / 1000)} s, ${requestCount} requests this run`);
  const statuses = {};
  for (const entry of all) statuses[entry.status] = (statuses[entry.status] || 0) + 1;
  console.log(`census: ${all.length} institutions, ${JSON.stringify(statuses)}`);
  console.log(`table: ${verified.length} rows ${args.dry ? 'would be' : ''} written to ${path.relative(process.cwd(), TABLE_FILE)}`);
  const routes = {};
  for (const entry of all) if (entry.route) routes[entry.route] = (routes[entry.route] || 0) + 1;
  console.log(`routes: ${JSON.stringify(routes)}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    parsed[key] = value;
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
