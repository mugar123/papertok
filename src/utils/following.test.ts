import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFollowEntity,
  createFollowKey,
  followChangeEvent,
  followSnapshotAction,
  followsEntity,
  isRetiredFollow,
  migrateLegacyAuthors,
  splitRetiredFollows,
  normalizeFollowId,
  planFollowToggle,
} from './following.ts';
import { getProjectDisplayName } from './entity-metadata.ts';
import { ANALYTICS_CONSENT, sanitizeProductEventParams } from '../services/analytics-service.ts';

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

// Journal follows were retired (ENG-123's follow). A journal is still a
// custom feed's ingredient, but no longer a follow, and a stored one is
// retired: the follow list deletes it when it loads.
test('a journal is no longer a follow, and a stored one is retired', () => {
  assert.equal(createFollowEntity({ type: 'journal', id: 'https://openalex.org/S23254222', displayName: 'American Economic Review' }), null);
  assert.equal(followsEntity([{ type: 'journal' as const, canonicalId: 'S23254222', displayName: 'American Economic Review' }],
    { type: 'journal', id: 'S23254222', displayName: 'American Economic Review' }), false);
  assert.equal(isRetiredFollow({ type: 'journal' }), true);
  assert.deepEqual(['author', 'topic', 'institution', 'project'].filter(type => isRetiredFollow({ type })), []);
});

test('a stored journal follow is kept from the app and deleted once, by its document id, and again after a failed delete', () => {
  const author = { type: 'author', canonicalId: 'A1', displayName: 'Ada' };
  const journal = { type: 'journal', canonicalId: 'S23254222', displayName: 'American Economic Review' };
  const docs = [{ id: 'author_A1', follow: author }, { id: 'journal_S23254222', follow: journal }];
  const deleting = new Set<string>();
  assert.deepEqual(splitRetiredFollows(docs, deleting), { kept: [author], toDelete: ['journal_S23254222'] });
  assert.deepEqual(splitRetiredFollows(docs, deleting), { kept: [author], toDelete: [] }, 'a delete under way is not asked again');
  deleting.delete('journal_S23254222');
  assert.deepEqual(splitRetiredFollows(docs, deleting).toDelete, ['journal_S23254222'], 'a failed delete is asked again');
  assert.deepEqual(splitRetiredFollows([{ id: 'author_A1', follow: author }], new Set()), { kept: [author], toDelete: [] });
});

test('a press of Follow adds what the list lacks and removes what it holds', () => {
  const author = createFollowEntity({ type: 'author', id: 'A1', displayName: 'Ada' })!;
  const topic = createFollowEntity({ type: 'topic', id: 'cs.LG', displayName: 'Machine Learning' })!;
  assert.deepEqual(planFollowToggle([topic], author), { existing: undefined, next: [topic, author] });
  assert.deepEqual(planFollowToggle([topic, author], author), { existing: author, next: [topic] });
});

// ENG-192: `follow_change` carries a verified provider id or none at all.
test('a follow reaches analytics with its id only when the id is a verified provider id', () => {
  const sentId = (input: Parameters<typeof createFollowEntity>[0]) => {
    const entity = createFollowEntity(input)!;
    const params = sanitizeProductEventParams('follow_change', followChangeEvent(entity, false), ANALYTICS_CONSENT.ENABLED);
    assert.equal(params.entity_type, entity.type);
    assert.equal(params.action, 'add');
    return params.entity_id;
  };
  assert.equal(sentId({ type: 'author', id: 'https://openalex.org/A5023888391', displayName: 'Wei Zhang' }), 'A5023888391');
  assert.equal(sentId({ type: 'author', id: 'https://orcid.org/0000-0002-1825-009X', displayName: 'Wei Zhang' }), '0000-0002-1825-009X');
  assert.equal(sentId({ type: 'institution', id: 'https://openalex.org/I1321305853', displayName: 'MIT' }), 'I1321305853');
  assert.equal(sentId({ type: 'institution', id: 'https://ror.org/042nb2s44', displayName: 'MIT' }), '042nb2s44');
  assert.equal(sentId({ type: 'topic', id: 'T10604', displayName: 'Topic' }), 'T10604');
  assert.equal(sentId({ type: 'topic', id: 'C41008148', displayName: 'Computer science' }), 'C41008148');
  assert.equal(sentId({ type: 'topic', id: 'cs.LG', displayName: 'Machine Learning' }), 'cs.LG');
  assert.equal(sentId({ type: 'topic', id: 'physics', displayName: 'Physics' }), 'physics', 'an area of the app taxonomy');

  assert.equal(sentId(migrateLegacyAuthors(['Ada Lovelace'])[0]), undefined, 'a legacy author id is the name');
  assert.equal(sentId({ type: 'author', displayName: 'Ada Lovelace' }), undefined, 'a nameless id falls back to the name');
  assert.equal(sentId({ type: 'institution', id: 'mit', displayName: 'MIT' }), undefined);
  assert.equal(sentId({ type: 'topic', id: 'query-3f419c36', displayName: 'Spatial transcriptomics' }), undefined, 'a followed search');
  assert.equal(sentId({ type: 'author', id: 'T10604', displayName: 'Wei Zhang' }), undefined, 'a topic id is no author');
  assert.equal(sentId({ type: 'project', id: '101034344', displayName: 'A grant' }), undefined);
  assert.equal(sentId({ type: 'project', id: 'my-thesis-on-ada', displayName: 'Typed in the address bar' }), undefined, 'route text');
});

test('a project name is its acronym and its title, or whichever of the two it has', () => {
  assert.equal(getProjectDisplayName({ acronym: 'LEAP', title: 'Quantum leap' }), 'LEAP: Quantum leap');
  assert.equal(getProjectDisplayName({ title: 'Quantum leap' }), 'Quantum leap');
  assert.equal(getProjectDisplayName({ acronym: 'LEAP' }), 'LEAP');
  assert.equal(getProjectDisplayName(null), '');
});

// With the connection down, Firestore answers a list it never reached with an
// empty snapshot from its cache. Taken as the follow list, the Following page
// told an account with follows that it followed nothing.
test('an empty follow list from the cache waits for the server; follows the cache holds are listed', () => {
  const snapshot = (size: number, fromCache: boolean, changes = size) => ({
    size, empty: size === 0, metadata: { fromCache }, docChanges: () => Array.from({ length: changes }),
  });
  assert.equal(followSnapshotAction(snapshot(0, true), 'waiting'), 'wait');
  assert.equal(followSnapshotAction(snapshot(0, true), 'failed'), 'wait', 'a listener started again waits the same way');
  assert.equal(followSnapshotAction(snapshot(3, true), 'waiting'), 'list', 'follows in the cache are follows');
  assert.equal(followSnapshotAction(snapshot(0, false), 'waiting'), 'list', 'the server says there are none');
  // The server confirming the same documents changes only their metadata.
  assert.equal(followSnapshotAction(snapshot(3, false, 0), 'listed'), 'confirm');
  assert.equal(followSnapshotAction(snapshot(2, true, 1), 'listed'), 'list', 'an unfollow made offline still leaves the list');
});

// Two institutions can share a name (Universidad Nacional in several countries,
// "Institute of Physics"). Each has its own OpenAlex id.
test('two institutions with different ids and one name are two follows', () => {
  const first = { type: 'institution' as const, id: 'I111', displayName: 'Institute of Physics', externalIds: { ror: '02f40zc51' } };
  const second = { type: 'institution' as const, id: 'I222', displayName: 'Institute of Physics', externalIds: { ror: '01ggx4157' } };

  const followed = [createFollowEntity(first)!];
  assert.equal(followsEntity(followed, first), true);
  assert.equal(followsEntity(followed, second), false, 'following the first does not show the second as followed');

  // Pressing the second adds it; it does not remove the first.
  const afterSecond = planFollowToggle(followed, createFollowEntity(second)!);
  assert.equal(afterSecond.existing, undefined);
  assert.deepEqual(afterSecond.next.map(follow => follow.canonicalId), ['I111', 'I222']);

  // Pressing the first again removes only the first.
  const afterFirstAgain = planFollowToggle(afterSecond.next, createFollowEntity(first)!);
  assert.deepEqual(afterFirstAgain.next.map(follow => follow.canonicalId), ['I222']);
});

test('an institution is the same follow under its OpenAlex id and its ROR id', () => {
  const followed = [createFollowEntity({ type: 'institution', id: 'I111', displayName: 'University of Oxford', externalIds: { ror: 'https://ror.org/052gg0110' } })!];
  assert.equal(followsEntity(followed, { type: 'institution', id: '052gg0110', displayName: 'Oxford' }), true);
  assert.equal(followsEntity(followed, { type: 'institution', id: 'https://openalex.org/I111', displayName: 'Another name' }), true);
});

test('a follow stored by name alone is still recognised by name, whichever id the probe carries', () => {
  const legacy = [{ type: 'institution' as const, canonicalId: 'sorbonne university', displayName: 'Sorbonne University' }];
  assert.equal(followsEntity(legacy, { type: 'institution', id: 'I39804081', displayName: 'Sorbonne University' }), true);
  assert.equal(followsEntity(legacy, { type: 'institution', id: 'I1', displayName: 'Sorbonne' }), false);

  const verified = [{ type: 'institution' as const, canonicalId: 'I39804081', displayName: 'Sorbonne University' }];
  assert.equal(followsEntity(verified, { type: 'institution', displayName: 'Sorbonne University' }), true, 'a probe without an id is matched by name');
});

// A follow saved before externalIds carried the ROR id holds only the OpenAlex id,
// and a search result from ROR passes only the ROR id: no namespace in common.
test('an OpenAlex-id follow is recognised by a ROR-id control for the same name, and unfollowed, not duplicated', () => {
  const stored = [createFollowEntity({ type: 'institution', id: 'I184999862', displayName: 'Universidad de Salamanca' })!];
  const control = { type: 'institution' as const, id: '02f40zc51', displayName: 'Universidad de Salamanca', externalIds: { ror: '02f40zc51' } };
  assert.equal(followsEntity(stored, control), true);

  const toggled = planFollowToggle(stored, createFollowEntity(control)!);
  assert.equal(toggled.existing?.canonicalId, 'I184999862');
  assert.deepEqual(toggled.next, [], 'unfollowed, with no second follow added');

  const otherName = { ...control, displayName: 'Universidad de Valladolid' };
  assert.equal(followsEntity(stored, otherName), false, 'the name still has to agree when no id can');
});

test('two institutions with different ids in one namespace stay two follows, whichever namespace', () => {
  const rorOnly = [createFollowEntity({ type: 'institution', id: '02f40zc51', displayName: 'Institute of Physics' })!];
  assert.equal(followsEntity(rorOnly, { type: 'institution', id: '01ggx4157', displayName: 'Institute of Physics' }), false);
  const toggled = planFollowToggle(rorOnly, createFollowEntity({ type: 'institution', id: '01ggx4157', displayName: 'Institute of Physics' })!);
  assert.deepEqual(toggled.next.map(follow => follow.canonicalId), ['02f40zc51', '01ggx4157']);

  // A shared id settles it even when the OpenAlex ids differ (a duplicate OpenAlex record).
  const bothIds = [createFollowEntity({ type: 'institution', id: 'I1', displayName: 'University of Oxford', externalIds: { ror: '052gg0110' } })!];
  assert.equal(followsEntity(bothIds, { type: 'institution', id: 'I2', displayName: 'Oxford', externalIds: { ror: '052gg0110' } }), true);
  // And different ids in a shared namespace beat a shared name even where another namespace has no answer.
  assert.equal(followsEntity(bothIds, { type: 'institution', id: 'I2', displayName: 'University of Oxford' }), false);
});

test('a control with an OpenAlex id and a ROR id meets a follow by whichever id agrees', () => {
  const byOpenAlex = createFollowEntity({ type: 'institution', id: 'I1', displayName: 'Institute of Physics' })!;
  const byRor = createFollowEntity({ type: 'institution', id: '02f40zc51', displayName: 'Institute of Physics' })!;
  const control = { type: 'institution' as const, id: 'I2', displayName: 'Institute of Physics', externalIds: { ror: '02f40zc51' } };

  assert.equal(followsEntity([byOpenAlex], control), false, 'a different OpenAlex id is a different institution');
  assert.equal(followsEntity([byRor], control), true);
  const toggled = planFollowToggle([byOpenAlex, byRor], createFollowEntity(control)!);
  assert.deepEqual(toggled.next.map(follow => follow.canonicalId), ['I1'], 'only the follow that agrees is removed');
});

// OpenAlex splits one person across several author ids, so authors keep
// matching as they did before ENG-123: by id, then by normalized name.
test('authors are matched by id, then by name, whatever other ids they carry', () => {
  const stored = [createFollowEntity({ type: 'author', id: 'A1', displayName: 'Josiah Carberry', externalIds: { orcid: '0000-0002-1825-0097' } })!];

  // The reader's profile of a card author: an OpenAlex id of its own, no ORCID.
  const profile = { type: 'author' as const, id: 'A2', displayName: 'Josiah Carberry' };
  assert.equal(followsEntity(stored, profile), true);
  const toggled = planFollowToggle(stored, createFollowEntity(profile)!);
  assert.equal(toggled.existing?.canonicalId, 'A1');
  assert.deepEqual(toggled.next, [], 'unfollowed, with no second author added');

  // The card's author: the same ORCID, or none, beside another OpenAlex id.
  assert.equal(followsEntity(stored, { ...profile, name: 'Josiah Carberry', externalIds: { orcid: '0000-0002-1825-0097' } }), true);
  assert.equal(followsEntity(stored, { type: 'author', id: 'https://openalex.org/A2', name: 'Josiah Carberry' }), true);
  // A shared id still settles it, and another name does not match.
  assert.equal(followsEntity(stored, { type: 'author', id: 'https://openalex.org/A1', name: 'Someone Else' }), true);
  assert.equal(followsEntity(stored, { type: 'author', id: 'A2', name: 'Someone Else' }), false);
  assert.equal(followsEntity(stored, { type: 'author', id: '0000-0002-1825-0097', name: 'Someone Else' }), false);
});
