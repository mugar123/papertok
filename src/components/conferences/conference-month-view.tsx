import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../ui/popover.tsx';
import ConferenceCard from './conference-card.tsx';
import { conferenceFields } from '../../data/conferences.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { addMonths, dayAfterKey, entriesBetween, entriesInMonth, layoutWeek, monthWeeks, nearestMonth, openingDay } from '../../utils/conference-month.ts';
import type { CalendarEntry, WeekSegment } from '../../utils/conference-month.ts';
import { conferencePlace, formatConferenceDates, formatConferenceMonth } from '../../utils/conference-text.ts';
import './conference-month-view.css';

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayFormat = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function formatDay(day: string) {
  return dayFormat.format(new Date(day));
}

function entryTitle({ edition, city }: CalendarEntry) {
  return edition.dates.length > 1 && city ? `${edition.name} · ${city}` : edition.name;
}

function entryKey({ edition, start, city }: CalendarEntry) {
  return edition.id + start + (city ?? '');
}

function entryDetails({ edition, start, end, city }: CalendarEntry) {
  return `${formatConferenceDates(start, start === end ? null : end)} · ${conferencePlace(edition, city)}`;
}

function conferenceCount(count: number) {
  return `${count} ${count === 1 ? 'conference' : 'conferences'}`;
}

function WeekdayHeader() {
  return (
    <thead>
      <tr>
        {weekdays.map(weekday => (
          <th key={weekday} scope="col"><span aria-hidden="true">{weekday.slice(0, 3)}</span><span className="visually-hidden">{weekday}</span></th>
        ))}
      </tr>
    </thead>
  );
}

function Bar({ segment, search }: { segment: WeekSegment; search: string }) {
  const { entry, span, lane, startsHere, endsHere } = segment;
  const title = entryTitle(entry);
  return (
    <li className="conference-bar" data-field={entry.edition.field} style={{ '--span': span, '--lane': lane }}>
      <Link to={`/conferences/${entry.edition.id}`} state={{ calendarSearch: search }} title={title} data-starts={startsHere || undefined} data-ends={endsHere || undefined}>
        {title}<span className="visually-hidden">, {entryDetails(entry)}{!startsHere && ', continued'}</span>
      </Link>
    </li>
  );
}

function MoreButton({ day, count, entries, search }: { day: string; count: number; entries: readonly CalendarEntry[]; search: string }) {
  return (
    <Popover>
      <PopoverTrigger className="conference-more">+{count} more<span className="visually-hidden"> on {formatDay(day)}</span></PopoverTrigger>
      <PopoverContent className="conference-more-popup">
        <PopoverTitle className="conference-more-title">{formatDay(day)}</PopoverTitle>
        <ul className="conference-more-list">
          {entriesBetween(entries, day, day).map(entry => (
            <li key={entryKey(entry)}>
              <Link to={`/conferences/${entry.edition.id}`} state={{ calendarSearch: search }}>{entryTitle(entry)}</Link>
              <p>{conferenceFields[entry.edition.field]} · {entryDetails(entry)}</p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A table, not an ARIA grid: it holds links to read, so Tab reaches each one
 * and a screen reader's table commands move between days.
 */
function MonthTable({ month, today, entries, search }: ViewProps) {
  return (
    <table className="conference-month">
      <caption className="visually-hidden">Conferences in {formatConferenceMonth(month)}</caption>
      <WeekdayHeader />
      <tbody>
        {monthWeeks(month).map((week) => {
          const { segments, rows, hidden } = layoutWeek(week, entries);
          return (
            <tr key={week[0]} style={{ '--rows': rows }}>
              {week.map((day, column) => {
                const starting = segments.filter(segment => segment.column === column);
                const outside = !day.startsWith(month);
                return (
                  <td key={day} aria-current={day === today ? 'date' : undefined} data-outside={outside || undefined}>
                    <time dateTime={day}>
                      {outside && <span className="visually-hidden">{formatConferenceMonth(day.slice(0, 7))} </span>}{Number(day.slice(8))}
                    </time>
                    {starting.length > 0 && (
                      <ul className="conference-bars">
                        {starting.sort((a, b) => a.lane - b.lane).map(segment => <Bar key={entryKey(segment.entry)} segment={segment} search={search} />)}
                      </ul>
                    )}
                    {hidden[column] > 0 && <MoreButton day={day} count={hidden[column]} entries={entries} search={search} />}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The phone's month is an ARIA grid: one tab stop, and arrow keys move between
 * days. Enter or a tap lists that day's conferences below it; a move into another
 * month lists the day it lands on.
 */
function DayPicker({ month, today, entries, search, day, onDay }: ViewProps & { day: string | null; onDay: (day: string) => void }) {
  const selected = openingDay(month, day, today, entries);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const movedTo = useRef<string | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  const tabStop = focusDay?.startsWith(month) ? focusDay : selected;

  // The day may be in a month the grid has yet to draw.
  useEffect(() => {
    const target = movedTo.current && grid.current?.querySelector<HTMLButtonElement>(`[data-day="${movedTo.current}"]`);
    if (!target) return;
    movedTo.current = null;
    target.focus();
  }, [focusDay, month]);

  const onKeyDown = (event: KeyboardEvent, from: string) => {
    const next = event.altKey || event.ctrlKey || event.metaKey ? null : dayAfterKey(from, event.key);
    if (!next) return;
    event.preventDefault();
    movedTo.current = next;
    setFocusDay(next);
    if (!next.startsWith(month)) onDay(next);
  };

  const chosen = [...new Set(entriesBetween(entries, selected, selected).map(entry => entry.edition))];
  return (
    <>
      <table ref={grid} role="grid" className="conference-days" aria-label={`Days of ${formatConferenceMonth(month)}`}>
        <WeekdayHeader />
        <tbody>
          {monthWeeks(month).map(week => (
            <tr key={week[0]}>
              {week.map((date) => {
                if (!date.startsWith(month)) return <td key={date} />;
                const meeting = entriesBetween(entries, date, date);
                return (
                  <td key={date} aria-selected={date === selected}>
                    <button
                      type="button"
                      data-day={date}
                      tabIndex={date === tabStop ? 0 : -1}
                      aria-current={date === today ? 'date' : undefined}
                      aria-pressed={date === selected}
                      aria-label={`${formatDay(date)}, ${meeting.length ? conferenceCount(meeting.length) : 'no conferences'}`}
                      onClick={() => { setFocusDay(date); onDay(date); }}
                      onKeyDown={event => onKeyDown(event, date)}
                    >
                      <span className="conference-day-number">{Number(date.slice(8))}</span>
                      <span className="conference-day-marks" aria-hidden="true">
                        {meeting.slice(0, 3).map(entry => <span key={entryKey(entry)} data-field={entry.edition.field} />)}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <section className="conference-day">
        <h2 aria-live="polite">{formatDay(selected)}<span className="visually-hidden">: {conferenceCount(chosen.length)}</span></h2>
        {chosen.length
          ? <ul className="conference-list">{chosen.map(edition => <ConferenceCard key={edition.id} edition={edition} search={search} />)}</ul>
          : <p className="conference-empty">No conferences on this day.</p>}
      </section>
    </>
  );
}

type ViewProps = { month: string; today: string; entries: readonly CalendarEntry[]; search: string };

type Props = ViewProps & {
  day: string | null;
  /** Editions with no dates, which only the list can show. */
  undated: number;
  listSearch: string;
  onMonth: (month: string | null) => void;
  onDay: (day: string) => void;
};

export default function ConferenceMonthView({ month, today, entries, search, day, undated, listSearch, onMonth, onDay }: Props) {
  const isPhone = useIsPhone();
  const heading = useRef<HTMLHeadingElement>(null);
  const empty = entriesInMonth(entries, month).length === 0;
  const nearest = empty ? nearestMonth(entries, month) : undefined;
  const view = { month, today, entries, search };
  return (
    <section className="conference-calendar" aria-labelledby="conference-month-title">
      <div className="conference-month-bar">
        <h2 id="conference-month-title" ref={heading} tabIndex={-1}>{formatConferenceMonth(month)}</h2>
        <Button variant="outline" onClick={() => onMonth(null)}>Today</Button>
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))}><CaretLeft aria-hidden="true" /></Button>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))}><CaretRight aria-hidden="true" /></Button>
      </div>
      {empty && (
        <p className="conference-empty">
          No conferences in {formatConferenceMonth(month)}.
          {/* The button leaves with the empty month, so the focus moves to the month it opened. */}
          {nearest && <Button variant="outline" size="sm" onClick={() => { onMonth(nearest); heading.current?.focus(); }}>Go to {formatConferenceMonth(nearest)}</Button>}
        </p>
      )}
      {isPhone ? <DayPicker {...view} day={day} onDay={onDay} /> : <MonthTable {...view} />}
      {undated > 0 && <p className="conference-empty"><Link to={`/conferences${listSearch && `?${listSearch}`}`}>{conferenceCount(undated)} without dates in the list</Link></p>}
    </section>
  );
}
