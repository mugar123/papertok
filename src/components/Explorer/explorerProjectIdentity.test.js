import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for a project entity's identity. A grant code alone is not
 * unique across funders (grantID=100010 answers for NHMRC, SNSF and UKRI
 * alike — see openAireService.js), so both OpenAIRE lookups need the route's
 * funder. And per entityPapersRequestKey's own comment block (entityExplorer.js),
 * entity.id is one of that key's inputs for a project: if the details lookup
 * renamed it away from the route id, the papers request already in flight
 * would be cancelled the moment those details land. The grant code OpenAIRE
 * returns belongs in entity.code instead, never in entity.id.
 */
test("the project is queried with the route's funder and keeps the route id", async () => {
  const src = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(src, /getProjectDetails\(id, \{ funder \}\)/);
  assert.match(src, /getPapersByProject\(resolvedId, page, \{ funder: searchParams\.get\('funder'\) \|\| entity\.funder \|\| '' \}\)/);
  assert.match(src, /code: details\.id \|\| id,/);
  // Positive half of the pin above: the previous two assertions only prove
  // entity.id is not details.id, never that it IS the route id. Match the
  // shorthand `id,` as well as `id: id,` — either is the route id since this
  // is a destructured `{ id }` param — so the assertion survives a lint pass
  // that collapses `id: id` to shorthand, but still fails if the route id is
  // ever replaced by anything else (e.g. `id: details.id` or no id at all).
  assert.match(
    src,
    /setEntity\(\{\s*id(?::\s*id)?,\s*code: details\.id \|\| id,/,
    'entity.id must be the route id right where entity.code is assigned from details.id',
  );
  assert.doesNotMatch(
    src,
    /id: details\.id/,
    'entity.id must stay the route id; the grant code OpenAIRE returns goes into entity.code, not entity.id',
  );
});
