import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, CalendarBlank, CalendarPlus, MapPin } from '@phosphor-icons/react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { buttonVariants } from '../ui/button-variants.ts';
import PrivacyPopover from '../public/privacy-popover.tsx';
import ConferenceCover from './conference-cover.tsx';
import ConferenceFilterBar, { ClearFilters } from './conference-filter-bar.tsx';
import { filterConferences, filterLabels, readConferenceFilters } from '../../utils/conference-filters.ts';
import { downloadConferenceIcs } from '../../utils/conference-ics.ts';
import { conferenceSubtitle, coverSaysName, deadlineCloses, deadlineSources, formatConferenceDates, formatConferenceMonth, formatDeadline, nextDeadline, usesCcfDeadlines } from '../../utils/conference-text.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { conferenceEditions, conferenceFields, findConferenceEdition } from '../../data/conferences.ts';
import type { ConferenceDeadline, ConferenceEdition } from '../../data/conferences.ts';
import { groupConferences, localCalendarDate } from '../../utils/conference-calendar.ts';
import './conference-page.css';

/** What the source states. A format it does not state has no label. */
const formatLabels = { 'in-person': 'In person', online: 'Online', hybrid: 'In person + online' } as const;

function placeOf(edition: ConferenceEdition, city?: string) {
  return city ?? edition.placeText ?? edition.venue ?? (edition.format === 'online' ? 'Online' : 'Location to be announced');
}

function Site({ dates, place }: { dates: string; place: string }) {
  return (
    <li>
      <span className="conference-site-dates"><CalendarBlank aria-hidden="true" /> {dates}</span>
      <span><MapPin aria-hidden="true" /> {place}</span>
    </li>
  );
}

/** The dates and place of each site. An edition without dates has one place. */
function Sites({ edition }: { edition: ConferenceEdition }) {
  return (
    <ul className="conference-sites">
      {edition.dates.map(({ start, end, city }) => (
        <Site key={start + (city ?? '')} dates={formatConferenceDates(start, end)} place={placeOf(edition, city)} />
      ))}
      {!edition.dates.length && <Site dates="Dates to be announced" place={placeOf(edition)} />}
    </ul>
  );
}

function ConferenceCard({ edition, search, now }: { edition: ConferenceEdition; search: string; now: number }) {
  const subtitle = conferenceSubtitle(edition);
  const deadline = nextDeadline(edition, now);
  return (
    <li className="conference-card" data-field={edition.field}>
      <ConferenceCover edition={edition} />
      <div className="conference-card-copy">
        {/* The edition's name too, when the acronym and year on the cover do not make it. */}
        <p className="conference-field">{conferenceFields[edition.field]}{subtitle && !coverSaysName(edition) && ` · ${edition.name}`}</p>
        <h3>
          <Link to={`/conferences/${edition.id}`} state={{ calendarSearch: search }}>
            {subtitle && <span className="visually-hidden">{edition.name}: </span>}
            {subtitle ?? edition.name}
          </Link>
        </h3>
        <Sites edition={edition} />
        {deadline && <p className="conference-chip">{deadline.label} · {formatDeadline(deadline)}</p>}
      </div>
    </li>
  );
}

function EditionGroup({ title, editions, search, now }: { title: string; editions: readonly ConferenceEdition[]; search: string; now: number }) {
  if (!editions.length) return null;
  return (
    <section className="conference-group">
      <h2>{title}</h2>
      <ul className="conference-list">
        {editions.map(edition => <ConferenceCard key={edition.id} edition={edition} search={search} now={now} />)}
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
  const filters = readConferenceFilters(params);
  const today = localCalendarDate(new Date());
  // Read once, so one render compares every deadline with the same instant.
  const [now] = useState(() => Date.now());
  const editions = filterConferences(conferenceEditions, filters);
  const { upcoming, undated, past } = groupConferences(editions, today, filters.month);
  const search = params.toString();
  const replace = (next: URLSearchParams) => setParams(next, { replace: true });
  // Naming the filters makes the announcement differ when the count does not.
  const count = `${editions.length} ${editions.length === 1 ? 'conference' : 'conferences'}`;
  return (
    <>
      <header className="conference-header">
        <h1>Conference calendar</h1>
        <p>Explore research conferences by field, date and format.</p>
      </header>
      <ConferenceFilterBar filters={filters} params={params} onChange={replace} />
      <div className="conference-state">
        <p role="status" className="conference-count">
          {[editions.length ? count : 'No conferences', ...filterLabels(filters)].join(' · ')}
        </p>
        <ClearFilters filters={filters} params={params} onChange={replace} />
      </div>
      {[...upcoming].map(([month, rows]) => (
        <EditionGroup key={month} title={formatConferenceMonth(month)} editions={rows} search={search} now={now} />
      ))}
      <EditionGroup title="Dates to be announced" editions={undated} search={search} now={now} />
      <EditionGroup title="Past conferences" editions={past} search={search} now={now} />
      <Credits editions={conferenceEditions} />
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
        <Sites edition={edition} />
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

function DeadlineList({ deadlines }: { deadlines: readonly ConferenceDeadline[] }) {
  return (
    <dl className="conference-facts">
      {deadlines.map(deadline => (
        <div key={deadline.label + deadline.date}><dt>{deadline.label}</dt><dd><time dateTime={deadline.date}>{formatDeadline(deadline)}</time></dd></div>
      ))}
    </dl>
  );
}

function Deadlines({ deadlines }: { deadlines: readonly ConferenceDeadline[] }) {
  // Read once, so one render compares every deadline with the same instant.
  const [now] = useState(() => Date.now());
  const open = deadlines.filter(deadline => deadlineCloses(deadline) > now);
  const passed = deadlines.filter(deadline => deadlineCloses(deadline) <= now);
  return (
    <>
      <h3>Key deadlines</h3>
      {open.length > 0 && <DeadlineList deadlines={open} />}
      {passed.length > 0 && (
        <details className="conference-passed">
          <summary>{passed.length === 1 ? '1 passed deadline' : `${passed.length} passed deadlines`}</summary>
          <DeadlineList deadlines={passed} />
        </details>
      )}
      <p className="conference-source">
        Deadlines from {deadlineSources(deadlines).map(({ url, name }, index) => <span key={url}>{index > 0 && ', '}<a href={url}>{name}</a></span>)}. Confirm them with the organizer.
      </p>
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
      {deadlines && <Deadlines deadlines={deadlines} />}
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
