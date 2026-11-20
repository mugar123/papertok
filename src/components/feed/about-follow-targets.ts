import type { Paper } from '../../models/paper.ts';
import type { FollowInput } from '../../utils/following.ts';
import { journalExplorerLink } from '../../utils/explorer-paths.ts';
import { isVerifiedFollowId, normalizeFollowId } from '../../utils/following.ts';
import { isListedWorkingPaperSeries } from '../../utils/publication-status.ts';

/** How many institutions "About this paper" lists before "Show all". */
export const ABOUT_INSTITUTION_LIMIT = 5;

/**
 * What "About this paper" offers to follow (ENG-123): the journal OpenAlex
 * identifies (`venueId`) and the institutions of the authors that carry an
 * OpenAlex or ROR id. Anything without a verified id is left out, never
 * matched by name: the follow is stored by that id.
 */
export function aboutFollowTargets(paper: Partial<Paper> | null | undefined): { journal: FollowInput | null; institutions: FollowInput[] } {
  const link = journalExplorerLink(paper);
  // A working-paper series has a lane of its own, so no Follow (see explorerFollowEntity).
  const journal: FollowInput | null = link && !isListedWorkingPaperSeries(paper?.venueId)
    ? { type: 'journal', id: String(paper?.venueId).trim(), displayName: link.name, source: 'openalex' }
    : null;

  const institutions = new Map<string, FollowInput>();
  for (const institution of paper?.institutions || []) {
    const displayName = String(institution?.displayName || institution?.display_name || '').trim();
    const openAlexId = normalizeFollowId(institution?.id);
    const ror = normalizeFollowId(institution?.ror);
    // The OpenAlex id first: it is the one the Explorer follows by.
    const canonicalId = [openAlexId, ror].find(id => isVerifiedFollowId('institution', id));
    if (!displayName || !canonicalId || institutions.has(canonicalId)) continue;
    institutions.set(canonicalId, {
      type: 'institution',
      id: canonicalId,
      displayName,
      source: 'openalex',
      externalIds: { ror: isVerifiedFollowId('institution', ror) ? ror : undefined },
    });
  }
  return { journal, institutions: [...institutions.values()] };
}
