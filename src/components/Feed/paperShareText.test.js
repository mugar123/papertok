import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Both paper share buttons, read as source (convention ce139ce: comments
// stripped, a bounded slice, the pieces bound in one contiguous pattern).
// What they must send is covered by `paperShareData` in shareLink.test.js;
// these pin that the buttons send it.

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function handlerSlice(code, start, maxLines) {
  const from = code.indexOf(start);
  assert.ok(from >= 0, `${start} is gone`);
  const lines = code.slice(from).split('\n');
  const end = lines.findIndex((line, index) => index > 0 && /^ {2}\};$/.test(line));
  assert.ok(end > 0 && end <= maxLines, `${start} runs past ${maxLines} lines`);
  return lines.slice(0, end + 1).join('\n');
}

test('SOURCE: the card shares its paper with the title as text', async () => {
  const code = stripComments(await readFile(new URL('./PaperCard.jsx', import.meta.url), 'utf8'));
  const handler = handlerSlice(code, 'const handleShare = async (event) => {', 30);
  assert.match(handler, /await navigator\.share\(paperShareData\(\{ title: paper\.title, url: shareUrl \}\)\);/);
  assert.doesNotMatch(handler, /navigator\.share\(\{/, 'no hand-built payload beside it');
});

test('SOURCE: Research shares the PaperTok page, the provider link only as a fallback', async () => {
  const code = stripComments(await readFile(new URL('../Report/ScientificReport.jsx', import.meta.url), 'utf8'));
  const handler = handlerSlice(code, 'const handleShare = async (paper) => {', 25);
  assert.match(
    handler,
    /const url = getPublicPaperUrl\(paper\)\s*\|\| safeExternalUrl\(paper\.pdfUrl\)\s*\|\| safeExternalUrl\(paper\.landingPageUrl\)/,
  );
  assert.match(handler, /shareOrCopyLink\(\{\s*\.\.\.paperShareData\(\{ title: paper\.title, url \}\),/);
});
