import type { MouseEvent } from 'react';
import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { lastKnownAIUses, subscribeAIUses } from '../../services/paper-rewrite-service.ts';
import { Button } from '../ui/button.tsx';
import { ZoteroMark } from '../pdf/zotero-button.tsx';
import {
  HELP_ALLOWANCE_RULES,
  HELP_OVERVIEW,
  HELP_SECTIONS,
  aiUsesLine,
  allowanceLabel,
  type HelpAllowance,
  type HelpEntry,
  type HelpSection,
} from './help-guide.ts';
import '../settings/settings-page.css';
import './help-page.css';

const headingId = (section: HelpSection) => `help-${section.id}-heading`;

/**
 * Jumps to a section and moves keyboard focus to its heading. The href stays
 * for assistive technology and for a click that opens in a new tab; the
 * handler keeps the address and the history as they are.
 */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const heading = document.getElementById(id);
  heading?.scrollIntoView({ block: 'start' });
  heading?.focus();
}

function HelpRow({ entry, signedInOnly }: { entry: HelpEntry; signedInOnly: boolean }) {
  const { icon: Glyph } = entry;
  return (
    <li className={`settings-row help-row${Glyph ? '' : ' help-row--plain'}`}>
      {Glyph && (
        <span className="help-icon" aria-hidden="true">
          {Glyph === 'zotero' ? <ZoteroMark size={20} /> : <Glyph size={20} />}
        </span>
      )}
      <div className="settings-row-content">
        <h3>{entry.name}</h3>
        <p>{entry.what}</p>
        <p className="help-stamps">
          <span className="visually-hidden">Allowance: </span>
          <span className={`settings-status${entry.allowance === 'free' ? '' : ' is-warning'}`}>{allowanceLabel(entry.allowance)}</span>
          {entry.needsAccount && !signedInOnly && <span className="settings-status">Account needed</span>}
        </p>
      </div>
    </li>
  );
}

function HelpSectionView({ section }: { section: HelpSection }) {
  return (
    <section className="settings-section" aria-labelledby={headingId(section)}>
      <div className="settings-section-heading">
        <h2 id={headingId(section)} className="help-heading" tabIndex={-1}>{section.title}</h2>
        <p>{section.intro}</p>
        {section.signedInOnly && (
          <p className="help-section-note">
            <span className="settings-status">Account needed</span>
            {' Every control in this section needs you to be signed in.'}
          </p>
        )}
      </div>
      <ul className="settings-list help-list">
        {section.entries.map(entry => (
          <HelpRow key={entry.id} entry={entry} signedInOnly={Boolean(section.signedInOnly)} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Help: what each button and gesture does, which of them spend a limited
 * allowance, and which need an account. A public page: a visitor reads it from
 * the welcome, a signed-in reader from Settings. The words live in
 * help-guide.ts; this draws them in the Settings layout.
 */
export default function HelpPage() {
  const { user } = useAuth();
  const { locale } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  // Back returns to where the reader came from; opened directly, it goes to
  // the page that links here.
  const goBack = () => {
    if (location.key !== 'default') void navigate(-1);
    else void navigate(user ? '/settings' : '/onboarding');
  };
  const uses = useSyncExternalStore(subscribeAIUses, () => lastKnownAIUses(user?.uid));
  const usesLine = aiUsesLine(uses, locale);

  return (
    <main className="settings-page help-page">
      <div className="settings-shell">
        <Button variant="ghost" size="icon" className="help-back" onClick={goBack} aria-label="Back" title="Back">
          <ArrowLeft size={18} aria-hidden="true" />
        </Button>
        <header className="settings-heading">
          <h1>Help</h1>
          <p>What each button and gesture does, what it costs, and what needs an account.</p>
        </header>
        <div className="help-content">
      <section className="settings-section" aria-labelledby="help-overview-heading">
        <div className="settings-section-heading">
          <h2 id="help-overview-heading" className="help-heading" tabIndex={-1}>What the buttons do</h2>
          <p>{HELP_OVERVIEW}</p>
          {usesLine && <p>{usesLine}</p>}
        </div>
        <dl className="help-legend">
          {(Object.keys(HELP_ALLOWANCE_RULES) as HelpAllowance[]).map(allowance => (
            <div key={allowance}>
              <dt><span className={`settings-status${allowance === 'free' ? '' : ' is-warning'}`}>{allowanceLabel(allowance)}</span></dt>
              <dd>{HELP_ALLOWANCE_RULES[allowance]}</dd>
            </div>
          ))}
          <div>
            <dt><span className="settings-status">Account needed</span></dt>
            <dd>Works only when signed in. Where a signed-out visitor can see the control, pressing it asks them to sign in.</dd>
          </div>
        </dl>
        <nav aria-label="Help sections">
          <ul className="help-jump">
            {HELP_SECTIONS.map(section => (
              <li key={section.id}>
                <a href={`#${headingId(section)}`} onClick={event => jumpTo(event, headingId(section))}>{section.title}</a>
              </li>
            ))}
          </ul>
        </nav>
      </section>
      {HELP_SECTIONS.map(section => <HelpSectionView key={section.id} section={section} />)}
        </div>
      </div>
    </main>
  );
}
