import type { MouseEventHandler } from 'react';

import './source-attribution.css';

/**
 * The credit Semantic Scholar's API licence asks for wherever its data is
 * shown: `lead` says what came from it, and the link goes back to it with
 * `utm_source=api` (utils/semantic-scholar-attribution.ts builds the href).
 * A plain line of text, not a live region: it arrives with the data it credits.
 * `as="span"` sets it inside the paragraph it credits, so it arrives and leaves
 * with those words; `onLinkClick` keeps a press on the link from reaching a
 * clickable surface around it.
 */
export function SourceAttribution({ lead, href, className = '', as: Tag = 'p', inert, onLinkClick }: {
  lead: string;
  href: string;
  className?: string;
  as?: 'p' | 'span';
  inert?: boolean;
  onLinkClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <Tag className={`source-attribution ${className}`.trim()} inert={inert}>
      {lead}{' '}
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={onLinkClick}>
        Semantic Scholar<span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </Tag>
  );
}
