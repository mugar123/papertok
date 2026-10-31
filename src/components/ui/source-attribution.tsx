import type { MouseEventHandler } from 'react';

import './source-attribution.css';

/**
 * The credit a paper's data source gets where the data is shown
 * (utils/source-attribution.ts decides which): `lead` leads into the source's
 * name ("From", "With data from", "Abstract:"). With `href`, the name links
 * back to the source; Semantic Scholar's licence asks for that link, with
 * `utm_source=api`. A plain line of text, not a live region: it arrives with
 * the data it credits.
 * `as="span"` sets it inside the paragraph it credits, so it arrives and leaves
 * with those words; `onLinkClick` keeps a press on the link from reaching a
 * clickable surface around it.
 */
export function SourceAttribution({ lead, name, href, className = '', as: Tag = 'p', inert, onLinkClick }: {
  lead: string;
  name: string;
  href?: string;
  className?: string;
  as?: 'p' | 'span';
  inert?: boolean;
  onLinkClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <Tag className={`source-attribution ${className}`.trim()} inert={inert}>
      {lead}{' '}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" onClick={onLinkClick}>
          {name}<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      ) : name}
    </Tag>
  );
}
