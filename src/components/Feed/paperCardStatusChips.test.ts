import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string | URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the topics, status and links live in About this paper, and the field still leads the masthead', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  const title = jsx.indexOf('className="pc-title"');
  assert.doesNotMatch(jsx, /className="pc-filed"/, 'no status row on the card');
  assert.match(jsx, /\{ id: 'about', label: 'About this paper', hint: '[^']+', Icon: Info,/, 'the More menu opens it');
  const about = jsx.slice(jsx.indexOf('const aboutSections = ('));
  assert.match(jsx, /panel=\{menuView === 'about' \? \{[\s\S]*?content: aboutSections,\s*className: 'pc-about',/, 'the menu turns into it');
  assert.match(about, /<div className="pc-chips">[\s\S]*reviewTag[\s\S]*accessTag/, 'status chips in the panel');
  assert.match(about, /\{topicsList\}/, 'topics in the panel');
  assert.doesNotMatch(jsx, /pc-project-badge/, 'no funding badge on the card');
  assert.match(about, /\{project && \([\s\S]*?'Funding'[\s\S]*?onClick=\{openProject\}/, 'the funding project in the panel');
  assert.match(jsx.slice(jsx.indexOf('<div className="pc-meta">'), title), /className="pc-masthead-field pc-topic-link"/, 'the field leads the masthead');

  const css = await read('./PaperCard.css');
  assert.doesNotMatch(css, /\.pc-authors \.pc-chips/);
  assert.match(css, /\.pc-chips:empty \{\s*display: none;\s*\}/);
});


test('SOURCE: the connections empty state uses a smaller Petri and steps down with the panel instead of running past it', async () => {
  const css = await read('./PaperCard.css');
  const shared = await read('../ui/empty-state.css');
  const rem = (source: string, selector: string) => parseFloat(source.match(new RegExp(`${selector} \\{[^}]*width: ([\\d.]+)rem`))?.[1] as string);
  const panelPetri = rem(css, '\\n\\.graph-empty \\.empty-state-art > svg');
  const sharedPetri = rem(shared, '\\.empty-state-art:not\\(\\.empty-state-art--icon\\) > svg');
  assert.ok(panelPetri > 0 && panelPetri < sharedPetri, 'smaller than every other empty state, at every height');
  assert.match(css, /\.related-sheet--inline \{\s*container: related-panel \/ size;\s*\}/, 'measured on the panel itself');
  const steps = [...css.matchAll(/@container related-panel \(max-height: (\d+)px\) \{([\s\S]*?)\n\}/g)]
    .map(([, height, body]) => ({ height: Number(height), body }));
  const shortest = steps.reduce((low, step) => (step.height < low.height ? step : low), steps[0]);
  assert.ok(steps.length >= 2, 'it steps down more than once');
  assert.match(shortest.body, /\.empty-state-art > svg \{\s*width: 2\.5rem;\s*height: 2\.5rem;/, 'on the shortest panel Petri shrinks rather than leaving');
  assert.doesNotMatch(shortest.body, /display: none/, 'Petri is never hidden');
  assert.match(css, /\.graph-empty \{[^}]*overflow-y: auto;/, 'as a last resort it scrolls, it is never cut off');
});

test('SOURCE: the abstract and the graph are one size: the slot takes the room and each face fills it', async () => {
  const jsx = await read('./PaperCard.tsx');
  assert.doesNotMatch(jsx, /layout="row"/, 'a missing abstract is the stacked empty state, like every other');
  assert.match(jsx, /className=\{`pc-slot\$\{abstractText \? '' : ' pc-slot--no-abstract'\}`\}/, 'the slot knows the record has no abstract');
  const css = stripComments(await read('./PaperCard.css'));
  const rule = (source: string, selector: RegExp) => source.match(new RegExp(`\\n${selector.source} \\{([^}]*)\\}`))?.[1] || '';
  assert.match(rule(css, /\.pc-slot,\n\.pc-slot-track,\n\.pc-slot-face/), /flex: 1 1 auto;/, 'the slot and its face take the room');
  const abstract = css.match(/\n\.pc-abstract \{([^}]*overflow: hidden[^}]*)\}/)?.[1] || '';
  assert.match(abstract, /flex: 1 1 auto;/, 'the abstract fills it');
  assert.doesNotMatch(abstract, /max-height/, 'with no cap of its own');
  const graph = rule(css, /\.related-sheet\.related-sheet--inline/);
  assert.match(graph, /flex: 1 1 auto;/, 'the graph fills it');
  assert.match(graph, /height: auto;\s*max-height: none;/, 'with no height of its own');
  assert.match(css, /\.pc-abstract:has\(> \.pc-abstract-empty\) \{\s*display: flex;\s*flex-direction: column;\s*justify-content: center;\s*\}/, 'a missing abstract is centred in its panel');
});
