import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Bell,
  BookOpen,
  CaretRight,
  CircleNotch,
  Compass,
  Flask,
  GearSix,
  GraduationCap,
  LinkSimple,
  PencilSimple,
  ShieldCheck,
  Sparkle,
  Trash,
  UploadSimple,
  UserCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.js';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useFollowing } from '../../context/FollowingContext';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.ts';
import { PAPER_REWRITE_LEVELS } from '../../services/paperRewriteService.ts';
import { CATEGORIES } from '../../data/categories';
import { prepareProfileImage } from '../../utils/profileImage.ts';
import { SIGN_IN_PROVIDERS } from '../../services/authIdentityService.ts';
import GoogleMark from '../Public/GoogleMark.jsx';
import InstitutionDialog from '../Institution/InstitutionDialog.jsx';
import InstitutionPill from '../Institution/InstitutionPill.jsx';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import EditInterestsModal from './EditInterestsModal';
import DeleteAccountDialog from './DeleteAccountDialog';
import EmailNotificationModal from '../Following/EmailNotificationModal';
import { Button } from '../ui/button.jsx';
import { GithubMark } from '../ui/GithubMark.jsx';
import { Label } from '../ui/label.jsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.jsx';
import { Switch } from '../ui/switch.jsx';
import './SettingsPage.css';

/**
 * The settings pages, one route each: a page carries one subject, so there is
 * no scroll position to track and nothing to spy on. Order is the rail's.
 */
const SETTINGS_PAGES = [
  { slug: 'profile', label: 'Profile & account', Icon: UserCircle },
  { slug: 'discovery', label: 'Discovery', Icon: Compass },
  { slug: 'reading', label: 'Reading & AI', Icon: Sparkle },
  { slug: 'notifications', label: 'Notifications', Icon: Bell },
  { slug: 'privacy', label: 'Privacy', Icon: ShieldCheck },
];

const LEVEL_DETAILS = {
  beginner: {
    label: 'Beginner',
    description: 'Clear language and context from first principles',
    Icon: BookOpen,
  },
  university: {
    label: 'University',
    description: 'Academic rigor without assuming specialization',
    Icon: GraduationCap,
  },
  researcher: {
    label: 'Researcher',
    description: 'Methods, limitations, and technical detail',
    Icon: Flask,
  },
};

const SETTINGS_COPY = {
  title: 'Settings',
  subtitle: 'Your account, discovery preferences, and reading tools.',
  pagesLabel: 'Settings pages',
  accountPhoto: 'Account photo',
  accountPhotoDescription: 'Shown on your account button in the navigation bar.',
  photo: 'Photo',
  photoHint: 'PNG, JPEG or WebP. Saved as soon as you choose it.',
  uploadPhoto: 'Upload photo',
  changePhoto: 'Change photo',
  removePhoto: 'Remove',
  removeToSignInPhoto: 'Remove and go back to your sign-in photo',
  removeToInitial: 'Remove and go back to your initial',
  photoUpdated: { title: 'Photo updated', description: 'It shows across PaperTok.' },
  signInPhotoRestored: { title: 'Photo removed', description: 'Your sign-in photo is back in its place.' },
  photoRemoved: { title: 'Photo removed', description: 'Your initial shows in its place.' },
  photoSaveError: 'Photo not saved',
  photoRestoreError: { title: 'Photo not removed', description: 'The profile photo could not be removed. Try again.' },
  discovery: 'Discovery',
  discoveryDescription: 'Signals PaperTok uses to build your feeds.',
  followedContent: 'Following',
  loadingFollowing: 'Loading the content you follow...',
  followedOne: 'followed entity',
  followedMany: 'followed entities',
  recommendationsSuffix: 'influence your recommendations',
  viewAll: 'View all',
  viewAllFollowing: 'View all you follow',
  scientificInterests: 'Scientific interests',
  selectedOne: 'selected subcategory',
  selectedMany: 'selected subcategories',
  trainFeed: 'used to train your feed',
  selectedAreas: 'Selected areas',
  edit: 'Edit',
  editInterests: 'Edit scientific interests',
  readingAi: 'Reading & AI',
  readingAiDescription: 'Adjust the depth of your AI explanations.',
  aiLevelLabel: 'Default AI level, preselected when you ask AI to explain a paper',
  levelSaved: label => ({ title: 'Explanation level set', description: `New AI explanations start at the ${label} level.` }),
  levelError: { title: 'Level not saved', description: 'Your previous level is still in use. Try again.' },
  notifications: 'Notifications',
  notificationsDescription: 'Choose whether to receive updates while PaperTok is closed.',
  emailUpdates: 'Email updates',
  configure: 'Configure',
  configureEmail: 'Configure email updates',
  usageAnalytics: 'Usage analytics',
  usageAnalyticsDescription: 'Control the anonymous measurements used to improve PaperTok.',
  analyticsToggleLabel: 'Allow usage analytics',
  analyticsHint: 'Counts pages and actions anonymously, without cookies; never your searches, papers, interests or account. Saved on the spot.',
  institution: 'University',
  institutionDescription: 'Verify where you study or work by signing in with your university\'s Google account.',
  institutionLinked: name => `Verified with ${name}.`,
  link: 'Link',
  manage: 'Manage',
  institutionLink: 'Link your university',
  institutionManage: 'Manage your university',
  dangerZone: 'Danger zone',
  dangerZoneDescription: 'Irreversible actions.',
  deleteAccount: 'Delete account',
  deleteAccountDescription: 'Permanently deletes your account and everything in it.',
  access: 'Access',
  accessDescription: 'The ways you sign in. Each one opens the same account and the same data.',
  connectedAs: 'Connected as ',
  connected: 'Connected',
  onlyMethod: 'Your only way to sign in, so it cannot be disconnected.',
  methodLinked: 'You can sign in with it.',
  methodUnlinked: 'Connect it and you can sign in with it as well as the way you sign in today.',
  connectShort: 'Connect',
  connect: label => `Connect ${label}`,
  connecting: label => `Connecting ${label}…`,
  alreadyLinked: label => ({ title: 'Already connected', description: `You can sign in with ${label} now.` }),
  linkSuccess: label => ({ title: `${label} connected`, description: 'Next time you can sign in with either one. Both open this same account.' }),
  linkTaken: label => ({
    title: `That ${label} account is already in use`,
    description: `It opens a different PaperTok account. The two are not merged: sign in to that one if it is the account you want to keep, or connect a different ${label} account.`,
  }),
  linkFailed: label => `${label} not connected`,
};

const copy = SETTINGS_COPY;


// Errors stay until dismissed (ui/toast.js); successes leave on their own.
const notify = (kind, { title, description }) => (kind === 'error'
  ? toastError(title, { description })
  : toast[kind](title, { description }));

function SectionHeading({ id, title, description }) {
  return (
    <div className="settings-section-heading">
      <h2 id={id}>{title}</h2>
      {description && <p>{description}</p>}
    </div>
  );
}

/**
 * A row's action. The visible text is short because the row's heading says
 * what it acts on; the accessible name repeats that subject, and starts with
 * the visible text so speech input can still reach it (WCAG 2.5.3).
 */
function RowAction({ label, text = label, Icon, variant = 'outline', ...props }) {
  return (
    <Button variant={variant} size="sm" className="settings-row-action" aria-label={label === text ? undefined : label} {...props}>
      <Icon size={15} aria-hidden="true" />
      {text}
    </Button>
  );
}

function emailStatus(preferences, health, loading) {
  if (loading) {
    return {
      label: 'Checking',
      description: 'Loading your email settings',
      tone: 'neutral',
    };
  }
  if (!health.available) {
    return {
      label: 'Unavailable',
      description: 'The email service is not responding right now',
      tone: 'warning',
    };
  }
  if (!preferences.enabled) {
    return {
      label: 'Off',
      description: `Updates will not be sent to ${preferences.email || 'your email'}`,
      tone: 'neutral',
    };
  }
  return {
    label: 'On',
    description: `Every Monday · up to ${preferences.maxPapers || 5} papers`,
    tone: 'success',
  };
}

function ProfileAccountPage() {
  const navigate = useNavigate();
  const profileInputRef = useRef(null);
  const { language } = useLanguage();
  const { user, profilePhoto, updateProfilePhoto, signInProviders, linkSignInMethod, signOut, institution } = useAuth();
  const [savingPhoto, setSavingPhoto] = useState(false);
  // The method being connected, while its popup is open.
  const [linking, setLinking] = useState(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [institutionOpen, setInstitutionOpen] = useState(false);

  const gitHubLinked = signInProviders.includes(SIGN_IN_PROVIDERS.github);
  const googleLinked = signInProviders.includes(SIGN_IN_PROVIDERS.google);
  // AuthContext has no unlink, so a connected method offers no Disconnect;
  // the only way in says why it never could.
  const onlyMethod = [gitHubLinked, googleLinked].filter(Boolean).length === 1;
  const visibleProfilePhoto = profilePhoto || user?.photoURL;

  const handlePhotoSelect = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || savingPhoto) return;

    setSavingPhoto(true);
    try {
      const preparedPhoto = await prepareProfileImage(file);
      await updateProfilePhoto(preparedPhoto);
      notify('success', copy.photoUpdated);
    } catch (error) {
      toastError(copy.photoSaveError, { description: getUiErrorMessage(error, 'PROFILE_PHOTO_SAVE_FAILED') });
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleRestorePhoto = async () => {
    if (!profilePhoto || savingPhoto) return;
    setSavingPhoto(true);
    try {
      await updateProfilePhoto(null);
      notify('success', user?.photoURL ? copy.signInPhotoRestored : copy.photoRemoved);
    } catch {
      notify('error', copy.photoRestoreError);
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleLink = async (method) => {
    setLinking(method.id);
    try {
      const result = await linkSignInMethod(method.providerId);
      notify('success', result.alreadyLinked ? copy.alreadyLinked(method.label) : copy.linkSuccess(method.label));
    } catch (linkError) {
      // The identity already opens a different uid. Two Firestore trees are
      // never merged behind somebody's back (03-AUTH.md), so the honest move
      // is to say so and let them decide which account they keep.
      if (linkError?.code === 'AUTH_IDENTITY_TAKEN') {
        notify('error', copy.linkTaken(method.label));
      } else if (linkError?.code === 'auth/popup-closed-by-user'
        || linkError?.code === 'auth/cancelled-popup-request') {
        // Closing the popup is an answer, not a failure: nothing to say.
      } else {
        console.error(`Error linking ${method.label}:`, linkError);
        toastError(copy.linkFailed(method.label), { description: getUiErrorMessage(linkError, 'AUTH_LINK_FAILED') });
      }
    } finally {
      setLinking(null);
    }
  };

  const handleAccountDeleted = async () => {
    try {
      await signOut();
    } catch {
      // The Auth user may already be gone; the tab still has to leave.
    }
    navigate('/feed');
  };

  const identityFor = providerId => {
    const info = user?.providerData?.find(entry => entry.providerId === providerId);
    return info?.email || info?.displayName || '';
  };
  const methods = [
    { id: 'google', providerId: SIGN_IN_PROVIDERS.google, label: 'Google', Icon: GoogleMark, linked: googleLinked },
    { id: 'github', providerId: SIGN_IN_PROVIDERS.github, label: 'GitHub', Icon: GithubMark, linked: gitHubLinked },
  ];


  const photoField = (
    <div className="settings-photo-field">
      <div className="settings-profile-avatar">
        {visibleProfilePhoto ? (
          <img src={visibleProfilePhoto} alt="" referrerPolicy="no-referrer" decoding="async" width="56" height="56" />
        ) : (
          <div className="settings-profile-fallback" aria-hidden="true">
            {user?.email?.charAt(0).toUpperCase() || 'U'}
          </div>
        )}
        {savingPhoto && (
          <span className="settings-profile-loading" aria-hidden="true"><CircleNotch size={18} aria-hidden="true" /></span>
        )}
      </div>
      <div className="settings-photo-copy">
        <span className="settings-photo-label">{copy.photo}</span>
        <span className="profile-hint">{copy.photoHint}</span>
      </div>
      <div className="settings-profile-actions">
        <input
          ref={profileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handlePhotoSelect}
          tabIndex={-1}
          aria-hidden="true"
        />
        <Button type="button" variant="outline" size="sm" disabled={savingPhoto} onClick={() => profileInputRef.current?.click()}>
          <UploadSimple size={15} aria-hidden="true" />
          {profilePhoto ? copy.changePhoto : copy.uploadPhoto}
        </Button>
        {/* Only an uploaded photo can be removed; removing it falls back to
            the default (the sign-in photo, or the initial). */}
        {profilePhoto && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="settings-photo-remove"
            disabled={savingPhoto}
            onClick={handleRestorePhoto}
            title={user?.photoURL ? copy.removeToSignInPhoto : copy.removeToInitial}
          >
            <Trash size={15} aria-hidden="true" />
            {copy.removePhoto}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <section className="settings-section" aria-labelledby="settings-photo-heading">
        <SectionHeading id="settings-photo-heading" title={copy.accountPhoto} description={copy.accountPhotoDescription} />
        <div className="profile-fields">{photoField}</div>
      </section>

      <section className="settings-section" aria-labelledby="settings-access-heading">
        <SectionHeading id="settings-access-heading" title={copy.access} description={copy.accessDescription} />
        <div className="settings-list">
          {/* Every way in, the ones in use included. A method that is the
              only way in cannot be disconnected: the account would have no
              door. */}
          {methods.map(method => (
            <div key={method.id} className="settings-row">
              <div className="settings-row-content">
                <h3 className="settings-method-name"><method.Icon size={16} aria-hidden="true" />{method.label}</h3>
                <p>
                  {method.linked
                    ? (onlyMethod ? copy.onlyMethod : copy.methodLinked)
                    : copy.methodUnlinked}
                </p>
              </div>
              {method.linked ? (
                <span className="settings-method-actions">
                  <span className="settings-account-id">
                    <span className="settings-account-dot" aria-hidden="true" />
                    <span className="visually-hidden">{copy.connectedAs}</span>
                    {identityFor(method.providerId) || copy.connected}
                  </span>
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="settings-row-action"
                  onClick={() => handleLink(method)}
                  disabled={Boolean(linking)}
                  aria-label={linking === method.id ? copy.connecting(method.label) : copy.connect(method.label)}
                >
                  {linking === method.id
                    ? <CircleNotch size={15} className="settings-spin" aria-hidden="true" />
                    : <LinkSimple size={15} aria-hidden="true" />}
                  {copy.connectShort}
                </Button>
              )}
            </div>
          ))}
          <div className="settings-row">
            <div className="settings-row-content">
              <div className="settings-row-title-line">
                <h3>{copy.institution}</h3>
                {institution && <InstitutionPill institution={institution} />}
              </div>
              <p>{institution ? copy.institutionLinked(institution.name) : copy.institutionDescription}</p>
            </div>
            <RowAction
              Icon={institution ? GearSix : LinkSimple}
              label={institution ? copy.institutionManage : copy.institutionLink}
              text={institution ? copy.manage : copy.link}
              onClick={() => setInstitutionOpen(true)}
              aria-haspopup="dialog"
            />
          </div>
          <InstitutionDialog open={institutionOpen} onOpenChange={setInstitutionOpen} />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-danger-heading">
        <SectionHeading id="settings-danger-heading" title={copy.dangerZone} description={copy.dangerZoneDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-content">
              <h3>{copy.deleteAccount}</h3>
              <p>{copy.deleteAccountDescription}</p>
            </div>
            <RowAction Icon={Trash} variant="rose" label={copy.deleteAccount} onClick={() => setDeleteAccountOpen(true)} />
          </div>
        </div>
      </section>

      {deleteAccountOpen && (
        <DeleteAccountDialog
          open
          language={language}
          onClose={() => setDeleteAccountOpen(false)}
          onDeleted={handleAccountDeleted}
        />
      )}
    </>
  );
}

function PrivacyPage() {
  const { consent: analyticsConsent, updateConsent: updateAnalyticsConsent } = useAnalyticsConsent();

  return (
    <section className="settings-section" aria-labelledby="settings-analytics-heading">
      <SectionHeading id="settings-analytics-heading" title={copy.usageAnalytics} description={copy.usageAnalyticsDescription} />
      <div className="profile-fields">
        <Label className="profile-switch">
          <span className="profile-switch-copy">
            <span className="profile-switch-label">{copy.analyticsToggleLabel}</span>
            <span className="profile-switch-hint">{copy.analyticsHint}</span>
          </span>
          <Switch
            className="settings-toggle"
            checked={analyticsConsent === ANALYTICS_CONSENT.GRANTED}
            aria-label={copy.analyticsToggleLabel}
            onCheckedChange={checked => updateAnalyticsConsent(
              checked ? ANALYTICS_CONSENT.GRANTED : ANALYTICS_CONSENT.DENIED,
            )}
          />
        </Label>
      </div>
    </section>
  );
}

function DiscoveryPage() {
  const navigate = useNavigate();
  const { userPreferences } = useAuth();
  const { followedEntities, loading: followingLoading } = useFollowing();
  const [isInterestsOpen, setIsInterestsOpen] = useState(false);
  const selectedInterestCount = Array.isArray(userPreferences) ? userPreferences.length : 0;

  const selectedAreas = useMemo(() => {
    const selected = new Set(userPreferences || []);
    return Object.entries(CATEGORIES)
      .map(([id, area]) => {
        const count = Object.keys(area.subcategories).filter(key => selected.has(key)).length;
        return count > 0 ? { id, label: area.label, accent: area.gradient, count } : null;
      })
      .filter(Boolean);
  }, [userPreferences]);

  return (
    <>
      <section className="settings-section" aria-labelledby="settings-discovery-heading">
        <SectionHeading id="settings-discovery-heading" title={copy.discovery} description={copy.discoveryDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-content">
              <h3>{copy.followedContent}</h3>
              <p>
                {followingLoading && followedEntities.length === 0
                  ? copy.loadingFollowing
                  : `${followedEntities.length} ${followedEntities.length === 1 ? copy.followedOne : copy.followedMany} ${copy.recommendationsSuffix}`}
              </p>
            </div>
            <RowAction Icon={CaretRight} label={copy.viewAllFollowing} text={copy.viewAll} onClick={() => navigate('/settings/following')} />
          </div>

          <div className="settings-row">
            <div className="settings-row-content">
              <h3>{copy.scientificInterests}</h3>
              <p>
                {selectedInterestCount}{' '}
                {selectedInterestCount === 1 ? copy.selectedOne : copy.selectedMany} {copy.trainFeed}
              </p>
            </div>
            <RowAction Icon={PencilSimple} label={copy.editInterests} text={copy.edit} onClick={() => setIsInterestsOpen(true)} />
            {selectedAreas.length > 0 && (
              <div className="settings-interest-summary settings-row-tags" role="group" aria-label={copy.selectedAreas}>
                {/* Each area in its own field ink (design.md, rule 2). */}
                {selectedAreas.map(area => (
                  <span key={area.id} style={{ '--area-accent': area.accent }}>{area.label} <small>{area.count}</small></span>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      <EditInterestsModal isOpen={isInterestsOpen} onClose={() => setIsInterestsOpen(false)} />
    </>
  );
}

function ReadingPage() {
  const { readingPreferences, updateReadingPreferences } = useAuth();
  const [savingLevel, setSavingLevel] = useState(null);

  const handleLevelChange = async (level) => {
    if (level === readingPreferences.aiExplanationLevel || savingLevel) return;
    setSavingLevel(level);
    try {
      await updateReadingPreferences({ aiExplanationLevel: level });
      notify('success', copy.levelSaved(LEVEL_DETAILS[level].label));
    } catch {
      notify('error', copy.levelError);
    } finally {
      setSavingLevel(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="settings-reading-heading">
      <SectionHeading id="settings-reading-heading" title={copy.readingAi} description={copy.readingAiDescription} />
      {/* A ruled list of the three levels, like the rows on the other pages. */}
      <RadioGroup
        className="settings-levels"
        aria-label={copy.aiLevelLabel}
        value={readingPreferences.aiExplanationLevel}
        onValueChange={handleLevelChange}
        // Busy, not disabled: disabling the radio that holds focus dropped a
        // keyboard user onto <body>. handleLevelChange ignores a choice made
        // while another is saving.
        aria-busy={Boolean(savingLevel)}
      >
        {PAPER_REWRITE_LEVELS.map(({ id }) => {
          const { label, description, Icon } = LEVEL_DETAILS[id];
          const checked = readingPreferences.aiExplanationLevel === id;
          return (
            <RadioGroupItem
              key={id}
              value={id}
              render={<button type="button" />}
              nativeButton
            >
              <span className="settings-level-radio" aria-hidden="true" />
              <Icon size={18} weight={checked ? 'fill' : 'regular'} aria-hidden="true" />
              <span className="settings-level-copy">
                <strong>{label}</strong>
                <span>{description}</span>
              </span>
            </RadioGroupItem>
          );
        })}
      </RadioGroup>
    </section>
  );
}

function NotificationsPage() {
  const { preferences, health, loading } = useEmailNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const status = emailStatus(preferences, health, loading);

  return (
    <>
      <section className="settings-section" aria-labelledby="settings-notifications-heading">
        <SectionHeading id="settings-notifications-heading" title={copy.notifications} description={copy.notificationsDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-content">
              <div className="settings-row-title-line">
                <h3>{copy.emailUpdates}</h3>
                <span className={`settings-status is-${status.tone}`}>{status.label}</span>
              </div>
              <p>{status.description}</p>
            </div>
            <RowAction Icon={GearSix} label={copy.configureEmail} text={copy.configure} onClick={() => setIsOpen(true)} />
          </div>
        </div>
      </section>
      <EmailNotificationModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}

const PAGE_COMPONENTS = {
  profile: ProfileAccountPage,
  discovery: DiscoveryPage,
  reading: ReadingPage,
  notifications: NotificationsPage,
  privacy: PrivacyPage,
};

export default function SettingsPage({ page = 'profile' }) {
  const activeIndex = Math.max(0, SETTINGS_PAGES.findIndex(entry => entry.slug === page));
  const active = SETTINGS_PAGES[activeIndex];
  const Page = PAGE_COMPONENTS[active.slug];
  // Below 900px the rail is a sideways strip, and every page remounts it
  // scrolled to the start, which hid a later page's own tab past the edge.
  // Brought in just clear of the strip's fading edge (28px, SettingsPage.css).
  const indexListRef = useRef(null);
  useLayoutEffect(() => {
    const list = indexListRef.current;
    const link = list?.querySelector('a.is-active');
    if (!link) return;
    list.scrollLeft = Math.max(0, link.offsetLeft + link.offsetWidth - list.clientWidth + 28);
  }, [activeIndex]);

  // The tab keeps saying which page this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    const ours = `${active.label} · Settings | PaperTok`;
    document.title = ours;
    // Only restore if nothing claimed the title since (the outgoing route
    // stays mounted ~200ms into the next one under AnimatePresence).
    return () => { if (document.title === ours) document.title = previous; };
  }, [active]);

  return (
    <main className="settings-page">
      <div className="settings-shell">
        <header className="settings-heading">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </header>

        <div className="settings-layout">

          <nav className="settings-index" aria-label={copy.pagesLabel}>
            <div ref={indexListRef} className="settings-index-list">
              {SETTINGS_PAGES.map(entry => (
                <NavLink
                  key={entry.slug}
                  to={`/settings/${entry.slug}`}
                  replace
                  className={({ isActive }) => (isActive ? 'is-active' : '')}
                >
                  {/* Filled on the page you are on: the shape changes, not
                      only the colour. */}
                  {({ isActive }) => (
                    <>
                      <entry.Icon size={18} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                      {entry.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </nav>

          <div className="settings-content">
            <Page />
          </div>
        </div>
      </div>
    </main>
  );
}
