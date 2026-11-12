import type { Paper } from '../../models/paper.ts';
import { hasUsableAIAbstract } from '../../utils/ai-explanation-access.ts';
import { summaryLooksCut } from '../../utils/paper-seed.ts';

/**
 * The abstract a list row shows, and whether the copy it comes from was cut.
 *
 * A list holds stored copies, never the provider's paper: a `savedPapers`
 * document keeps the first 500 characters, an interaction's copy up to 4,000
 * (1,000 for older ones). A merged paper can carry one in `abstract` and the
 * other in `summary`, so the longer usable text is the one shown. A text that
 * stops at one of those caps was cut there, and the row says so rather than
 * presenting the excerpt as the whole abstract. A copy with no usable text,
 * including the "No abstract available." placeholder, has nothing to show.
 */
export function listAbstractText(paper: Partial<Pick<Paper, 'abstract' | 'summary'>>) {
  const stored = [paper.abstract, paper.summary]
    .filter((value): value is string => typeof value === 'string' && hasUsableAIAbstract(value))
    .reduce<string | null>((longest, value) => (!longest || value.length > longest.length ? value : longest), null);
  const text = stored?.trim();
  if (!stored || !text) return null;
  return { text, cut: summaryLooksCut(stored) };
}
