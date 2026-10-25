interface IndexView {
  readonly scrollY: number;
  scrollTo(options: { top: number; behavior: 'instant' }): void;
}

interface ListName {
  scrollIntoView(options: { block: 'nearest'; behavior: 'instant' }): void;
  focus(options: { preventScroll: true }): void;
}

/**
 * Takes the reader back to the index of lists the way they left it: scrolled
 * to the same place, with focus on the list they had open.
 *
 * The page swaps the index and an open list in one AnimatePresence, and that
 * swap puts the window at the top in both directions. Without this, closing a
 * list leaves the reader at the top of the index, with focus on <body>.
 */
export function createIndexReturn(view: IndexView) {
  let left: { top: number; listId: string } | null = null;

  return {
    /**
     * The reader opens a list from the index. Only that open calls this: a
     * list reopened on the way back from a paper has no index position in
     * this visit to return to.
     */
    leave(listId: string) {
      left = { top: view.scrollY, listId };
    },

    /**
     * The index is in the document again. Call it then, not when the open list
     * finishes leaving: at that point the page is still only as tall as the
     * list, and the position would be clamped. It spends what `leave` recorded,
     * so a later mount of the index does not jump.
     *
     * The position fits the layout the reader left. A window resized or a phone
     * turned while the list was open can leave the name off screen there, so
     * the name is brought into sight, below the navbar (its `scroll-margin`);
     * with an unchanged layout and the name in sight, nothing moves. Both
     * scrolls are instant, since `html { scroll-behavior: smooth }` would
     * animate them, and focus does not scroll again.
     */
    arrive(findName: (listId: string) => ListName | null) {
      if (!left) return;
      const { top, listId } = left;
      left = null;
      view.scrollTo({ top, behavior: 'instant' });
      const name = findName(listId);
      name?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      name?.focus({ preventScroll: true });
    },
  };
}
