import { ArrowRight, LockSimple } from '@phosphor-icons/react';
import { useLanguage } from '../../context/language-context.tsx';
import { Button } from '../ui/button.tsx';
import { GUEST_PREVIEW_LIMIT } from '../../utils/entity-explorer.ts';
import './explorer-guest-gate.css';

// The foot of a list somebody is reading without an account: one more row of
// the list, the height of the others, saying what is left and opening the same
// in-context door the rest of the explorer uses (`onAuthRequired` → AuthPrompt),
// so signing up happens here rather than on a page that would lose the entity.
//
// It is a block in the flow, not an overlay: nothing is dismissed, nothing is
// covered, and a visitor who does not want an account can still read the rows
// above and leave through any of the entity's links.
//
// The count comes from the entity's own publication total, and `guestGateTotal`
// hands over `null` rather than a figure that would not explain the wall. With
// no number the copy makes no claim about size.

const COPY = {
  papers: {
    lead: (rest: string | null) => (rest ? `${rest} more publications` : 'More publications'),
    body: 'with an account, plus search and filters.',
  },
  authors: {
    lead: () => 'More authors',
    body: 'with an account.',
  },
};

export default function ExplorerGuestGate({ kind = 'papers', total = null, onSignUp }: { kind?: keyof typeof COPY; total?: number | null; onSignUp?: () => void }) {
  const { locale } = useLanguage();
  const copy = COPY[kind];
  const rest = typeof total === 'number' ? (total - GUEST_PREVIEW_LIMIT).toLocaleString(locale) : null;

  return (
    <div className="explorer-guest-gate">
      <LockSimple size={18} aria-hidden="true" className="egg-icon" />
      <p className="egg-text"><strong>{copy.lead(rest)}</strong> {copy.body}</p>
      <Button variant="outline" size="sm" onClick={onSignUp}>
        Sign up
        <ArrowRight size={15} aria-hidden="true" />
      </Button>
    </div>
  );
}
