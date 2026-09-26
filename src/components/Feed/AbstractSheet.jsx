import { useRef } from 'react';
import { X } from '@phosphor-icons/react';
import ScientificText from '../ScientificText';
import { useLanguage } from '../../context/LanguageContext';
import { usePopupOpenOnMount } from '../../hooks/usePopupOpenOnMount.js';
import { areaLabelForPaper } from '../../utils/areaAccent.js';
import { Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.jsx';
import './AbstractSheet.css';

/**
 * The abstract, read comfortably on a phone.
 *
 * On a fine pointer the card unfolds its abstract in place; on a phone the
 * column is bottom-anchored and short, the unfolded panel scrolls inside a
 * box a few lines tall, and reading it there is a thumb fight. A clipped
 * abstract opens here instead: a bottom sheet with the title and the whole
 * text, at the reader's own measure, dismissed by a swipe or the X. Mounted
 * by the card as `{showAbstractSheet && <AbstractSheet/>}`; `open` flips on
 * the frame after mount (usePopupOpenOnMount) so the drawer actually arrives,
 * and the card unmounts it once the leave has played (`onOpenChangeComplete`).
 */
export default function AbstractSheet({ paper, onClose }) {
  const { isEnglish } = useLanguage();
  const { open, requestClose } = usePopupOpenOnMount();
  const closeRef = useRef(null);
  const authors = (paper?.authors || []).map((author) => author?.name || author).filter(Boolean);
  const authorsLine = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClose(); }}
    >
      <DrawerContent render={<section />} className="abstract-sheet" initialFocus={closeRef}>
        <DrawerHandle />
        <header className="abstract-sheet-head">
          <div className="abstract-sheet-heading">
            <span className="abstract-sheet-kicker">{areaLabelForPaper(paper, { english: isEnglish })}</span>
            <DrawerTitle render={<h3 />} className="abstract-sheet-title"><ScientificText>{paper?.title}</ScientificText></DrawerTitle>
            {authorsLine && <p className="abstract-sheet-authors">{authorsLine}</p>}
          </div>
          <DrawerClose
            ref={closeRef}
            className="abstract-sheet-close"
            aria-label={isEnglish ? 'Close' : 'Cerrar'}
          >
            <X size={18} />
          </DrawerClose>
        </header>
        <DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>
          <p><ScientificText>{paper.abstract}</ScientificText></p>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
