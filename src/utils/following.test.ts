import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFollowEntity,
  createFollowKey,
  followsEntity,
  migrateLegacyAuthors,
  normalizeFollowId,
} from './following.ts';
import { getProjectDisplayName } from './entity-metadata.ts';

test('normalizes provider URLs into stable ids', () => {
  assert.equal(normalizeFollowId('https://openalex.org/A123'), 'A123');
  assert.equal(normalizeFollowId('https://ror.org/02f40zc51'), '02f40zc51');
  assert.equal(createFollowKey('institution', 'https://openalex.org/I1'), 'institution_I1');
});

test('matches by id and falls back to normalized display name', () => {
  const followed = [{ type: 'author' as const, canonicalId: 'A1', displayName: 'José García' }];
  assert.equal(followsEntity(followed, { type: 'author' as const, id: 'https://openalex.org/A1', name: 'Other' }), true);
  assert.equal(followsEntity(followed, { type: 'author' as const, id: 'legacy:jose', name: 'Jose Garcia' }), true);
});

test('migrates unique legacy authors', () => {
  const migrated = migrateLegacyAuthors(['Ada Lovelace', 'Ada Lovelace']);
  assert.equal(migrated.length, 1);
  assert.deepEqual(createFollowEntity(migrated[0])?.type, 'author');
});

test('removes undefined provider fields before persisting a follow', () => {
  const follow = createFollowEntity({
    type: 'author' as const,
    id: 'A1',
    displayName: 'Ada',
    externalIds: { orcid: undefined, semanticScholar: 'S1' },
    metadata: { categoryIds: [undefined!, 'cs.AI'] },
  });
  assert.deepEqual(follow!.externalIds, { semanticScholar: 'S1' });
  assert.deepEqual(follow!.metadata!.categoryIds, ['cs.AI']);
});

/**
 * A grant code is not unique across funders, so `searchProjects().id` moved
 * from the bare code to the OpenAIRE id (`prefix::hash`), and the Explorer's
 * entity id moved with it. Both feed `canonicalId`, which is the Firestore
 * document key — so a project followed before that change is stored under
 * `project_100010` while both surfaces now compute
 * `project_snsf________::…`. The displayName fallback in `followsEntity` is
 * the only thing that still recognises those follows.
 *
 * Those follows come in two populations, stored under two spellings of the
 * same name: the search box wrote the acronym alone, the Explorer writes
 * `${acronym}: ${title}` (see getProjectDisplayName). Teaching one surface the
 * other's spelling only swaps which population is orphaned, and an orphaned
 * follow shows an unfilled heart on a project the reader already follows, so
 * the click writes a second document for it — a duplicate row in Following
 * settings, a duplicated entity in the feed and the digest, and an unfollow
 * that has to be done twice. Both spellings have to answer to both.
 */
test('a project followed under its old grant-code id is recognised under either spelling of its name', () => {
  const row = {
    id: 'snsf________::daa28096f9e8879ab3a02b90aa0e2f83',
    code: '100010',
    acronym: 'QUANTUMLEAP',
    title: 'Quantum leap in photonics',
  };
  const bareName = row.acronym;
  const fullName = getProjectDisplayName(row);
  const storedUnder = (displayName: string) => [{
    type: 'project' as const,
    canonicalId: '100010',
    displayName,
    source: 'openaire',
  }];
  const probeWith = (displayName: string) => ({ type: 'project' as const, id: row.id, displayName });

  assert.equal(
    followsEntity(storedUnder(bareName), probeWith(bareName)),
    true,
    'the old search box stored the acronym and probed with it',
  );
  assert.equal(
    followsEntity(storedUnder(bareName), probeWith(fullName)),
    true,
    'a follow stored by the old search box, probed by any surface today',
  );
  assert.equal(
    followsEntity(storedUnder(fullName), probeWith(bareName)),
    true,
    'a follow stored by the Explorer, probed with the acronym alone',
  );
  assert.equal(
    followsEntity(storedUnder(fullName), probeWith(fullName)),
    true,
    'the Explorer stored the full name and probes with it',
  );
});

/**
 * The narrow half of the rule above. The acronym is read as a name only when
 * it is the WHOLE segment heading the other spelling, and only for a project:
 * the displayName fallback serves every followable type, and two authors or
 * two institutions whose names share a prefix are still two entities.
 */
test('one spelling of a project name never pulls a different entity in with it', () => {
  const project = [{ type: 'project' as const, canonicalId: '100010', displayName: 'LEAP: Quantum leap in photonics' }];
  assert.equal(
    followsEntity(project, { type: 'project' as const, id: 'corda____h2020::abc', displayName: 'LEAP: Leadership in Europe' }),
    false,
    'two projects sharing an acronym but not a title are two projects',
  );
  assert.equal(
    followsEntity(project, { type: 'project' as const, id: 'corda____h2020::abc', displayName: 'LEAP Quantum' }),
    false,
    'a shared opening is not a shared name without the separator',
  );
  const acronymOnly = [{ type: 'project' as const, canonicalId: '100010', displayName: 'LEAP' }];
  assert.equal(
    followsEntity(acronymOnly, { type: 'project' as const, id: 'corda____h2020::abc', displayName: 'LEAPFROG: Fast leaps' }),
    false,
    'an acronym that merely opens another acronym is a different project',
  );

  const author = [{ type: 'author' as const, canonicalId: 'A1', displayName: 'Ada Lovelace' }];
  assert.equal(
    followsEntity(author, { type: 'author' as const, id: 'A2', displayName: 'Ada Lovelace: a life' }),
    false,
    'no type but project reads a colon as a separator',
  );
  const institution = [{ type: 'institution' as const, canonicalId: 'I1', displayName: 'Sorbonne' }];
  assert.equal(
    followsEntity(institution, { type: 'institution' as const, id: 'I2', displayName: 'Sorbonne: Faculty of Law' }),
    false,
    'nor does an institution and one of its faculties collapse into one follow',
  );
});

/**
 * Why a page must never hand a placeholder name to a follow. Two nameless
 * projects — an OpenAIRE outage makes several at once — carrying one shared
 * stand-in name are the SAME follow to everything downstream: the second one's
 * heart comes up filled, and `toggleFollow` resolves the click against the
 * first, deleting its document. A name the entity does not have is no name:
 * it yields no follow at all, and matches nothing.
 */
test('a nameless entity is no follow, and a shared placeholder name would have been one', () => {
  const followedProject = [{
    type: 'project' as const,
    canonicalId: 'snsf________::aaa',
    displayName: 'QUANTUMLEAP: Quantum leap in photonics',
  }];

  assert.equal(
    createFollowEntity({ type: 'project' as const, id: 'snsf________::bbb', displayName: '' }),
    null,
    'no name, no follow to write',
  );
  assert.equal(
    followsEntity(followedProject, { type: 'project' as const, id: 'snsf________::bbb', displayName: '' }),
    false,
    'and an empty name matches nothing, rather than everything',
  );
  assert.equal(
    followsEntity([{ type: 'project' as const, canonicalId: 'snsf________::aaa', displayName: '' }],
      { type: 'project' as const, id: 'snsf________::bbb', displayName: 'LEAP' }),
    false,
    'from either side of the comparison',
  );

  // The shape of the bug, kept as the reason: one stand-in name on two
  // different projects IS one follow here, and no rule in this module can tell
  // them apart — so the stand-in has to stop at the page that renders it.
  const placeholder = 'Research project';
  assert.equal(
    followsEntity([{ type: 'project' as const, canonicalId: 'snsf________::aaa', displayName: placeholder }],
      { type: 'project' as const, id: 'snsf________::bbb', displayName: placeholder }),
    true,
    'two different projects under one placeholder name are indistinguishable',
  );
});

// ENG-123: a journal is followed by its OpenAlex source id. Its ISSN-L rides
// along for display; a name or an ISSN alone is no journal to follow.
test('a journal is followed by its OpenAlex source id, never by its name or ISSN', () => {
  assert.deepEqual(createFollowEntity({
    type: 'journal',
    id: 'https://openalex.org/S23254222',
    displayName: 'American Economic Review',
    source: 'openalex',
    externalIds: { issnl: '0002-8282' },
  }), {
    type: 'journal',
    canonicalId: 'S23254222',
    displayName: 'American Economic Review',
    source: 'openalex',
    externalIds: { issnl: '0002-8282' },
    metadata: {},
  });
  assert.equal(createFollowKey('journal', 'S23254222'), 'journal_S23254222');
  assert.equal(createFollowEntity({ type: 'journal', displayName: 'American Economic Review' }), null);
  assert.equal(createFollowEntity({ type: 'journal', id: '0002-8282', displayName: 'American Economic Review' }), null);

  // OpenAlex lists distinct sources under one name; only the id tells them apart.
  const followed = [{ type: 'journal' as const, canonicalId: 'S23254222', displayName: 'Economic Review' }];
  assert.equal(followsEntity(followed, { type: 'journal', id: 'S23254222', displayName: 'American Economic Review' }), true);
  assert.equal(followsEntity(followed, { type: 'journal', id: 'S99999999', displayName: 'Economic Review' }), false);
});

test('a project name is its acronym and its title, or whichever of the two it has', () => {
  assert.equal(getProjectDisplayName({ acronym: 'LEAP', title: 'Quantum leap' }), 'LEAP: Quantum leap');
  assert.equal(getProjectDisplayName({ title: 'Quantum leap' }), 'Quantum leap');
  assert.equal(getProjectDisplayName({ acronym: 'LEAP' }), 'LEAP');
  assert.equal(getProjectDisplayName(null), '');
});
