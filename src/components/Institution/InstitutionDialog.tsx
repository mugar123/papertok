import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import InstitutionLink from './InstitutionLink.tsx';
import './Institution.css';

/**
 * Settings opens the link in its own window: typing an address and leaving
 * for Google is a task, not a row to edit in place. The Dialog owns focus,
 * Escape and restoration; the form lands focus on the field, the first thing
 * in it. The same window manages a linked institution (Unlink).
 */
export default function InstitutionDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="institution-dialog" closeLabel="Close">
        <DialogTitle>{'Your university'}</DialogTitle>
        <DialogDescription className="institution-dialog-lede">
          {'Sign in with your university\'s Google account to verify where you study or work. Papers behind a paywall often open through your library.'}
        </DialogDescription>
        <InstitutionLink idPrefix="settings-institution" />
      </DialogContent>
    </Dialog>
  );
}
