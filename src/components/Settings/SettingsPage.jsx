import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Bell,
  BookOpen,
  Briefcase,
  Buildings,
  Camera,
  CaretRight,
  ChartBar,
  ChatCircle,
  Check,
  CircleNotch,
  Code,
  Envelope,
  Flask,
  GraduationCap,
  Key,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  Sparkle,
  Tag,
  Trash,
  User,
  UsersThree,
} from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useFollowing } from '../../context/FollowingContext';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService';
import { AI_EXPLANATION_LEVELS } from '../../services/aiExplanationService';
import { CATEGORIES } from '../../data/categories';
import { PUBLIC_AVATAR_PRESET, prepareProfileImage } from '../../utils/profileImage';
import { profileIsPublic, savePublicProfilePhoto } from '../../services/userProfileService';
import { ownProfileCache, ownProfileKey } from '../../utils/profileSessionCaches.js';
import { SIGN_IN_PROVIDERS } from '../../services/authIdentityService';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { settleWithin } from '../../utils/asyncTiming';
import EditInterestsModal from './EditInterestsModal';
import DeleteAccountDialog from './DeleteAccountDialog';
import EmailNotificationModal from '../Following/EmailNotificationModal';
import { Button } from '../ui/button.jsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.jsx';
import { Switch } from '../ui/switch.jsx';
import './SettingsPage.css';

/* The GitHub mark (the same path the login page uses): the sign-in row is
   about the GitHub identity, and it was wearing the same generic code icon as
   the open-source row two rows above. */
function GitHubMark({ size = 20 }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

const LEVEL_DETAILS = {
  beginner: {
    label: { en: 'Beginner' },
    description: {
      en: 'Clear language and context from first principles',
    },
    Icon: BookOpen,
  },
  university: {
    label: { en: 'University' },
    description: {
      en: 'Academic rigor without assuming specialization',
    },
    Icon: GraduationCap,
  },
  researcher: {
    label: { en: 'Researcher' },
    description: {
      en: 'Methods, limitations, and technical detail',
    },
    Icon: Flask,
  },
};

const FOLLOW_SUMMARY = [
  { type: 'author', label: { en: 'Authors' }, Icon: User },
  { type: 'topic', label: { en: 'Topics' }, Icon: Tag },
  { type: 'institution', label: { en: 'Institutions' }, Icon: Buildings },
  { type: 'project', label: { en: 'Projects' }, Icon: Briefcase },
];

/**
 * The index rail down the left of the hub, and the identity of every section
 * on the page. Order is document order: the spy below picks the first entry
 * that touches the reading band, so this array must stay in sync with the
 * order the sections are rendered in.
 */
const SETTINGS_SECTIONS = [
  { id: 'settings-account', label: { en: 'Account' } },
  { id: 'settings-discovery', label: { en: 'Discovery' } },
  { id: 'settings-reading', label: { en: 'Reading and AI' } },
  { id: 'settings-notifications', label: { en: 'Notifications' } },
  { id: 'settings-privacy', label: { en: 'Privacy' } },
  { id: 'settings-community', label: { en: 'Community' } },
  { id: 'settings-access', label: { en: 'Access and session' } },
];

/**
 * Which section the reader is on, for the index rail.
 *
 * A "reading band" a little below the navbar decides: the active section is
 * the first one, in document order, whose box touches that band. Picking by
 * document order rather than by whichever entry the observer reports last is
 * what keeps the marker from flickering between two sections that straddle
 * the band at the same moment.
 */
function useSectionSpy(sectionIds) {
  const [activeId, setActiveId] = useState(sectionIds[0]);

  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return undefined;
    const nodes = sectionIds
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (nodes.length === 0) return undefined;

    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = sectionIds.find(id => visible.has(id));
        // No band contact at all (between sections, or bounced past the end)
        // keeps the last answer rather than clearing the marker.
        if (first) setActiveId(first);
      },
      { rootMargin: '-96px 0px -62% 0px' },
    );
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}

/**
 * The public copy's whole budget: the patient read (PUBLIC_PHOTO_READ_TIMEOUT_MS,
 * 8 s, with the stream kick at 3 s), the second compression and the commit.
 */
const PUBLIC_PHOTO_MIRROR_TIMEOUT_MS = 12_000;

const SETTINGS_COPY = {
  en: {
    eyebrow: 'User settings',
    title: 'Settings',
    subtitle: 'Your account, discovery preferences, and reading tools.',
    index: 'Index',
    indexLabel: 'Settings sections',
    indexHint: 'Changes are saved as you make them, section by section.',
    account: 'Account',
    defaultUser: 'PaperTok user',
    googleAccount: 'Account managed with Google',
    githubAccount: 'Account managed with GitHub',
    accountBothProviders: 'You sign in with Google and GitHub',
    genericAccount: 'PaperTok account',
    changePhoto: 'Change photo',
    restoreGooglePhoto: 'Restore Google photo',
    removePhoto: 'Remove profile photo',
    photoUpdated: 'Profile photo updated.',
    googlePhotoRestored: 'Your Google photo has been restored.',
    photoRemoved: 'Profile photo removed.',
    photoSaveError: 'The profile photo could not be saved.',
    photoRestoreError: 'The profile photo could not be restored.',
    photoPublicPending: 'The change is saved, but your public profile does not reflect it yet. Try again.',
    discovery: 'Discovery',
    discoveryDescription: 'Signals PaperTok uses to build your feeds.',
    followedContent: 'Following',
    loadingFollowing: 'Loading the content you follow...',
    followedOne: 'followed entity',
    followedMany: 'followed entities',
    recommendationsSuffix: 'influence your recommendations',
    followingSummary: 'Summary of followed content',
    viewAll: 'View all',
    publicProfile: 'Public profile',
    publicProfileDescription: 'Your handle, your bio and the lists you choose to show',
    profileIsPublicBadge: 'public',
    profileIsPrivateBadge: 'private',
    myComments: 'My comments',
    myCommentsDescription: 'What you have written on papers, moderated items included',
    scientificInterests: 'Scientific interests',
    selectedOne: 'selected subcategory',
    selectedMany: 'selected subcategories',
    trainFeed: 'used to train your feed',
    selectedAreas: 'Selected areas',
    edit: 'Edit',
    readingAi: 'Reading and AI',
    readingAiDescription: 'Adjust the depth of your AI explanations.',
    defaultAiLevel: 'Default AI level',
    defaultAiDescription: 'This level will be preselected when you ask AI to explain a paper',
    saving: 'Saving...',
    preferenceSaved: 'Preference saved',
    saveError: 'Could not save',
    aiLevelLabel: 'Default explanation level',
    notifications: 'Notifications',
    notificationsDescription: 'Choose whether to receive updates while PaperTok is closed.',
    emailUpdates: 'Email updates',
    configure: 'Configure',
    privacy: 'Privacy',
    privacyDescription: 'Control the anonymous measurements used to improve PaperTok.',
    usageAnalytics: 'Usage analytics',
    usageAnalyticsDescription: 'Only anonymous pages are recorded; never searches, papers, interests, or account data.',
    analyticsEnabled: 'On',
    analyticsDisabled: 'Off',
    analyticsToggleLabel: 'Allow usage analytics',
    deleteAccount: 'Delete account',
    deleteAccountDescription: 'Deletes your profile, your data, and sign-in access. It cannot be undone.',
    deleteAccountAction: 'Delete',
    community: 'Community',
    communityDescription: 'Explore the project and take part in its development.',
    openSource: 'PaperTok is open source',
    openSourceDescription: 'View the code, share ideas, or contribute on GitHub.',
    viewOnGitHub: 'View on GitHub',
    opensNewTab: 'opens in a new tab',
    access: 'Access and session',
    accessDescription: 'Different doors, the same account and the same data.',
    session: 'Session',
    sessionDescription: 'Your personalized information remains linked to this account.',
    signOut: 'Sign out',
    signInMethods: 'Ways to sign in',
    signInMethodsDescription: 'Different doors, the same account and the same data.',
    githubMethod: 'Sign in with GitHub',
    githubLinked: 'Connected. You can sign in with GitHub now.',
    githubUnlinked: 'Connect it and you can sign in with GitHub as well as the way you sign in today.',
    connect: 'Connect',
    connecting: 'Connecting...',
    connected: 'Connected',
    linkSuccess: 'GitHub connected. Next time you can sign in with either one.',
    linkTaken: 'That GitHub account already opens a different PaperTok account. The two are not merged: sign in to the other one if that is the account you want to keep, or connect a different GitHub account.',
  },
};

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
    description: `${preferences.frequency === 'weekly' ? 'Every Monday' : 'Every morning'} · up to ${preferences.maxPapers || 5} papers`,
    tone: 'success',
  };
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const profileInputRef = useRef(null);
  const { language } = useLanguage();
  const { consent: analyticsConsent, updateConsent: updateAnalyticsConsent } = useAnalyticsConsent();
  const copy = SETTINGS_COPY[language];
  const {
    user,
    userPreferences,
    readingPreferences,
    profilePhoto,
    updateReadingPreferences,
    updateProfilePhoto,
    signInProviders,
    linkGitHubAccount,
    signOut,
  } = useAuth();
  const {
    followedEntities,
    followedByType,
    loading: followingLoading,
  } = useFollowing();
  const {
    preferences: notificationPreferences,
    health: notificationHealth,
    loading: notificationsLoading,
  } = useEmailNotifications();
  const [isInterestsOpen, setIsInterestsOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [savingLevel, setSavingLevel] = useState(null);
  const [levelFeedback, setLevelFeedback] = useState(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoFeedback, setPhotoFeedback] = useState(null);
  const [linkingGitHub, setLinkingGitHub] = useState(false);
  const [linkFeedback, setLinkFeedback] = useState(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);

  const sectionIds = useMemo(() => SETTINGS_SECTIONS.map(section => section.id), []);
  const activeSection = useSectionSpy(sectionIds);

  /**
   * The public profile's handle, for the row's badge — read from the session
   * cache the profile screens fill, never fetched. The badge is a courtesy:
   * if nothing has read the profile yet this session, the row says what it
   * always said rather than paying a Firestore read to decorate itself.
   */
  const cachedProfile = user?.uid
    ? ownProfileCache.get(ownProfileKey(user.uid))?.profile
    : null;

  const jumpToSection = useCallback((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    // The rail moves the viewport, so the heading it lands on takes focus:
    // a keyboard user must not be left with focus behind the scroll.
    node.focus({ preventScroll: true });
  }, []);

  const gitHubLinked = signInProviders.includes(SIGN_IN_PROVIDERS.github);
  const googleLinked = signInProviders.includes(SIGN_IN_PROVIDERS.google);
  const accountBadge = gitHubLinked && googleLinked
    ? copy.accountBothProviders
    : gitHubLinked ? copy.githubAccount
      : googleLinked ? copy.googleAccount
        : copy.genericAccount;

  const handleLinkGitHub = async () => {
    setLinkingGitHub(true);
    setLinkFeedback(null);
    try {
      const result = await linkGitHubAccount();
      setLinkFeedback({ tone: 'success', text: result.alreadyLinked ? copy.githubLinked : copy.linkSuccess });
    } catch (linkError) {
      // The GitHub identity already opens a different uid. Two Firestore trees
      // are never merged behind somebody's back (03-AUTH.md), so the honest
      // move is to say so and let them decide which account they keep.
      if (linkError?.code === 'AUTH_IDENTITY_TAKEN') {
        setLinkFeedback({ tone: 'error', text: copy.linkTaken });
      } else if (linkError?.code === 'auth/popup-closed-by-user'
        || linkError?.code === 'auth/cancelled-popup-request') {
        setLinkFeedback(null);
      } else {
        console.error('Error linking GitHub:', linkError);
        setLinkFeedback({ tone: 'error', text: getUiErrorMessage(linkError, 'AUTH_LINK_FAILED') });
      }
    } finally {
      setLinkingGitHub(false);
    }
  };

  const selectedAreas = useMemo(() => {
    const selected = new Set(userPreferences || []);
    return Object.entries(CATEGORIES)
      .map(([id, area]) => {
        const count = Object.keys(area.subcategories).filter(key => selected.has(key)).length;
        return count > 0 ? { id, label: area.label, count } : null;
      })
      .filter(Boolean);
  }, [userPreferences]);

  // The tab keeps saying which screen this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    const ours = 'Settings | PaperTok';
    document.title = ours;
    // Only restore if nothing claimed the title since (the outgoing route
    // stays mounted ~200ms into the next one under AnimatePresence).
    return () => { if (document.title === ours) document.title = previous; };
  }, [language]);

  const selectedInterestCount = Array.isArray(userPreferences) ? userPreferences.length : 0;
  const notificationStatus = emailStatus(
    notificationPreferences,
    notificationHealth,
    notificationsLoading,
  );
  const visibleProfilePhoto = profilePhoto || user?.photoURL;

  useEffect(() => {
    if (levelFeedback !== 'saved') return undefined;
    const timer = window.setTimeout(() => setLevelFeedback(null), 1_800);
    return () => window.clearTimeout(timer);
  }, [levelFeedback]);

  useEffect(() => {
    if (photoFeedback?.tone !== 'success') return undefined;
    const timer = window.setTimeout(() => setPhotoFeedback(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [photoFeedback]);

  const handleLevelChange = async (level) => {
    if (level === readingPreferences.aiExplanationLevel || savingLevel) return;
    setSavingLevel(level);
    setLevelFeedback(null);
    try {
      await updateReadingPreferences({ aiExplanationLevel: level });
      setLevelFeedback('saved');
    } catch {
      setLevelFeedback('error');
    } finally {
      setSavingLevel(null);
    }
  };

  // The public profile keeps its own copy: `users/{uid}` is owner-only, so a
  // signed-out visitor could never see the private one. The copy is
  // best-effort — a failure is not worth losing the photo the user just set —
  // but it is neither unbounded nor silent: the spinner waits on it, and a
  // public page left on the old picture is exactly what the user would check
  // next (reported 2026-09-23, when this waited forever on a dead stream).
  // Pinned to the account that chose the file: compressions and reads happen
  // between the click and the write, and `auth.currentUser` may be somebody
  // else by then.
  const mirrorPublicPhoto = async (makePhoto) => {
    const settled = await settleWithin(
      Promise.resolve()
        .then(makePhoto)
        .then(photo => savePublicProfilePhoto(photo, { currentUser: user })),
      PUBLIC_PHOTO_MIRROR_TIMEOUT_MS,
    );
    if (settled.status === 'fulfilled') return true;
    console.error('Could not mirror the photo to the public profile:', settled.reason || 'timed out');
    return false;
  };

  const handlePhotoSelect = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || savingPhoto) return;

    setSavingPhoto(true);
    setPhotoFeedback(null);
    try {
      const preparedPhoto = await prepareProfileImage(file);
      await updateProfilePhoto(preparedPhoto);
      // Recompressed again because the public budget is 60 KB against 280 KB here.
      const mirrored = await mirrorPublicPhoto(() => prepareProfileImage(file, PUBLIC_AVATAR_PRESET));
      setPhotoFeedback(mirrored
        ? { tone: 'success', text: copy.photoUpdated }
        : { tone: 'error', text: copy.photoPublicPending });
    } catch (error) {
      setPhotoFeedback({
        tone: 'error',
        text: getUiErrorMessage(error, 'PROFILE_PHOTO_SAVE_FAILED'),
      });
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleRestorePhoto = async () => {
    if (!profilePhoto || savingPhoto) return;
    setSavingPhoto(true);
    setPhotoFeedback(null);
    try {
      await updateProfilePhoto(null);
      // Removing the upload falls back to the account picture, so the public
      // profile follows it there rather than being left on the old one.
      const mirrored = await mirrorPublicPhoto(() => user?.photoURL || null);
      setPhotoFeedback(mirrored
        ? { tone: 'success', text: user?.photoURL ? copy.googlePhotoRestored : copy.photoRemoved }
        : { tone: 'error', text: copy.photoPublicPending });
    } catch {
      setPhotoFeedback({ tone: 'error', text: copy.photoRestoreError });
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/feed');
  };

  const handleAccountDeleted = async () => {
    try {
      await signOut();
    } catch {
      // The Auth user may already be gone; the tab still has to leave.
    }
    navigate('/feed');
  };


  return (
    <>
      <main className="settings-page">
        <div className="settings-shell">
          <header className="settings-heading">
            <span>{copy.eyebrow}</span>
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </header>

          <div className="settings-layout">
            {/* The page's own table of contents. It is decoration for a mouse
                and a shortcut for everyone else, so it is a real nav of real
                buttons rather than a scroll-position ornament. */}
            <nav className="settings-index" aria-label={copy.indexLabel}>
              <span className="settings-index-title">{copy.index}</span>
              <div
                className="settings-index-list"
                style={{ '--settings-active': Math.max(0, SETTINGS_SECTIONS.findIndex(s => s.id === activeSection)) }}
              >
                <span className="settings-index-marker" aria-hidden="true" />
                {SETTINGS_SECTIONS.map((section, position) => {
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={active ? 'is-active' : ''}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => jumpToSection(section.id)}
                    >
                      <span aria-hidden="true">{String(position + 1).padStart(2, '0')}</span>
                      {section.label[language]}
                    </button>
                  );
                })}
              </div>
              <p className="settings-index-hint">{copy.indexHint}</p>
            </nav>

            <div className="settings-content">
              <section
                id="settings-account"
                tabIndex={-1}
                className="settings-profile"
                aria-labelledby="settings-account-title"
              >
                <div className="settings-profile-avatar">
                  {visibleProfilePhoto ? (
                    <img
                      src={visibleProfilePhoto}
                      alt=""
                      referrerPolicy="no-referrer"
                      // First section of the page, visible on load -- not lazy.
                      // `.settings-profile-avatar > img` renders at 82x82 (66x66
                      // on the narrow layout).
                      decoding="async"
                      width="82"
                      height="82"
                    />
                  ) : (
                    <div className="settings-profile-fallback" aria-hidden="true">
                      {user?.email?.charAt(0).toUpperCase() || 'U'}
                    </div>
                  )}
                  {savingPhoto && (
                    <span className="settings-profile-loading" aria-hidden="true">
                      <CircleNotch size={22} />
                    </span>
                  )}
                </div>

                <div className="settings-profile-copy">
                  <small>{copy.account}</small>
                  <h2 id="settings-account-title">{user?.displayName || copy.defaultUser}</h2>
                  <p>{user?.email}</p>
                  <span><ShieldCheck size={14} /> {accountBadge}</span>
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
                  <Button
                    variant="outline"
                    className="settings-photo-button"
                    disabled={savingPhoto}
                    onClick={() => profileInputRef.current?.click()}
                  >
                    <Camera size={17} aria-hidden="true" />
                    {copy.changePhoto}
                  </Button>
                  {profilePhoto && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="settings-photo-restore"
                      disabled={savingPhoto}
                      onClick={handleRestorePhoto}
                      aria-label={user?.photoURL ? copy.restoreGooglePhoto : copy.removePhoto}
                      title={user?.photoURL ? copy.restoreGooglePhoto : copy.removePhoto}
                    >
                      <ArrowCounterClockwise size={17} aria-hidden="true" />
                    </Button>
                  )}
                </div>

                <p
                  className={`settings-photo-feedback ${photoFeedback ? `is-${photoFeedback.tone}` : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  {photoFeedback?.text || ''}
                </p>
              </section>

              <section id="settings-discovery" tabIndex={-1} className="settings-section" aria-labelledby="discovery-heading">
                <div className="settings-section-heading">
                  <SlidersHorizontal size={18} />
                  <div>
                    <h2 id="discovery-heading">{copy.discovery}</h2>
                    <p>{copy.discoveryDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row" style={{ '--settings-index': 0 }}>
                    <span className="settings-row-icon is-purple"><User size={20} /></span>
                    <div className="settings-row-content">
                      <div className="settings-row-title-line">
                        <h3>{copy.publicProfile}</h3>
                        {/* Only when the profile is already in hand: the badge is
                            worth a glance, never a read. */}
                        {cachedProfile?.handle && (
                          <span className={`settings-handle-badge ${profileIsPublic(cachedProfile) ? 'is-public' : ''}`}>
                            @{cachedProfile.handle}
                            {' · '}
                            {profileIsPublic(cachedProfile) ? copy.profileIsPublicBadge : copy.profileIsPrivateBadge}
                          </span>
                        )}
                      </div>
                      <p>{copy.publicProfileDescription}</p>
                    </div>
                    <Button variant="outline" className="settings-row-action" onClick={() => navigate('/settings/profile')}>
                      {copy.edit} <CaretRight size={17} aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 1 }}>
                    <span className="settings-row-icon is-purple"><ChatCircle size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.myComments}</h3>
                      <p>{copy.myCommentsDescription}</p>
                    </div>
                    <Button variant="outline" className="settings-row-action" onClick={() => navigate('/settings/comments')}>
                      {copy.viewAll} <CaretRight size={17} aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 1 }}>
                    <span className="settings-row-icon is-purple"><UsersThree size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.followedContent}</h3>
                      <p>
                        {followingLoading && followedEntities.length === 0
                          ? copy.loadingFollowing
                          : `${followedEntities.length} ${followedEntities.length === 1 ? copy.followedOne : copy.followedMany} ${copy.recommendationsSuffix}`}
                      </p>
                      {/* Only the kinds actually followed: four zeros in a row are
                          noise, and "0 followed entities" already says it all. */}
                      {FOLLOW_SUMMARY.some(({ type }) => (followedByType[type]?.length || 0) > 0) && (
                        <div className="settings-follow-summary" aria-label={copy.followingSummary}>
                          {FOLLOW_SUMMARY
                            .filter(({ type }) => (followedByType[type]?.length || 0) > 0)
                            .map(({ type, label, Icon }) => (
                              <span key={type}>
                                <Icon size={12} />
                                {label[language]}
                                <strong>{followedByType[type].length}</strong>
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                    <Button variant="outline" className="settings-row-action" onClick={() => navigate('/settings/following')}>
                      {copy.viewAll} <CaretRight size={17} aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 2 }}>
                    <span className="settings-row-icon is-green"><SlidersHorizontal size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.scientificInterests}</h3>
                      <p>
                        {selectedInterestCount}{' '}
                        {selectedInterestCount === 1 ? copy.selectedOne : copy.selectedMany} {copy.trainFeed}
                      </p>
                      {selectedAreas.length > 0 && (
                        <div className="settings-interest-summary" aria-label={copy.selectedAreas}>
                          {selectedAreas.map(area => (
                            <span key={area.id}>{area.label} <small>{area.count}</small></span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Button variant="outline" className="settings-row-action" onClick={() => setIsInterestsOpen(true)}>
                      {copy.edit} <CaretRight size={17} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </section>

              <section id="settings-reading" tabIndex={-1} className="settings-section" aria-labelledby="reading-heading">
                <div className="settings-section-heading">
                  <Sparkle size={18} />
                  <div>
                    <h2 id="reading-heading">{copy.readingAi}</h2>
                    <p>{copy.readingAiDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row settings-row--levels" style={{ '--settings-index': 2 }}>
                    <span className="settings-row-icon is-purple"><Sparkle size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.defaultAiLevel}</h3>
                      <p>{copy.defaultAiDescription}</p>
                      <span className={`settings-save-feedback ${levelFeedback ? `is-${levelFeedback}` : ''}`} aria-live="polite">
                        {savingLevel && copy.saving}
                        {!savingLevel && levelFeedback === 'saved' && copy.preferenceSaved}
                        {!savingLevel && levelFeedback === 'error' && copy.saveError}
                      </span>
                    </div>
                    <RadioGroup
                      className="settings-levels"
                      aria-label={copy.aiLevelLabel}
                      value={readingPreferences.aiExplanationLevel}
                      onValueChange={handleLevelChange}
                      disabled={Boolean(savingLevel)}
                    >
                      {AI_EXPLANATION_LEVELS.map(({ id }) => {
                        const { label, description, Icon } = LEVEL_DETAILS[id];
                        return (
                          <RadioGroupItem
                            key={id}
                            value={id}
                            render={<button type="button" />}
                            nativeButton
                            disabled={Boolean(savingLevel)}
                          >
                            <Icon size={18} aria-hidden="true" />
                            <span><strong>{label[language]}</strong><small>{description[language]}</small></span>
                          </RadioGroupItem>
                        );
                      })}
                    </RadioGroup>
                  </div>
                </div>
              </section>

              <section id="settings-notifications" tabIndex={-1} className="settings-section" aria-labelledby="notifications-heading">
                <div className="settings-section-heading">
                  <Bell size={18} />
                  <div>
                    <h2 id="notifications-heading">{copy.notifications}</h2>
                    <p>{copy.notificationsDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row" style={{ '--settings-index': 4 }}>
                    <span className="settings-row-icon is-amber"><Envelope size={20} /></span>
                    <div className="settings-row-content">
                      <div className="settings-row-title-line">
                        <h3>{copy.emailUpdates}</h3>
                        <span className={`settings-status is-${notificationStatus.tone}`}>
                          {notificationStatus.label}
                        </span>
                      </div>
                      <p>{notificationStatus.description}</p>
                    </div>
                    <Button variant="outline" className="settings-row-action" onClick={() => setIsNotificationsOpen(true)}>
                      {copy.configure} <CaretRight size={17} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </section>

              <section id="settings-privacy" tabIndex={-1} className="settings-section" aria-labelledby="privacy-heading">
                <div className="settings-section-heading">
                  <ShieldCheck size={18} />
                  <div>
                    <h2 id="privacy-heading">{copy.privacy}</h2>
                    <p>{copy.privacyDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row" style={{ '--settings-index': 5 }}>
                    <span className="settings-row-icon is-cyan"><ChartBar size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.usageAnalytics}</h3>
                      <p>{copy.usageAnalyticsDescription}</p>
                    </div>
                    <div className="settings-toggle-control">
                      <span aria-live="polite">{analyticsConsent === ANALYTICS_CONSENT.GRANTED ? copy.analyticsEnabled : copy.analyticsDisabled}</span>
                      <Switch
                        className="settings-toggle"
                        checked={analyticsConsent === ANALYTICS_CONSENT.GRANTED}
                        aria-label={copy.analyticsToggleLabel}
                        onCheckedChange={checked => updateAnalyticsConsent(
                          checked ? ANALYTICS_CONSENT.GRANTED : ANALYTICS_CONSENT.DENIED,
                        )}
                      />
                    </div>
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 6 }}>
                    <span className="settings-row-icon is-rose"><Trash size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.deleteAccount}</h3>
                      <p>{copy.deleteAccountDescription}</p>
                    </div>
                    <Button
                      variant="outline"
                      className="settings-signout"
                      onClick={() => setDeleteAccountOpen(true)}
                    >
                      {copy.deleteAccountAction}
                    </Button>
                  </div>
                </div>
              </section>

              <section id="settings-community" tabIndex={-1} className="settings-section settings-section--community" aria-labelledby="community-heading">
                <div className="settings-section-heading">
                  <Code size={18} />
                  <div>
                    <h2 id="community-heading">{copy.community}</h2>
                    <p>{copy.communityDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row" style={{ '--settings-index': 6 }}>
                    <span className="settings-row-icon settings-row-icon--github"><Code size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.openSource}</h3>
                      <p>{copy.openSourceDescription}</p>
                    </div>
                    <a
                      className="settings-row-action"
                      href="https://github.com/mugar123/papertok"
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${copy.viewOnGitHub} (${copy.opensNewTab})`}
                    >
                      {copy.viewOnGitHub} <ArrowSquareOut size={16} />
                    </a>
                  </div>
                </div>
              </section>

              {/* Signing in and signing out are one subject — how this account is
                  reached — so they are one section with two rows, not two sections
                  a scroll apart. */}
              <section id="settings-access" tabIndex={-1} className="settings-section" aria-labelledby="access-heading">
                <div className="settings-section-heading">
                  <Key size={18} />
                  <div>
                    <h2 id="access-heading">{copy.access}</h2>
                    <p>{copy.accessDescription}</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="settings-row" style={{ '--settings-index': 6 }}>
                    <span className="settings-row-icon settings-row-icon--github"><GitHubMark size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.githubMethod}</h3>
                      <p>{gitHubLinked ? copy.githubLinked : copy.githubUnlinked}</p>
                    </div>
                    {gitHubLinked ? (
                      <span className="settings-row-status"><Check size={16} /> {copy.connected}</span>
                    ) : (
                      <Button
                        variant="outline"
                        className="settings-row-action"
                        onClick={handleLinkGitHub}
                        disabled={linkingGitHub}
                      >
                        {linkingGitHub ? copy.connecting : copy.connect}
                        {!linkingGitHub && <CaretRight size={17} aria-hidden="true" />}
                      </Button>
                    )}
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 7 }}>
                    <span className="settings-row-icon is-rose"><User size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.session}</h3>
                      <p>{copy.sessionDescription}</p>
                    </div>
                    <Button variant="outline" className="settings-signout" onClick={handleSignOut}>
                      <SignOut size={18} aria-hidden="true" /> {copy.signOut}
                    </Button>
                  </div>
                </div>

                {linkFeedback && (
                  <p
                    className={`settings-link-feedback is-${linkFeedback.tone}`}
                    role="status"
                    aria-live="polite"
                  >
                    {linkFeedback.text}
                  </p>
                )}
              </section>
            </div>
          </div>
        </div>
      </main>

      <EditInterestsModal
        isOpen={isInterestsOpen}
        onClose={() => setIsInterestsOpen(false)}
      />
      <EmailNotificationModal
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
      />
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
