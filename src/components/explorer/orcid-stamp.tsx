import { useId } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';

export default function OrcidStamp({ orcid }: { orcid: string }) {
  const id = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={`https://orcid.org/${orcid}`} target="_blank" rel="noopener noreferrer" />}
        className="ehc-orcid-stamp"
        aria-label={`Verified ORCID profile ${orcid}, opens orcid.org in a new tab`}
      >
        <svg viewBox="0 0 80 80" aria-hidden="true" focusable="false">
          <defs>
            <path id={`${id}-top`} d="M14 40a26 26 0 0 1 52 0" />
            <path id={`${id}-bottom`} d="M12 40a28 28 0 0 0 56 0" />
          </defs>
          <circle cx="40" cy="40" r="37" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <circle cx="40" cy="40" r="32" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2.4" />
          <text className="ehc-orcid-stamp-text"><textPath href={`#${id}-top`} startOffset="50%" textAnchor="middle">ORCID</textPath></text>
          <text className="ehc-orcid-stamp-text"><textPath href={`#${id}-bottom`} startOffset="50%" textAnchor="middle">VERIFIED</textPath></text>
          <path d="M29 41l7 7 15-15" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </TooltipTrigger>
      <TooltipContent>Verified ORCID profile · opens orcid.org</TooltipContent>
    </Tooltip>
  );
}
