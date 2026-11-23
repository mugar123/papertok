import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, CalendarBlank, MapPin } from '@phosphor-icons/react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { conferenceEditions, conferenceFields, findConferenceEdition } from '../../data/conferences.ts';
import type { ConferenceEdition } from '../../data/conferences.ts';
import { groupConferences } from '../../utils/conference-calendar.ts';
import './conference-page.css';

const fields = Object.entries(conferenceFields);
const monthFormat = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function formatDates(start: string, end: string | null) {
  return end ? dateFormat.formatRange(new Date(start), new Date(end)) : dateFormat.format(new Date(start));
}

function Dates({ edition }: { edition: ConferenceEdition }) {
  if (edition.sourceUrl || edition.placeText) {
    const date = edition.dates[0];
    return (
      <ul className="conference-dates">
        <li><CalendarBlank aria-hidden="true" /> {edition.dateText ?? (date ? formatDates(date.start, date.end) : 'Dates to be announced')}</li>
        <li><MapPin aria-hidden="true" /> {edition.placeText ?? (edition.online ? 'Online' : 'Location to be announced')}</li>
      </ul>
    );
  }
  return (
    <ul className="conference-dates">
      {edition.dates.map(({ start, end, city }) => (
        <li key={start + (city ?? '')}>
          <span><CalendarBlank aria-hidden="true" /> {formatDates(start, end)}</span>
          <span><MapPin aria-hidden="true" /> {city ?? 'Location to be announced'}</span>
        </li>
      ))}
    </ul>
  );
}

function EditionGroup({ title, editions }: { title: string; editions: readonly ConferenceEdition[] }) {
  if (!editions.length) return null;
  return (
    <section className="conference-group">
      <h2>{title}</h2>
      <ul className="conference-list">
        {editions.map(edition => (
          <li key={edition.id} data-field={edition.field}>
            <div className="conference-marker" aria-hidden="true"><CalendarBlank size={24} /></div>
            <div>
              <p className="conference-field">{conferenceFields[edition.field]}</p>
              <h3><Link to={`/conferences/${edition.id}`}>{edition.name}</Link></h3>
              <Dates edition={edition} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Credits() {
  return (
    <footer className="conference-credits">
      <p>Calendar sources include <a href="https://github.com/ccfddl/ccf-deadlines">CCF Deadlines</a> (<a href="/licenses/ccf-deadlines.txt">MIT license</a>) and <a href="https://github.com/databio/conferences">databio/conferences</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>). PaperTok selects entries and formats dates and locations.</p>
    </footer>
  );
}

function Calendar() {
  const [field, setField] = useState('all');
  const today = new Date().toISOString().slice(0, 10);
  const editions = conferenceEditions.filter(edition => field === 'all' || edition.field === field);
  const { upcoming, undated, past } = groupConferences(editions, today);
  return (
    <>
      <header className="conference-header">
        <h1>Conference calendar</h1>
        <p>Explore research conferences by field and date.</p>
      </header>
      <div className="conference-filter">
        <label htmlFor="conference-field">Research field</label>
        <select id="conference-field" value={field} onChange={event => setField(event.target.value)}>
          <option value="all">All fields</option>
          {fields.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <p role="status" className="conference-count">
        {editions.length === 0 ? 'No conferences listed for this field yet.' : `${editions.length} ${editions.length === 1 ? 'conference' : 'conferences'}`}
      </p>
      {[...upcoming].map(([month, rows]) => (
        <EditionGroup key={month} title={monthFormat.format(new Date(`${month}-01`))} editions={rows} />
      ))}
      <EditionGroup title="Dates to be announced" editions={undated} />
      <EditionGroup title="Past conferences" editions={past} />
      <Credits />
    </>
  );
}

export default function ConferencePage() {
  const { editionId } = useParams();
  const edition = findConferenceEdition(editionId);
  return (
    <main className="conference-page">
      {editionId === undefined ? <Calendar /> : (
        <>
          <Link className="conference-back" to="/conferences"><ArrowLeft aria-hidden="true" /> Conference calendar</Link>
          {edition ? (
            <article data-field={edition.field}>
              <header className="conference-header conference-hero">
                <p className="conference-field">{conferenceFields[edition.field]}</p>
                <h1>{edition.name}</h1>
                <p>{edition.series}</p>
              </header>
              <section className="conference-details">
                <h2>Dates and location</h2>
                <Dates edition={edition} />
                {edition.notes && <p>{edition.notes}</p>}
                <Button variant="outline" render={<a href={edition.url} />}>
                  Official website <ArrowUpRight aria-hidden="true" />
                </Button>
                <p className="conference-source">
                  <a href={edition.sourceUrl ?? edition.url}>
                    {edition.source === 'ccf' ? 'CCF Deadlines' : edition.source === 'databio' ? 'databio/conferences' : 'Organizer’s date and location information'}
                  </a>
                  {edition.checkedOn && <> · Checked <time dateTime={edition.checkedOn}>{dateFormat.format(new Date(edition.checkedOn))}</time></>}
                </p>
              </section>
            </article>
          ) : <h1>Conference not found</h1>}
          <Credits />
        </>
      )}
    </main>
  );
}
