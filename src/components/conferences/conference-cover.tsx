import { Fragment, useMemo } from 'react';
import type { ConferenceEdition } from '../../data/conferences.ts';
import { coverAcronym } from '../../utils/conference-text.ts';
import { COVER_ART_VIEW_BOX, coverArt } from '../../utils/conference-cover-art.ts';
import './conference-cover.css';

/**
 * Art drawn from the field and the series, with the acronym and the year.
 * Decoration: the text beside a cover names the edition and its field.
 */
export default function ConferenceCover({ edition, hero = false }: { edition: ConferenceEdition; hero?: boolean }) {
  const { field, series, year, logo } = edition;
  const art = useMemo(() => coverArt(field, series), [field, series]);
  const acronym = coverAcronym(edition);
  const words = (acronym ?? String(year)).split('/');
  const length = words.join('/').length;
  const longestWord = Math.max(...words.flatMap(word => word.split(/[\s-]/)).map(word => word.length));
  const size = longestWord <= 5 && length <= 10 ? 'short' : longestWord <= 8 && length <= 16 ? 'medium' : 'long';
  return (
    <div className={`conference-cover${hero ? ' conference-cover--hero' : ''}`} aria-hidden="true">
      <svg className="conference-cover-art" viewBox={COVER_ART_VIEW_BOX} preserveAspectRatio="xMaxYMid slice" fill="none" stroke="currentColor">
        <path d={art.ground} />
        <path d={art.figure} strokeWidth="2" />
      </svg>
      {acronym && <span className="conference-cover-year">{year}</span>}
      {logo
        ? <img className="conference-cover-logo" src={logo} alt="" />
        : <span className="conference-cover-acronym" data-size={size}>{words.map((word, index) => <Fragment key={word}>{index > 0 && <>/<wbr /></>}{word}</Fragment>)}</span>}
    </div>
  );
}
