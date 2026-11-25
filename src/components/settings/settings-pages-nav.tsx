import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { CaretDown, Check } from '@phosphor-icons/react';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { HELP_PAGE, SETTINGS_PAGES, isFollowsPath, type SettingsPageEntry } from './settings-pages.ts';

const PAGES_LABEL = 'Settings pages';

const pageHref = (entry: SettingsPageEntry) => entry.to ?? `/settings/${entry.slug}`;

/**
 * The navigation state for a step from `pathname` to `entry`. The settings
 * pages swap among themselves in place (app.tsx keys them as one route), but
 * Help has its own route, /help, so going to it slid it in from the right
 * over the settings page, and leaving it faded it out over the next one. They
 * are one list to the reader, so a step across is still. Only a step across
 * carries the state, because it stays on the history entry: coming back to
 * that entry later, from any page, is still too. Back from Help still runs
 * the return transition; the entry it returns to was not marked.
 */
const stepState = (entry: SettingsPageEntry, pathname: string) => (
  (entry === HELP_PAGE) !== (pathname.replace(/\/+$/, '') === HELP_PAGE.to)
    ? { pageMotion: 'still' }
    : undefined
);

/**
 * The phone's way between the pages (under 901px, where the rail is hidden):
 * a button naming the page you are on, opening a sheet with all of them.
 */
export function SettingsSwitcher({ active }: { active: SettingsPageEntry }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  return (
    <>
      <button
        type="button"
        className="settings-switcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="settings-switcher-icon"><active.Icon size={18} weight="fill" aria-hidden="true" /></span>
        <span className="settings-switcher-copy">
          <small>Settings page</small>
          <strong>{active.label}</strong>
        </span>
        <CaretDown size={16} aria-hidden="true" />
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="settings-pages-sheet">
          <DrawerHandle />
          <DrawerTitle render={<h3 />} className="settings-pages-title">Settings</DrawerTitle>
          <nav aria-label={PAGES_LABEL}>
            <ul className="settings-pages-list">
              {SETTINGS_PAGES.map(entry => (
                <li key={entry.slug}>
                  <NavLink
                    to={pageHref(entry)}
                    replace={!entry.to}
                    state={stepState(entry, pathname)}
                    className={({ isActive }) => (isActive ? 'is-active' : '')}
                    onClick={() => setOpen(false)}
                  >
                    {({ isActive }) => (
                      <>
                        <entry.Icon size={20} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                        <span className="settings-pages-copy">
                          <strong>{entry.label}</strong>
                          <small>{entry.summary}</small>
                        </span>
                        {isActive && <Check size={16} aria-hidden="true" />}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** The rail of pages beside the content, from 901px. */
export function SettingsRail() {
  const { pathname } = useLocation();
  // Discovery stays marked under the Follows dialog, whose route is not its own.
  const followsOpen = isFollowsPath(pathname);
  const marked = (entry: SettingsPageEntry, isActive: boolean) => isActive || (followsOpen && entry.slug === 'discovery');
  return (
    <nav className="settings-index" aria-label={PAGES_LABEL}>
      <div className="settings-index-list">
        {SETTINGS_PAGES.map(entry => (
          <NavLink
            key={entry.slug}
            to={pageHref(entry)}
            replace={!entry.to}
            state={stepState(entry, pathname)}
            className={({ isActive }) => (marked(entry, isActive) ? 'is-active' : '')}
          >
            {/* Filled on the page you are on: the shape changes, not
                only the colour. */}
            {({ isActive }) => (
              <>
                <entry.Icon size={18} weight={marked(entry, isActive) ? 'fill' : 'regular'} aria-hidden="true" />
                {entry.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
