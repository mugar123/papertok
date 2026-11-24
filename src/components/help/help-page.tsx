import type { MouseEvent } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
const OVERVIEW_TITLE = 'What the buttons do';

/** The page's contents, in its order: the overview, then every section. */
const CONTENTS = [
  { id: OVERVIEW_HEADING, title: OVERVIEW_TITLE },
  ...HELP_SECTIONS.map(section => ({ id: headingId(section), title: section.title })),
];

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
  // Without preventScroll, focusing cuts the smooth scroll short and the
  // heading stops mid-screen.
  heading?.focus({ preventScroll: true });
}

/**
 * The heading of the section being read: the last one whose top has passed a
 * line at 30% of the viewport, and the last section once the page cannot
 * scroll further (a short last section never reaches the line).
 */
function useSectionInView() {
  const [current, setCurrent] = useState(CONTENTS[0].id);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let next = CONTENTS[0].id;
      for (const { id } of CONTENTS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) next = id;
      }
      const root = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) next = CONTENTS[CONTENTS.length - 1].id;
      setCurrent(next);
    };
    const schedule = () => { frame ||= window.requestAnimationFrame(measure); };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return current;
}

/**
 * The page's contents beside it, the section being read marked. On a window
 * too short for the whole rail, the rail scrolls on its own and is moved, not
 * the page, so the marked entry stays in sight.
 */
function HelpContents({ current }: { current: string }) {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const link = navRef.current?.querySelector<HTMLElement>('[aria-current]');
    const rail = link?.closest<HTMLElement>('.settings-index');
    if (!link || !rail) return;
    // Back at the first section, the rail returns to its own top, with the
    // settings pages (or the visitor's label) above the contents.
    if (current === CONTENTS[0].id) {
      rail.scrollTop = 0;
      return;
    }
    const linkBox = link.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    if (linkBox.top < railBox.top) rail.scrollTop -= railBox.top - linkBox.top;
    else if (linkBox.bottom > railBox.bottom) rail.scrollTop += linkBox.bottom - railBox.bottom;
  }, [current]);
  return (
    <nav ref={navRef} className="help-toc" aria-label="Help sections">
      <ol className="help-toc-list">
        {CONTENTS.map(({ id, title }) => (
          <li key={id}>
            <a href={`#${id}`} aria-current={id === current ? 'location' : undefined} onClick={event => jumpTo(event, id)}>{title}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
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
  const { user, loading, onboardingComplete, profileLoadError } = useAuth();
  // The navbar (app.tsx `showNavbar`) takes the top of the page; without it the
  // page starts at its own top.
  const hasNavbar = Boolean(user) && !loading && onboardingComplete && !profileLoadError;
  const { locale } = useLanguage();
  const current = useSectionInView();
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
            stay beside it with the contents under Help; a visitor, who has no
            settings, gets the contents alone. */}
        <div className="settings-layout">
          {hasNavbar && <SettingsSwitcher active={HELP_PAGE} />}
          {hasNavbar ? (
            <SettingsRail expanded="help"><HelpContents current={current} /></SettingsRail>
          ) : (
            <div className="settings-index">
              <p className="help-toc-label">On this page</p>
              <HelpContents current={current} />
            </div>
          )}
          <div className="settings-content help-content">
            <section className="settings-section" aria-labelledby={OVERVIEW_HEADING}>
              <div className="settings-section-heading">
                <h2 id={OVERVIEW_HEADING} className="help-heading" tabIndex={-1}>{OVERVIEW_TITLE}</h2>
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
              {/* Under 901px, where the contents beside the page are hidden. */}
              <nav className="help-jump-nav" aria-label="Help sections">
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
      </div>
    </main>
  );
}
