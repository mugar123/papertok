import type { ConferenceEdition } from '../data/conferences.ts';
import { downloadFile } from './reading-library.ts';

function escapeText(value: string) {
  return value.replace(/[\\;,]/g, match => '\\' + match).replace(/\r?\n/g, '\\n');
}

/** RFC 5545 lines are at most 75 octets. A continuation starts with a space. */
function fold(line: string) {
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = new TextEncoder().encode(character).length;
    if (octets + size > 75) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  return [...lines, current].join('\r\n');
}

function dateValue(date: string) {
  return date.replaceAll('-', '');
}

/** All-day events: an iCalendar end date is the day after the last one. */
function dayAfter(date: string) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** One all-day event per site, as an iCalendar file. */
export function conferenceIcs(edition: ConferenceEdition, now: Date) {
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const events = edition.dates.flatMap(({ start, end, city }, index) => {
    const location = city ?? edition.placeText ?? edition.venue ?? (edition.format === 'online' ? 'Online' : undefined);
    const summary = edition.dates.length > 1 && city ? `${edition.name} (${city})` : edition.name;
    return [
      'BEGIN:VEVENT',
      `UID:${edition.id}-${index + 1}@papertok.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dateValue(start)}`,
      `DTEND;VALUE=DATE:${dateValue(dayAfter(end ?? start))}`,
      `SUMMARY:${escapeText(summary)}`,
      ...(location ? [`LOCATION:${escapeText(location)}`] : []),
      ...(edition.url ? [`URL:${edition.url}`] : []),
      'END:VEVENT',
    ];
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PaperTok//Conference calendar//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR', '']
    .map(fold).join('\r\n');
}

export function downloadConferenceIcs(edition: ConferenceEdition) {
  downloadFile(new Blob([conferenceIcs(edition, new Date())], { type: 'text/calendar;charset=utf-8' }), `${edition.id}.ics`);
}
