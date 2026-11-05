import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPaperPdfBytes } from './ai-explanation.ts';

const PDF = '%PDF-1.4\n%test\n';
const FILE = 'https://zenodo.org/api/records/23965739/files/paper.pdf/content';

function zenodo(t: test.TestContext, files: Array<{ key: string; links: { self: string } }>, body = PDF) {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === 'https://zenodo.org/api/records/23965738') return Response.json({ files });
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  });
  return asked;
}

test('a Zenodo record gives up its PDF, sent as octet-stream', async t => {
  const asked = zenodo(t, [{ key: 'data.csv', links: { self: 'https://zenodo.org/api/records/23965739/files/data.csv/content' } }, { key: 'paper.pdf', links: { self: FILE } }]);
  const { bytes, reason } = await fetchPaperPdfBytes('https://zenodo.org/records/23965738', 5_000);
  assert.equal(reason, '');
  assert.equal(new TextDecoder().decode(bytes), PDF);
  assert.deepEqual(asked, ['https://zenodo.org/api/records/23965738', FILE]);
});

test('a Zenodo record without a PDF, or a file that is not one, is no PDF', async t => {
  zenodo(t, [{ key: 'data.csv', links: { self: 'https://zenodo.org/api/records/23965739/files/data.csv/content' } }]);
  assert.equal((await fetchPaperPdfBytes('https://zenodo.org/records/23965738', 5_000)).reason, 'not_pdf');
});

test('octet-stream bytes that are not a PDF are refused', async t => {
  zenodo(t, [{ key: 'paper.pdf', links: { self: FILE } }], '<html>sign in</html>');
  assert.equal((await fetchPaperPdfBytes('https://zenodo.org/records/23965738', 5_000)).reason, 'not_pdf');
});
