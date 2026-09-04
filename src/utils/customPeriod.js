/**
 * The date arithmetic behind Research's custom period.
 *
 * It lives out here rather than inside the panel so it can be pinned by tests:
 * every month index in this file is zero-based the way `Date` counts them, and
 * every string is a `YYYY-MM-DD` where the month is one-based the way ISO does.
 * That boundary is the only place an off-by-one month can hide, so it is the
 * one place worth proving.
 */

/** How many months the day step shows at once. */
export const MONTHS_VISIBLE = 3;

export function formatYMD(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The quarter a month belongs to, as the index of that quarter's first month. */
export function monthWindowStart(month) {
  const safe = Math.max(0, Math.min(11, Number(month) || 0));
  return safe - (safe % MONTHS_VISIBLE);
}

/** The months on screen when the window starts at `start`. */
export function monthsInWindow(start) {
  const from = monthWindowStart(start);
  return Array.from({ length: MONTHS_VISIBLE }, (_, i) => from + i).filter(m => m <= 11);
}

/**
 * One month laid out for a Monday-first grid: leading blanks, then the days.
 */
export function getDaysArray(year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayIndex = new Date(year, month, 1).getDay();
  const startOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

  return [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
}

/**
 * The period the panel is actually asking for.
 *
 * The single source for both the sentence on screen and what Apply sends, so
 * the two can never drift apart. A year that has not finished closes at today
 * rather than at 31 December, and says so.
 */
export function resolveCustomPeriod({ yearRange, startDateStr, endDateStr, todayStr }) {
  if (startDateStr) {
    const from = startDateStr;
    const to = endDateStr || startDateStr;
    // Two clicks in either order still describe the same span.
    return from <= to
      ? { from, to, cappedAtToday: false }
      : { from: to, to: from, cappedAtToday: false };
  }

  const fullRangeEnd = `${yearRange[1]}-12-31`;
  const capped = fullRangeEnd > todayStr;
  return {
    from: `${yearRange[0]}-01-01`,
    to: capped ? todayStr : fullRangeEnd,
    cappedAtToday: capped,
  };
}

/**
 * A `YYYY-MM-DD` read out in words.
 *
 * Parsed at midday deliberately: `new Date('1981-01-10')` is UTC midnight, which
 * is the previous day west of Greenwich and the reason date pickers the world
 * over are famously off by one. Midday local is the same calendar day in every
 * zone the app runs in.
 */
export function prettyDate(iso, locale = 'es-ES') {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${iso}T12:00:00`));
}
