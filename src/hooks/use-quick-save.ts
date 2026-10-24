import type { OwnList } from '../utils/own-lists.ts';
import type { Paper } from '../models/paper.ts';

import { useCallback, useEffect, useRef } from 'react';
import { setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { useAuth } from '../context/auth-context.tsx';
import { useAnalyticsConsent } from '../context/analytics-context.tsx';
import { useFeed } from '../context/feed-context.tsx';
import { useLanguage } from '../context/language-context.tsx';
import { readListsHoldingPaper, writeListMembership } from '../services/paper-list-membership.ts';
import { savedPaperDocRef } from '../services/saved-paper-store.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';
import { markThenConfirm, pickerUndoToastId, runOneAtATime } from './quick-save-operation.ts';

/**
 * A card's Save button, the same wherever the card is: a tap saves the paper
 * to Read later and offers "Add to list" in the toast; a tap on a saved paper
 * takes it out of every list, with Undo. `onSaveToList` opens the list picker,
 * for that toast action and for a saved paper whose lists cannot be read.
 *
 * The button changes at the tap and the writes follow; a write that is
 * refused puts it back and says so. It used to change only once Firestore
 * had acknowledged every write, two or three round trips later, and a reader
 * who tapped again meanwhile started the same operation over from the state
 * they still saw. Each operation queued its writes behind the previous one,
 * and the last to finish decided the state. Reproduced 2026-10-21 against the
 * emulator behind a 120 ms proxy: eight taps 300 ms apart, nothing for 1.4 s,
 * then three changes and seven toasts, the last change 0.4 s after the last tap.
 */
export default function useQuickSave(onSaveToList: (paper: Paper) => void) {
  const { markActivation } = useAnalyticsConsent();
  const { savedPaperIds, interactionIdFor, personalLibrary, toggleReadLater, markSaved, unmarkSaved } = useFeed();
  const { user } = useAuth();
  const { language } = useLanguage();
  const saveState = useRef({ savedPaperIds, personalLibrary, toggleReadLater, markSaved, unmarkSaved });
  useEffect(() => {
    saveState.current = { savedPaperIds, personalLibrary, toggleReadLater, markSaved, unmarkSaved };
  }, [markSaved, personalLibrary, savedPaperIds, toggleReadLater, unmarkSaved]);

  const inFlight = useRef(new Set<string>());
  const oneAtATime = useCallback(
    (id: string, operation: () => Promise<void>) => runOneAtATime(inFlight.current, id, operation),
    [],
  );

  const restoreSave = useCallback(async (paper: Paper, lists: OwnList[], readLater: boolean) => {
    const id = interactionIdFor(paper)!;
    const latest = saveState.current;
    // The saved document is issued before the mark, so a late OpenAlex topic
    // landing on a marked paper always finds the copy to complete (PAP-60, D6).
    await markThenConfirm({
      alreadySaved: latest.savedPaperIds.has(id),
      issued: user
        ? setDoc(savedPaperDocRef(user.uid, paper.id), buildSavedPaperPayload(paper, new Date().toISOString()), { merge: true })
        : null,
      mark: () => latest.markSaved(paper),
      unmark: () => latest.unmarkSaved(paper),
      confirm: async () => {
        if (user) await writeListMembership({ uid: user.uid, paper, lists, added: true, language });
      },
    });
    // Not awaited: Read later flips in the same tick and its write never
    // rejects, so waiting for its acknowledgement would only hold the paper
    // against the next tap for one more round trip.
    if (readLater && !latest.personalLibrary[id]?.readLater) void latest.toggleReadLater(paper);
  }, [interactionIdFor, language, user]);

  const handleSaveToList = useCallback((paper: Paper) => {
    const id = interactionIdFor(paper)!;
    toast.dismiss(pickerUndoToastId(paper.id));
    return oneAtATime(id, async () => {
      if (!savedPaperIds.has(id)) {
        try {
          await restoreSave(paper, [], true);
          void markActivation();
          toast.success('Saved to Read later', {
            action: { label: 'Add to list', onClick: () => onSaveToList(paper) },
          });
        } catch {
          toast.error('Could not save this paper');
        }
        return;
      }
      const readLater = Boolean(personalLibrary[id]?.readLater);
      // The button empties now; which lists held the paper is read after.
      void unmarkSaved(paper);
      let held: OwnList[] | null;
      try {
        held = user ? await readListsHoldingPaper(user.uid, paper.id) : [];
        if (held && user) await writeListMembership({ uid: user.uid, paper, lists: held, added: false, language });
      } catch {
        void markSaved(paper);
        toast.error('Could not remove this paper');
        return;
      }
      if (!held) {
        // A full page of lists may hide more that hold the paper: the picker
        // shows them all, and the paper stays saved until the reader chooses.
        void markSaved(paper);
        onSaveToList(paper);
        return;
      }
      if (readLater) void toggleReadLater(paper);
      const lists = held;
      toast('Removed from your saved papers', {
        action: {
          label: 'Undo',
          onClick: () => { oneAtATime(id, () => restoreSave(paper, lists, readLater)).catch(() => toast.error('Could not save this paper')); },
        },
      });
    });
  }, [interactionIdFor, language, markActivation, markSaved, onSaveToList, oneAtATime, personalLibrary, restoreSave, savedPaperIds, toggleReadLater, unmarkSaved, user]);

  return handleSaveToList;
}
