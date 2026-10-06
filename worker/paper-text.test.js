import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PAPER_TEXT_CHARS,
  MIN_PAPER_TEXT_CHARS,
  cleanConvertedPaperText,
  extractPaperText,
  formatPaperTextForPrompt,
} from './paper-text.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const BODY = 'We measure the cooling of an ultracold gas under an alternating field. '.repeat(20);

/** A Workers AI binding that converts every PDF into `data`, and records the call. */
function workersAI(data, { format = 'markdown', reply } = {}) {
  const calls = [];
  return {
    calls,
    toMarkdown: async (file, options) => {
      calls.push({ file, options });
      if (reply) return reply();
      return { name: file.name, format, mimetype: 'application/pdf', tokens: 10, data };
    },
  };
}

test('the converted text loses the metadata block and the page headings', () => {
  const markdown = [
    '# paper.pdf',
    '## Metadata',
    '- Producer=pdfTeX-1.40.25',
    '',
    '## Contents',
    '### Page 1',
    'Attention Is All You Need',
    '',
    '',
    '',
    '### Page 2',
    '1 Introduction',
  ].join('\n');
  assert.equal(cleanConvertedPaperText(markdown), 'Attention Is All You Need\n\n1 Introduction');
});

test('a paper becomes text through toMarkdown, metadata left out', async () => {
  const AI = workersAI(`## Contents\n### Page 1\n${BODY}`);
  const result = await extractPaperText({ AI }, PDF_BYTES);

  assert.equal(result.reason, '');
  assert.equal(result.truncated, false);
  assert.equal(result.text, BODY.trim());
  assert.equal(AI.calls[0].file.name, 'paper.pdf');
  assert.equal(AI.calls[0].file.blob.type, 'application/pdf');
  assert.deepEqual(AI.calls[0].options, { conversionOptions: { pdf: { metadata: false } } });
});

test('a binding that answers with a list is read the same way', async () => {
  const AI = workersAI('', { reply: () => [{ format: 'markdown', data: BODY }] });
  assert.equal((await extractPaperText({ AI }, PDF_BYTES)).text, BODY.trim());
});

test('without the binding there is nothing to try', async () => {
  assert.deepEqual(await extractPaperText({}, PDF_BYTES), { text: '', truncated: false, reason: 'unavailable' });
  assert.equal((await extractPaperText({ AI: workersAI(BODY) }, new Uint8Array())).reason, 'unavailable');
});

test('a scan with no text layer is not handed over as a paper', async () => {
  const result = await extractPaperText({ AI: workersAI('Figure 1') }, PDF_BYTES);
  assert.equal(result.text, '');
  assert.equal(result.reason, 'no_text');
  assert.ok('Figure 1'.length < MIN_PAPER_TEXT_CHARS);
});

test('a failed conversion is a reason, never an error', async () => {
  const refused = await extractPaperText({ AI: workersAI('', { format: 'error' }) }, PDF_BYTES);
  assert.equal(refused.reason, 'conversion_failed');
  const thrown = await extractPaperText({
    AI: workersAI('', { reply: () => { throw new Error('Workers AI is down'); } }),
  }, PDF_BYTES);
  assert.equal(thrown.reason, 'conversion_failed');
});

test('a conversion that never answers is given up on', async () => {
  const AI = { toMarkdown: () => new Promise(() => {}) };
  const result = await extractPaperText({ AI }, PDF_BYTES, { timeoutMs: 20 });
  assert.equal(result.reason, 'conversion_failed');
});

test('a paper past the cap is cut there, and says so', async () => {
  const long = 'x'.repeat(MAX_PAPER_TEXT_CHARS + 500);
  const result = await extractPaperText({ AI: workersAI(long) }, PDF_BYTES);
  assert.equal(result.text.length, MAX_PAPER_TEXT_CHARS);
  assert.equal(result.truncated, true);
});

test('the prompt fences the text and labels it as PDF layout', () => {
  const block = formatPaperTextForPrompt('The paper body.');
  assert.match(block, /<paper>\nThe paper body\.\n<\/paper>/);
  assert.match(block, /come from the PDF layout, not from the authors/);
  assert.doesNotMatch(block, /cut short/);
});

test('a cut text tells the model to stop where it stops', () => {
  assert.match(formatPaperTextForPrompt('Half a paper.', { truncated: true }), /cut short before the end of the paper/);
});
