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

/**
 * A project whose OpenAIRE lookup fails on a route with no `?name=` — a shared
 * public link opened while signed in, a hand-typed URL — has no name to show,
 * and a raw `snsf________::daa28096…` is not a title. The page has its own
 * bilingual wording for what this is, and that wording is the PAGE's, never
 * the entity's.
 *
 * Stamped into `entity.display_name` it became a follow key:
 * `followEntity.displayName` is built from that field and `followsEntity`
 * compares type plus normalized display name after the id, so every nameless
 * project carried the same name. Follow project A from such a page and open
 * project B in the same state: B's heart comes up filled, and the click hands
 * `toggleFollow` a probe that finds A as `existingFollow` — deleting A's
 * document. One OpenAIRE outage puts several project pages into that state at
 * once.
 *
 * So the entity keeps no name at all; the fallback happens where the title is
 * rendered, reusing the label the page already computes for the type. That
 * render body already has `isEnglish` in scope, so the entity effect needs
 * neither a ref nor a language dependency (which would drop every entity page
 * back to its skeleton on a toggle), and the wording follows a language change
 * without waiting for a remount.
 */
test('a nameless project lends a title to the hero and no name to the follow', async () => {
  const src = stripComments(await read('./EntityExplorer.jsx'));

  assert.match(
    src,
    /\} else \{\s*setEntity\(\{\s*id,\s*openaireId: id\.includes\('::'\) \? id : undefined,\s*display_name: name,\s*type: 'project',\s*funder,\s*\}\);\s*\}/,
    'the failed-lookup arm lands the route name or nothing at all',
  );
  assert.doesNotMatch(
    src,
    /display_name: name \|\|/,
    'nothing stands in for a missing name inside the entity',
  );
  assert.doesNotMatch(
    src,
    /projectFallbackName/,
    'the stamped constant and the ref that held it are both gone',
  );

  assert.match(
    src,
    /<h1 className="ehc-name" style=\{\{ margin: 0 \}\}>\{entityDisplayName \|\| entityTypeLabel\}<\/h1>/,
    'the hero title falls back where it is rendered',
  );
  assert.match(
    src,
    /const entityTypeLabel = type === 'author'[\s\S]{0,400}?type === 'project'\s*\? \(isEnglish \? 'Research project' : 'Proyecto de investigación'\)/,
    "the fallback is the page's own bilingual wording, read on every render",
  );

  assert.match(
    src,
    /const displayName = type === 'institution' \? entityOfficialName : entityDisplayName;\s*if \(!displayName\) return null;/,
    'an entity with no name yields no follow identity rather than a placeholder one',
  );
  assert.match(
    src,
    /displayName,\s*source: type === 'project' \? 'openaire'/,
    'and the follow carries that same checked name',
  );
});
