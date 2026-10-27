import type { OwnList } from '../utils/own-lists.ts';
import type { Paper } from '../models/paper.ts';

import { useCallback, useEffect, useRef } from 'react';
import { setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { useAuth } from '../context/auth-context.tsx';
import { useAnalyticsConsent } from '../context/privacy-context.tsx';
import { useFeed } from '../context/feed-context.tsx';
import { useLanguage } from '../context/language-context.tsx';
import { readListsHoldingPaper, writeListMembership } from '../services/paper-list-membership.ts';
import { savedPaperDocRef } from '../services/saved-paper-store.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';
import { auth } from '../services/firebase.ts';
import { pickerUndoToastId } from '../components/lists/picker-undo-toast.ts';
import { markThenConfirm, runOneAtATime, unmarkThenConfirm, writeSaveDestinations } from './quick-save-operation.ts';

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
export default function useQuickSave(onSaveToList: (paper: Paper) => void, surface: string) {
  const { markActivation, trackEvent } = useAnalyticsConsent();
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
    if (auth.currentUser?.uid !== user?.uid) return;
    const id = interactionIdFor(paper)!;
    const latest = saveState.current;
    // The saved document is issued before the mark, so a late OpenAlex topic
    // landing on a marked paper always finds the copy to complete (PAP-60, D6).
    await markThenConfirm({
      alreadySaved: latest.savedPaperIds.has(id),
      issued: user
        ? setDoc(savedPaperDocRef(user.uid, paper.id), buildSavedPaperPayload(paper, new Date().toISOString()), { merge: true })
        : null,
      mark: () => latest.markSaved(paper, { throwOnError: true }),
      unmark: async () => {
        if (auth.currentUser?.uid === user?.uid) await latest.unmarkSaved(paper);
      },
      confirm: async () => {
        if (auth.currentUser?.uid !== user?.uid) return;
        const previousReadLater = Boolean(latest.personalLibrary[id]?.readLater);
        await writeSaveDestinations({
          previousReadLater,
          nextReadLater: readLater || previousReadLater,
          writeReadLater: value => latest.toggleReadLater(paper, value, { throwOnError: true }),
          writeLists: async () => {
            if (user) await writeListMembership({ uid: user.uid, paper, lists, added: true, language });
          },
        });
      },
      onSaved: () => {
        if (auth.currentUser?.uid === user?.uid) void trackEvent('save_change', { action: 'add', surface, paper_id: paper.id });
      },
    });
  }, [interactionIdFor, language, surface, trackEvent, user]);

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
      let lists: OwnList[];
      try {
        const held = await unmarkThenConfirm({
          unmark: () => unmarkSaved(paper, { throwOnError: true }),
          confirm: async () => {
            const held = user ? await readListsHoldingPaper(user.uid, paper.id) : [];
            if (!held) return null;
            await writeSaveDestinations({
              previousReadLater: readLater,
              nextReadLater: false,
              writeReadLater: value => toggleReadLater(paper, value, { throwOnError: true }),
              writeLists: async () => {
                if (user) await writeListMembership({ uid: user.uid, paper, lists: held, added: false, language });
              },
            });
            return held;
          },
          restore: async () => {
            if (auth.currentUser?.uid !== user?.uid) return;
            await markSaved(paper);
          },
          onRemoved: () => {
            if (auth.currentUser?.uid === user?.uid) void trackEvent('save_change', { action: 'remove', surface, paper_id: paper.id });
          },
        });
        if (!held) {
          // A full page may hide more lists: let the picker show them all.
          onSaveToList(paper);
          return;
        }
        lists = held;
      } catch {
        toast.error('Could not remove this paper');
        return;
      }
      toast('Removed from your saved papers', {
        action: {
          label: 'Undo',
          onClick: () => { oneAtATime(id, () => restoreSave(paper, lists, readLater)).catch(() => toast.error('Could not save this paper')); },
        },
      });
    });
  }, [interactionIdFor, language, markActivation, markSaved, onSaveToList, oneAtATime, personalLibrary, restoreSave, savedPaperIds, surface, toggleReadLater, trackEvent, unmarkSaved, user]);

  return handleSaveToList;
}
