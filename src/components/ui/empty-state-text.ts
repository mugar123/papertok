/** The ids an EmptyState given `textId` puts on its title and its body. */
export function emptyStateTextIds(textId: string) {
  return { title: `${textId}-title`, body: `${textId}-body` };
}

/**
 * The `aria-describedby` of an action that an empty state's title and body
 * describe, so a reader whose focus lands on it hears why it is there.
 */
export function emptyStateDescription(textId: string) {
  const { title, body } = emptyStateTextIds(textId);
  return `${title} ${body}`;
}
