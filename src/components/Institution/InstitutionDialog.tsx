import { useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import InstitutionLink from './InstitutionLink.tsx';
import PetriStamp from '../Onboarding/PetriStamp.tsx';
import '../Settings/SettingsSheet.css';
import './Institution.css';

const TITLE = 'Your university';
const LEDE = 'Verify your university email to link your library. Papers behind a paywall often open through your library.';

/**
 * The Dialog owns focus,
 * Escape and restoration; the form lands focus on the field, the first thing
 * in it. The same window manages a linked institution (Unlink).
 *
 * On a phone it is a bottom sheet, like the other sheets Settings opens
 * (SettingsSheet.css); the handle and a swipe take the place of the X. Focus
 * lands on the title there rather than the field, so opening the sheet does
 * not raise the keyboard over it before the reader asks to type.
 */
export default function InstitutionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const isPhone = useIsPhone();
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  if (isPhone) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="settings-sheet institution-sheet" overlayClassName="settings-sheet-backdrop" initialFocus={titleRef}>
          <DrawerHandle />
          <div className="settings-sheet-head">
            <DrawerTitle ref={titleRef} tabIndex={-1} render={<h2 />} className="institution-title"><PetriStamp />{TITLE}</DrawerTitle>
            <DrawerDescription>{LEDE}</DrawerDescription>
          </div>
          <div className="settings-sheet-body" data-base-ui-swipe-ignore="">
            <InstitutionLink idPrefix="settings-institution" hideLabel />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="institution-dialog" closeLabel="Close">
        <DialogTitle className="institution-title"><PetriStamp />{TITLE}</DialogTitle>
        <DialogDescription className="institution-dialog-lede">{LEDE}</DialogDescription>
        <InstitutionLink idPrefix="settings-institution" hideLabel />
      </DialogContent>
    </Dialog>
  );
}
