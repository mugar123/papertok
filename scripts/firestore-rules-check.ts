import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { areasForInterests, normalizeInterestSettings } from '../src/utils/area-preferences.ts';
import { AUTHOR_METRIC_CONSENT, AUTHOR_METRIC_RECEIPTS } from '../src/utils/author-metrics.ts';
import { interestPreferencesWrite, onboardingProfileWrite } from '../src/utils/profile-writes.ts';
import { normalizeReadingPreferences } from '../src/utils/user-settings.ts';

const project = 'projects/papertok-168df';
const rulesApi = 'https://firebaserules.googleapis.com/v1';
const database = `${project}/databases/(default)`;

type Source = { files: { name: string; content: string }[] };
type IndexField = {
  fieldPath: string; order?: string; arrayConfig?: string; vectorConfig?: { dimension: number; flat: object };
};
type Index = {
  queryScope: string; apiScope?: string; density?: string; multikey?: boolean; unique?: boolean; fields: IndexField[];
};
type LocalIndex = Index & { collectionGroup: string };
type LiveIndex = Index & { name: string; state: string };
type Report = { passed: boolean; label: string; detail: string };

export function compareRules(local: string, deployed: Source): Report {
  // Firebase uploads a single UTF-8 source file. Ignore CR and preserve all other bytes.
  const passed = deployed.files.length === 1 && deployed.files[0].name === 'firestore.rules'
    && local.replaceAll('\r', '') === deployed.files[0].content.replaceAll('\r', '');
  return { passed, label: 'Firestore rules', detail: passed ? 'rules match main (checked-out firestore.rules)' : 'deployed rules differ from firestore.rules' };
}

function indexKey(collectionGroup: string, index: Index) {
  const fields = index.fields.map(({ fieldPath, order, arrayConfig, vectorConfig }) =>
    [fieldPath, order, arrayConfig, vectorConfig?.dimension ?? null]);
  // Match firebase deploy's Standard Edition normalization, including vector indexes.
  const namePosition = index.fields.at(-1)?.vectorConfig ? fields.length - 1 : fields.length;
  if (fields[namePosition - 1]?.[0] !== '__name__') {
    fields.splice(namePosition, 0, ['__name__', index.fields.findLast(field => field.order)?.order ?? 'ASCENDING', undefined, null]);
  }
  return JSON.stringify([collectionGroup, index.queryScope, index.apiScope ?? 'ANY_API',
    index.density ?? 'SPARSE_ALL', index.multikey ?? false, index.unique ?? false, fields]);
}

export function compareIndexes(local: LocalIndex[], deployed: LiveIndex[]): Report {
  const expected = new Set(local.map(index => indexKey(index.collectionGroup, index)));
  const actual = new Set(deployed.map(index => indexKey(index.name.split('/').at(-3) ?? '', index)));
  const missing = [...expected].filter(key => !actual.has(key)).length;
  const unexpected = [...actual].filter(key => !expected.has(key)).length;
  const unready = deployed.filter(index => index.state !== 'READY').length;
  const passed = missing === 0 && unexpected === 0 && unready === 0;
  return { passed, label: 'Firestore composite indexes', detail: passed ? `${expected.size} match firestore.indexes.json`
    : `${missing} missing, ${unexpected} unexpected, ${unready} not ready` };
}

const uid = 'papertok-rules-smoke';
const documents = '/databases/(default)/documents';
const userPath = `${documents}/users/${uid}`;
const time = '2026-12-01T12:00:00Z';

function mockLookup(fn: 'get' | 'exists', path: string, value: unknown) {
  return { function: fn, args: [{ exactValue: path }], result: { value } };
}

function contractCase(label: string, path: string, data: object, options: {
  before?: object; method?: 'update' | 'create'; deny?: boolean;
  functionMocks?: ReturnType<typeof mockLookup>[];
} = {}) {
  const method = options.method ?? 'update';
  return { label, testCase: {
    expectation: options.deny ? 'DENY' : 'ALLOW',
    request: {
      method, path: `${userPath}${path}`, time,
      auth: { uid: options.deny ? 'papertok-other-smoke-user' : uid, token: { email_verified: true } },
      resource: { data },
    },
    // Omission triggers a null-value error on `resource == null` in the simulator.
    resource: method === 'create' ? null : { data: options.before ?? {} },
    functionMocks: options.functionMocks ?? [],
  } };
}

export function firestoreWriteCases() {
  const preferences = ['cs.AI'];
  const settings = normalizeInterestSettings({
    interestMix: 'mostly-work', areaPreferences: { ai: { priority: 'curiosity', level: 'beginner' } },
  }, areasForInterests(preferences));
  const reading = normalizeReadingPreferences({ aiExplanationLevel: 'beginner', languagePreferenceSet: true });
  const profile = onboardingProfileWrite(preferences, settings, reading);
  // The worker stores this as a string. The simulator promotes ISO strings to
  // timestamps, so use an opaque string to exercise the connection equality.
  const connectedAt = 'smoke-orcid-connection';
  const consent = `/${AUTHOR_METRIC_CONSENT}/saves`;
  const accountMocks = [mockLookup('exists', userPath, true), mockLookup('get', userPath, { data: profile })];
  return [
    contractCase('onboarding profile creation', '', profile, { method: 'create' }),
    contractCase('onboarding profile merge', '', profile),
    contractCase('another account’s onboarding profile', '', profile, { deny: true }),
    contractCase('interest settings', '', { ...profile, ...interestPreferencesWrite(['cs.LG'], ['cs.AI'], ['cs.LG'], settings, settings) }, { before: profile }),
    contractCase('email digest setting', '', { ...profile, emailDigestOptIn: true }, { before: profile }),
    contractCase('privacy notice setting', '/settings/privacyNotice', { shownVersion: '2026-11-06' }),
    contractCase('following updates setting', '/settings/followingUpdates', { seenIds: ['smoke-paper'], updatedAt: time }),
    contractCase('custom feeds setting', '/settings/customFeeds', { feeds: [], updatedAt: time }),
    // The simulator interprets RFC 3339 strings as timestamps in comparisons with request.time.
    contractCase('ORCID work decisions', '/orcid/works', { connectedAt, mine: ['openalex:W1'], notMine: ['openalex:W2'], updatedAt: time }, {
      functionMocks: [mockLookup('get', userPath, { data: { orcid: { connectedAt } } })],
    }),
    contractCase('author metrics consent', consent, { enabled: true, changedAt: time }, { functionMocks: accountMocks }),
    contractCase('author metrics receipt', `/${AUTHOR_METRIC_RECEIPTS}/00000000-0000-4000-8000-000000000000`, {
      paperId: 'smoke-paper', savedAt: time, expiresAt: '2026-12-01T12:05:00Z',
    }, { method: 'create', functionMocks: [
      ...accountMocks,
      mockLookup('exists', `${userPath}${consent}`, false),
      mockLookup('get', `${documents}/authorMetricConfig/saves`, {
        data: { enabled: true, launchedAt: '2026-11-01T12:00:00Z' },
      }),
    ] }),
    contractCase('paper interaction', '/interactions/smoke-paper', {
      liked: true, saved: true, readLater: false, paperTitle: 'Smoke fixture', paperAuthors: ['Test Author'],
      paperCategory: 'cs.AI', timestamp: time,
    }),
  ];
}

export function reportContract(labels: string[], result: {
  testResults?: { state?: string; debugMessages?: string[]; errorPosition?: { line?: number } }[];
  issues?: { severity?: string }[];
}): Report {
  const label = 'Firestore write contract';
  if (result.issues?.some(issue => issue.severity === 'ERROR') || result.testResults?.length !== labels.length) {
    return { passed: false, label, detail: 'Rules API did not return a complete test result' };
  }
  const failures = labels.flatMap((name, index) => {
    const test = result.testResults?.[index];
    if (test?.state === 'SUCCESS' && !test.debugMessages?.length && !test.errorPosition) return [];
    const line = test?.errorPosition?.line;
    return [line && Number.isSafeInteger(line) && line > 0 ? `${name} (rules line ${line})` : name];
  });
  return { passed: failures.length === 0, label, detail: failures.length ? `failed cases: ${failures.join(', ')}` : `${labels.length} cases passed` };
}

class CheckError extends Error {}

async function jsonRequest<T>(stage: string, url: string, init?: RequestInit): Promise<T> {
  const signal = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) throw new CheckError(`${stage} returned HTTP ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError(`${stage} ${signal.aborted ? 'timed out' : 'failed or returned invalid JSON'}`);
  }
}

async function accessToken(cli: boolean) {
  const form = new URLSearchParams();
  let url = 'https://oauth2.googleapis.com/token';
  if (cli) {
    const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'configstore', 'firebase-tools.json');
    const { tokens } = JSON.parse(readFileSync(config, 'utf8')) as { tokens?: { refresh_token?: string } };
    if (!tokens?.refresh_token) throw new CheckError('Firebase CLI login not configured');
    // Public installed-app OAuth client published in firebase/firebase-tools src/api.ts.
    url = 'https://www.googleapis.com/oauth2/v3/token';
    form.set('client_id', process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com');
    form.set('client_secret', process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi');
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', tokens.refresh_token);
  } else {
    const key = process.env.FIREBASE_RULES_READER_KEY;
    if (!key?.trim()) throw new CheckError('FIREBASE_RULES_READER_KEY not configured');
    const credential = JSON.parse(key) as { type?: string; client_email?: string; private_key?: string };
    if (credential.type !== 'service_account' || !credential.client_email || !credential.private_key) {
      throw new CheckError('FIREBASE_RULES_READER_KEY must contain service-account key JSON');
    }
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: credential.client_email, aud: url, iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/firebase.readonly https://www.googleapis.com/auth/datastore',
    })}`;
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    form.set('assertion', `${claims}.${sign('RSA-SHA256', Buffer.from(claims), credential.private_key).toString('base64url')}`);
  }
  const token = await jsonRequest<{ access_token?: string }>('Google OAuth token exchange', url, { method: 'POST', body: form });
  if (!token.access_token) throw new CheckError('Google OAuth response omitted the access token');
  return token.access_token;
}

async function main() {
  let failed = false;
  const print = ({ passed, label, detail }: Report) => {
    failed ||= !passed;
    console.log(`- ${passed ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  };
  const report = async (label: string, check: () => Promise<void>) => {
    try {
      await check();
    } catch (error) {
      print({ passed: false, label, detail: error instanceof CheckError ? error.message : 'Could not read or validate the check inputs' });
    }
  };

  await report('Firestore credentials', async () => {
    const cli = process.argv.includes('--firebase-cli-token');
    const token = await accessToken(cli);
    const headers = { Authorization: `Bearer ${token}` };
    await Promise.all([
      report('Firestore rules and write contract', async () => {
        const release = await jsonRequest<{ rulesetName?: string }>('Rules release lookup', `${rulesApi}/${project}/releases/cloud.firestore`, { headers });
        if (!/^projects\/papertok-168df\/rulesets\/[\w-]+$/.test(release.rulesetName ?? '')) {
          throw new CheckError('Rules release omitted a valid ruleset name');
        }
        const { source } = await jsonRequest<{ source: Source }>('Ruleset source lookup', `${rulesApi}/${release.rulesetName}`, { headers });
        print(compareRules(readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), source));
        const cases = firestoreWriteCases();
        const result = await jsonRequest<Parameters<typeof reportContract>[1]>('Rules API write tests', `${rulesApi}/${project}:test`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, testSuite: { testCases: cases.map(entry => entry.testCase) } }),
        });
        print(reportContract(cases.map(entry => entry.label), result));
      }),
      report('Firestore composite indexes', async () => {
        const local = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')) as { indexes: LocalIndex[] };
        const indexes: LiveIndex[] = [];
        const url = new URL(`https://firestore.googleapis.com/v1/${database}/collectionGroups/-/indexes`);
        const seen = new Set<string>();
        while (true) {
          const page = await jsonRequest<{ indexes?: LiveIndex[]; nextPageToken?: string }>('Firestore index lookup', url.href, {
            headers: cli ? { ...headers, 'x-goog-user-project': 'papertok-168df' } : headers,
          });
          indexes.push(...(page.indexes ?? []));
          const pageToken = page.nextPageToken;
          if (!pageToken) break;
          if (seen.has(pageToken)) throw new CheckError('Firestore index lookup repeated a page');
          seen.add(pageToken);
          url.searchParams.set('pageToken', pageToken);
        }
        print(compareIndexes(local.indexes, indexes));
      }),
    ]);
  });
  if (failed) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
