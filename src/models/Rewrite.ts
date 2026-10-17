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
