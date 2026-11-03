/**
 * What taking a save back puts back, for each paper markSaved has marked.
 *
 * markSaved marks only a paper the screen shows unsaved, so a refused save,
 * or the list picker's Undo of a first save, takes the mark off again. While
 * the profile loads, though, every paper shows unsaved, whatever storage
 * holds. Once a profile has loaded (`screenReplaced`), a take-back puts back
 * what that profile holds instead: a Save tapped meanwhile on a paper already
 * saved in storage, and refused once the profile has arrived, must not unsave
 * it and take back the counts and lean of the stored save.
 */
export function saveRollbacks() {
  // Whether each marked paper was saved before its mark.
  const savedBefore = new Map<string, boolean>();
  return {
    marked(paperId: string) {
      savedBefore.set(paperId, false);
    },
    /** Every saved mark was set anew, to `saved`, as a profile load or a sign-out sets them. */
    screenReplaced(saved: ReadonlySet<string>) {
      for (const paperId of savedBefore.keys()) savedBefore.set(paperId, saved.has(paperId));
    },
    /**
     * The paper's saved mark is asked to come off: whether it does. A
     * take-back (`rollback`) leaves on a mark the paper had before it was
     * marked.
     */
    comesOff(paperId: string, rollback: boolean) {
      const stays = rollback && savedBefore.get(paperId) === true;
      savedBefore.delete(paperId);
      return !stays;
    },
  };
}
