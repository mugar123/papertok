/**
 * Appends a page of thread rows to the ones on screen, by id.
 *
 * A page fetched from a value cursor — the Worker hands the sheet the last
 * comment's createdAt at millisecond precision, while Firestore keeps
 * microseconds — can begin with the comment the cursor was made from. React
 * keys are ids, and a duplicated key is a duplicated comment on screen.
 */
export function appendNewRows(previous, fresh) {
  const seen = new Set(previous.map(row => row.id));
  const additions = fresh.filter(row => !seen.has(row.id));
  return additions.length ? [...previous, ...additions] : previous;
}
