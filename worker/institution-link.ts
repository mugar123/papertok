import { isServiceAccountConfigured, FirebaseServiceAccountError } from './firebase-service-account.ts';
import type { WorkerEnv, WorkerGlobals } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FirestoreAdmin, FirestoreWrite } from './firestore-admin.ts';

interface RorRecord { id?: unknown; types?: unknown[]; domains?: unknown[]; names?: Array<{ types?: unknown[]; value?: unknown }> }
export interface ResolvedInstitution { domain: string; rorId: string; name: string; acronym: string | null; entityId: string | null }
interface InstitutionLinkOptions {
  admin?: Pick<FirestoreAdmin, 'name'> & { commit(writes: FirestoreWrite[]): Promise<unknown> };
  fetchImpl?: typeof fetch;
  cache?: { match(request: RequestInfo | URL): Promise<Response | null | undefined>; put(request: RequestInfo | URL, response: Response): Promise<void> } | null;
  now?: () => number;
}


/**
 * Links a verified university email to the signed-in account.
 *
 * The browser cannot write `users/{uid}.institution` itself: the only thing
 * that proves an institution is a verified address in its domain, and the
 * Firestore rules can see the session's own address but not a second Google
 * account the person signed into for this purpose. So the proof is checked
 * here — either the session's address or an ID token of that second account,
 * both through Identity Toolkit — and the field is written with the service
 * identity. The rules keep the field frozen for the client afterwards.
 *
 * What gets stored is the institution, not the address: the domain, the ROR
 * record it resolves to, and the SAML entityID of its identity provider when
 * the federation metadata lists one. The address is the proof and is discarded
 * once the domain is known.
 */

import { institutionDomainOf } from '../src/utils/institution-domain.ts';
import { readBoundedJson } from './bounded-body.ts';
import { verifyFirebaseIdentity, verifyIdToken, WorkerAuthError } from './firebase-auth.ts';
import { isEntityId } from './institution-access.ts';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  FirestoreAdminError,
  mergeWrite,
} from './firestore-admin.ts';

export const INSTITUTION_LINK_PATH = '/institution/link';
export const INSTITUTION_UNLINK_PATH = '/institution/unlink';
export const INSTITUTION_PATHS = new Set([INSTITUTION_LINK_PATH, INSTITUTION_UNLINK_PATH]);

// A Firebase ID token runs to about a kilobyte; the body carries at most one.
const BODY_LIMIT_BYTES = 16_384;
const LOOKUP_TIMEOUT_MS = 6000;
// One budget for every registry question of a link: the browser waits 15 s
// for the whole request, which also verifies one or two tokens and writes
// the document, and one ROR and two federation questions at 6 s each would
// outrun it.
export const LINK_LOOKUP_BUDGET_MS = 10_000;
const ROR_API = 'https://api.ror.org/v2/organizations';
const ROR_ID_PREFIX = 'https://ror.org/';
// SeamlessAccess publishes the eduGAIN metadata as a query service: each entry
// carries the email `scope` its identity provider authenticates.
const FEDERATION_MDQ = 'https://md.seamlessaccess.org/entities/';
const INSTITUTION_CACHE_SECONDS = 7 * 24 * 3600;

export class InstitutionLinkError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = 'InstitutionLinkError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads the body inside the deadline as well: a registry that sends its
 * headers and then stalls is as unavailable as one that never answered.
 */
async function fetchJson<T>(url: string, fetchImpl: typeof fetch, budget: AbortSignal): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.any([budget, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return JSON.parse(text);
}

function rorName(record: RorRecord, type: string) {
  const names = Array.isArray(record?.names) ? record.names : [];
  const match = names.find(name => Array.isArray(name?.types) && name.types.includes(type));
  return typeof match?.value === 'string' && match.value.trim() ? match.value.trim() : null;
}

type CheckedMailDomain = { source: string; checked: string } & ({ rorId: string } | { rorDomain: string });

/**
 * Mail domains checked by hand against the university's own pages: each is a
 * domain the university gives its students or staff, with the page that says
 * so and the date it was read. An address links only when ROR lists its exact
 * domain or when its domain is here. A parent domain proves no membership:
 * alumni.cmu.edu is alumni mail, mgh.harvard.edu a hospital, and nhs.uk or
 * gob.es are public suffixes that ROR lists as organisations.
 *
 * `rorId` names the university's record, which ROR is asked for by id. A
 * student domain then links to the record whose library `/access` serves:
 * `/access` finds a library by ROR id, and a student domain is not among the
 * row's domains. The entry also wins over a record that ROR lists the domain
 * under: ROR lists purdue.edu only under the Clifford B. Kinley Trust
 * (049s7vz13), a funder record, and arizona.edu, univ-lille.fr and slu.se
 * only under sub-units (checked 2026-10-19). It lists lmu.de under LMU and
 * under the Walther-Straub-Institut (02wbcav28), and only the order of its
 * answer decided between them (checked 2026-10-20).
 *
 * `rorDomain` names the domain ROR is asked about instead, for a domain ROR
 * lists under another record: ROR lists neu.edu, the legacy domain of
 * Northeastern in Boston, under Northeastern in Shenyang, and lists
 * northeastern.edu under Boston (04t5xt781). The record found must list that
 * domain. Either way the name and acronym come from ROR.
 *
 * `/access` does not read this list, so a record stored under another
 * organisation is never answered with this university's library.
 */
const CHECKED_MAIL_DOMAINS: Record<string, CheckedMailDomain> = {
  'comunidadunir.net': { rorId: 'https://ror.org/029gnnp81', source: 'https://www.unir.net/eduroam/', checked: '2026-10-21' },
  'campus.lmu.de': { rorId: 'https://ror.org/05591te55', source: 'https://www.lmu.de/en/about-lmu/structure/central-university-administration/it-services-division/it-service-desk/central-it-services/e-mail-mailbox/', checked: '2026-10-20' },
  'lmu.de': { rorId: 'https://ror.org/05591te55', source: 'https://www.lmu.de/en/about-lmu/structure/central-university-administration/it-services-division/it-service-desk/central-it-services/e-mail-dienst-fuer-beschaeftigte/', checked: '2026-10-20' },
  'mytum.de': { rorId: 'https://ror.org/02kkvpp62', source: 'https://www.tum.de/ueber-die-tum/kontakt-und-anfahrt/logins', checked: '2026-10-20' },
  'myumanitoba.ca': { rorId: 'https://ror.org/02gfys938', source: 'https://umanitoba.ca/information-services-technology/my-accounts-email/claim-umnetid', checked: '2026-10-20' },
  'rochester.edu': { rorId: 'https://ror.org/022kthw22', source: 'https://it.rochester.edu/rochedualiaspages/FAQ.aspx', checked: '2026-10-20' },
  'sms.ed.ac.uk': { rorId: 'https://ror.org/01nrxwf90', source: 'https://information-services.ed.ac.uk/computing/comms-and-collab/email/directories/student-directory', checked: '2026-10-20' },
  'student.ethz.ch': { rorId: 'https://ror.org/05a28rw58', source: 'https://blogs.ethz.ch/its/2026/09/11/new-to-eth-your-it-starter-pack-for-your-studies/', checked: '2026-10-20' },
  'sydney.edu.au': { rorId: 'https://ror.org/0384j8v12', source: 'https://www.sydney.edu.au/policies/showdoc.aspx?RendNum=0&recnum=PDOC2011%2F139', checked: '2026-10-20' },
  'u.rochester.edu': { rorId: 'https://ror.org/022kthw22', source: 'https://tech.rochester.edu/faqs/gmail-faqs/', checked: '2026-10-20' },
  'ugent.be': { rorId: 'https://ror.org/00cv9y106', source: 'https://www.ugent.be/student/en/ict/ict-services/account.htm', checked: '2026-10-20' },
  'umail.leidenuniv.nl': { rorId: 'https://ror.org/027bh9e22', source: 'https://researchwiki.solo.universiteitleiden.nl/xwiki/wiki/researchwiki.solo.universiteitleiden.nl/view/Online%20Research/Pavlovia/', checked: '2026-10-20' },
  'umanitoba.ca': { rorId: 'https://ror.org/02gfys938', source: 'https://umanitoba.ca/information-services-technology/my-accounts-email/claim-umnetid', checked: '2026-10-20' },
  'uni.sydney.edu.au': { rorId: 'https://ror.org/0384j8v12', source: 'https://www.sydney.edu.au/students/student-responsibilities/university-correspondence.html', checked: '2026-10-20' },
  'unr.edu': { rorId: 'https://ror.org/01keh0577', source: 'https://library.unr.edu/help/troubleshooting/technology-updates', checked: '2026-10-20' },
  'neu.edu': { rorDomain: 'northeastern.edu', source: 'https://www.northeastern.edu/privacy-information/', checked: '2026-10-19' },
  'husky.neu.edu': { rorDomain: 'northeastern.edu', source: 'https://cssh.northeastern.edu/writingcenter/tutoring/first-visit/', checked: '2026-10-19' },
  'alum.us.es': { rorId: 'https://ror.org/03yxnpp24', source: 'https://cat.us.es/orientacion/guia-de-estudiantes/', checked: '2026-10-19' },
  'alumnes.ub.edu': { rorId: 'https://ror.org/021018s57', source: 'https://www.ub.edu/campusvirtualub/ca/pmf/com-crear-la-teva-adreca-de-correu-ub', checked: '2026-10-19' },
  'alumni.unav.es': { rorId: 'https://ror.org/02rxc7m23', source: 'https://www.unav.edu/web/it/cuentas-y-claves', checked: '2026-10-19' },
  'alumni.uv.es': { rorId: 'https://ror.org/043nxc105', source: 'https://www.uv.es/uvweb/social/en/faculty/office-secretary/faq-1286251981646.html', checked: '2026-10-19' },
  'alumno.uned.es': { rorId: 'https://ror.org/02msb5n36', source: 'https://www.uned.es/universidad/inicio/en/estudios/idiomas/servicios-estudiante/acceso-correo-estudiante.html', checked: '2026-10-19' },
  'alumnos.uc3m.es': { rorId: 'https://ror.org/03ths8210', source: 'https://www.uc3m.es/grado/informacion-practica/llegada-uc3m/correo-uc3m', checked: '2026-10-19' },
  'alumnos.upm.es': { rorId: 'https://ror.org/03n6nwv02', source: 'https://www.upm.es/internacional/UPM/Network%20Services/e-mail', checked: '2026-10-19' },
  'alumnos.uvigo.es': { rorId: 'https://ror.org/05rdf8595', source: 'https://secretaria.uvigo.gal/uv/web/axuda/faq/documento/downloadbyhash/bf55f3e58f46c2cdd74a35e796f4930ccfdc833ec737d74694647c23c0fff004', checked: '2026-10-19' },
  'arizona.edu': { rorId: 'https://ror.org/03m2x1q45', source: 'https://news.arizona.edu/node/21525', checked: '2026-10-19' },
  'autonoma.cat': { rorId: 'https://ror.org/052g8jq94', source: 'https://www.uab.cat/doc/presentacio_acollida_2025_2026', checked: '2026-10-19' },
  'correo.ugr.es': { rorId: 'https://ror.org/04njjy449', source: 'https://csirc.ugr.es/estudiantes/acceso-servicios', checked: '2026-10-19' },
  'estudiant.upf.edu': { rorId: 'https://ror.org/04n0g0b29', source: 'https://www.upf.edu/web/phd-political-and-social-sciences/resources', checked: '2026-10-19' },
  'estudiantat.upc.edu': { rorId: 'https://ror.org/03mb6wj31', source: 'https://serveistic.upc.edu/ca/g-suite-for-education/faq/soc-estudiant-tinc-correu-g-suite-o-correu-google', checked: '2026-10-19' },
  'estudiante.uam.es': { rorId: 'https://ror.org/01cby8j38', source: 'https://www.uam.es/uam/tecnologias-informacion/servicios/correo-electronico', checked: '2026-10-19' },
  'g.ucla.edu': { rorId: 'https://ror.org/046rm7j60', source: 'https://www.psych.ucla.edu/admin-units/information-technology/technical-training-and-how-tos/ucla-email-faq/', checked: '2026-10-19' },
  'mail.utoronto.ca': { rorId: 'https://ror.org/03dbr7087', source: 'https://www.utsc.utoronto.ca/iits/student-email-and-calendar', checked: '2026-10-20' },
  'opendeusto.es': { rorId: 'https://ror.org/00ne6sr39', source: 'https://icttraining.deusto.es/opendeusto-account', checked: '2026-10-19' },
  'purdue.edu': { rorId: 'https://ror.org/02dqehb95', source: 'https://service.purdue.edu/TDClient/32/Purdue/KB/ArticleDet?ID=455', checked: '2026-10-19' },
  'rai.usc.es': { rorId: 'https://ror.org/030eybx10', source: 'https://assets.usc.gal/sites/default/files/paragraphs/moreinfo/2025-09/guia-estudantes-curso-sep-2025.pdf', checked: '2026-10-19' },
  'slu.se': { rorId: 'https://ror.org/02yy8x990', source: 'https://internt.slu.se/en/support-services/administrative-support/communication/templates-and-promotional-items/mallar/email-signature/', checked: '2026-10-19' },
  'student.bham.ac.uk': { rorId: 'https://ror.org/03angcq70', source: 'https://www.birmingham.ac.uk/welcome/essential-tasks/your-next-steps', checked: '2026-10-19' },
  'student.unimelb.edu.au': { rorId: 'https://ror.org/01ej9dk98', source: 'https://studentit.unimelb.edu.au/student-email', checked: '2026-10-20' },
  'terpmail.umd.edu': { rorId: 'https://ror.org/047s2c258', source: 'https://itsupport.umd.edu/kb_view.do?sysparm_article=KB0016507', checked: '2026-10-19' },
  'ull.edu.es': { rorId: 'https://ror.org/01r9z8p25', source: 'https://campusvirtual.ull.es/static/ayuda-soporte/doc/guia_usuarios_estudiante.pdf', checked: '2026-10-19' },
  'unav.es': { rorId: 'https://ror.org/02rxc7m23', source: 'https://www.unav.edu/web/it/cuentas-y-claves', checked: '2026-10-19' },
  'univ-lille.fr': { rorId: 'https://ror.org/02kzqn938', source: 'https://sciences-technologies.univ-lille.fr/filefst/user_upload/sciences_de_la_terre/Secretariat_pedago/Activation_compte_Info_Etudiant.pdf', checked: '2026-10-19' },
  'utexas.edu': { rorId: 'https://ror.org/00hj54h04', source: 'https://catalog.utexas.edu/archive/2025-26/general-information/libraries-and-other-academic-resources/computing-resources/', checked: '2026-10-19' },
};

/** A ROR question; any failure, the budget running out included, is the registry being unavailable. */
async function askRor<T>(url: string, fetchImpl: typeof fetch, budget: AbortSignal): Promise<T> {
  try {
    return await fetchJson<T>(url, fetchImpl, budget);
  } catch {
    throw new InstitutionLinkError('INSTITUTION_LOOKUP_UNAVAILABLE', 502);
  }
}

/**
 * The ROR record for an address's exact domain, asked in one question, with
 * the domain the federation may list the university under (`scope`). For a
 * domain that is not hand-checked, ROR's search is a text query, so the
 * answer is filtered again on the `domains` field: a record that merely
 * mentions the domain somewhere is not a match. Among the records that list
 * it, a university (`types` include `education`) is preferred: ROR lists a
 * university's domain under its research units too, and returns them in no
 * useful order (ugent.be: the Centre for X-ray Tomography before Ghent
 * University, 2026-10-20). A domain listed under no university still links
 * to the first record, as a hospital's or a laboratory's does.
 */
async function lookupRor(domain: string, fetchImpl: typeof fetch, budget: AbortSignal) {
  const checked = CHECKED_MAIL_DOMAINS[domain];
  let record: RorRecord | undefined;
  let scope = domain;
  if (checked && 'rorId' in checked) {
    const answer = await askRor<RorRecord>(`${ROR_API}/${checked.rorId.slice(ROR_ID_PREFIX.length)}`, fetchImpl, budget);
    record = answer?.id === checked.rorId ? answer : undefined;
    const [listed] = Array.isArray(record?.domains) ? record.domains : [];
    if (typeof listed === 'string') scope = listed.toLowerCase();
  } else {
    if (checked) scope = checked.rorDomain;
    const payload = await askRor<{ items?: RorRecord[] }>(`${ROR_API}?query.advanced=${encodeURIComponent(`domains:${scope}`)}`, fetchImpl, budget);
    const listed = (Array.isArray(payload?.items) ? payload.items : []).filter(item => Array.isArray(item?.domains)
      && item.domains.some(value => String(value).toLowerCase() === scope));
    record = listed.find(item => Array.isArray(item.types) && item.types.includes('education')) ?? listed[0];
  }
  const name = record && (rorName(record, 'ror_display') || rorName(record, 'label'));
  if (!record || typeof record.id !== 'string' || !name) throw new InstitutionLinkError('INSTITUTION_NOT_FOUND', 404);
  return { rorId: record.id, name, acronym: rorName(record, 'acronym'), scope };
}

/**
 * The identity provider's entityID, which is how GetFTR and the publishers'
 * sign-in pages name an institution. Optional: an institution outside the
 * federation, or a metadata service that is down, leaves it null rather than
 * blocking the link. Null here means "not found now", not "has none". An
 * entityID in a form the access routes refuse (`isEntityId`) is null too:
 * stored, it would fail every later `/access` request of the account.
 */
async function lookupEntityId(domain: string, fetchImpl: typeof fetch, budget: AbortSignal) {
  // Optional, so a budget already spent on the registry is not spent again.
  if (budget.aborted) return null;
  try {
    const entries = await fetchJson<Array<{ scope?: unknown; entityID?: unknown }>>(`${FEDERATION_MDQ}?q=${encodeURIComponent(domain)}`, fetchImpl, budget);
    const entry = (Array.isArray(entries) ? entries : []).find(candidate => String(candidate?.scope || '')
      .split(',')
      .map(scope => scope.trim().toLowerCase())
      .includes(domain));
    return typeof entry?.entityID === 'string' && isEntityId(entry.entityID) ? entry.entityID : null;
  } catch {
    return null;
  }
}

// The cache is on its fifth generation. Each bump dropped records the code no
// longer accepts: the first could hold a record that does not own its domain
// (neu.edu resolved to Shenyang until 2026-10-19), the second one linked
// through a parent domain (alumni.cmu.edu to CMU), the third the research unit
// ROR listed first for a university's domain (until 2026-10-20), and the
// fourth an entityID the access routes refuse. A hand-checked domain's key
// also names what its entry asks ROR, so the answer cached before an entry was
// added, changed or removed is not served for another week.
function cacheRequest(domain: string) {
  const url = new URL(`https://papertok.internal/institution/v5/${encodeURIComponent(domain)}`);
  const checked = CHECKED_MAIL_DOMAINS[domain];
  if (checked && 'rorId' in checked) url.searchParams.set('rorId', checked.rorId);
  else if (checked) url.searchParams.set('rorDomain', checked.rorDomain);
  return new Request(url);
}

/**
 * What a domain resolves to. Cached a week on success: the registries change
 * slowly and every member of one institution asks the same question. Not
 * found and unavailable are not cached, so a registry outage or a record
 * added tomorrow is not remembered as a refusal. Every registry question
 * shares one `budget`, `LINK_LOOKUP_BUDGET_MS` by default.
 */
export async function resolveInstitution(domain: string, { fetchImpl = fetch, cache = (globalThis as WorkerGlobals).caches?.default, signal: budget = AbortSignal.timeout(LINK_LOOKUP_BUDGET_MS) }: Pick<InstitutionLinkOptions, 'fetchImpl' | 'cache'> & { signal?: AbortSignal } = {}): Promise<ResolvedInstitution> {
  const key = cacheRequest(domain);
  const cached = cache ? await cache.match(key) : null;
  if (cached) return cached.json<ResolvedInstitution>();

  const { scope, ...ror } = await lookupRor(domain, fetchImpl, budget);
  // The federation lists the identity provider by the university's own
  // scope, which a hand-checked student domain may not be.
  const entityId = await lookupEntityId(domain, fetchImpl, budget)
    ?? (scope !== domain ? await lookupEntityId(scope, fetchImpl, budget) : null);
  const institution = { domain, ...ror, entityId };
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(institution), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${INSTITUTION_CACHE_SECONDS}`,
      },
    }));
  }
  return institution;
}

/**
 * The address the link is about. Without a token in the body it is the
 * session's own; with one, the second account's. The second token is verified
 * exactly like the first, but its failures are reported as a bad proof rather
 * than as a lost session, which is what a 401 would tell the browser.
 */
async function proofHolder(request: Request, env: WorkerEnv, identity: VerifiedIdentity) {
  const body = await readBoundedJson<{ institutionToken?: unknown }>(request, BODY_LIMIT_BYTES, {
    tooLarge: () => new InstitutionLinkError('BODY_TOO_LARGE', 413),
    invalid: () => new InstitutionLinkError('INVALID_BODY', 400),
  });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InstitutionLinkError('INVALID_BODY', 400);
  }
  const token = body.institutionToken;
  if (token === undefined || token === null || token === '') return identity;
  if (typeof token !== 'string') throw new InstitutionLinkError('INVALID_BODY', 400);
  try {
    return await verifyIdToken(token, env, { allowCache: false });
  } catch (error) {
    if (error instanceof WorkerAuthError && error.status === 401) {
      throw new InstitutionLinkError('INSTITUTION_TOKEN_INVALID', 400);
    }
    throw error;
  }
}

function userDocument(admin: Pick<FirestoreAdmin, 'name'>, uid: string) {
  return admin.name(['users', uid]);
}

export async function handleInstitutionLinkRequest(request: Request, env: WorkerEnv, options: InstitutionLinkOptions = {}) {
  if (request.method !== 'POST') throw new InstitutionLinkError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new InstitutionLinkError('INSTITUTION_LINK_NOT_CONFIGURED', 503);
  }
  // A write, so no identity cache: a token revoked a moment ago must not link.
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const admin = options.admin || createFirestoreAdmin(env);
  const pathname = new URL(request.url).pathname;

  try {
    if (pathname === INSTITUTION_UNLINK_PATH) {
      await admin.commit([clearFieldsWrite(userDocument(admin, identity.uid), ['institution'])]);
      // A legacy public profile may still hold the copy made while profiles
      // existed; unlinking erases it there too.
      await admin.commit([clearFieldsWrite(admin.name(['userProfiles', identity.uid]), ['institution'])]);
      return { institution: null };
    }

    const holder = await proofHolder(request, env, identity);
    if (!holder.emailVerified) throw new InstitutionLinkError('INSTITUTION_EMAIL_NOT_VERIFIED', 403);
    const domain = institutionDomainOf(holder.email);
    if (!domain) throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);

    const resolved = await resolveInstitution(domain, { fetchImpl: options.fetchImpl, cache: options.cache });
    const institution = { ...resolved, verifiedAt: new Date(options.now?.() ?? Date.now()).toISOString() };
    // No existence precondition: during onboarding the user document may not
    // have been written yet, and the link must not have to wait for it.
    await admin.commit([mergeWrite(userDocument(admin, identity.uid), { institution }, { mustExist: false })]);
    return { institution };
  } catch (error) {
    if (error instanceof InstitutionLinkError || error instanceof WorkerAuthError) throw error;
    if (error instanceof FirestoreAdminError || error instanceof FirebaseServiceAccountError) {
      // Unlinking has nothing to clear in a document that never existed: the
      // user document of an account that never onboarded, or the profile most
      // accounts never had. The precondition failure is that, not a fault.
      if (pathname === INSTITUTION_UNLINK_PATH && error.status === 409) return { institution: null };
      throw new InstitutionLinkError('INSTITUTION_LINK_FAILED', 502);
    }
    throw error;
  }
}
