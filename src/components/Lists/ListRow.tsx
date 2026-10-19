import type { ReactNode } from 'react';
import type { HTMLMotionProps } from 'framer-motion';
import type { PaperAuthor } from '../../models/Paper.ts';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils.ts';
import AuthorDots from '../Feed/AuthorDots.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import './ListRow.css';

type ListRowProps = Omit<HTMLMotionProps<'div'>, 'title' | 'onClick'> & {
  /** The meta line: the first slot takes the field colour, the rest are muted; empty slots are skipped. */
  meta?: (string | null | undefined | false)[];
  title: ReactNode;
  titleLang?: string;
  onOpen: () => void;
  actions?: ReactNode;
  children?: ReactNode;
};

/**
 * A ruled row: meta line, a serif title that is the row's keyboard opener,
 * whatever the caller adds under it, and actions on the right. The whole row
 * is a pointer target too; the title button carries the accessible name.
 */
export function ListRow({ meta, title, titleLang, onOpen, actions, children, className, ...props }: ListRowProps) {
  const items = (meta ?? []).map((text, slot) => ({ text, slot })).filter((item): item is { text: string; slot: number } => Boolean(item.text));
  return (
    <motion.div {...props} className={cn('list-row', className)} onClick={onOpen}>
      <div className="list-row-content">
        {items.length > 0 && (
          <div className="list-row-head">
            {items.map(({ text, slot }, index) => (
              <span key={slot} className={slot === 0 ? 'list-row-lead' : 'list-row-meta'}>
                {index > 0 && <span aria-hidden="true">·</span>}
                {text}
              </span>
            ))}
          </div>
        )}
        <p className="list-row-title" lang={titleLang}>
          <button
            type="button"
            className="list-row-title-btn"
            onClick={(event) => { event.stopPropagation(); onOpen(); }}
          >
            {title}
          </button>
        </p>
        {children}
      </div>
      {actions && <div className="list-row-actions">{actions}</div>}
    </motion.div>
  );
}

/** A paper row's byline: author dots, with every name in a tooltip and for assistive tech. */
export function ListRowAuthors({ authors }: { authors: Array<PaperAuthor | string> }) {
  const names = authors.map(author => (typeof author === 'string' ? author : author.name)).filter(Boolean).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="pc-author-avatars list-row-authors" />}>
        <AuthorDots authors={authors} />
        <span className="visually-hidden">{names}</span>
      </TooltipTrigger>
      <TooltipContent align="start" className="list-row-authors-tooltip" aria-hidden="true">{names}</TooltipContent>
    </Tooltip>
  );
}
