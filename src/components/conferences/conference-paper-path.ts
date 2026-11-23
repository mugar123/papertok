import type { Paper } from '../../models/paper.ts';
import { getPublicPaperPath } from '../../utils/public-navigation.ts';

export function conferencePaperPath(paper: Pick<Paper, 'openReviewId'>) {
  return paper.openReviewId ? getPublicPaperPath('openreview', paper.openReviewId) : null;
}
