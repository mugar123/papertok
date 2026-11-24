import { useSyncExternalStore } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { lastKnownAIUses, subscribeAIUses } from '../../services/paper-rewrite-service.ts';
import { ZoteroMark } from '../pdf/zotero-mark.tsx';
import { HELP_PAGE } from '../settings/settings-pages.ts';
import { SettingsRail, SettingsSwitcher } from '../settings/settings-pages-nav.tsx';
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

const OVERVIEW_HEADING = 'help-overview-heading';

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
        <h2 id={headingId(section)}>{section.title}</h2>
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
  const { user, loading, onboardingComplete, profileLoadError } = useAuth();
  // The navbar (app.tsx `showNavbar`) takes the top of the page; without it the
  // page starts at its own top.
  const hasNavbar = Boolean(user) && !loading && onboardingComplete && !profileLoadError;
  const { locale } = useLanguage();
  const uses = useSyncExternalStore(subscribeAIUses, () => lastKnownAIUses(user?.uid));
  const usesLine = aiUsesLine(uses, locale);

  return (
    <main className={`settings-page help-page${hasNavbar ? '' : ' help-page--bare'}`}>
      <div className="settings-shell">
        <header className="settings-heading">
          <h1>Help</h1>
          <p>What each button and gesture does, what it costs, and what needs an account.</p>
        </header>
        {/* A signed-in reader reaches Help from Settings, so the settings pages
            stay beside it; a visitor, who has no settings, gets the page alone. */}
        <div className="settings-layout">
          {hasNavbar && <SettingsSwitcher active={HELP_PAGE} />}
          {hasNavbar && <SettingsRail />}
          <div className="settings-content help-content">
            <section className="settings-section" aria-labelledby={OVERVIEW_HEADING}>
              <div className="settings-section-heading">
                <h2 id={OVERVIEW_HEADING}>What the buttons do</h2>
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
            </section>
            {HELP_SECTIONS.map(section => <HelpSectionView key={section.id} section={section} />)}
          </div>
        </div>
      </div>
    </main>
  );
}
