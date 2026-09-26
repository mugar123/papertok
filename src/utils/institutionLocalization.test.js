import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalizedInstitutionName } from './institutionLocalization.js';

test('uses a verified English ROR label', () => {
  const institution = {
    display_name: 'Universidad de Salamanca',
    localized_names: {
      es: 'Universidad de Salamanca',
      en: 'University of Salamanca',
    },
  };

  assert.equal(getLocalizedInstitutionName(institution), 'University of Salamanca');
  assert.equal(institution.display_name, 'Universidad de Salamanca');
});

test('supports localized names stored with a followed institution', () => {
  const follow = {
    type: 'institution',
    displayName: 'Universidad de Salamanca',
    metadata: {
      localizedNames: {
        en: 'University of Salamanca',
      },
    },
  };

  assert.equal(getLocalizedInstitutionName(follow), 'University of Salamanca');
});

test('keeps the official name when ROR has no verified translation', () => {
  const institution = { display_name: 'KU Leuven' };

  assert.equal(getLocalizedInstitutionName(institution), 'KU Leuven');
});

test('returns an empty label while an institution is still loading', () => {
  assert.equal(getLocalizedInstitutionName(null), '');
  assert.equal(getLocalizedInstitutionName(undefined), '');
});
