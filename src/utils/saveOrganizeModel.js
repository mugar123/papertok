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
