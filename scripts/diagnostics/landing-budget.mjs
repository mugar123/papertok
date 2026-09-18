// The landing's transfer budget, §10.9 of the spec: `dist/index.html` plus the
// landing's own CSS chunk plus its own JS chunk, gzipped, must stay at or
// under 30 720 bytes. Until now that number was measured BY HAND, once, as a
// step in the task plan (`docs/superpowers/plans/2026-09-17-landing-rediseno.md`,
// step 1) — which means it was true on the day someone typed the command and
// unenforced every day since. It currently sits within a few hundred bytes of
// the ceiling, so the next copy edit crosses it with every test still green;
// that is exactly the shape of criterion that needs a gate rather than a
// checklist.
//
//   node scripts/diagnostics/landing-budget.mjs            # dist/ at the repo root
//   node scripts/diagnostics/landing-budget.mjs path/to/dist
//
// No dependencies: node:zlib's gzipSync over the file's own bytes. Runs after
// `npm run build` in `npm run check`, before the axe gate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET = 30720;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The directory is an argument, not a constant, for one reason: a gate whose
// failure modes cannot be rehearsed is a gate nobody trusts. Pointing this at
// a throwaway directory is how the "glob matched nothing" branch below gets
// tested without anyone having to break the real build first.
// `resolve`, not `join`: join() would glue an absolute argument onto the cwd
// and then report "no build output at /here/there/tmp/..." for a path the
// caller typed correctly.
const DIST = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(REPO_ROOT, 'dist');

// Written as literal glob strings rather than compiled regexes because these
// same strings are what the failure message has to print: a developer who
// renamed a chunk in vite.config.js needs to read back the pattern that no
// longer matches, not a regex source with escaping in it.
const GLOBS = ['assets/landing-*.css', 'assets/landing-*.js'];

function fail(message, hint) {
  console.error(`landing-budget: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Every file under DIST matching one `dir/prefix-*.ext` glob. Deliberately a
 * readdir plus a regex rather than node:fs's own globSync: that landed as
 * experimental in Node 22 (which is what CI runs) and prints a warning on
 * every invocation, and a gate that cries wolf on a clean run teaches people
 * to skim past its output — which is the one thing this script must not do. */
function matchGlob(glob) {
  const slash = glob.lastIndexOf('/');
  const dir = glob.slice(0, slash);
  // Only `*` is special, and only ever once, in the middle of a filename.
  // Everything else — the dots especially — is escaped so `landing-*.js`
  // cannot accidentally match `landing-abc-js-something`.
  const re = new RegExp(`^${glob.slice(slash + 1).split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  let names;
  try {
    names = readdirSync(join(DIST, dir));
  } catch {
    return []; // no such directory — the caller's own empty-match guard reports it
  }
  return names.filter((n) => re.test(n)).sort().map((n) => `${dir}/${n}`);
}

function gzipped(rel) {
  return gzipSync(readFileSync(join(DIST, rel))).length;
}

// dist/ missing entirely is its own message, separate from "the chunk is not
// there": the first means nobody built, the second means the build changed
// shape. Collapsing the two into one error sent the reader looking at
// vite.config.js when all they had to do was run the build.
try {
  if (!statSync(DIST).isDirectory()) throw new Error('not a directory');
} catch {
  fail(`no build output at ${DIST}`, 'run `npm run build` first — this gate measures the built bytes, not the sources.');
}

const entries = [];

// index.html is named, not globbed, so a missing one is simply a missing file;
// it still gets its own check rather than being left to readFileSync's ENOENT,
// which would surface as an unhandled stack trace instead of a sentence.
try {
  entries.push(['index.html', gzipped('index.html')]);
} catch {
  fail(`${join(DIST, 'index.html')} is missing`, 'run `npm run build` first — a partial dist/ cannot be measured.');
}

// The failure this whole section exists for: the chunk names come from Vite's
// own chunking, so a config change can rename `landing-*` to anything. A glob
// that then matches nothing would contribute zero bytes, and the script would
// print a comfortable total and exit 0 — a budget gate reporting a PASS for a
// page whose JS it never found. Zero matches is therefore fatal and names the
// glob, so the fix is "teach this script the new name", not "wonder why the
// landing got 3 KB lighter overnight".
for (const glob of GLOBS) {
  const found = matchGlob(glob);
  if (found.length === 0) {
    fail(
      `the glob "${glob}" matched nothing under ${DIST}`,
      'if a Vite config change renamed the landing chunk, update GLOBS here to follow it. '
      + 'This is fatal on purpose: an unmatched glob would otherwise add 0 bytes and report a total that looks fine.',
    );
  }
  // More than one match is summed rather than rejected: if Vite ever splits
  // the landing's CSS in two, both halves really are shipped to the visitor
  // and both belong in the budget. It is printed loudly all the same, because
  // the number of chunks changing is worth a human noticing — and summing an
  // unrelated chunk that happened to be named `landing-*` only ever makes
  // this gate stricter, never laxer, which is the right direction to be wrong in.
  if (found.length > 1) console.log(`note: "${glob}" matched ${found.length} files — all of them counted.\n`);
  for (const rel of found) entries.push([rel, gzipped(rel)]);
}

const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
const headroom = BUDGET - total;
const n = (bytes) => bytes.toLocaleString('en-US');

console.log(`landing transfer budget — gzip over ${relative(process.cwd(), DIST) || DIST}\n`);
for (const [rel, bytes] of entries) console.log(`  ${rel.padEnd(34)} ${n(bytes).padStart(7)} B`);
console.log(`  ${'-'.repeat(42)}`);
console.log(`  ${'total'.padEnd(34)} ${n(total).padStart(7)} B`);
console.log(`  ${'budget (spec §10.9)'.padEnd(34)} ${n(BUDGET).padStart(7)} B`);
console.log(`  ${(headroom >= 0 ? 'headroom' : 'OVER BUDGET BY').padEnd(34)} ${n(Math.abs(headroom)).padStart(7)} B   (${(Math.abs(headroom) / BUDGET * 100).toFixed(1)}% of the budget)`);

// gzipSync, not `gzip -c file`: the CLI writes the source filename and mtime
// into the gzip header (the FNAME field), which adds a dozen-odd bytes per
// file that no server ever sends — compression at the edge has no filename to
// record. So these numbers run slightly UNDER the hand-measured ones in the
// plan, and they are the more honest proxy for what a visitor downloads. Both
// use zlib's default level 6, so nothing else about the comparison moved.
console.log(`\n${headroom >= 0 ? 'PASS' : 'FAIL'}: ${n(total)} B of ${n(BUDGET)} B.`);
process.exit(headroom >= 0 ? 0 : 1);
