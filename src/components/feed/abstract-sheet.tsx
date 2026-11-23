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
import { PaperTranslationPicker, PaperTranslationStatus, TranslatedPaperText, type PaperTranslationState } from './paper-translation.tsx';
import './abstract-sheet.css';

/**
 * The abstract, read comfortably on a phone.
 *
 * On a fine pointer the card unfolds its abstract in place; on a phone the
 * column is bottom-anchored and short, the unfolded panel scrolls inside a
 * box a few lines tall, and reading it there is a thumb fight. A clipped
 * abstract opens here instead: a bottom sheet with the title and the whole
 * text, at the reader's own measure, dismissed by a swipe or the X. The
 * card's title opens it too, clipped abstract or not. Mounted
 * by the card as `{showAbstractSheet && <AbstractSheet/>}`; `open` flips on
 * the frame after mount (usePopupOpenOnMount) so the drawer actually arrives,
 * and the card unmounts it once the leave has played (`onOpenChangeComplete`).
 */
export default function AbstractSheet({ paper, onClose, translation }: {
  paper: Paper;
  onClose: () => void;
  translation: PaperTranslationState;
}) {
  const { open, requestClose } = usePopupOpenOnMount();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const attribution = sourceAttribution(paper);
  const translatedText = translation.current.showing ? translation.current.translation : undefined;
  const result = translation.current.translation;
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
            <DrawerTitle render={<h3 />} className="abstract-sheet-title" lang={result?.sourceLanguage} dir="auto"><ScientificText>{paper?.title}</ScientificText></DrawerTitle>
          </div>
          {/* `shrink-0`: the heading's flex basis is its title's whole width,
              so the row shares its shortfall with this button. Beside a
              seven-line title WebKit shrinks it to under 6px, glyph included:
              the global `svg { max-width: 100% }` leaves it no minimum. */}
          <DrawerClose
            ref={closeRef}
            render={<Button variant="ghost" size="icon" className="shrink-0" aria-label={'Close'} />}
          >
            <X size={20} />
          </DrawerClose>
        </header>
        <DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>
          <PaperTranslationPicker key={translation.scope} state={translation} />
          {result && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              translate="no"
              aria-disabled={translation.current.pending}
              onClick={() => {
                if (translation.current.pending) return;
                if (translatedText) translation.showOriginal();
                else void translation.translate(result.language);
              }}
            >
              {translatedText ? 'Show original' : 'Show translation'}
            </Button>
          )}
          <PaperTranslationStatus state={translation} />
          <p className="abstract-sheet-text">
            {translatedText
              ? <TranslatedPaperText translation={translatedText} />
              : <span lang={result?.sourceLanguage} dir="auto"><ScientificText>{paper.abstract}</ScientificText></span>}
          </p>
          {attribution && <SourceAttribution className="abstract-sheet-source" lead={attribution.label} name={attribution.name} href={attribution.href} />}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
