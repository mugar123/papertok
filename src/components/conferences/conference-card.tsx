import { CalendarBlank, MapPin } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import ConferenceCover from './conference-cover.tsx';
import { conferenceFields } from '../../data/conferences.ts';
import type { ConferenceEdition } from '../../data/conferences.ts';
import { conferencePlace, conferenceSubtitle, coverSaysName, deadlineToday, formatConferenceDates, formatDeadline, nextDeadline } from '../../utils/conference-text.ts';

function Site({ dates, place }: { dates: string; place: string }) {
  return (
    <li>
      <span className="conference-site-dates"><CalendarBlank aria-hidden="true" /> {dates}</span>
      <span><MapPin aria-hidden="true" /> {place}</span>
    </li>
  );
}

/** The dates and place of each site. An edition without dates has one place. */
export function ConferenceSites({ edition }: { edition: ConferenceEdition }) {
  return (
    <ul className="conference-sites">
      {edition.dates.map(({ start, end, city }) => (
        <Site key={start + (city ?? '')} dates={formatConferenceDates(start, end)} place={conferencePlace(edition, city)} />
      ))}
      {!edition.dates.length && <Site dates="Dates to be announced" place={conferencePlace(edition)} />}
    </ul>
  );
}

/** `deadlineDay` is `deadlineToday()`, which a list computes once for all its cards. */
export default function ConferenceCard({ edition, search, deadlineDay }: { edition: ConferenceEdition; search: string; deadlineDay?: string }) {
  const subtitle = conferenceSubtitle(edition);
  const deadline = nextDeadline(edition, deadlineDay ?? deadlineToday(new Date()));
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
        <ConferenceSites edition={edition} />
        {deadline && <p className="conference-chip">{deadline.label} · {formatDeadline(deadline)}</p>}
      </div>
    </li>
  );
}
