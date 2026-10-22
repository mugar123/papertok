export interface RewriteHighlight { paragraphIndex: number; quote: string; kind: string }
export interface RewriteSection {
  id: string;
  kind: string;
  heading: string;
  originalHeading: string;
  paragraphs: string[];
  highlights: RewriteHighlight[];
}
export interface RewriteMeta {
  level: string;
  language: string;
  model: string;
  provider: string;
  promptVersion: string;
  sourceBasis: string;
  title: string;
  doi: string;
  pdfUrl: string;
}
export interface AIQuota {
  resetAt: string;
  retryAfterSeconds: number;
  scope: string;
  remainingUses?: number;
}

/**
 * One section in the shape the reader renders, whether it arrives on the stream
 * or comes back from a copy saved in the reader's account. A section whose
 * paragraphs are not all text is refused whole: dropping one would move every
 * later paragraph's index, and highlights and notes are anchored by index.
 */
export function toRewriteSection(value: unknown): RewriteSection | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  const id = text(source.id);
  const paragraphs = source.paragraphs;
  if (!id || !Array.isArray(paragraphs) || paragraphs.length === 0
    || !paragraphs.every(paragraph => typeof paragraph === 'string')) return null;
  const highlights = Array.isArray(source.highlights) ? source.highlights.flatMap((item) => {
    const highlight = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const paragraphIndex = highlight.paragraphIndex;
    const quote = text(highlight.quote);
    return Number.isInteger(paragraphIndex) && (paragraphIndex as number) >= 0
      && (paragraphIndex as number) < paragraphs.length && quote
      ? [{ paragraphIndex: paragraphIndex as number, quote, kind: text(highlight.kind) }]
      : [];
  }) : [];
  return {
    id,
    kind: text(source.kind),
    heading: text(source.heading),
    originalHeading: text(source.originalHeading),
    paragraphs: paragraphs as string[],
    highlights,
  };
}
