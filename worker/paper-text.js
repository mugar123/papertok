/**
 * A paper's PDF as plain text, for a model that should not read the PDF itself.
 *
 * NaN's gateway does read a PDF attached to the prompt, but slowly: measured on
 * 2026-10-06 it spent about 45 s before the first token on a 15-page paper, and
 * three at once ran to 110–125 s, one of them cut off by a 524. Workers AI's
 * `toMarkdown` turned the same PDFs into text in 1.5–3 s, three at once
 * included, and the text then reaches the model as ordinary prompt tokens: the
 * first rewritten section arrived after 2.4 s. The conversion runs on
 * Cloudflare's side, so it spends nothing of this isolate's CPU time and adds
 * no PDF parser to the bundle. Cloudflare documents the conversion as free
 * except where a format needs a model (images do); a PDF's pages are parsed.
 *
 * Anything that goes wrong here is a reason, never an error: the caller still
 * has the PDF and can hand it over as it is.
 */

/** Below this, the PDF has no text layer worth the name (a scan, an image). */
export const MIN_PAPER_TEXT_CHARS = 1_000;
/**
 * About 75,000 tokens: a 90-page technical report is 220,000 characters. The
 * cap bounds what one rewrite can cost, not what the model can read.
 */
export const MAX_PAPER_TEXT_CHARS = 300_000;
const CONVERSION_BUDGET_MS = 20_000;

/**
 * The converted text without the scaffolding `toMarkdown` wraps it in: a
 * metadata block (asked to be left out, removed anyway if it comes) and one
 * `### Page N` heading per page, which a model following "the paper's own
 * sections" could mistake for sections.
 */
export function cleanConvertedPaperText(markdown) {
  let text = String(markdown || '');
  const contents = text.indexOf('## Contents');
  if (contents !== -1) text = text.slice(contents + '## Contents'.length);
  return text
    .replace(/^#{1,3} Page \d+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * `{ text, truncated, reason }`. `text` is empty whenever `reason` says why:
 * `unavailable` (no Workers AI binding), `conversion_failed`, or `no_text`.
 */
export async function extractPaperText(env, bytes, { timeoutMs = CONVERSION_BUDGET_MS } = {}) {
  const failed = reason => ({ text: '', truncated: false, reason });
  if (typeof env?.AI?.toMarkdown !== 'function' || !bytes?.length) return failed('unavailable');
  let timer;
  try {
    const conversion = env.AI.toMarkdown(
      { name: 'paper.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) },
      { conversionOptions: { pdf: { metadata: false } } },
    );
    // The call cannot be aborted, only stopped being waited for: the model
    // still needs the rest of the request's time.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('conversion timed out')), timeoutMs);
    });
    const result = await Promise.race([conversion, timeout]);
    const converted = Array.isArray(result) ? result[0] : result;
    if (!converted || converted.format === 'error') return failed('conversion_failed');
    const text = cleanConvertedPaperText(converted.data);
    if (text.length < MIN_PAPER_TEXT_CHARS) return failed('no_text');
    return text.length > MAX_PAPER_TEXT_CHARS
      ? { text: text.slice(0, MAX_PAPER_TEXT_CHARS), truncated: true, reason: '' }
      : { text, truncated: false, reason: '' };
  } catch {
    return failed('conversion_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The extracted text as it goes into a prompt: fenced, and labelled as layout
 * output so line breaks, running headers and figure labels are not read as the
 * authors' prose. A truncated text says so, so the model stops where the text
 * does instead of inventing the rest.
 */
export function formatPaperTextForPrompt(text, { truncated = false } = {}) {
  return [
    "The attached PDF's text, as extracted from its pages, is between the <paper> tags below. Line breaks, running headers, page numbers and figure labels come from the PDF layout, not from the authors.",
    '<paper>',
    text,
    '</paper>',
    ...(truncated
      ? ['The extracted text was cut short before the end of the paper. Stop where it stops, and say so in the last section rather than inventing what follows.']
      : []),
  ].join('\n');
}
