import type { ReactNode } from 'react';
import type { HTMLMotionProps } from 'framer-motion';
import type { Paper } from '../../models/paper.ts';
import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils.ts';
import { getPaperFieldClassification } from '../../utils/paper-topic-tags.ts';
import { areaAccentForPaper } from '../../utils/area-accent.ts';
import { authorExplorerPath } from '../../utils/explorer-paths.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import AuthorDots from '../feed/author-dots.tsx';
import ScientificText from '../scientific-text.ts';
import { bylineText } from './list-row-byline.ts';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.tsx';
import '../feed/share-panel.css';
import './list-row.css';

type ListRowProps = Omit<HTMLMotionProps<'div'>, 'title' | 'onClick'> & {
  /** The meta line: the first slot takes the field colour, the rest are muted; empty slots are skipped. */
  meta?: (string | null | undefined | false)[];
  /** Stands in the meta line while it is empty and may still be filled, so the row does not grow when it is. */
  metaPlaceholder?: ReactNode;
  title: ReactNode;
  titleLang?: string;
  onOpen: () => void;
  aside?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
};

export function ListRow({ meta, metaPlaceholder, title, titleLang, onOpen, aside, actions, children, className, ...props }: ListRowProps) {
  const items = (meta ?? []).map((text, slot) => ({ text, slot })).filter((item): item is { text: string; slot: number } => Boolean(item.text));
  return (
    <motion.div {...props} className={cn('list-row', className)} onClick={onOpen}>
      <div className="list-row-content">
        {(items.length > 0 || aside || metaPlaceholder) && (
          <div className="list-row-head">
            {items.length === 0 && metaPlaceholder}
            {items.map(({ text, slot }, index) => (
              <span key={slot} className={slot === 0 ? 'list-row-lead' : 'list-row-meta'}>
                {index > 0 && <span aria-hidden="true">·</span>}
                {text}
              </span>
            ))}
            {aside && <span className="list-row-aside">{aside}</span>}
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

export function PaperListRow({ paper, style, ...props }: Omit<ListRowProps, 'meta' | 'title' | 'titleLang'> & { paper: Partial<Paper> }) {
  return (
    <ListRow
      {...props}
      style={{ ...style, '--area-accent': areaAccentForPaper(paper) }}
      meta={[
        getPaperFieldClassification(paper)?.label,
        paper.year ? String(paper.year) : null,
      ]}
      title={<ScientificText>{paper.title}</ScientificText>}
      titleLang="en"
    />
  );
}

/**
 * The first names of a byline, with how many more there are (`bylineText`).
 * The count sits outside the names, so a narrow row cuts a name rather than
 * the count.
 */
function BylineLabel({ names }: { names: string[] }) {
  const text = bylineText(names);
  return (
    <>
      <span className="list-row-byline-names">{text.names}</span>
      {text.more && <span className="list-row-byline-more">{text.more}</span>}
    </>
  );
}

/**
 * A paper's authors, opening the full list: overlapping initials by default,
 * or, with `byline`, the first names written out as a line of text.
 */
export function ListRowAuthors({ paper, onNavigate, byline = false }: { paper: Partial<Paper>; onNavigate?: () => void; byline?: boolean }) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const authors = paper.authors ?? [];
  const nameList = authors.map(author => (typeof author === 'string' ? author : author.name)).filter(Boolean);
  const names = nameList.join(', ');
  // The written byline is its own accessible name, so the visible names are
  // the ones read out; the dots carry nothing readable and need the label.
  const triggerLabel = byline ? undefined : `Authors: ${names}`;
  const trigger = byline
    ? <><span className="sr-only">{'Authors: '}</span><BylineLabel names={nameList} /></>
    : <AuthorDots authors={authors} />;
  const triggerClass = byline ? 'list-row-byline-btn' : 'pc-author-avatars';
  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger
          render={<button type="button" className={`${triggerClass} list-row-authors list-row-authors-btn`} onClick={(event) => event.stopPropagation()} />}
          aria-label={triggerLabel}
        >
          {trigger}
        </DrawerTrigger>
        <DrawerContent className="pc-share-sheet" viewportProps={{ onClick: (event) => event.stopPropagation() }}>
          <DrawerHandle />
          <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{'Authors'}</DrawerTitle>
          <ul className="pc-share-list list-row-authors-sheet">
            {authors.map((author, index) => {
              const name = typeof author === 'string' ? author : author.name;
              if (!name) return null;
              const path = authorExplorerPath(author, paper);
              const inner = (
                <>
                  <span className="pc-author-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                  {name}
                </>
              );
              return (
                <li key={index}>
                  {path
                    ? <Link to={path} className="pc-share-row list-row-authors-sheet-row" onClick={onNavigate}>{inner}</Link>
                    : <span className="list-row-authors-sheet-row">{inner}</span>}
                </li>
              );
            })}
          </ul>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <>
      <button
        type="button"
        className={byline ? 'list-row-byline-btn list-row-authors' : 'pc-author-avatars pc-authors-more list-row-authors'}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={triggerLabel}
        onClick={(event) => { event.stopPropagation(); setOpen(value => !value); }}
      >
        {trigger}
      </button>
      <div id={listId} className="pc-authors-list list-row-authors-list" data-open={open || undefined} inert={!open}>
        <ul>
          {authors.map((author, index) => {
            const name = typeof author === 'string' ? author : author.name;
            if (!name) return null;
            const path = authorExplorerPath(author, paper);
            const inner = (
              <>
                <span className="pc-author-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                <span className="pc-authors-list-name" title={name}>{name}</span>
              </>
            );
            return (
              <li key={index} style={{ '--i': index }}>
                {path
                  ? (
                    <Link
                      to={path}
                      className="pc-authors-list-item pc-author-link"
                      onClick={(event) => { event.stopPropagation(); onNavigate?.(); }}
                    >
                      {inner}
                    </Link>
                  )
                  : <span className="pc-authors-list-item">{inner}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
