/**
 * Marks each `·` separator in `row` that a wrap leaves at the end of its line, as "2020 ·", so the
 * stylesheet can hide it: one whose next item starts on a lower line, or that has none after it.
 */
export function markSeparatorLineEnds(row: Element | null) {
  for (const dot of row?.querySelectorAll<HTMLElement>('.pc-meta-dot') ?? []) {
    const next = dot.nextElementSibling as HTMLElement | null;
    dot.toggleAttribute('data-line-end', !next || next.offsetTop > dot.offsetTop + dot.offsetHeight / 2);
  }
}
