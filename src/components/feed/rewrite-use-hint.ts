import type { Paper } from '../../models/paper.ts';
import { resolveReadingLevel, type InterestSettings } from '../../utils/area-preferences.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';

interface RewriteHintOptions {
  paper: Partial<Paper>;
  interestSettings: InterestSettings;
  globalLevel: ReadingLevel;
  isCached: (level: ReadingLevel) => boolean;
}

/** Under the plain-words button, only when its version is saved and opens without spending a use; the uses left are the masthead's tag. */
export function rewriteUseHint({ paper, interestSettings, globalLevel, isCached }: RewriteHintOptions) {
  const level = resolveReadingLevel(paper, interestSettings, undefined, globalLevel);
  return isCached(level) ? 'Open this version for free.' : '';
}
