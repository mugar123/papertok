import type { OwnList } from '../utils/ownLists.ts';
import type { Paper } from '../models/Paper.ts';

import { useCallback, useEffect, useRef } from 'react';
import { setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.tsx';
import { useAnalyticsConsent } from '../context/AnalyticsContext.tsx';
import { useFeed } from '../context/FeedContext.tsx';
import { useLanguage } from '../context/LanguageContext.tsx';
import { IS_DEMO } from '../services/firebase.ts';
import { readListsHoldingPaper, writeListMembership } from '../services/paperListMembership.ts';
import { savedPaperDocRef } from '../services/savedPaperStore.ts';
import { buildSavedPaperPayload } from '../utils/savedPaperPayload.ts';

/**
 * A card's Save button, the same wherever the card is: a tap saves the paper
 * to Read later and offers "Add to list" in the toast; a tap on a saved paper
 * takes it out of every list, with Undo. `onSaveToList` opens the list picker,
 * for that toast action and for a saved paper whose lists cannot be read.
 */
export default function useQuickSave(onSaveToList: (paper: Paper) => void) {
  const { markActivation } = useAnalyticsConsent();
  const { savedPaperIds, interactionIdFor, personalLibrary, toggleReadLater, markSaved, unmarkSaved } = useFeed();
  const { user } = useAuth();
  const { language } = useLanguage();
  const saveState = useRef({ personalLibrary, toggleReadLater, markSaved });
  useEffect(() => {
    saveState.current = { personalLibrary, toggleReadLater, markSaved };
  }, [markSaved, personalLibrary, toggleReadLater]);

  const restoreSave = useCallback(async (paper: Paper, lists: OwnList[], readLater: boolean) => {
    const id = interactionIdFor(paper)!;
    const latest = saveState.current;
    if (user && !IS_DEMO) {
      await setDoc(savedPaperDocRef(user.uid, paper.id), buildSavedPaperPayload(paper, new Date().toISOString()), { merge: true });
      await writeListMembership({ uid: user.uid, paper, lists, added: true, language });
    }
    if (readLater && !latest.personalLibrary[id]?.readLater) await latest.toggleReadLater(paper);
    await latest.markSaved(paper);
  }, [interactionIdFor, language, user]);

  const handleSaveToList = useCallback(async (paper: Paper) => {
    const id = interactionIdFor(paper)!;
    const readLater = Boolean(personalLibrary[id]?.readLater);
    if (savedPaperIds.has(id)) {
      let lists: OwnList[] | null = null;
      let removed = false;
      try {
        lists = user && !IS_DEMO ? await readListsHoldingPaper(user.uid, paper.id) : [];
        if (!lists) {
          onSaveToList(paper);
          return;
        }
        const held = lists;
        if (user && !IS_DEMO) await writeListMembership({ uid: user.uid, paper, lists: held, added: false, language });
        removed = true;
        if (readLater) await toggleReadLater(paper);
        await unmarkSaved(paper);
        toast('Removed from your saved papers', {
          action: {
            label: 'Undo',
            onClick: () => { restoreSave(paper, held, readLater).catch(() => toast.error('Could not save this paper')); },
          },
        });
      } catch {
        // Half an unsave is worse than none: put back what was already taken.
        if (removed && lists) await restoreSave(paper, lists, readLater).catch(() => {});
        toast.error('Could not remove this paper');
      }
      return;
    }
    try {
      await restoreSave(paper, [], true);
      markActivation();
      toast.success('Saved to Read later', {
        action: { label: 'Add to list', onClick: () => onSaveToList(paper) },
      });
    } catch {
      toast.error('Could not save this paper');
    }
  }, [interactionIdFor, language, markActivation, onSaveToList, personalLibrary, restoreSave, savedPaperIds, toggleReadLater, unmarkSaved, user]);

  return handleSaveToList;
}
