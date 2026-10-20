import type { ComponentProps } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import InstitutionLink from './InstitutionLink.tsx';
import './Institution.css';

/**
 * The Dialog owns focus,
 * Escape and restoration; the form lands focus on the field, the first thing
 * in it. The same window manages a linked institution (Unlink).
 */
export default function InstitutionDialog({ open, onOpenChange }: Pick<ComponentProps<typeof Dialog>, 'open' | 'onOpenChange'>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="institution-dialog" closeLabel="Close">
        <DialogTitle>{'Your university'}</DialogTitle>
        <DialogDescription className="institution-dialog-lede">
          {'Verify your university email to link your library. Papers behind a paywall often open through your library.'}
        </DialogDescription>
        <InstitutionLink idPrefix="settings-institution" />
      </DialogContent>
    </Dialog>
  );
}
