import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFieldOverrides, compareIndexes, compareRules, firestoreWriteCases, reportContract } from './firestore-rules-check.ts';

test('rules comparison ignores CR and detects source changes and extra files', () => {
  const local = "rules_version = '2';\n// café\n";
  const file = { name: 'firestore.rules', content: "rules_version = '2';\r\n// café\r\n" };
  assert.deepEqual(compareRules(local, { files: [file] }), {
    passed: true, label: 'Firestore rules', detail: 'rules match main (checked-out firestore.rules)',
  });
  assert.deepEqual(compareRules(local.trimEnd(), { files: [file] }), {
    passed: false, label: 'Firestore rules', detail: 'deployed rules differ from firestore.rules',
  });
  assert.equal(compareRules(local, { files: [file, { name: 'other.rules', content: '' }] }).passed, false);
});

const collectionGroup = 'papers';
const queryScope = 'COLLECTION';
const fields = [{ fieldPath: 'createdAt', order: 'DESCENDING' }, { fieldPath: 'tags', arrayConfig: 'CONTAINS' }];
const localIndex = { collectionGroup, queryScope, fields };
const liveIndex = {
  name: 'projects/sample/databases/(default)/collectionGroups/papers/indexes/abc', state: 'READY', queryScope,
  apiScope: 'ANY_API', density: 'SPARSE_ALL', fields: [...fields, { fieldPath: '__name__', order: 'DESCENDING' }],
};

test('index comparison normalizes API metadata and implicit document name ordering', () => {
  const otherLocal = { ...localIndex, collectionGroup: 'reviews' };
  const otherLive = { ...liveIndex, name: liveIndex.name.replace('/papers/', '/reviews/') };
  assert.deepEqual(compareIndexes([localIndex, otherLocal], [otherLive, liveIndex]), {
    passed: true, label: 'Firestore composite indexes', detail: '2 match firestore.indexes.json',
  });
  assert.equal(compareIndexes([], []).passed, true);
});

test('index comparison reports missing, unexpected and unready indexes', () => {
  const reversed = { ...liveIndex, fields: [liveIndex.fields[1], liveIndex.fields[0], liveIndex.fields[2]], state: 'CREATING' };
  assert.deepEqual(compareIndexes([localIndex], [reversed]), {
    passed: false, label: 'Firestore composite indexes', detail: '1 missing, 1 unexpected, 1 not ready',
  });
  assert.equal(compareIndexes([localIndex], [{ ...liveIndex, state: 'CREATING' }]).passed, false);
});

const fieldOverrides = [
  { collectionGroup: 'comments', fieldPath: 'authorUid', indexes: [{ queryScope: 'COLLECTION_GROUP', order: 'ASCENDING' }] },
  { collectionGroup: 'authorMetricReceipts', fieldPath: 'expiresAt', indexes: [], ttl: true },
];
const authorField = {
  name: 'projects/sample/databases/(default)/collectionGroups/comments/fields/authorUid',
  indexConfig: { indexes: [{
    name: '', state: 'READY', queryScope: 'COLLECTION_GROUP',
    fields: [{ fieldPath: 'authorUid', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'ASCENDING' }],
  }] },
};
const receiptField = {
  name: 'projects/sample/databases/(default)/collectionGroups/authorMetricReceipts/fields/expiresAt',
  indexConfig: {}, ttlConfig: { state: 'ACTIVE' },
};

test('field overrides match explicit indexes, empty exemptions and active TTL', () => {
  assert.deepEqual(compareFieldOverrides(fieldOverrides, [receiptField, authorField]), {
    passed: true, label: 'Firestore field overrides and TTL', detail: '2 match firestore.indexes.json',
  });
  assert.equal(compareFieldOverrides(fieldOverrides, [receiptField]).detail, 'comments.authorUid: missing field override');
  assert.equal(compareFieldOverrides(fieldOverrides, [receiptField, {
    ...authorField, indexConfig: { indexes: [{ ...authorField.indexConfig.indexes[0], queryScope: 'COLLECTION' }] },
  }]).detail, 'comments.authorUid: single-field indexes differ');
});

test('an inherited index config and absent TTL do not satisfy an exemption and retention policy', () => {
  assert.deepEqual(compareFieldOverrides(fieldOverrides, [authorField, {
    ...receiptField, indexConfig: { usesAncestorConfig: true }, ttlConfig: null,
  }]), {
    passed: false, label: 'Firestore field overrides and TTL',
    detail: 'authorMetricReceipts.expiresAt: missing index exemption; authorMetricReceipts.expiresAt: missing TTL policy',
  });
});

test('TTL-only fields are checked for readiness and undeclared policies', () => {
  const ttlOnly = { collectionGroup: 'authorMetricReceipts', fieldPath: 'expiresAt', ttl: true };
  const inherited = { ...receiptField, indexConfig: { usesAncestorConfig: true } };
  assert.equal(compareFieldOverrides([ttlOnly], [inherited]).passed, true);
  assert.equal(compareFieldOverrides([ttlOnly], [receiptField]).detail, '1 unexpected single-field index override');
  assert.equal(compareFieldOverrides([ttlOnly], [{ ...inherited, ttlConfig: { state: 'CREATING' } }]).detail,
    'authorMetricReceipts.expiresAt: TTL policy not active');
  assert.deepEqual(compareFieldOverrides([], [inherited]), {
    passed: false, label: 'Firestore field overrides and TTL', detail: '1 unexpected TTL policy',
  });
});

test('an undeclared exemption on lists.paperIds fails the comparison', () => {
  const listsField = {
    name: 'projects/sample/databases/(default)/collectionGroups/lists/fields/paperIds',
    indexConfig: { usesAncestorConfig: false, indexes: [] },
  };
  assert.deepEqual(compareFieldOverrides(fieldOverrides, [authorField, receiptField, listsField]), {
    passed: false, label: 'Firestore field overrides and TTL', detail: '1 unexpected single-field index override',
  });
  assert.equal(compareFieldOverrides(fieldOverrides, [authorField, receiptField, {
    ...listsField, indexConfig: { indexes: [{
      name: '', queryScope: 'COLLECTION', state: 'READY', fields: [{ fieldPath: 'paperIds', order: 'ASCENDING' }],
    }] },
  }]).passed, false);
});

test('the database default is ignored while collection wildcard overrides fail', () => {
  const wildcard = { indexConfig: { indexes: [] } };
  const prefix = 'projects/sample/databases/(default)/collectionGroups';
  assert.equal(compareFieldOverrides([], [{ ...wildcard, name: `${prefix}/__default__/fields/*` }]).passed, true);
  assert.equal(compareFieldOverrides([], [{ ...wildcard, name: `${prefix}/lists/fields/*` }]).passed, false);
});

test('contract reports each failed case without printing API error messages', () => {
  assert.deepEqual(reportContract(['onboarding', 'interactions', 'settings'], { testResults: [
    { state: 'SUCCESS' }, { state: 'FAILURE', errorPosition: { line: 254 } }, { state: 'SUCCESS', debugMessages: ['an upstream message'] },
  ] }), { passed: false, label: 'Firestore write contract', detail: 'failed cases: interactions (rules line 254), settings' });
  assert.deepEqual(reportContract(['onboarding'], { testResults: [{ state: 'SUCCESS' }] }), {
    passed: true, label: 'Firestore write contract', detail: '1 cases passed',
  });
  assert.deepEqual(reportContract(['onboarding'], { testResults: [] }), {
    passed: false, label: 'Firestore write contract', detail: 'Rules API did not return a complete test result',
  });
});

test('the onboarding contract simulates a new profile with all optional onboarding fields', () => {
  const onboarding = firestoreWriteCases().find(entry => entry.label === 'onboarding profile creation');
  assert.ok(onboarding);
  assert.equal(onboarding.testCase.resource, null);
  assert.equal(onboarding.testCase.request.method, 'create');
  assert.deepEqual(onboarding.testCase.request.resource.data, {
    onboardingComplete: true,
    preferences: ['cs.AI'],
    interestMix: 'mostly-work',
    areaPreferences: { ai: { priority: 'curiosity', level: 'beginner' } },
    readingPreferences: { aiExplanationLevel: 'beginner', language: 'en', languagePreferenceSet: true },
  });
});
