import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * A grant code is not unique across funders (`grantID=100010` answers for
 * NHMRC, SNSF and UKRI alike) — the OpenAIRE id (`prefix::hash`) is. The feed
 * pill must prefer it and only fall back to the bare code when a project has
 * no OpenAIRE id (e.g. an older cached shape).
 */
test('the project pill navigates with the OpenAIRE id and falls back to the code only when it is missing', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  assert.match(src, /const projectRouteId = project\.id \|\| project\.code;/);
  assert.match(src, /\/explorer\/project\/\$\{encodeURIComponent\(projectRouteId\)\}/);
  assert.match(src, /disabled=\{!\(project\.id \|\| project\.code\)\}/);
});

/**
 * The signed-in path carries `?name=` so the project hero can paint at once
 * and reserve, inside itself, only what the pill cannot know. The public path
 * carried neither name nor funder, so a logged-out reader tapping the same
 * pill got `name === ''`, the optimistic guard never fired, and they sat
 * through the full skeleton-to-hero jump this branch exists to remove. The
 * funder is not needed there: the identifier on that route is the OpenAIRE
 * id, which already names one project.
 */
test('the public project path carries the name, so a logged-out reader gets the hero straight away too', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  assert.match(
    src,
    /getPublicEntityPath\('project', projectRouteId, \{ includeName: true, name: project\.acronym \}\)/,
    'the same name the signed-in path passes',
  );
});

/**
 * searchProjects (openAireService.js) now puts the OpenAIRE id — which
 * contains "::" — in a project's `id` field instead of the bare grant code.
 * Two search surfaces interpolate that field straight into a URL path
 * without encoding it, which would ship an unencoded "::" path segment:
 * the command palette (SearchCommand.jsx) and the search results list
 * (SearchPage.jsx, both the row click and its title button share the string).
 */
test('search results wrap the OpenAIRE project id in encodeURIComponent before it lands in a URL path', async () => {
  const command = strip(await read('../Search/SearchCommand.jsx'));
  const searchPage = strip(await read('../Search/SearchPage.jsx'));
  const encodedProjectPath = /\/explorer\/project\/\$\{encodeURIComponent\(project\.id\)\}/g;

  assert.equal(
    (command.match(encodedProjectPath) || []).length,
    1,
    'SearchCommand: the command-palette project row',
  );
  assert.equal(
    (searchPage.match(encodedProjectPath) || []).length,
    2,
    'SearchPage: the row click and the title button both build the same route',
  );
});
