import type { AppUser } from '../../context/auth-context.tsx';
import type { ThemeContextValue } from '../../context/theme-context.tsx';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowSquareOut,
  Desktop,
  FolderOpen,
  GearSix,
  Moon,
  SignOut,
  Sun,
} from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useTheme } from '../../context/theme-context.tsx';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { GithubMark } from '../ui/github-mark.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTrigger } from '../ui/drawer.tsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.tsx';
import './account-menu.css';

const LINKS = [
  { to: '/lists', label: 'My lists', Icon: FolderOpen },
  { to: '/settings', label: 'Settings', Icon: GearSix },
];

const THEMES = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'System', Icon: Desktop },
];

export const PAPERTOK_REPO_URL = 'https://github.com/mugar123/papertok';


function Avatar({ photo, user, className = '' }: { photo: string | null; user: AppUser; className?: string }) {
  return photo ? (
    <img
      src={photo}
      alt=""
      className={`navbar-avatar ${className}`}
      referrerPolicy="no-referrer"
      decoding="async"
      width="26"
      height="26"
    />
  ) : (
    <div className={`navbar-avatar navbar-avatar--fallback ${className}`} aria-hidden="true">
      {user.email?.charAt(0).toUpperCase() || 'U'}
    </div>
  );
}

/**
 * The same account entries as the menu, as a bottom sheet: on a phone the
 * menu hung from the top corner, out of a thumb's reach, with 34 px rows.
 * A sheet is a dialog, not a menu, so its entries are plain links, a radio
 * group and a button; the Drawer owns focus, Escape and swipe-to-dismiss.
 */
function AccountSheet({ user, photo, preference, setPreference, onOpen, onSignOut }: { user: AppUser; photo: string | null; onOpen: () => void; onSignOut: () => void } & Pick<ThemeContextValue, 'preference' | 'setPreference'>) {
  const [open, setOpen] = useState(false);
  const firstRow = useRef<HTMLAnchorElement | null>(null);
  const close = () => setOpen(false);

  return (
    <Drawer open={open} onOpenChange={(next) => { setOpen(next); if (next) onOpen(); }}>
      <DrawerTrigger className="navbar-avatar-btn" aria-label="Account menu" title="Account">
        <Avatar photo={photo} user={user} />
      </DrawerTrigger>
      {/* Focus starts on the first entry, as the menu's does; the checked
          theme radio would otherwise take it, halfway down the sheet. */}
      <DrawerContent className="account-sheet" aria-label="Account menu" initialFocus={firstRow}>
        <DrawerHandle />
        <div className="account-sheet-head">
          <Avatar photo={photo} user={user} className="account-sheet-avatar" />
          <div className="account-sheet-identity">
            <strong>{user.displayName || 'PaperTok user'}</strong>
            <span>{user.email}</span>
          </div>
        </div>

        <nav className="account-sheet-list" aria-label="Account">
          {LINKS.map(({ to, label, Icon }, index) => (
            <Link key={to} ref={index === 0 ? firstRow : undefined} to={to} className="account-sheet-row" onClick={close}>
              <Icon size={20} aria-hidden="true" /> {label}
            </Link>
          ))}
        </nav>

        <div className="account-sheet-separator" />

        <div className="account-sheet-theme">
          <span id="account-sheet-theme-label" className="account-sheet-label">Appearance</span>
          <RadioGroup
            className="account-sheet-theme-options"
            aria-labelledby="account-sheet-theme-label"
            value={preference}
            onValueChange={setPreference}
          >
            {THEMES.map(({ id, label, Icon }) => (
              <RadioGroupItem
                key={id}
                value={id}
                className="account-sheet-theme-option"
                render={<button type="button" />}
                nativeButton
              >
                <Icon size={16} weight={preference === id ? 'fill' : 'regular'} aria-hidden="true" />
                {label}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </div>

        <div className="account-sheet-separator" />

        <a className="account-sheet-row" href={PAPERTOK_REPO_URL} target="_blank" rel="noreferrer">
          <GithubMark size={20} /> PaperTok is open source
          <ArrowSquareOut size={15} className="account-menu-external" aria-hidden="true" />
          <span className="visually-hidden">(opens in a new tab)</span>
        </a>

        <div className="account-sheet-separator" />

        <button type="button" className="account-sheet-row is-danger" onClick={onSignOut}>
          <SignOut size={20} aria-hidden="true" /> Log out
        </button>
      </DrawerContent>
    </Drawer>
  );
}

export default function AccountMenu() {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const { ensurePersonalLibrary } = useFeed();
  // My lists draws its folder previews from the library. Asked for when the
  // menu that leads there opens, the previews are in hand when the page is.
  const prefetchLists = () => { void ensurePersonalLibrary(); };

  const handleSignOut = async () => {
    await signOut();
    void navigate('/feed');
  };

  const photo = user!.photoURL;

  if (isPhone) {
    return (
      <AccountSheet
        user={user!}
        photo={photo}
        preference={preference}
        setPreference={setPreference}
        onOpen={prefetchLists}
        onSignOut={() => { void handleSignOut(); }}
      />
    );
  }

  return (
    <Menu.Root onOpenChange={(open) => { if (open) prefetchLists(); }}>
      <Menu.Trigger className="navbar-avatar-btn" aria-label="Account menu" title="Account">
        <Avatar photo={photo} user={user!} />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner className="account-menu-positioner" align="end" sideOffset={8}>
          <Menu.Popup className="account-menu">
            <div className="account-menu-head">
              <strong>{user!.displayName || 'PaperTok user'}</strong>
              <span>{user!.email}</span>
            </div>


            {LINKS.map(({ to, label, Icon }) => (
              <Menu.LinkItem key={to} className="account-menu-item" closeOnClick render={<Link to={to} />}>
                <Icon size={17} aria-hidden="true" /> {label}
              </Menu.LinkItem>
            ))}

            <Menu.Separator className="account-menu-separator" />

            <Menu.Group>
              <Menu.GroupLabel className="visually-hidden">Theme</Menu.GroupLabel>
              <Menu.RadioGroup
                className="account-menu-theme"
                value={preference}
                onValueChange={setPreference}
                style={{ '--theme-index': THEMES.findIndex(option => option.id === preference) }}
              >
                <span className="account-menu-theme-pill" aria-hidden="true" />
                {THEMES.map(({ id, label, Icon }) => (
                  <Menu.RadioItem key={id} value={id} closeOnClick={false} className="account-menu-theme-option">
                    <Icon size={14} weight={preference === id ? 'fill' : 'regular'} aria-hidden="true" />
                    {label}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>

            <Menu.Separator className="account-menu-separator" />

            <Menu.LinkItem className="account-menu-item" closeOnClick href={PAPERTOK_REPO_URL} target="_blank" rel="noreferrer">
              <GithubMark size={17} /> PaperTok is open source
              <ArrowSquareOut size={13} className="account-menu-external" aria-hidden="true" />
              <span className="visually-hidden">(opens in a new tab)</span>
            </Menu.LinkItem>

            <Menu.Separator className="account-menu-separator" />

            <Menu.Item className="account-menu-item is-danger" onClick={() => { void handleSignOut(); }}>
              <SignOut size={17} aria-hidden="true" /> Log out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
