/**
 * P18 — why public lists are not validated in firestore.rules. Measurement,
 * not reasoning.
 *
 * Publishing a list was broken in production: not a logic bug but the
 * Firestore ceiling of 1000 expressions evaluated per request. This file
 * reproduces that against the emulator and measures the whole design space, and
 * it is the evidence behind F11 in `docs/plan/04-PHASES.md` — moving the write
 * to the Worker instead of trimming the validator.
 *
 * It runs against a FIXTURE of the rules as they shipped when publishing broke,
 * not against `firestore.rules`, which no longer contains any of this: the
 * validators are gone and clients cannot write `publicLists` at all (that half
 * is asserted in `firestore.rules.test.js`, against the live file). Keeping the
 * fixture means the question "could we not just slim the validator down?" can
 * be re-answered with numbers in a couple of minutes rather than re-derived.
 *
 * Method calqued from p17-measure.test.js: variants are built by string surgery
 * with anchors asserted verbatim, and the only trusted signal is
 * allowed/denied — denial traces mention "1000 expressions" for unrelated
 * reasons, so classifying by message lies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, writeBatch, serverTimestamp, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const ALICE = 'alice-uid';
const SHARE = '0'.repeat(32);
const LIST_ID = 'list-1';

// ---------------------------------------------------------------------------
// The fixture: publicLists as it stood the day publishing broke.
// ---------------------------------------------------------------------------

const HISTORICAL_RULES = `rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    function validString(value, maximum) {
      return value is string && value.size() <= maximum;
    }

    function validBoundedStringList(values, maximumItems, maximumLength) {
      return values is list
        && values.size() <= maximumItems
${Array.from({ length: 20 }, (_, i) => (
    `        && (values.size() < ${i + 1} || validString(values[${i}], maximumLength))`
  )).join('\n')};
    }

    function validPublicPaper(paper) {
      return paper is map
        && paper.keys().hasOnly([
          'id', 'title', 'authors', 'abstract', 'year', 'date', 'category',
          'concepts', 'citations', 'doi', 'arxivId', 'openUrl'
        ])
        && paper.keys().hasAll(['id', 'title', 'authors'])
        && validString(paper.id, 300) && paper.id.size() > 0
        && validString(paper.title, 500) && paper.title.size() > 0
        && validBoundedStringList(paper.authors, 20, 160)
        && (!('abstract' in paper) || validString(paper.abstract, 3000))
        && (!('year' in paper) || paper.year is int && paper.year >= 1000 && paper.year <= 3000)
        && (!('date' in paper) || validString(paper.date, 40))
        && (!('category' in paper) || validString(paper.category, 120))
        && (!('concepts' in paper) || validBoundedStringList(paper.concepts, 12, 120))
        && (!('citations' in paper)
          || paper.citations is int && paper.citations >= 0 && paper.citations <= 1000000000)
        && (!('doi' in paper)
          || validString(paper.doi, 300) && paper.doi.matches('^10\\\\.[0-9]{4,9}/.+$'))
        && (!('arxivId' in paper)
          || validString(paper.arxivId, 100)
            && paper.arxivId.matches('^([A-Za-z-]+(\\\\.[A-Z]{2})?/[0-9]{7}|[0-9]{4}\\\\.[0-9]{4,5})(v[0-9]+)?$'))
        && (!('openUrl' in paper)
          || validString(paper.openUrl, 2000) && paper.openUrl.matches('^https://[^[:space:]]+$'));
    }

    function validPublicPapers(papers) {
      return papers is list
        && papers.size() <= 12
${Array.from({ length: 12 }, (_, i) => (
    `        && (papers.size() < ${i + 1} || validPublicPaper(papers[${i}]))`
  )).join('\n')};
    }

    function validPublicList() {
      return request.resource.data.keys().hasOnly([
          'title', 'description', 'language', 'paperCount',
          'papers', 'createdAt', 'updatedAt'
        ])
        && validString(request.resource.data.title, 120)
        && request.resource.data.title.size() > 0
        && request.resource.data.language in ['es', 'en']
        && request.resource.data.paperCount is int
        && request.resource.data.paperCount == request.resource.data.papers.size()
        && validPublicPapers(request.resource.data.papers)
        && request.resource.data.createdAt is timestamp
        && request.resource.data.updatedAt is timestamp;
    }

    function ownsPublicListAfter(shareId) {
      return request.auth != null
        && existsAfter(/databases/$(database)/documents/publicListOwners/$(shareId))
        && getAfter(/databases/$(database)/documents/publicListOwners/$(shareId)).data.ownerId
          == request.auth.uid;
    }

    match /publicLists/{shareId} {
      allow read: if true;
      allow create: if ownsPublicListAfter(shareId)
        && request.resource.data.createdAt == request.time
        && request.resource.data.updatedAt == request.time
        && validPublicList();
    }

    match /publicListOwners/{shareId} {
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid
        && getAfter(
          /databases/$(database)/documents/users/$(request.auth.uid)/lists/$(request.resource.data.listId)
        ).data.publicShareId == shareId;
    }

    match /users/{userId}/lists/{listId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const HOST = process.env.FIRESTORE_EMULATOR_HOST.split(':')[0];
const PORT = Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const created = [];
let sequence = 0;

async function envFor(rules, attempt = 0) {
  sequence += 1;
  try {
    const env = await initializeTestEnvironment({
      projectId: `papertok-p18-${sequence}-${attempt}`,
      firestore: { rules, host: HOST, port: PORT },
    });
    created.push(env);
    return env;
  } catch (error) {
    // The emulator intermittently answers 500 to loadRules under repeated
    // project creation; a retry with a fresh project id gets through.
    if (attempt < 3) return envFor(rules, attempt + 1);
    throw error;
  }
}
test.after(async () => {
  for (const env of created) await env.cleanup();
});

async function allowed(run) {
  try { await run(); return true; } catch { return false; }
}

const PAPER_FN = /\s{4}function validPublicPaper\(paper\) \{[\s\S]*?\n {4}\}/;
function withPaperBody(rules, lines) {
  assert.match(rules, PAPER_FN, 'validPublicPaper must have been found');
  const body = [
    '    function validPublicPaper(paper) {',
    '      return paper is map',
    ...lines,
    '    }',
  ].join('\n').replace(/\n {4}}$/, ';\n    }');
  // A replacer function, not a string: the openUrl regex ends in `$'`, which
  // String.replace would expand as "everything after the match".
  return rules.replace(PAPER_FN, () => body);
}

function splice(rules, anchor, replacement, label) {
  assert.ok(rules.includes(anchor), `anchor not found verbatim: ${label}`);
  assert.equal(rules.split(anchor).length, 2, `anchor not unique: ${label}`);
  return rules.replace(anchor, () => replacement);
}

// ---------------------------------------------------------------------------
// Payloads, shaped as sanitizePublicPaper() leaves them.
// ---------------------------------------------------------------------------

const paper = (i, authors, concepts, abstractLength = 1200) => ({
  id: `arxiv:2608.${String(18000 + i)}`,
  title: `A perfectly ordinary paper number ${i}`,
  authors: Array.from({ length: authors }, (_, a) => `Author ${a} of paper ${i}`),
  abstract: 'x'.repeat(abstractLength),
  year: 2026,
  date: '2026-08-01',
  category: 'cs.LG',
  ...(concepts ? { concepts: Array.from({ length: concepts }, (_, c) => `concept ${c}`) } : {}),
  citations: 42,
  doi: `10.1234/papertok.${i}`,
  arxivId: `2608.${String(18000 + i)}`,
  openUrl: `https://arxiv.org/abs/2608.${String(18000 + i)}`,
});
/** The cheapest paper those rules accepted: the three required keys. */
const minimalPaper = i => ({ id: `p${i}`, title: `T${i}`, authors: ['A'] });

const listBody = papers => ({
  title: 'My public list',
  language: 'es',
  paperCount: papers.length,
  papers,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
});

/** The write the app made: the three-document batch publishPublicList() commits. */
async function realPublish(env, papers) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE, 'lists', LIST_ID), {
      id: LIST_ID, name: 'My list', paperIds: [], createdAt: new Date(),
    });
  });
  const db = env.authenticatedContext(ALICE).firestore();
  return allowed(() => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'publicListOwners', SHARE), {
      ownerId: ALICE, listId: LIST_ID, createdAt: serverTimestamp(),
    });
    batch.set(doc(db, 'publicLists', SHARE), listBody(papers));
    batch.update(doc(db, 'users', ALICE, 'lists', LIST_ID), { publicShareId: SHARE });
    return batch.commit();
  });
}

/** Highest N in 1..12 whose whole publish batch is allowed. */
async function ceiling(rules, build) {
  const env = await envFor(rules);
  let best = 0;
  for (let n = 1; n <= 12; n += 1) {
    if (!await realPublish(env, Array.from({ length: n }, (_, i) => build(i)))) break;
    best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// A — the reproduction.
// ---------------------------------------------------------------------------

test('A: those rules could not publish one realistic paper', async () => {
  const cases = [
    ['20 authors, 12 concepts, every field (what the app writes)', i => paper(i, 20, 12)],
    ['20 authors, 12 concepts, 10-char abstract', i => paper(i, 20, 12, 10)],
    ['5 authors, 3 concepts, every field', i => paper(i, 5, 3)],
    ['1 author, no concepts, every field', i => paper(i, 1, 0)],
    ['id + title + one author, nothing else', minimalPaper],
  ];
  console.log('\n  [papers that survived the real publish batch]');
  const results = [];
  for (const [label, build] of cases) {
    const n = await ceiling(HISTORICAL_RULES, build);
    results.push(n);
    console.log(`  ${label.padEnd(50)} -> ${n} of 12`);
  }
  assert.equal(results[0], 0, 'a full-fat paper did not publish even alone: this WAS the bug');
  assert.equal(results[0], results[1], 'payload SIZE never mattered, only clause count');
  assert.ok(results[4] > results[2], 'a cheaper paper published more of itself');
});

// ---------------------------------------------------------------------------
// B — where the budget went. One clause removed at a time.
// ---------------------------------------------------------------------------

const CLAUSE = {
  authors: '        && validBoundedStringList(paper.authors, 20, 160)\n',
  concepts: "        && (!('concepts' in paper) || validBoundedStringList(paper.concepts, 12, 120))\n",
  hasOnly: `        && paper.keys().hasOnly([
          'id', 'title', 'authors', 'abstract', 'year', 'date', 'category',
          'concepts', 'citations', 'doi', 'arxivId', 'openUrl'
        ])\n`,
  scalars: `        && (!('abstract' in paper) || validString(paper.abstract, 3000))
        && (!('year' in paper) || paper.year is int && paper.year >= 1000 && paper.year <= 3000)
        && (!('date' in paper) || validString(paper.date, 40))
        && (!('category' in paper) || validString(paper.category, 120))\n`,
};
const without = (rules, ...names) => names.reduce(
  (acc, name) => splice(acc, CLAUSE[name], '', name), rules,
);

test('B: the two list unrolls were the sink, even at one element', async () => {
  const rich = i => paper(i, 20, 12);
  const rows = [
    ['as shipped', HISTORICAL_RULES],
    ['minus the authors element check', without(HISTORICAL_RULES, 'authors')],
    ['minus the concepts element check', without(HISTORICAL_RULES, 'concepts')],
    ['minus both list element checks', without(HISTORICAL_RULES, 'authors', 'concepts')],
    ['minus hasOnly', without(HISTORICAL_RULES, 'hasOnly')],
    ['minus abstract/year/date/category', without(HISTORICAL_RULES, 'scalars')],
  ];
  console.log('\n  [rich payload; one clause removed at a time]');
  const scores = {};
  for (const [label, rules] of rows) {
    scores[label] = await ceiling(rules, rich);
    console.log(`  ${label.padEnd(40)} -> ${scores[label]} of 12`);
  }
  assert.ok(
    scores['minus both list element checks'] > scores['minus hasOnly'],
    'the list unrolls cost more than the 12-key allowlist',
  );

  // The same check, with a ONE-element list, still cost the earth:
  // `values.size()` is re-evaluated on all 20 unrolled lines.
  const oneAuthor = i => paper(i, 1, 0);
  const withCheck = await ceiling(HISTORICAL_RULES, oneAuthor);
  const noCheck = await ceiling(without(HISTORICAL_RULES, 'authors'), oneAuthor);
  console.log(`  one-author paper, authors checked  -> ${withCheck} of 12`);
  console.log(`  one-author paper, check removed    -> ${noCheck} of 12`);
  assert.ok(noCheck > withCheck, 'the 20 unrolled lines are paid even when they short-circuit');
});

// ---------------------------------------------------------------------------
// C — the frontier. This is what ruled out "just slim validPublicPaper down".
// ---------------------------------------------------------------------------

const KEYS = `        && paper.keys().hasOnly([
          'id', 'title', 'authors', 'abstract', 'year', 'date', 'category',
          'concepts', 'citations', 'doi', 'arxivId', 'openUrl'
        ])
        && paper.keys().hasAll(['id', 'title', 'authors'])`;
const TYPES = `        && paper.id is string
        && paper.title is string
        && paper.authors is list`;
const LENGTHS = `        && paper.id.size() <= 300
        && paper.title.size() <= 500`;
const AUTHOR_CAP = '        && paper.authors.size() <= 20';
const ABSTRACT_CAP = "        && (!('abstract' in paper) || paper.abstract.size() <= 3000)";
const URL_REGEX = `        && (!('openUrl' in paper)
          || paper.openUrl.matches('^https://[^[:space:]]+$'))`;

test('C: at the 12-paper cap only the allowlist fitted', async () => {
  const rich = i => paper(i, 20, 12);
  const rungs = [
    ['allowlist + hasAll', [KEYS]],
    ['+ type checks', [KEYS, TYPES]],
    ['+ id/title length caps', [KEYS, TYPES, LENGTHS]],
    ['+ authors count cap', [KEYS, TYPES, LENGTHS, AUTHOR_CAP]],
    ['+ abstract length cap', [KEYS, TYPES, LENGTHS, AUTHOR_CAP, ABSTRACT_CAP]],
    ['+ openUrl https regex', [KEYS, TYPES, LENGTHS, AUTHOR_CAP, ABSTRACT_CAP, URL_REGEX]],
  ];
  console.log('\n  [climbing from the free allowlist; the product cap was 12]');
  const scores = [];
  for (const [label, lines] of rungs) {
    const n = await ceiling(withPaperBody(HISTORICAL_RULES, lines), rich);
    scores.push(n);
    console.log(`  ${label.padEnd(40)} -> ${n} of 12`);
  }
  assert.equal(scores[0], 12, 'the 12-key allowlist itself was affordable');
  assert.ok(scores.at(-1) < 12, 'anything past types and the allowlist cost papers');
  assert.ok(
    scores.at(-1) <= 8,
    'no rule that bounds the bulk fields reached the product cap — which is why F11 '
    + 'moved the write to the Worker instead of trimming validPublicPaper',
  );
});
