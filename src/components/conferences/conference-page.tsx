import { ArrowLeft, ArrowUpRight, CalendarPlus } from '@phosphor-icons/react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { buttonVariants } from '../ui/button-variants.ts';
import PrivacyPopover from '../public/privacy-popover.tsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import ConferenceCard, { ConferenceSites } from './conference-card.tsx';
import ConferenceCover from './conference-cover.tsx';
import ConferenceDeadlines from './conference-deadlines.tsx';
import ConferenceFilterBar, { ClearFilters } from './conference-filter-bar.tsx';
import ConferenceMonthView from './conference-month-view.tsx';
import { filterConferences, filterLabels, isCalendarView, matchingSites, readConferenceDay, readConferenceFilters, withConferenceParam } from '../../utils/conference-filters.ts';
import type { ConferenceFilters } from '../../utils/conference-filters.ts';
import { calendarEntries, entriesInMonth } from '../../utils/conference-month.ts';
import { downloadConferenceIcs } from '../../utils/conference-ics.ts';
import { conferenceSubtitle, deadlineToday, formatConferenceDates, formatConferenceMonth, usesCcfDeadlines } from '../../utils/conference-text.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { conferenceEditions, conferenceFields, findConferenceEdition } from '../../data/conferences.ts';
import type { ConferenceEdition } from '../../data/conferences.ts';
import { groupConferences, localCalendarDate } from '../../utils/conference-calendar.ts';
import './conference-page.css';

/** What the source states. A format it does not state has no label. */
const formatLabels = { 'in-person': 'In person', online: 'Online', hybrid: 'In person + online' } as const;

function EditionGroup({ title, editions, search, deadlineDay }: { title: string; editions: readonly ConferenceEdition[]; search: string; deadlineDay: string }) {
  if (!editions.length) return null;
  return (
    <section className="conference-group">
      <h2>{title}</h2>
      <ul className="conference-list">
        {editions.map(edition => <ConferenceCard key={edition.id} edition={edition} search={search} deadlineDay={deadlineDay} />)}
      </ul>
    </section>
  );
}

/** The sources whose licence asks for a credit, among the editions shown. */
function Credits({ editions }: { editions: readonly ConferenceEdition[] }) {
  const ccf = editions.some(usesCcfDeadlines);
  const databio = editions.some(edition => edition.source === 'databio');
  if (!ccf && !databio) return null;
  return (
    <footer className="conference-credits">
      {ccf && <p><a href="https://github.com/ccfddl/ccf-deadlines">CCF Deadlines</a> (<a href="/licenses/ccf-deadlines.txt">MIT license</a>).</p>}
      {databio && <p><a href="https://github.com/databio/conferences">databio/conferences</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>). PaperTok selects entries and formats dates and locations.</p>}
    </footer>
  );
}

function Calendar() {
  const [params, setParams] = useSearchParams();
  const read = readConferenceFilters(params);
  const inCalendar = isCalendarView(params);
  // The calendar shows the month it is on. Only the list filters by it.
  const filters = inCalendar ? { ...read, month: null } : read;
  const today = localCalendarDate(new Date());
  const month = read.month ?? today.slice(0, 7);
  const editions = filterConferences(conferenceEditions, filters);
  const search = params.toString();
  const replace = (next: URLSearchParams) => setParams(next, { replace: true });
  // The calendar's month and day say where it is, not what to filter: the list starts from every month.
  const listParams = ['view', 'month', 'day'].reduce((next, name) => withConferenceParam(next, name, null), params);
  const goTo = (nextMonth: string | null, day: string | null) => replace(withConferenceParam(withConferenceParam(params, 'month', nextMonth), 'day', day));
  // Each site is its own entry, and a region keeps only the sites in it.
  const entries = inCalendar ? calendarEntries(editions.map(edition => ({ edition, sites: matchingSites(edition, filters) }))) : [];
  const inMonth = new Set(entriesInMonth(entries, month).map(entry => entry.edition)).size;
  const count = editions.length ? `${editions.length} ${editions.length === 1 ? 'conference' : 'conferences'}` : 'No conferences';
  return (
    <>
      <header className="conference-header conference-list-header">
        <div>
          <h1>Conference calendar</h1>
          <p>Explore research conferences by field, region, date and format.</p>
        </div>
        <ToggleGroup aria-label="View" value={[inCalendar ? 'calendar' : 'list']} onValueChange={([view]) => { if (view) replace(view === 'calendar' ? withConferenceParam(params, 'view', view) : listParams); }}>
          <ToggleGroupItem value="list">List</ToggleGroupItem>
          <ToggleGroupItem value="calendar">Calendar</ToggleGroupItem>
        </ToggleGroup>
      </header>
      <ConferenceFilterBar filters={filters} params={params} inCalendar={inCalendar} onChange={replace} />
      <div className="conference-state">
        {/* Naming the filters makes the announcement differ when the count does not. */}
        <p role="status" className="conference-count">
          {[count, ...filterLabels(filters), ...(inCalendar ? [`${inMonth} in ${formatConferenceMonth(month)}`] : [])].join(' · ')}
        </p>
        <ClearFilters filters={filters} params={params} inCalendar={inCalendar} onChange={replace} />
      </div>
      {inCalendar ? (
        <ConferenceMonthView
          month={month}
          today={today}
          entries={entries}
          search={search}
          day={readConferenceDay(params, month)}
          undated={editions.filter(edition => !edition.dates.length).length}
          listSearch={listParams.toString()}
          onMonth={nextMonth => goTo(nextMonth, null)}
          onDay={day => goTo(day.slice(0, 7), day.slice(8))}
        />
      ) : <ConferenceList editions={editions} filters={filters} today={today} search={search} />}
      <Credits editions={conferenceEditions} />
    </>
  );
}

function ConferenceList({ editions, filters, today, search }: { editions: readonly ConferenceEdition[]; filters: ConferenceFilters; today: string; search: string }) {
  const { upcoming, undated, past } = groupConferences(editions, today, filters.month, edition => matchingSites(edition, filters));
  const deadlineDay = deadlineToday(new Date());
  return (
    <>
      {[...upcoming].map(([month, rows]) => (
        <EditionGroup key={month} title={formatConferenceMonth(month)} editions={rows} search={search} deadlineDay={deadlineDay} />
      ))}
      <EditionGroup title="Dates to be announced" editions={undated} search={search} deadlineDay={deadlineDay} />
      <EditionGroup title="Past conferences" editions={past} search={search} deadlineDay={deadlineDay} />
    </>
  );
}

function Hero({ edition }: { edition: ConferenceEdition }) {
  const subtitle = conferenceSubtitle(edition);
  return (
    <>
      <ConferenceCover edition={edition} hero />
      <div className="conference-hero-copy">
        <p className="conference-field">{conferenceFields[edition.field]}</p>
        <h1>{edition.name}</h1>
        {subtitle && <p className="conference-series">{subtitle}</p>}
        <ConferenceSites edition={edition} />
        {edition.format && <p className="conference-chip">{formatLabels[edition.format]}</p>}
        <div className="conference-actions">
          {edition.dates.length > 0 && (
            <Button variant="outline" onClick={() => downloadConferenceIcs(edition)}>
              <CalendarPlus aria-hidden="true" /> Add to calendar
            </Button>
          )}
          {edition.url && (
            <a className={buttonVariants({ variant: 'outline' })} href={edition.url}>
              Official website <ArrowUpRight aria-hidden="true" />
            </a>
          )}
        </div>
        {edition.dates.length > 0 && <p className="conference-note">.ics download · No account needed</p>}
      </div>
    </>
  );
}

function Overview({ edition }: { edition: ConferenceEdition }) {
  const { venue, deadlines, dateText, dates } = edition;
  const place = edition.placeText ?? (dates.length === 1 ? dates[0].city : undefined);
  return (
    <>
      <h2>Overview</h2>
      <dl className="conference-facts">
        <div>
          <dt>Dates</dt>
          <dd>{dates.length ? dates.map(({ start, end, city }) => (
            <span key={start + (city ?? '')}>{formatConferenceDates(start, end)}{dates.length > 1 && city ? ` · ${city}` : ''}</span>
          )) : 'To be announced'}</dd>
        </div>
        {dateText && <div><dt>Dates in the organizer’s words</dt><dd>{dateText}</dd></div>}
        {venue && <div><dt>Venue</dt><dd>{venue}</dd></div>}
        {place && place !== venue && <div><dt>Location</dt><dd>{place}</dd></div>}
      </dl>
      {deadlines && <ConferenceDeadlines deadlines={deadlines} />}
    </>
  );
}

/** Back to the calendar as the reader left it, when they came from it. */
function BackToCalendar() {
  const { state } = useLocation() as { state: { calendarSearch?: unknown } | null };
  const search = typeof state?.calendarSearch === 'string' ? state.calendarSearch : '';
  return <Link className="conference-back" to={{ pathname: '/conferences', search }}><ArrowLeft aria-hidden="true" /> Conference calendar</Link>;
}

export default function ConferencePage() {
  const { user, loading } = useAuth();
  const { editionId } = useParams();
  const edition = findConferenceEdition(editionId);
  return (
    <main className="conference-page">
      {!user && !loading && (
        <nav className="conference-public-nav" aria-label="PaperTok">
          <Link to="/"><ArrowLeft aria-hidden="true" /> Back to PaperTok</Link>
          <PrivacyPopover />
        </nav>
      )}
      {editionId === undefined ? <Calendar /> : (
        <>
          <BackToCalendar />
          {edition ? (
            <article data-field={edition.field}>
              <header className="conference-header conference-hero">
                <Hero edition={edition} />
              </header>
              <section className="conference-details">
                <Overview edition={edition} />
                <p className="conference-source">
                  <a href={edition.sourceUrl ?? edition.url}>
                    {edition.source === 'ccf' ? 'CCF Deadlines' : edition.source === 'databio' ? 'databio/conferences' : 'Dates and location source'}
                  </a>
                  {edition.checkedOn && <> · Checked <time dateTime={edition.checkedOn}>{formatConferenceDates(edition.checkedOn, null)}</time></>}
                </p>
              </section>
            </article>
          ) : <h1>Conference not found</h1>}
          {edition && <Credits editions={[edition]} />}
        </>
      )}
    </main>
  );
}
