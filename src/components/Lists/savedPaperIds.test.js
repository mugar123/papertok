import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE tests. Saving a pre-2007 arXiv paper (`hep-th/0603001`) to a list
 * threw on `doc(db, 'users', uid, 'savedPapers', id)` — a slash is a path
 * separator — AFTER `markSaved` had already written the aggregate, and the
 * list never received the id. The document name is now encoded, the
 * aggregate is written only once the document exists, and the lists screen
 * encodes what it asks for and decodes what comes back.
 */
test('SOURCE: the saved-paper document is addressed by its encoded name, after which the aggregate learns of it', async () => {
  const code = stripComments(await read('./SaveToListModal.jsx'));
  assert.doesNotMatch(code, /doc\(db, 'users', user\.uid, 'savedPapers'/);
  const save = bounded(code, 'if (toAdd.length > 0) {\n          await setDoc(', 'for (const listId of toAdd)', 'the saved-paper write', 20);
  assert.match(
    save,
    /await setDoc\(\s*savedPaperDocRef\(user\.uid, paper\.id\),[\s\S]*?\);\s*markSaved\(paper\);/,
    'the aggregate is told AFTER the document is written, so a refused write leaves no orphan',
  );
});

test('SOURCE: the lists screen asks by encoded name and keys what comes back by paper id', async () => {
  const code = stripComments(await read('./ListsPage.jsx'));
  assert.match(code, /where\(documentId\(\), 'in', requestDefinition\.paperIds\.map\(encodeFirestoreDocId\)\)/);
  const merge = bounded(code, 'snapshot.forEach((item) => {', 'loadedPapers[paperId] = paper;', 'the snapshot merge', 22);
  assert.match(merge, /const paperId = decodeFirestoreDocId\(item\.id\);/);
  assert.doesNotMatch(merge, /id: item\.id|arxivId: item\.id/, 'every id the row sees is the decoded one');
});

test('SOURCE: a row whose paper never came says so instead of printing the id', async () => {
  const code = stripComments(await read('./ListsPage.jsx'));
  const placeholder = bounded(code, 'className="lists-paper-title lists-paper-placeholder"', '</p>', 'the placeholder row', 4);
  assert.doesNotMatch(placeholder, /\{paperId\}/, 'a document id is not a title');
});

test('SOURCE: legacy ids no document could answer for are named from arXiv', async () => {
  const code = stripComments(await read('./ListsPage.jsx'));
  const tail = bounded(code, 'const unresolvedIds = missingIds.filter(', '} catch (metadataLoadError) {', 'the end of openList', 40);
  assert.match(tail, /hydrateLegacyArxivPapers\(/);
  assert.match(tail, /metadataRequestId\.current !== requestId/, 'a superseded open must not paint into the current one');
});
