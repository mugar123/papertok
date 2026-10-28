import type { Paper } from '../../models/paper.ts';
import { useRef } from 'react';
import { X } from '@phosphor-icons/react';
import ScientificText from '../scientific-text.ts';
import { usePopupOpenOnMount } from '../../hooks/use-popup-open-on-mount.ts';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/area-accent.ts';
import { sourceAttribution } from '../../utils/source-attribution.ts';
import { Button } from '../ui/button.tsx';
import { SourceAttribution } from '../ui/source-attribution.tsx';
import { Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import './abstract-sheet.css';

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
export default function AbstractSheet({ paper, onClose }: { paper: Paper; onClose: () => void }) {
  const { open, requestClose } = usePopupOpenOnMount();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const attribution = sourceAttribution(paper);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClose(); }}
    >
      <DrawerContent render={<section />} className="abstract-sheet" overlayClassName="abstract-sheet-backdrop" initialFocus={closeRef} style={{ '--area-accent': areaAccentForPaper(paper) }}>
        <DrawerHandle />
        <header className="abstract-sheet-head">
          <div className="abstract-sheet-heading">
            <span className="abstract-sheet-kicker">{areaLabelForPaper(paper)}</span>
            <DrawerTitle render={<h3 />} className="abstract-sheet-title"><ScientificText>{paper?.title}</ScientificText></DrawerTitle>
          </div>
          <DrawerClose
            ref={closeRef}
            render={<Button variant="ghost" size="icon-sm" aria-label={'Close'} />}
          >
            <X size={18} />
          </DrawerClose>
        </header>
        <DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>
          <p className="abstract-sheet-text"><ScientificText>{paper.abstract}</ScientificText></p>
          {attribution && <SourceAttribution className="abstract-sheet-source" lead={attribution.label} name={attribution.name} href={attribution.href} />}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
