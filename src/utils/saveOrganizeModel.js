/**
 * The pending-selection model behind the "Save and organize" modal.
 *
 * The modal is confirm-on-save: toggling a list, editing the note, adding a
 * tag or flipping Read later only mutates pending state, and one Save button
 * commits everything. These helpers are the part of that model that can be
 * wrong in silence — the two-direction diff, the tag grammar, and the "is
 * there anything to lose?" question the close guard asks — so they live here,
 * pure and tested, instead of inline in the component.
 */

/**
 * What Save must write: additions AND removals. A paper can already be in
 * lists when the modal opens; unchecking one of those must remove it, not
 * just fail to re-add it.
 */
export function diffListSelection(initialIds, pendingIds) {
  const initial = new Set(initialIds ?? []);
  const pending = new Set(pendingIds ?? []);
  return {
    toAdd: [...pending].filter(id => !initial.has(id)),
    toRemove: [...initial].filter(id => !pending.has(id)),
  };
}

/**
 * Commit the text in the tag input as chips. Splits on commas so a pasted
 * "a, b, c" becomes three tags, trims, drops empties, and dedupes against
 * the tags already present (case-sensitive, like the service stores them).
 */
export function commitTagInput(tags, input) {
  const current = [...(tags ?? [])];
  for (const candidate of String(input ?? '').split(',')) {
    const tag = candidate.trim();
    if (tag && !current.includes(tag)) current.push(tag);
  }
  return current;
}

export function removeTag(tags, tag) {
  return (tags ?? []).filter(existing => existing !== tag);
}

/**
 * Whether closing now would lose something. Tag ORDER changes count as a
 * change deliberately: the order is what gets stored.
 */
export function hasUnsavedChanges({ initial, pending }) {
  const listsChanged = (() => {
    const { toAdd, toRemove } = diffListSelection(initial.listIds, pending.listIds);
    return toAdd.length > 0 || toRemove.length > 0;
  })();
  // Stringified, not joined: tags can contain spaces, and any join separator
  // that can also appear inside a tag would make two different lists compare
  // equal.
  const tagsChanged = JSON.stringify(initial.tags ?? []) !== JSON.stringify(pending.tags ?? []);
  return listsChanged
    || tagsChanged
    || (initial.note ?? '') !== (pending.note ?? '')
    || Boolean(initial.readLater) !== Boolean(pending.readLater);
}

/**
 * What the user actually did to the checkboxes, kept apart from what the
 * account says.
 *
 * The modal paints from a session cache that can be thirty seconds old and
 * revalidates behind it, so "which lists hold this paper" changes underneath a
 * screen the user is already touching. Keeping the whole tick state as one set
 * made those two facts the same variable, and the modal then had to choose:
 * accept the fresh membership and lose the user's ticks, or freeze on the stale
 * one. It froze — and every list the fresh read knew about but the stale one
 * did not became a REMOVAL nobody asked for, written by a Save the user thought
 * was about a different row entirely.
 *
 * So the state is the DIFFERENCE, never the result. `checked` and `unchecked`
 * hold only the rows the user disagreed with the account about; everything else
 * follows whatever membership is current, however late it lands.
 */
export const EMPTY_LIST_INTENT = Object.freeze({ checked: [], unchecked: [] });

/**
 * Whether a row is ticked right now: the membership, as amended by the user.
 */
export function isListSelected(listId, { membership, checked, unchecked } = {}) {
  if (new Set(unchecked ?? []).has(listId)) return false;
  if (new Set(checked ?? []).has(listId)) return true;
  return new Set(membership ?? []).has(listId);
}

/**
 * Flip one row, and normalise: an intent that agrees with the membership is not
 * an intent at all. Without that, ticking a box back on would leave an
 * `unchecked` entry behind and a later membership change would be fought by a
 * ghost the user had already undone.
 */
export function toggleListIntent(intent, listId, membership) {
  const checked = new Set(intent?.checked ?? []);
  const unchecked = new Set(intent?.unchecked ?? []);
  const wanted = !isListSelected(listId, { membership, checked, unchecked });

  checked.delete(listId);
  unchecked.delete(listId);
  if (wanted !== new Set(membership ?? []).has(listId)) {
    (wanted ? checked : unchecked).add(listId);
  }
  return { checked: [...checked], unchecked: [...unchecked] };
}

/**
 * The ticks on screen, and what Save diffs against the membership.
 *
 * `known` is the ids currently on screen, and it bounds the user's own ticks
 * only — never the membership. A list deleted on another device must not be
 * written to; a membership arriving while the rows are still painting must
 * still count, or the half-painted screen would turn every unseen list into a
 * removal, which is the bug one layer down.
 */
export function resolveSelection({ membership, checked, unchecked, known } = {}) {
  const selection = new Set(membership ?? []);
  const reachable = known == null ? null : new Set(known);
  for (const id of checked ?? []) {
    if (!reachable || reachable.has(id)) selection.add(id);
  }
  for (const id of unchecked ?? []) selection.delete(id);
  return selection;
}
