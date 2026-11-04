import type { ProfileLoadResult } from '../utils/interaction-profile-loader.ts';
import { loadedMarkValue, type MarkChanges } from './write-mark.ts';

/**
 * What taking a save back puts back, for each paper markSaved has marked.
 *
 * markSaved marks only a paper the screen shows unsaved, so a refused save,
 * or the list picker's Undo of a first save, takes the mark off again. While
 * the profile loads, though, every paper shows unsaved, whatever storage
 * holds. Once a profile has loaded (`screenReplaced`), a take-back puts back
 * what that profile holds instead, when it can tell (`takeBacksOnProfile`): a
 * Save tapped meanwhile on a paper already saved in storage, and refused once
 * the profile has arrived, must not unsave it and take back the counts and
 * lean of the stored save.
 */
export function saveRollbacks() {
  // Whether each marked paper was saved before its mark, and whether a reset
  // (`screenReplaced`) has passed since the mark.
  const entries = new Map<string, { savedBefore: boolean; reset: boolean }>();
  return {
    marked(paperId: string) {
      entries.set(paperId, { savedBefore: false, reset: false });
    },
    /**
     * Every saved mark was set anew, as a profile load or a sign-out sets
     * them. `saved`: the papers a loaded profile holds saved from before
     * this session's saves. Only the first reset after a mark may say: a
     * profile loaded at a later one, such as after signing out and back in,
     * may hold the save itself, which this session wrote into it.
     */
    screenReplaced(saved?: ReadonlySet<string>) {
      for (const [paperId, entry] of entries) {
        if (saved && !entry.reset) entry.savedBefore = saved.has(paperId);
        entry.reset = true;
      }
    },
    /**
     * The paper's saved mark is asked to come off: whether it does. A
     * take-back (`rollback`) leaves on a mark the paper had before it was
     * marked.
     */
    comesOff(paperId: string, rollback: boolean) {
      const stays = rollback && entries.get(paperId)?.savedBefore === true;
      entries.delete(paperId);
      return !stays;
    },
  };
}

/**
 * A profile load (FeedContext's applyInteractionProfile) set every like, read
 * and saved mark on screen anew, to the sets it loaded. Tells `marks` and
 * `saves`, which follow the writes still waiting, so that a refused write or
 * a save taken back puts back what storage held before the tap: a Like or
 * Save tapped while the profile loaded, on a paper storage already holds
 * liked or saved, keeps its like or save when refused.
 *
 * Only a profile read from the stored aggregate says what storage held
 * before the tap: this session writes the aggregate only once its profile
 * has loaded. A profile rebuilt from the interaction documents, by this load
 * or by an earlier one in the session (`reusedRebuild`), may hold this
 * session's own writes, accepted or still waiting (`getDocs` shows a write
 * still waiting). It cannot tell a paper liked or saved before the tap from
 * one the tap liked or saved, so a refusal puts back the screen from before
 * the load: a quick save whose Read later is refused takes its mark off
 * rather than leave the paper saved with no list. The cost is that a Like or
 * Save refused there, on a paper storage already held liked or saved, takes
 * the like or save away, as it did before ENG-166.
 */
export function takeBacksOnProfile(
  { marks, saves }: { marks: MarkChanges; saves: ReturnType<typeof saveRollbacks> },
  userId: string,
  loaded: { liked: ReadonlySet<string>; read: ReadonlySet<string>; saved: ReadonlySet<string> },
  { rebuilt, reusedRebuild }: Pick<Extract<ProfileLoadResult, { status: 'loaded' | 'empty' }>, 'rebuilt' | 'reusedRebuild'>,
) {
  if (rebuilt || reusedRebuild) {
    marks.screenReplaced();
    saves.screenReplaced();
    return;
  }
  marks.screenReplaced(loadedMarkValue(userId, { like: loaded.liked, read: loaded.read }));
  saves.screenReplaced(loaded.saved);
}
