import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork } from '../services/adapters/openAlexTypes.ts';
import { paperLegacyAdapter, storedClassification } from '../models/Paper.ts';
import { mapEuropePmcSearchResult } from '../services/domainSourceService.ts';
import { mapOpenAlexEnrichmentWork } from '../services/openAlexService.ts';
import { areaLabelForPaper } from '../utils/areaAccent.ts';
import { cardsGivenTopic, getOpenAlexEnrichmentId, mergeOpenAlexEnrichment } from '../utils/feedEnrichment.ts';
import { definedFields } from '../utils/feedInteractions.ts';
import { serializeLibraryPaper } from '../utils/readingLibrary.ts';
import { buildSavedPaperPayload } from '../utils/savedPaperPayload.ts';

// The feed's own save callbacks, run with React state and Firestore injected.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
function callback(source: string, name: string, deps: string) {
  const from = source.indexOf(`const ${name} = useCallback(`);
  const to = source.indexOf(`\n  }, [${deps}]);`, from);
  assert.ok(from >= 0 && to > from, `${name} must exist`);
  return stripTypeScriptTypes(source.slice(from + `const ${name} = useCallback(`.length, to) + '\n  }');
}
const feedContext = read('./FeedContext.tsx');
const keepLateTopicsCode = callback(feedContext, 'keepLateTopics', 'withInteractionId, personalLibrary, user?.uid');
const toggleReadLaterCode = callback(feedContext, 'toggleReadLater', 'withInteractionId, personalLibrary, recordProfileEvent, user?.uid');
const markSavedCode = callback(feedContext, 'markSaved', 'withInteractionId, papers, reRankFeed, recordProfileEvent, countEngagement, traverseAndExpandNetwork, user?.uid');
const restoreSaveCode = callback(read('../hooks/useQuickSave.ts'), 'restoreSave', 'interactionIdFor, language, user');
const compile = (code: string, scope: object) => new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
const ref = <T,>(current: T) => ({ current });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

type Fields = Record<string, unknown>;
type DocRef = { path: string };
const isMap = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const mergeInto = (stored: Fields, sent: Fields): Fields => Object.fromEntries([...Object.entries(stored), ...Object.entries(sent)
  .map(([key, value]) => [key, isMap(value) && isMap(stored[key]) ? mergeInto(stored[key], value) : value])]);

// Firestore as the client sees it: a write is in the client's view as soon
// as it is issued, and acknowledged later. `issued` runs while a write is in
// flight, before the code that sent it resumes.
function firestore(issued: (path: string, data: Fields) => void) {
  const docs = new Map<string, Fields>();
  const counts = { reads: 0 };
  const setDoc = async (doc: DocRef, data: Fields, options?: { merge?: boolean }) => {
    const sent = JSON.parse(JSON.stringify(data)) as Fields;
    const stored = docs.get(doc.path);
    docs.set(doc.path, options?.merge && stored ? mergeInto(stored, sent) : sent);
    issued(doc.path, sent);
    await tick();
  };
  const getDoc = async (doc: DocRef) => {
    counts.reads += 1;
    const data = docs.get(doc.path);
    return { ref: doc, exists: () => data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined) };
  };
  const updateDoc = async (doc: DocRef, fields: Fields) => {
    const stored = docs.get(doc.path);
    if (!stored) throw new Error('not-found');
    for (const [path, value] of Object.entries(fields)) {
      const keys = path.split('.');
      const parent = keys.slice(0, -1).reduce((map, key) => map[key] as Fields, stored);
      parent[keys.at(-1)!] = value;
    }
  };
  return { docs, counts, setDoc, getDoc, updateDoc };
}

const works = JSON.parse(readFileSync(new URL('../utils/openAlexWorks.fixture.json', import.meta.url), 'utf8')) as { named: OpenAlexWork[] };
const work = works.named.find(entry => entry.id?.endsWith('W2120490784'))!;
// Europe PMC's record of the cat-embryo paper, which has no field of its own
// until OpenAlex answers: Genetics, so Biology. Only the DOI is real.
const shown = mapEuropePmcSearchResult({
  id: '1', source: 'MED', pmid: '1', doi: work.doi!, title: work.title!, firstPublicationDate: '2002-11-01',
})!;
const records = { [getOpenAlexEnrichmentId(shown)]: mapOpenAlexEnrichmentWork(work)!.enrichment };

/**
 * A feed holding `shown`. `answerWhen` picks the write during which the late
 * OpenAlex answer lands; it lands as followShownPapers delivers it: the
 * committed keepLateTopics gets the cards the merge gave a topic, then the
 * merged cards commit.
 */
function feed(answerWhen: (path: string, data: Fields) => boolean) {
  const state = { papers: [shown] as Paper[], personalLibrary: {} as Record<string, Fields>, libraryPapers: {} as Record<string, Fields> };
  const refs = {
    savedPaperIdsRef: ref(new Set<string>()), likedPaperIdsRef: ref(new Set<string>()), readPaperIdsRef: ref(new Set<string>()),
    papersRef: ref(state.papers), keepLateTopicsRef: ref<(cards: Paper[]) => void>(() => {}),
    saveState: ref({}),
  };
  let answered = false;
  const answer = () => {
    answered = true;
    render();
    const before = refs.papersRef.current;
    const after = mergeOpenAlexEnrichment(before, records);
    refs.keepLateTopicsRef.current(cardsGivenTopic(before, after));
    state.papers = after;
    render();
  };
  const store = firestore((path, data) => { if (!answered && answerWhen(path, data)) answer(); });
  // One render: every callback closes over the state of this render, and
  // the commit publishes them, as the provider's refs and effects do.
  function render() {
    const scope = {
      ...refs, setDoc: store.setDoc, getDoc: store.getDoc, updateDoc: store.updateDoc,
      user: { uid: 'reader' }, IS_DEMO: false, language: 'en', papers: state.papers, personalLibrary: state.personalLibrary,
      withInteractionId: <T,>(paper: T) => paper, interactionIdFor: (paper: Paper) => paper.id,
      interactionDocRef: (uid: string, id: string) => ({ path: `users/${uid}/interactions/${id}` }),
      savedPaperDocRef: (uid: string, id: string) => ({ path: `users/${uid}/savedPapers/${id}` }),
      setPersonalLibrary: (update: (current: Record<string, Fields>) => Record<string, Fields>) => { state.personalLibrary = update(state.personalLibrary); },
      setLibraryPapers: (update: (current: Record<string, Fields>) => Record<string, Fields>) => { state.libraryPapers = update(state.libraryPapers); },
      setSavedPaperIds: () => {}, demoSet: () => {}, writeListMembership: async () => {},
      storedClassification, serializeLibraryPaper, buildSavedPaperPayload, definedFields, cardsGivenTopic,
      getDeviceInfo: () => ({ type: 'desktop' }), boredomLevel: ref(0), temporalPreference: ref(0),
      traverseAndExpandNetwork: () => {}, countEngagement: () => {}, recordProfileEvent: () => {}, reRankFeed: () => {},
    };
    const markSaved = compile(markSavedCode, scope);
    refs.keepLateTopicsRef.current = compile(keepLateTopicsCode, scope);
    refs.saveState.current = { savedPaperIds: refs.savedPaperIdsRef.current, personalLibrary: state.personalLibrary, toggleReadLater: compile(toggleReadLaterCode, scope), markSaved };
    refs.papersRef.current = state.papers;
    return { restoreSave: compile(restoreSaveCode, scope), markSaved, setDoc: store.setDoc, savedPaperDocRef: scope.savedPaperDocRef };
  }
  const copies = () => {
    const interaction = store.docs.get(`users/reader/interactions/${shown.id}`)!;
    const saved = store.docs.get(`users/reader/savedPapers/${shown.id}`)!;
    return { interaction, saved, interactionCopy: paperLegacyAdapter(interaction.paper as Partial<Paper>), savedCopy: paperLegacyAdapter({ id: shown.id, ...saved }) };
  };
  return { render, answer, copies, counts: store.counts, isAnswered: () => answered };
}

const savedPapersWrite = (path: string) => path.includes('/savedPapers/');
const readLaterWrite = (path: string, data: Fields) => path.includes('/interactions/') && data.readLater === true;
const savedMarkWrite = (path: string, data: Fields) => path.includes('/interactions/') && data.saved === true;

// PAP-60, D6. The Save button writes the savedPapers document, then Read
// later, and only then records the saved mark. An answer landing before the
// mark found the paper unmarked and stored nothing, and the copies, reloaded,
// showed no field while the card said Biology.
for (const [during, answerWhen] of [
  ['the savedPapers write', savedPapersWrite],
  ['the Read later write', readLaterWrite],
  ["the saved mark's write", savedMarkWrite],
] as const) {
  test(`a Save tapped before OpenAlex answers keeps the card's field when the answer lands during ${during}`, async () => {
    assert.equal(areaLabelForPaper(shown), null, 'the card had no field when tapped');
    const { render, copies, isAnswered } = feed(answerWhen);
    await render().restoreSave(shown, [], true);
    await tick();
    assert.ok(isAnswered(), 'the answer landed during the save');

    const { interaction, saved, interactionCopy, savedCopy } = copies();
    assert.equal(areaLabelForPaper(interactionCopy), 'Biology', 'interaction copy');
    assert.equal(areaLabelForPaper(savedCopy), 'Biology', 'savedPapers document');
    // Only the topic is added: the categories and version are what the save stored.
    const asTapped = JSON.parse(JSON.stringify(serializeLibraryPaper(shown)));
    assert.deepEqual({ ...(interaction.paper as Fields), primaryTopic: undefined }, { ...asTapped, primaryTopic: undefined });
    assert.deepEqual(saved.categories, asTapped.categories);
    assert.equal(saved.classificationVersion, asTapped.classificationVersion);
    assert.deepEqual(saved.primaryTopic, storedClassification(mergeOpenAlexEnrichment([shown], records)[0]).primaryTopic);
  });
}

// The save sheet holds the card as it was when the sheet opened. It writes
// the savedPapers document and then records the mark, after an answer that
// found the paper unmarked.
test('a save from a sheet opened before OpenAlex answered keeps the field the card now shows', async () => {
  const { render, answer, copies } = feed(() => false);
  answer();
  const { setDoc, savedPaperDocRef, markSaved } = render();
  await setDoc(savedPaperDocRef('reader', shown.id), buildSavedPaperPayload(shown, '2026-10-21T12:00:00.000Z'), { merge: true });
  await markSaved(shown);
  await tick();
  const { interactionCopy, savedCopy } = copies();
  assert.equal(areaLabelForPaper(interactionCopy), 'Biology', 'interaction copy');
  assert.equal(areaLabelForPaper(savedCopy), 'Biology', 'savedPapers document');
});

test('a save of a card that already shows its topic reads nothing back', async () => {
  const { render, answer, copies, counts } = feed(() => false);
  answer();
  const [card] = mergeOpenAlexEnrichment([shown], records);
  await render().restoreSave(card, [], true);
  await tick();
  assert.equal(counts.reads, 0);
  assert.equal(areaLabelForPaper(copies().savedCopy), 'Biology');
});
