import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const firestore = `
  export * from ${JSON.stringify(import.meta.resolve('firebase/firestore'))};
  const records = new Map();
  export const doc = (_, ...parts) => parts.join('/');
  export const getDoc = async path => ({ get: key => records.get(path)?.[key], metadata: { fromCache: false } });
  export const setDoc = (path, data) => records.set(path, data);
  export const runTransaction = (_, update) => update({ get: getDoc, set: setDoc });
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier !== 'firebase/firestore' ? next(specifier, context) : {
      url: 'data:text/javascript,' + encodeURIComponent(firestore),
      shortCircuit: true,
    };
  },
});
const { readAccountPmfSurvey, saveAccountPmfSurvey } = await import('./pmf-survey-service.ts');
hooks.deregister();

test('ENG-249: an account with no record reads as never asked, and the first ask creates it', async () => {
  const { signal } = new AbortController();
  assert.equal(await readAccountPmfSurvey('new-reader', signal), null);
  await saveAccountPmfSurvey('new-reader', '0.3.0');
  assert.equal(await readAccountPmfSurvey('new-reader', signal), '0.3.0');
});

test('ENG-249: a tab on an older version cannot lower the account record, and versions compare as numbers', async () => {
  const { signal } = new AbortController();
  await saveAccountPmfSurvey('reader', '0.10.0');
  await saveAccountPmfSurvey('reader', '0.9.0');
  assert.equal(await readAccountPmfSurvey('reader', signal), '0.10.0');
  await saveAccountPmfSurvey('reader', '0.10.1');
  assert.equal(await readAccountPmfSurvey('reader', signal), '0.10.1');
});
