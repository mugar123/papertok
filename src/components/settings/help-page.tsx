import type { MouseEvent } from 'react';
import { useSyncExternalStore } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { lastKnownAIUses, subscribeAIUses } from '../../services/paper-rewrite-service.ts';
import { ZoteroMark } from '../pdf/zotero-button.tsx';
import {
  HELP_ALLOWANCE_RULES,
  HELP_OVERVIEW,
  HELP_SECTIONS,
  aiUsesLine,
  allowanceLabel,
  type HelpEntry,
  type HelpSection,
} from './help-guide.ts';
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
 * Settings › Help: what each button and gesture does, which of them spend a
 * limited allowance, and which need an account. The words live in
 * help-guide.ts; this draws them in the Settings layout.
 */
export default function HelpPage() {
  const { user } = useAuth();
  const { locale } = useLanguage();
  const uses = useSyncExternalStore(subscribeAIUses, () => lastKnownAIUses(user?.uid));
  const usesLine = aiUsesLine(uses, locale);

  return (
    <>
      <section className="settings-section" aria-labelledby="help-overview-heading">
        <div className="settings-section-heading">
          <h2 id="help-overview-heading" className="help-heading" tabIndex={-1}>What the buttons do</h2>
          <p>{HELP_OVERVIEW}</p>
          {usesLine && <p>{usesLine}</p>}
        </div>
        <dl className="help-legend">
          {(['free', 'ai', 'ai-new', 'publish'] as const).map(allowance => (
            <div key={allowance}>
              <dt><span className={`settings-status${allowance === 'free' ? '' : ' is-warning'}`}>{allowanceLabel(allowance)}</span></dt>
              <dd>{HELP_ALLOWANCE_RULES[allowance]}</dd>
            </div>
          ))}
          <div>
            <dt><span className="settings-status">Account needed</span></dt>
            <dd>Works only when signed in. A signed-out visitor who presses it is asked to sign in.</dd>
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
    </>
  );
}
