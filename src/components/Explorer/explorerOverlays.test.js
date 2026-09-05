import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The explorer's overlays and controls on Base UI. The filter drawer is a
 * Sheet — a modal Dialog pinned to the right edge, so the focus trap, Escape,
 * restore and `aria-modal` come from the primitive (FeedContainer probes
 * `[aria-modal="true"]`); the project links are a real menu; the follow
 * control and the peer-review switch write their own state.
 */

const jsxFile = readFile(new URL('./EntityExplorer.jsx', import.meta.url), 'utf8');
const cssFile = readFile(new URL('./EntityExplorer.css', import.meta.url), 'utf8');

test('the filter drawer is a ui Sheet from the right, named by its title, with nothing hand-rolled left', async () => {
  const jsx = await jsxFile;
  const css = await cssFile;
  assert.match(jsx, /<Sheet open=\{showFilters\} onOpenChange=\{setShowFilters\}>/);
  assert.match(jsx, /<SheetContent\s+side="right"\s+className="ee-filter-drawer"\s+overlayClassName="ee-filter-backdrop"/);
  assert.match(jsx, /<SheetTitle render=\{<h3 \/>\}>/);
  assert.match(jsx, /<SheetClose\s+render=\{<Button variant="ghost" size="icon" \/>\}\s+aria-label=\{isEnglish \? 'Close filters' : 'Cerrar filtros'\}/);
  for (const resto of ['useDialogFocus', 'aria-modal=', 'role="dialog"', 'ee-filter-backdrop" onClick']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en EntityExplorer.jsx: eso lo pone el Sheet`);
  }
  // The primitive stacks and animates both layers; a z-index here would fight it.
  const backdrop = css.match(/\.ee-filter-backdrop \{([^}]*)\}/);
  const drawer = css.match(/\.ee-filter-drawer \{([^}]*)\}/);
  assert.ok(backdrop && drawer);
  assert.doesNotMatch(backdrop[1], /z-index/);
  assert.doesNotMatch(drawer[1], /z-index/);
});

test('the project links are a DropdownMenu of link items, positioned by Base UI', async () => {
  const jsx = await jsxFile;
  const css = await cssFile;
  assert.match(jsx, /<DropdownMenu>\s*<DropdownMenuTrigger render=\{<button type="button" className="project-links-trigger" \/>\}>/);
  assert.match(jsx, /<DropdownMenuContent[\s\S]*?className="project-links-dropdown"[\s\S]*?aria-label=\{isEnglish \? 'Project links' : 'Enlaces del proyecto'\}/);
  assert.match(jsx, /<MenuPrimitive\.LinkItem[\s\S]*?closeOnClick/);
  assert.doesNotMatch(jsx, /addEventListener\('pointerdown'|isProjectLinksMenuOpen|aria-haspopup=/);
  assert.match(css, /\.project-links-trigger\[data-popup-open\]/);
  const popup = css.match(/\.project-links-dropdown \{([^}]*)\}/);
  assert.ok(popup);
  assert.doesNotMatch(popup[1], /position:\s*absolute/, 'the Positioner places the popup');
  assert.match(css, /\.project-links-option\[data-highlighted\]/, 'keyboard and pointer land on the same look');
});

test('the drawer\'s sort, category and date rows are single-select ToggleGroups that announce their choice', async () => {
  const jsx = await jsxFile;
  const css = await cssFile;
  assert.match(jsx, /<ToggleGroup\s+variant="outline"\s+className="ee-filter-chips"\s+aria-label=\{isEnglish \? 'Sort by' : 'Ordenar por'\}\s+value=\{\[sortBy\]\}/);
  assert.match(jsx, /value=\{\[filters\.category \|\| 'all'\]\}/);
  assert.match(jsx, /value=\{\[filters\.dateRange \|\| 'any'\]\}/);
  assert.doesNotMatch(jsx, /className=\{`ee-filter-chip \$\{/, 'the pressed chip is the one Base UI marks, not a class computed by hand');
  assert.match(css, /\.ee-filter-chip\[data-pressed\]/);
  assert.doesNotMatch(css, /\.ee-filter-chip\.active/);
});

test('follow is a Toggle, peer-review a Switch in a Label, search an Input, the verified badge a Tooltip', async () => {
  const jsx = await jsxFile;
  const css = await cssFile;
  assert.match(jsx, /<Toggle\s+variant="outline"\s+className="entity-follow-btn"\s+pressed=\{entityIsFollowing\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/);
  assert.match(css, /\.entity-follow-btn\[data-pressed\]/);
  assert.match(jsx, /<Label className="ee-toggle-label">\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<Switch\s+checked=\{filters\.peerReviewed\}/);
  assert.doesNotMatch(css, /\.ee-toggle-switch/);
  assert.match(jsx, /<Input\s+type="text"\s+className="explorer-search-input"/);
  assert.match(jsx, /<TooltipProvider>/);
  assert.match(jsx, /<TooltipTrigger\s+render=\{<span className="eli-verified" role="img" \/>\}\s+aria-label=/);
  assert.doesNotMatch(jsx, /data-tooltip=/);
});
