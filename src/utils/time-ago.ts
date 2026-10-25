const DAY = 24 * 60 * 60 * 1000;

/**
 * "today", "yesterday", "3 days ago", "2 weeks ago"… for a Firestore
 * Timestamp, a Date or an ISO string; null when there is no usable date.
 */
export function timeAgo(value: { toDate(): Date } | Date | string | number | null | undefined, locale: string, now = Date.now()): string | null {
  if (!value) return null;
  const date = typeof value === 'object' && 'toDate' in value ? value.toDate() : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const days = Math.floor((now - time) / DAY);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (days < 1) return format.format(0, 'day');
  if (days < 7) return format.format(-days, 'day');
  if (days < 30) return format.format(-Math.floor(days / 7), 'week');
  if (days < 365) return format.format(-Math.floor(days / 30), 'month');
  return format.format(-Math.floor(days / 365), 'year');
}
