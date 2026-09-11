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
  assert.doesNotMatch(
    src,
    /id: details\.id/,
    'entity.id must stay the route id; the grant code OpenAIRE returns goes into entity.code, not entity.id',
  );
});
