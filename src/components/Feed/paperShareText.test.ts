import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The card's share button, read as source (convention ce139ce: comments
// stripped, a bounded slice, the pieces bound in one contiguous pattern).
// What it must send is covered by `paperShareData` in shareLink.test.ts;
// this pins that the button sends it.

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function handlerSlice(code: string, start: string, maxLines: number) {
  const from = code.indexOf(start);
  assert.ok(from >= 0, `${start} is gone`);
  const lines = code.slice(from).split('\n');
  const end = lines.findIndex((line: string, index: number) => index > 0 && /^ {2}\};$/.test(line));
  assert.ok(end > 0 && end <= maxLines, `${start} runs past ${maxLines} lines`);
  return lines.slice(0, end + 1).join('\n');
}

test('SOURCE: the card shares its paper with the title as text', async () => {
  const code = stripComments(await readFile(new URL('./PaperCard.tsx', import.meta.url), 'utf8'));
  const handler = handlerSlice(code, 'const handleShare = async (event: MouseEvent) => {', 30);
  assert.match(handler, /await navigator\.share\(paperShareData\(\{ title: paper\.title, url: shareUrl \}\)\);/);
  assert.doesNotMatch(handler, /navigator\.share\(\{/, 'no hand-built payload beside it');
});
