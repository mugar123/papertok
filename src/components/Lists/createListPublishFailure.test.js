import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('a new public list that fails to publish tells the user it stayed private', async () => {
  for (const file of ['./SaveToListModal.jsx', './ListsPage.jsx']) {
    const jsx = await read(file);
    const failure = jsx.match(/catch \(publishError\) \{[^}]*\}/)?.[0] || '';
    assert.match(failure, /toastError\(/, `${file}: the failure reaches the user, not only the console`);
  }
});
