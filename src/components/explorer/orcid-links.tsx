import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowSquareOut, Globe } from '@phosphor-icons/react';
import { foldMotion } from './explorer-fold.ts';

const SHOWN = 3;

type Link = { name?: string; url: string };

function LinkRow({ link }: { link: Link }) {
  return (
    <li>
      <a href={link.url} target="_blank" rel="noopener noreferrer" className="orcid-link">
        <Globe size={14} aria-hidden="true" />
        <span className="orcid-link-name">{link.name || 'External link'}</span>
        <ArrowSquareOut size={14} aria-hidden="true" />
      </a>
    </li>
  );
}

// The author's ORCID links, one per row: the first few, and the rest behind a
// toggle that opens them the way the project participants open.
export default function OrcidLinks({ links }: { links: Link[] }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();
  return (
    <>
      <ul id={id} className="orcid-links">
        {links.slice(0, SHOWN).map((link, i) => <LinkRow key={i} link={link} />)}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.li key="more" className="orcid-links-more" {...foldMotion(reduce)}>
              <ul className="orcid-links">
                {links.slice(SHOWN).map((link, i) => <LinkRow key={i} link={link} />)}
              </ul>
            </motion.li>
          )}
        </AnimatePresence>
      </ul>
      {links.length > SHOWN && (
        <button
          type="button"
          className="project-show-more"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={id}
        >
          {expanded ? 'Show fewer' : `Show ${links.length - SHOWN} more`}
        </button>
      )}
    </>
  );
}
