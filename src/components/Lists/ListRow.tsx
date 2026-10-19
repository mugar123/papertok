import type { CSSProperties, ReactNode } from 'react';
import type { HTMLMotionProps } from 'framer-motion';
import type { Paper } from '../../models/Paper.ts';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils.ts';
import { getCategoryLabel } from '../../data/categories.ts';
import { areaAccentForPaper } from '../../utils/areaAccent.ts';
import { authorExplorerPath } from '../../utils/explorerPaths.ts';
import useIsPhone from '../../hooks/useIsPhone.ts';
import AuthorDots from '../Feed/AuthorDots.tsx';
import ScientificText from '../ScientificText.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.tsx';
import '../Feed/SharePanel.css';
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

export function PaperListRow({ paper, style, ...props }: Omit<ListRowProps, 'meta' | 'title' | 'titleLang'> & { paper: Partial<Paper> }) {
  return (
    <ListRow
      {...props}
      style={{ ...style, '--area-accent': areaAccentForPaper(paper) } as CSSProperties}
      meta={[
        (paper.categories?.length ?? 0) > 0 && getCategoryLabel(paper.categories![0]),
        paper.year ? String(paper.year) : null,
      ]}
      title={<ScientificText>{paper.title}</ScientificText>}
      titleLang="en"
    />
  );
}

export function ListRowAuthors({ paper, onNavigate }: { paper: Partial<Paper>; onNavigate?: () => void }) {
  const isPhone = useIsPhone();
  const authors = paper.authors ?? [];
  const names = authors.map(author => (typeof author === 'string' ? author : author.name)).filter(Boolean).join(', ');
  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger
          render={<button type="button" className="pc-author-avatars list-row-authors list-row-authors-btn" onClick={(event) => event.stopPropagation()} />}
          aria-label={`Authors: ${names}`}
        >
          <AuthorDots authors={authors} />
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
    <Tooltip>
      <TooltipTrigger render={<p className="pc-author-avatars list-row-authors" />}>
        <AuthorDots authors={authors} />
        <span className="visually-hidden">{names}</span>
      </TooltipTrigger>
      <TooltipContent align="start" className="list-row-authors-tooltip" aria-hidden="true">{names}</TooltipContent>
    </Tooltip>
  );
}
