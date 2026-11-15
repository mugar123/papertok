type AnnotationPosition = { sectionId?: string; paragraphIndex?: number };

/**
 * Ordering for the reader's notes.
 *
 * Kept pure and apart from the reader because the rule is easy to state and
 * easy to get subtly wrong: the notes read top to bottom like a margin, which
 * means document order and not arrival order.
 */

/**
 * Where each section sits in the rewrite, by id. Annotations carry a
 * `sectionId` and a `paragraphIndex` but nothing that says which section comes
 * first — that only exists in the order the sections streamed in.
 */
export function buildSectionOrder(sections: Array<{ id?: string }> = []) {
  const order = new Map<string, number>();
  sections.forEach((section, index) => {
    if (section?.id != null) order.set(String(section.id), index);
  });
  return order;
}

/**
 * Document order: section, then paragraph, then the passage's own position is
 * unknown so arrival order breaks the tie.
 *
 * An annotation whose section is no longer in the rewrite — a different level
 * regenerated the paper with other headings — sorts to the end rather than
 * being dropped. It is still the reader's note; it has simply lost its place.
 */
export function sortAnnotations<T extends AnnotationPosition>(annotations: readonly T[] = [], sectionOrder = new Map<string, number>()) {
  const placed = annotations.map((annotation, arrival) => ({ annotation, arrival }));
  placed.sort((left, right) => {
    const leftSection = sectionOrder.has(String(left.annotation?.sectionId))
      ? sectionOrder.get(String(left.annotation.sectionId))!
      : Number.MAX_SAFE_INTEGER;
    const rightSection = sectionOrder.has(String(right.annotation?.sectionId))
      ? sectionOrder.get(String(right.annotation.sectionId))!
      : Number.MAX_SAFE_INTEGER;
    if (leftSection !== rightSection) return leftSection - rightSection;

    const leftParagraph = Number(left.annotation?.paragraphIndex) || 0;
    const rightParagraph = Number(right.annotation?.paragraphIndex) || 0;
    if (leftParagraph !== rightParagraph) return leftParagraph - rightParagraph;

    return left.arrival - right.arrival;
  });
  return placed.map(entry => entry.annotation);
}

/**
 * Where an answer about `passage` will be filed among the annotations on
 * show — the index it will take in `visible` — so that the card waiting for it
 * can wait in that same place. The answer is stored last, so it sorts after
 * every note already on its paragraph: a stand-in handed to `sortAnnotations`
 * after the rest lands exactly where the answer will.
 */
export function answerSlot(visible: AnnotationPosition[] = [], passage: AnnotationPosition | null = null, sectionOrder = new Map<string, number>()) {
  if (!passage) return null;
  const standIn = { sectionId: passage.sectionId, paragraphIndex: passage.paragraphIndex };
  return sortAnnotations([...visible, standIn], sectionOrder).indexOf(standIn);
}
