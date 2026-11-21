import type { WorkerEnv } from './env.ts';
import type { FirestoreAdmin, FirestoreWrite } from './firestore-admin.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import { AUTHOR_METRIC_CONSENT, AUTHOR_METRIC_RECEIPTS, AUTHOR_METRICS_DEFAULT } from '../src/utils/author-metrics.ts';
import { encodeFirestoreDocId } from '../src/utils/firestore-doc-id.ts';
import { normalizeDoi, normalizePmid } from '../src/utils/public-navigation.ts';
import { doiPathId, getArxivIdFromWork } from '../src/utils/open-alex-work.ts';
import { arxivIdOf } from './paper-store.ts';
import { readBoundedJson } from './bounded-body.ts';
import { verifyFirebaseIdentity } from './firebase-auth.ts';
import { FirebaseServiceAccountError, isServiceAccountConfigured } from './firebase-service-account.ts';
import { createFirestoreAdmin, createWrite, deleteWrite, FirestoreAdminError, mergeWrite } from './firestore-admin.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

const METRIC = 'saves';
const CONFIG = ['authorMetricConfig', METRIC];
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const RECEIPT_MAX_AGE_MS = 120_000;
const WEEKLY_LIMIT = 100;
const MINUTE_LIMIT = 20;

const RECEIPT_CLEANUP_PAGE = 200;
const RECEIPT_CLEANUP_MAX_PAGES = 5;

type MetricsAdmin = Pick<FirestoreAdmin, 'name' | 'batchGet' | 'beginTransaction' | 'commit' | 'rollback'>;
type CleanupAdmin = Pick<FirestoreAdmin, 'name' | 'runQuery' | 'commit'>;
type Config = { enabled?: unknown; launchedAt?: unknown };
type Consent = { enabled?: unknown; changedAt?: unknown };
type SaveReceipt = { savedAt?: unknown; paperId?: unknown };
type SaveEvent = { paperId: string; receipt: string; now: number };

function mondayUtc(ms: number) {
  const date = new Date(ms);
  return Math.floor(ms / DAY_MS) * DAY_MS - ((date.getUTCDay() + 6) % 7) * DAY_MS;
}

function collectionStarted(config: Config | null, week: number) {
  return config?.enabled === true && config.launchedAt instanceof Date
    && week >= mondayUtc(config.launchedAt.getTime()) + WEEK_MS;
}

function canContribute(consent: Consent | null) {
  return (consent?.enabled ?? AUTHOR_METRICS_DEFAULT) === true;
}

function normalizedId(input: unknown) {
  if (typeof input !== 'string' || input.length > 300) return '';
  const doi = normalizeDoi(input.replace(/^doi:/i, '')).toLowerCase();
  const arxivDoi = doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1];
  const arxiv = arxivIdOf((arxivDoi ?? input).toLowerCase().replace(/^((?:arxiv:)?[a-z-]+)\.[a-z]{2}\//, '$1/'));
  if (arxiv) return `arxiv:${arxiv}`;
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) return `doi:${doi}`;
  const openAlex = input.match(/^(?:openalex:|https:\/\/openalex\.org\/)?(W[1-9]\d{0,19})$/i)?.[1];
  return openAlex ? `openalex:${openAlex.toUpperCase()}` : '';
}

async function aliasPath(id: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return ['authorMetricAliases', key];
}

// The exact ID names itself. Only OpenAlex's work lookup can connect different
// identifiers here: the saved copy and the corpus can contain merged metadata.
export async function verifiedIdentifiers(id: string, env: WorkerEnv) {
  if (id.startsWith('arxiv:')) return [id];
  const pubmed = id.startsWith('pmid:');
  const fallback = pubmed ? [] : [id];
  const reference = pubmed ? id
    : id.startsWith('openalex:') ? id.slice('openalex:'.length) : doiPathId(id.slice(4));
  if (!reference) return [id];
  const response = await handleOpenAlex(new Request(
    `https://papertok.internal/openalex/works/${reference}?select=id,doi,ids,locations,primary_location,best_oa_location`,
  ), env);
  if (response.status === 404 || response.status === 400) return fallback;
  if (!response.ok) throw new FirestoreAdminError('AUTHOR_METRICS_IDENTIFIER_LOOKUP_FAILED', 503);
  const work = await response.json<OpenAlexWork>();
  const doi = normalizedId(work?.doi);
  const openAlex = normalizedId(work?.id);
  if (!openAlex.startsWith('openalex:') || (id.startsWith('doi:') && doi !== id)
    || (pubmed && normalizePmid(work?.ids?.pmid) !== id.slice('pmid:'.length))) return fallback;
  const arxiv = normalizedId(getArxivIdFromWork(work));
  return [...new Set([doi, arxiv, openAlex, id].filter(Boolean))];
}

function eligibleSaveTime(saved: SaveReceipt | null, event: SaveEvent, consent: Consent | null) {
  if (!(saved?.savedAt instanceof Date) || saved.paperId !== event.paperId) return null;
  const time = saved.savedAt.getTime();
  if (!Number.isFinite(time) || time > event.now || event.now - time > RECEIPT_MAX_AGE_MS
    || (consent?.changedAt instanceof Date && time < consent.changedAt.getTime())) return null;
  return time;
}

async function recordAuthorSaveOnce(admin: MetricsAdmin, uid: string, event: SaveEvent, ids: string[]) {
  const user = ['users', uid];
  const transaction = await admin.beginTransaction();
  let committed = false;
  try {
    const [config, account, consent, receipt, saved] = await admin.batchGet([
      CONFIG, user, [...user, AUTHOR_METRIC_CONSENT, METRIC],
      [...user, AUTHOR_METRIC_RECEIPTS, event.receipt],
      [...user, 'savedPapers', encodeFirestoreDocId(event.paperId)],
    ], transaction);
    if (!account || account.authorMetricsDeleting || !saved) return;
    if (!canContribute(consent)) return;
    const savedAt = eligibleSaveTime(receipt, event, consent);
    if (savedAt === null) return;
    if (!(saved.savedAt instanceof Date)) return;
    const copyTime = saved.savedAt.getTime();
    if (!Number.isFinite(copyTime) || Math.abs(savedAt - copyTime) > RECEIPT_MAX_AGE_MS
      || (consent?.changedAt instanceof Date && copyTime < consent.changedAt.getTime())) return;
    // A later copy from a second tab must not move an acknowledged receipt
    // forward, and a receipt delayed across midnight follows the save.
    const week = mondayUtc(Math.min(copyTime, savedAt));
    if (!collectionStarted(config, week)) return;

    const weekStart = new Date(week).toISOString().slice(0, 10);
    const path = [...user, 'authorMetricWeeks', `${METRIC}-${weekStart}`];
    const paths = await Promise.all(ids.map(aliasPath));
    const [contribution, ...aliases] = await admin.batchGet<{ paperIds?: string[]; canonicalId?: string }>(
      [path, ...paths], transaction,
    );
    const paperIds = contribution?.paperIds ?? [];
    if (paperIds.length >= WEEKLY_LIMIT) return;
    const existing = new Set(aliases.flatMap(alias => alias?.canonicalId ? [alias.canonicalId] : []));
    if (existing.size > 1) return;
    const canonicalId = [...existing][0] ?? ids[0];
    const writes: FirestoreWrite[] = paths.flatMap((path, index) => aliases[index]
      ? [] : [createWrite(admin.name(path), { canonicalId })]);
    if (!paperIds.includes(canonicalId)) {
      const data = { metric: METRIC, weekStart, paperIds: [...paperIds, canonicalId] };
      const name = admin.name(path);
      writes.push(contribution ? mergeWrite(name, data) : createWrite(name, data));
    }
    if (!writes.length) return;

    await admin.commit(writes, transaction);
    committed = true;
  } finally {
    if (!committed) await admin.rollback(transaction).catch(() => {});
  }
}

export async function recordAuthorSave(admin: MetricsAdmin, uid: string, event: SaveEvent, ids: string[]) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await recordAuthorSaveOnce(admin, uid, event, ids);
      return;
    } catch (error) {
      if (!(error instanceof FirestoreAdminError) || error.status !== 409 || attempt === 2) throw error;
    }
  }
}

export async function handleAuthorSave(request: Request, env: WorkerEnv) {
  const now = Date.now();
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  if (!identity.emailVerified) return 204;

  const invalid = () => new FirestoreAdminError('INVALID_AUTHOR_SAVE', 400);
  const payload = await readBoundedJson<{ paperId?: unknown; receipt?: unknown } | null>(request, 2048, { tooLarge: invalid, invalid });
  const paperId = payload?.paperId;
  const receipt = payload?.receipt;
  if (typeof paperId !== 'string' || !paperId.trim() || paperId.length > 300
    || typeof receipt !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt)) throw invalid();
  const id = normalizedId(paperId) || paperId.match(/^pmid:[1-9]\d{0,11}$/)?.[0];
  if (!id) return 204;
  const event = { paperId, receipt, now };

  const admin = createFirestoreAdmin(env);
  const config = await admin.getDocument<Config>(CONFIG);
  if (!collectionStarted(config, mondayUtc(now))) return 204;
  const user = ['users', identity.uid];
  const consent = await admin.getDocument<Consent>([...user, AUTHOR_METRIC_CONSENT, METRIC]);
  if (!canContribute(consent)) return 204;

  const minute = Math.floor(now / 60_000);
  const rate = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `author-metrics:saves:${minute}`,
    subject: `${minute}:${identity.uid}`,
    subjectLimit: MINUTE_LIMIT,
    globalLimit: MINUTE_LIMIT,
    globalAmount: 0,
    expiresAt: (minute + 2) * 60_000,
  });
  if (!rate.accepted) return rate.scope === 'user' ? 429 : 503;
  const saved = await admin.getDocument<SaveReceipt>([...user, AUTHOR_METRIC_RECEIPTS, receipt]);
  if (eligibleSaveTime(saved, event, consent) === null) return 204;

  const existing = await admin.getDocument(await aliasPath(id));
  const ids = existing ? [id] : await verifiedIdentifiers(id, env);
  if (!ids.length) return 204;
  await recordAuthorSave(admin, identity.uid, event, ids);
  return 204;
}

/**
 * Deletes save receipts whose `expiresAt` has passed: the ones a browser
 * closed before deleting. Firestore TTL would need billing, so the daily
 * harvest cron runs this instead. An expired receipt can no longer count
 * (the Worker accepts receipts for two minutes), so deleting it changes
 * nothing but what is stored.
 *
 * Each page is one query and one commit of plain deletes. A commit lands
 * whole or not at all, and deleting a receipt the browser already removed
 * succeeds, so a failure at any point leaves the next run the same query.
 * Every query costs at least one Firestore read even when empty, and each
 * receipt it returns costs one more.
 */
export async function deleteExpiredAuthorReceipts(admin: CleanupAdmin, now: number) {
  let deleted = 0;
  for (let page = 0; page < RECEIPT_CLEANUP_MAX_PAGES; page += 1) {
    const rows = await admin.runQuery({
      collectionId: AUTHOR_METRIC_RECEIPTS,
      allDescendants: true,
      where: { field: 'expiresAt', op: 'LESS_THAN', value: new Date(now) },
      limit: RECEIPT_CLEANUP_PAGE,
      select: ['__name__'],
    });
    if (rows.length) await admin.commit(rows.map(row => deleteWrite(admin.name(row.path))));
    deleted += rows.length;
    if (rows.length < RECEIPT_CLEANUP_PAGE) return { deleted, complete: true };
  }
  return { deleted, complete: false };
}

/**
 * The daily entry point. It never throws: a failed run, including a query
 * refused while its index is still building, leaves every receipt for the
 * next day. The log carries the error code only, never a document name.
 */
export async function runAuthorReceiptCleanup(env: WorkerEnv, now: number) {
  if (!isServiceAccountConfigured(env)) return;
  try {
    const { deleted, complete } = await deleteExpiredAuthorReceipts(createFirestoreAdmin(env), now);
    if (!complete) console.warn('Author receipt cleanup stopped at its cap', deleted);
  } catch (error) {
    const known = error instanceof FirestoreAdminError || error instanceof FirebaseServiceAccountError;
    console.error('Author receipt cleanup failed', known ? error.message : 'unexpected error');
  }
}
