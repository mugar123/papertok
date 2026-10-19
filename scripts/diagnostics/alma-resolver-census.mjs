#!/usr/bin/env node
/**
 * Census of university Alma link resolvers, for `worker/institution-resolvers.ts`.
 *
 * A library's Alma resolver is reached at
 * `https://<region>.alma.exlibrisgroup.com/view/uresolver/<CODE>/openurl`, and
 * no public registry maps a university to its code or region. This script
 * finds the code by reading the library's own pages (its Primo catalogue
 * carries it as `vid=<CODE>:<VIEW>`), then finds the region by probing the
 * sixteen Alma regions: only the right one answers with a `full_text_indicator`.
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
 * other); a product other than Alma does not prove the library lacks an Alma
 * resolver, so discovery still runs, and an institution left without one is
 * `compatibility-pending`, with the product kept for a later adapter.
 * `--only <ror>` restricts a run to one institution; `--dry` probes without
 * writing anything.
 *
 * Every host is asked at most once per second, with an identifying user agent.
 * Only public endpoints are used: OpenAlex, ROR, library web pages and the
 * resolvers themselves. OpenAlex charges its free daily budget per request.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { promises as dns } from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROBE_QUERY = 'openurl?svc_dat=CTO&rft.genre=article&rft.issn=0028-0836&rft.date=2020';
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
  const primoLinks = [...new Set([...haystack.matchAll(PRIMO_LINK)].map(match => match[0].replace(/&amp;/g, '&')))].slice(0, 3);
  return { code, region, primoLinks };
}

/**
 * The institution code and, when a page named it, the region. Pages are
 * read in order of likelihood and the search stops at the first code.
 */
async function discoverCode(institution, ror) {
  const seen = new Set();
  const found = { code: null, region: null, route: null, evidence: null };
  const visit = async (url, route) => {
    if (!url || found.code || seen.size >= MAX_PAGES || ASSET_LINK.test(url)) return;
    const key = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    const page = await fetchPage(url);
    if (!page) return;
    const { code, region, primoLinks } = inspect(page);
    if (region && !found.region) found.region = region;
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
 * `{ host, indicator, services, packages }` for the region that answers for
 * the code, or null. A wrong region answers 200 with an empty body. Some
 * libraries answer without a `full_text_indicator` (Harvard, seen 2026-10-14);
 * the Worker's parser cannot read those, so they are recorded but not shipped.
 */
async function probeRegions(code, preferred) {
  // Consortium members often answer only on a host named after the code:
  // 01OHIOLINK_CWRU on ohiolink-cwru.alma…, 49HBZ_ULB on hbz-ulb.alma…
  const slug = code.replace(/^\d+/, '').toLowerCase().replace(/_/g, '-');
  const regions = [...new Set([preferred, slug, ...ALMA_REGIONS].filter(Boolean))];
  for (const region of regions) {
    const host = `${region}.alma.exlibrisgroup.com`;
    const page = await fetchPage(`https://${host}/view/uresolver/${code}/${PROBE_QUERY}`, { accept: 'text/xml' });
    if (!page || !page.text.includes('<uresolver_content')) continue;
    const indicator = page.text.includes('full_text_indicator');
    const services = (page.text.match(/<context_service /g) || []).length;
    if (!indicator && services === 0) continue;
    const packages = [...page.text.matchAll(/<key id="package_public_name">([^<]*)<\/key>/g)].map(match => match[1]).slice(0, 2);
    return { host, indicator, services, packages };
  }
  return null;
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
    .map(entry => `  { rorId: ${quote(entry.rorId)}, domains: [${entry.domains.map(quote).join(', ')}], name: ${quote(entry.name)}, host: ${quote(entry.host)}, institution: ${quote(entry.code)} },`);
  return `// Generated by scripts/diagnostics/alma-resolver-census.mjs from
// scripts/diagnostics/alma-resolver-census.json; do not edit by hand.
// Each row is a library's Alma link resolver, verified by a probe that got a
// \`full_text_indicator\` back from that host and institution code.

export interface InstitutionResolverEntry {
  rorId: string;
  domains: readonly string[];
  name: string;
  host: string;
  institution: string;
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
  // An address for another product (SFX, EBSCO…) is not a page to read for
  // an Alma code; an Alma or unknown one is the best first page.
  const almaLike = !seed?.product || seed.product === 'alma' || seed.product === 'other';
  let code = seed?.code || record?.code || null;
  let route = seed?.code ? 'seed' : record?.route || null;
  let region = (seed?.host || record?.host || '').split('.')[0] || null;
  // A directory address without a code is read even in a verify run.
  if (!code && (!verifyOnly || (seed?.url && almaLike))) {
    const found = await discoverCode({ ...entry, seedUrl: almaLike ? seed?.url : null, seedSource: seed?.source }, { domains: entry.domains, links: entry.links });
    code = found.code;
    route = found.route;
    region = found.region || region;
    entry.evidence = found.evidence;
  }
  if (!code) {
    const status = seed?.url ? (almaLike ? 'address-located' : 'compatibility-pending') : 'unresolved';
    return { ...entry, code: null, host: null, status };
  }
  const probe = await probeRegions(code, region);
  if (!probe) return { ...entry, code, route, host: null, status: 'code-without-region' };
  const status = probe.indicator ? 'verified' : 'answers-without-indicator';
  return { ...entry, code, route, host: probe.host, services: probe.services, packages: probe.packages, status };
}

async function main() {
  const census = await readJson(CENSUS_FILE, { institutions: {} });
  const seeds = new Map((await readJson(SEEDS_FILE, [])).map(seed => [seed.rorId, seed]));

  let targets;
  if (args.verify) {
    // A verified row is not probed again (`--all` does); what gets probed is
    // every code or seed still without a verified answer.
    targets = Object.values(census.institutions).filter(entry => (entry.code || seeds.has(entry.rorId)) && (args.all || entry.status !== 'verified' || seeds.get(entry.rorId)?.exclude));
  } else {
    const countries = (args.countries || '').split(',').flatMap(code => (code.toUpperCase() === 'EU' ? EUROPE : [code.toUpperCase()])).filter(Boolean);
    if (!countries.length) throw new Error('pass --countries (ISO codes or EU) or --verify');
    targets = await listInstitutions(countries, args.limit ? Number(args.limit) : 0);
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
