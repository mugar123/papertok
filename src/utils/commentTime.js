/**
 * Comment timestamps arrive as Firestore Timestamps, Dates, ISO strings, or
 * epoch millis depending on the path (SDK vs Worker JSON). One conversion so
 * sorting and relative time do not each invent a reader.
 */
export function commentMillis(value) {
  if (value == null) return 0;
  if (typeof value?.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : 0;
  }
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    const millis = date instanceof Date ? date.getTime() : NaN;
    return Number.isFinite(millis) ? millis : 0;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : 0;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : 0;
  }
  if (typeof value?.seconds === 'number') {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return 0;
}

export function commentDate(value) {
  const millis = commentMillis(value);
  return millis ? new Date(millis) : null;
}
