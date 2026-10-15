import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  ArrowSquareOut,
  Bell,
  BookOpen,
  Briefcase,
  Buildings,
  CaretRight,
  ChartBar,
  CircleNotch,
  Envelope,
  Flask,
  GearSix,
  GlobeHemisphereWest,
  GraduationCap,
  Key,
  LinkBreak,
  LinkSimple,
  PencilSimple,
  SlidersHorizontal,
  Sparkle,
  Tag,
  Trash,
  UploadSimple,
  User,
  UserMinus,
  UsersThree,
  Warning,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.js';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useFollowing } from '../../context/FollowingContext';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService';
import { PAPER_REWRITE_LEVELS } from '../../services/paperRewriteService';
import { CATEGORIES } from '../../data/categories';
import { PUBLIC_AVATAR_PRESET, prepareProfileImage } from '../../utils/profileImage';
import { savePublicProfilePhoto } from '../../services/userProfileService';
import { SIGN_IN_PROVIDERS } from '../../services/authIdentityService';
import GoogleMark from '../Public/GoogleMark.jsx';
import InstitutionDialog from '../Institution/InstitutionDialog.jsx';
import InstitutionPill from '../Institution/InstitutionPill.jsx';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { settleWithin } from '../../utils/asyncTiming';
import {
  IdentitySection,
  ProfileListsSection,
  ProfilePreview,
  ProfileReadState,
  ProfileVisibilityPrompt,
  PublicPageSection,
} from '../Profile/ProfileEditor.jsx';
import { useProfileEditor } from '../Profile/useProfileEditor.js';
import { PAPERTOK_REPO_URL } from '../Layout/AccountMenu.jsx';
import EditInterestsModal from './EditInterestsModal';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog.jsx';
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
  { slug: 'profile', label: 'Profile & account' },
  { slug: 'discovery', label: 'Discovery' },
  { slug: 'reading', label: 'Reading & AI' },
  { slug: 'notifications', label: 'Notifications' },
  { slug: 'privacy', label: 'Privacy' },
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

const FOLLOW_SUMMARY = [
  { type: 'author', label: 'Authors', Icon: User },
  { type: 'topic', label: 'Topics', Icon: Tag },
  { type: 'institution', label: 'Institutions', Icon: Buildings },
  { type: 'project', label: 'Projects', Icon: Briefcase },
];

/**
 * The public copy's whole budget: the patient read (PUBLIC_PHOTO_READ_TIMEOUT_MS,
 * 8 s, with the stream kick at 3 s), the second compression and the commit.
 */
const PUBLIC_PHOTO_MIRROR_TIMEOUT_MS = 12_000;

const SETTINGS_COPY = {
  eyebrow: 'User settings',
  title: 'Settings',
  subtitle: 'Your account, discovery preferences, and reading tools.',
  pagesTitle: 'Pages',
  pagesLabel: 'Settings pages',
  photo: 'Photo',
  photoHint: 'PNG, JPEG or WebP. Saved as soon as you choose it.',
  uploadPhoto: 'Upload photo',
  changePhoto: 'Change photo',
  removePhoto: 'Remove',
  removeToSignInPhoto: 'Remove and go back to your sign-in photo',
  removeToInitial: 'Remove and go back to your initial',
  photoUpdated: { title: 'Photo updated', description: 'It shows across PaperTok and on your public page.' },
  photoUpdatedHidden: { title: 'Photo updated', description: 'It shows across PaperTok. Your public page keeps your initial, as set in Privacy.' },
  signInPhotoRestored: { title: 'Photo removed', description: 'Your sign-in photo is back in its place.' },
  photoRemoved: { title: 'Photo removed', description: 'Your initial shows in its place.' },
  photoSaveError: 'Photo not saved',
  photoRestoreError: { title: 'Photo not removed', description: 'The profile photo could not be removed. Try again.' },
  photoPublicPending: { title: 'Photo saved, public page behind', description: 'Your public page still shows the old picture. Try again.' },
  discovery: 'Discovery',
  discoveryDescription: 'Signals PaperTok uses to build your feeds.',
  followedContent: 'Following',
  loadingFollowing: 'Loading the content you follow...',
  followedOne: 'followed entity',
  followedMany: 'followed entities',
  recommendationsSuffix: 'influence your recommendations',
  followingSummary: 'Summary of followed content',
  viewAll: 'View all',
  viewAllFollowing: 'View everything you follow',
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
  unpublish: 'Unpublish',
  unpublishDescription: 'Take your public page down. Your account stays.',
  unpublishTitle: 'Unpublish my profile',
  unpublishBody: handle => `Deletes your public page and frees @${handle}. Published lists stay published but stop carrying your name. You can create a profile again whenever you want.`,
  unpublishing: 'Saving...',
  unpublishConfirmTitle: 'Unpublish your public profile?',
  unpublishConfirmBody: handle => `Your page will stop existing and @${handle} becomes available to anyone. Your account and your lists stay.`,
  cancel: 'Cancel',
  institution: 'University',
  institutionDescription: 'Verify where you study or work by signing in with your university\'s Google account.',
  institutionLinked: name => `Verified with ${name}.`,
  institutionLink: 'Link your university',
  institutionManage: 'Manage your university',
  dangerZone: 'Danger zone',
  dangerZoneDescription: 'Irreversible actions.',
  deleteAccount: 'Delete account',
  deleteAccountDescription: 'Permanently deletes your account and everything in it.',
  openSource: 'PaperTok is open source',
  opensNewTab: '(opens in a new tab)',
  access: 'Access',
  accessDescription: 'The ways you sign in. Each one opens the same account and the same data.',
  connectedAs: 'Connected as ',
  connected: 'Connected',
  onlyMethod: 'Your only way to sign in, so it cannot be disconnected.',
  methodLinked: 'You can sign in with it.',
  methodUnlinked: 'Connect it and you can sign in with it as well as the way you sign in today.',
  disconnect: label => `Disconnect ${label}`,
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

function SectionHeading({ id, Icon, title, description }) {
  return (
    <div className="settings-section-heading">
      <Icon size={18} aria-hidden="true" />
      <div>
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}

/** An icon-only row action: the name is the label, the title its tooltip. */
function IconAction({ label, title = label, Icon, className = '', ...props }) {
  return (
    <Button variant="outline" size="icon" className={`settings-icon-action ${className}`} aria-label={label} title={title} {...props}>
      <Icon size={17} aria-hidden="true" />
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
  const editor = useProfileEditor();
  const [savingPhoto, setSavingPhoto] = useState(false);
  // The method being connected, while its popup is open.
  const [linking, setLinking] = useState(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [institutionOpen, setInstitutionOpen] = useState(false);

  const gitHubLinked = signInProviders.includes(SIGN_IN_PROVIDERS.github);
  const googleLinked = signInProviders.includes(SIGN_IN_PROVIDERS.google);
  // ponytail: AuthContext has no unlink, so Disconnect only renders, disabled,
  // where it would be refused anyway (the only way in). Add unlinking before
  // offering it with two methods connected.
  const onlyMethod = [gitHubLinked, googleLinked].filter(Boolean).length === 1;
  const visibleProfilePhoto = profilePhoto || user?.photoURL;

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


  const reportPhoto = (mirrored, done) => notify(
    mirrored ? 'success' : 'error',
    mirrored ? done : copy.photoPublicPending,
  );

  const publicPhotoHidden = editor.read.status === 'ready' && !editor.form.showPhoto;

  const handlePhotoSelect = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || savingPhoto) return;

    setSavingPhoto(true);
    try {
      const preparedPhoto = await prepareProfileImage(file);
      await updateProfilePhoto(preparedPhoto);
      // Recompressed again because the public budget is 60 KB against 280 KB here.
      const mirrored = publicPhotoHidden
        || await mirrorPublicPhoto(() => prepareProfileImage(file, PUBLIC_AVATAR_PRESET));
      reportPhoto(mirrored, publicPhotoHidden ? copy.photoUpdatedHidden : copy.photoUpdated);
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
      // Removing the upload falls back to the account picture, so the public
      // profile follows it there rather than being left on the old one.
      const mirrored = publicPhotoHidden || await mirrorPublicPhoto(() => user?.photoURL || null);
      reportPhoto(mirrored, user?.photoURL ? copy.signInPhotoRestored : copy.photoRemoved);
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
        <Button type="button" variant="outline" className="settings-photo-button" disabled={savingPhoto} onClick={() => profileInputRef.current?.click()}>
          <UploadSimple size={17} aria-hidden="true" />
          {profilePhoto ? copy.changePhoto : copy.uploadPhoto}
        </Button>
        {/* Only an uploaded photo can be removed; removing it falls back to
            the default (the sign-in photo, or the initial). */}
        {profilePhoto && (
          <Button
            type="button"
            variant="outline"
            className="settings-photo-button settings-photo-remove"
            disabled={savingPhoto}
            onClick={handleRestorePhoto}
            title={user?.photoURL ? copy.removeToSignInPhoto : copy.removeToInitial}
          >
            <Trash size={17} aria-hidden="true" />
            {copy.removePhoto}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {editor.read.ready ? (
        <>
          <ProfilePreview preview={editor.preview} />
          <IdentitySection form={editor.form} photo={photoField} />
          {/* Which published lists the page shows: part of what it says
              about you, so it sits with the identity, not with Privacy. */}
          {editor.read.status === 'ready' && <ProfileListsSection lists={editor.lists} />}
        </>
      ) : (
        <ProfileReadState read={editor.read} />
      )}

      <section className="settings-section" aria-labelledby="settings-access-heading">
        <SectionHeading id="settings-access-heading" Icon={Key} title={copy.access} description={copy.accessDescription} />
        <div className="settings-list">
          {/* Every way in, the ones in use included. A method that is the
              only way in cannot be disconnected: the account would have no
              door. */}
          {methods.map(method => (
            <div key={method.id} className="settings-row">
              <span className={`settings-row-icon${method.id === 'github' ? ' settings-row-icon--github' : ''}`}>
                <method.Icon size={20} aria-hidden="true" />
              </span>
              <div className="settings-row-content">
                <h3>{method.label}</h3>
                <p id={`settings-${method.id}-method`}>
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
                  {onlyMethod && (
                    <IconAction
                      Icon={LinkBreak}
                      label={copy.disconnect(method.label)}
                      disabled
                      aria-describedby={`settings-${method.id}-method`}
                    />
                  )}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="icon"
                  className="settings-icon-action"
                  onClick={() => handleLink(method)}
                  disabled={Boolean(linking)}
                  aria-label={linking === method.id ? copy.connecting(method.label) : copy.connect(method.label)}
                  title={copy.connect(method.label)}
                >
                  {linking === method.id
                    ? <CircleNotch size={17} className="settings-spin" aria-hidden="true" />
                    : <LinkSimple size={17} aria-hidden="true" />}
                </Button>
              )}
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-row-icon is-cyan"><GraduationCap size={20} aria-hidden="true" /></span>
            <div className="settings-row-content">
              <div className="settings-row-title-line">
                <h3>{copy.institution}</h3>
                {institution && <InstitutionPill institution={institution} />}
              </div>
              <p>{institution ? copy.institutionLinked(institution.name) : copy.institutionDescription}</p>
            </div>
            <IconAction
              Icon={institution ? GearSix : LinkSimple}
              label={institution ? copy.institutionManage : copy.institutionLink}
              onClick={() => setInstitutionOpen(true)}
              aria-haspopup="dialog"
            />
          </div>
          <InstitutionDialog open={institutionOpen} onOpenChange={setInstitutionOpen} />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-danger-heading">
        <SectionHeading id="settings-danger-heading" Icon={Warning} title={copy.dangerZone} description={copy.dangerZoneDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row-icon is-rose"><UserMinus size={20} aria-hidden="true" /></span>
            <div className="settings-row-content">
              <h3>{copy.deleteAccount}</h3>
              <p>{copy.deleteAccountDescription}</p>
            </div>
            <IconAction Icon={Trash} label={copy.deleteAccount} className="settings-danger-icon" onClick={() => setDeleteAccountOpen(true)} />
          </div>
        </div>
      </section>

      <ProfileVisibilityPrompt prompt={editor.prompt} />
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

/** Unpublishing deletes the page and frees the handle, so it asks first. */
function UnpublishDialog({ unpublish, open, onOpenChange }) {
  const confirm = async () => {
    await unpublish.run();
    onOpenChange(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="settings-confirm-dialog" aria-busy={unpublish.busy ? 'true' : undefined}>
        <AlertDialogTitle>{copy.unpublishConfirmTitle}</AlertDialogTitle>
        <AlertDialogDescription>{copy.unpublishConfirmBody(unpublish.handle ?? '')}</AlertDialogDescription>
        <div className="settings-confirm-actions">
          <AlertDialogCancel disabled={unpublish.busy}>{copy.cancel}</AlertDialogCancel>
          <Button variant="outline" className="settings-signout" onClick={confirm} disabled={unpublish.busy}>
            {unpublish.busy ? copy.unpublishing : copy.unpublish}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PrivacyPage() {
  const { consent: analyticsConsent, updateConsent: updateAnalyticsConsent } = useAnalyticsConsent();
  const editor = useProfileEditor();
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  return (
    <>
      {editor.read.ready
        ? <PublicPageSection form={editor.form} visibility={editor.visibility} />
        : <ProfileReadState read={editor.read} />}

      {/* The account's, not the profile's: it works with or without one. */}
      <section className="settings-section" aria-labelledby="settings-analytics-heading">
        <SectionHeading id="settings-analytics-heading" Icon={ChartBar} title={copy.usageAnalytics} description={copy.usageAnalyticsDescription} />
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

      {editor.unpublish.handle && (
        <section className="settings-section" aria-labelledby="settings-unpublish-heading">
          <SectionHeading id="settings-unpublish-heading" Icon={Warning} title={copy.unpublish} description={copy.unpublishDescription} />
          <div className="settings-list">
            <div className="settings-row">
              <span className="settings-row-icon is-amber"><GlobeHemisphereWest size={20} aria-hidden="true" /></span>
              <div className="settings-row-content">
                <h3>{copy.unpublishTitle}</h3>
                <p>{copy.unpublishBody(editor.unpublish.handle)}</p>
              </div>
              <Button variant="outline" className="settings-signout" onClick={() => setUnpublishOpen(true)} disabled={editor.unpublish.blocked}>
                {copy.unpublish}
              </Button>
            </div>
          </div>
        </section>
      )}

      <UnpublishDialog unpublish={editor.unpublish} open={unpublishOpen} onOpenChange={setUnpublishOpen} />
      <ProfileVisibilityPrompt prompt={editor.prompt} />
    </>
  );
}

function DiscoveryPage() {
  const navigate = useNavigate();
  const { userPreferences } = useAuth();
  const { followedEntities, followedByType, loading: followingLoading } = useFollowing();
  const [isInterestsOpen, setIsInterestsOpen] = useState(false);
  const selectedInterestCount = Array.isArray(userPreferences) ? userPreferences.length : 0;

  const selectedAreas = useMemo(() => {
    const selected = new Set(userPreferences || []);
    return Object.entries(CATEGORIES)
      .map(([id, area]) => {
        const count = Object.keys(area.subcategories).filter(key => selected.has(key)).length;
        return count > 0 ? { id, label: area.label, count } : null;
      })
      .filter(Boolean);
  }, [userPreferences]);

  // Only the kinds actually followed: four zeros in a row are noise, and
  // "0 followed entities" already says it all.
  const followedKinds = FOLLOW_SUMMARY.filter(({ type }) => (followedByType[type]?.length || 0) > 0);

  return (
    <>
      <section className="settings-section" aria-labelledby="settings-discovery-heading">
        <SectionHeading id="settings-discovery-heading" Icon={SlidersHorizontal} title={copy.discovery} description={copy.discoveryDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row-icon is-purple"><UsersThree size={20} aria-hidden="true" /></span>
            <div className="settings-row-content">
              <h3>{copy.followedContent}</h3>
              <p>
                {followingLoading && followedEntities.length === 0
                  ? copy.loadingFollowing
                  : `${followedEntities.length} ${followedEntities.length === 1 ? copy.followedOne : copy.followedMany} ${copy.recommendationsSuffix}`}
              </p>
            </div>
            <IconAction Icon={CaretRight} label={copy.viewAllFollowing} title={copy.viewAll} onClick={() => navigate('/settings/following')} />
            {followedKinds.length > 0 && (
              <div className="settings-follow-summary settings-row-tags" role="group" aria-label={copy.followingSummary}>
                {followedKinds.map(({ type, label, Icon }) => (
                  <span key={type}><Icon size={12} aria-hidden="true" />{label}<strong>{followedByType[type].length}</strong></span>
                ))}
              </div>
            )}
          </div>

          <div className="settings-row">
            <span className="settings-row-icon is-green"><SlidersHorizontal size={20} aria-hidden="true" /></span>
            <div className="settings-row-content">
              <h3>{copy.scientificInterests}</h3>
              <p>
                {selectedInterestCount}{' '}
                {selectedInterestCount === 1 ? copy.selectedOne : copy.selectedMany} {copy.trainFeed}
              </p>
            </div>
            <IconAction Icon={PencilSimple} label={copy.editInterests} title={copy.edit} onClick={() => setIsInterestsOpen(true)} />
            {selectedAreas.length > 0 && (
              <div className="settings-interest-summary settings-row-tags" role="group" aria-label={copy.selectedAreas}>
                {selectedAreas.map(area => <span key={area.id}>{area.label} <small>{area.count}</small></span>)}
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
      <SectionHeading id="settings-reading-heading" Icon={Sparkle} title={copy.readingAi} description={copy.readingAiDescription} />
      <div className="profile-fields">
        {/* The same stacked radio list as Privacy's public/private choice. */}
        <RadioGroup
          className="settings-levels"
          aria-label={copy.aiLevelLabel}
          value={readingPreferences.aiExplanationLevel}
          onValueChange={handleLevelChange}
          disabled={Boolean(savingLevel)}
          aria-busy={Boolean(savingLevel)}
        >
          {PAPER_REWRITE_LEVELS.map(({ id }) => {
            const { label, description, Icon } = LEVEL_DETAILS[id];
            const checked = readingPreferences.aiExplanationLevel === id;
            return (
              <div key={id} className={`settings-level${checked ? ' is-checked' : ''}`}>
                <RadioGroupItem
                  value={id}
                  render={<button type="button" />}
                  nativeButton
                  disabled={Boolean(savingLevel)}
                >
                  <span className="settings-level-radio" aria-hidden="true" />
                  <Icon size={18} weight={checked ? 'fill' : 'regular'} aria-hidden="true" />
                  <span className="settings-level-copy">
                    <strong>{label}</strong>
                    <span>{description}</span>
                  </span>
                </RadioGroupItem>
              </div>
            );
          })}
        </RadioGroup>
      </div>
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
        <SectionHeading id="settings-notifications-heading" Icon={Bell} title={copy.notifications} description={copy.notificationsDescription} />
        <div className="settings-list">
          <div className="settings-row">
            {/* Amber, the app's warning tint, only while the service is down;
                the status pill says the same, so colour is not alone. */}
            <span className={`settings-row-icon ${status.tone === 'warning' ? 'is-amber' : 'is-purple'}`}>
              <Envelope size={20} aria-hidden="true" />
            </span>
            <div className="settings-row-content">
              <div className="settings-row-title-line">
                <h3>{copy.emailUpdates}</h3>
                <span className={`settings-status is-${status.tone}`}>{status.label}</span>
              </div>
              <p>{status.description}</p>
            </div>
            <IconAction Icon={GearSix} label={copy.configureEmail} title={copy.configure} onClick={() => setIsOpen(true)} />
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

/*
 * Which rail row the marker sat on, kept outside the component: every
 * settings page is its own route and remounts the rail, so without this the
 * marker would appear on the new row instead of sliding to it. Forgotten when
 * the last settings page unmounts, so a later visit does not slide in from
 * wherever the previous one ended. (The incoming page mounts beside the
 * outgoing one, so a rail click never drops the count to zero.)
 */
let lastMarkerIndex = null;
let mountedRails = 0;

export default function SettingsPage({ page = 'profile' }) {
  const activeIndex = Math.max(0, SETTINGS_PAGES.findIndex(entry => entry.slug === page));
  const active = SETTINGS_PAGES[activeIndex];
  const Page = PAGE_COMPONENTS[active.slug];
  // First paint on the previous row, then move: the rail's own transition
  // (SettingsPage.css, off under reduced motion) does the slide.
  const [markerIndex, setMarkerIndex] = useState(() => lastMarkerIndex ?? activeIndex);
  useEffect(() => {
    mountedRails += 1;
    return () => {
      mountedRails -= 1;
      if (mountedRails === 0) lastMarkerIndex = null;
    };
  }, []);
  useEffect(() => {
    lastMarkerIndex = activeIndex;
    const frame = requestAnimationFrame(() => setMarkerIndex(activeIndex));
    return () => cancelAnimationFrame(frame);
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
          <span>{copy.eyebrow}</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </header>

        <div className="settings-layout">

          <nav className="settings-index" aria-label={copy.pagesLabel}>
            <span className="settings-index-title">{copy.pagesTitle}</span>
            <div className="settings-index-list" style={{ '--settings-active': markerIndex }}>
              <span className="settings-index-marker" aria-hidden="true" />
              {SETTINGS_PAGES.map((entry, position) => (
                <NavLink
                  key={entry.slug}
                  to={`/settings/${entry.slug}`}
                  replace
                  className={({ isActive }) => (isActive ? 'is-active' : '')}
                >
                  <span aria-hidden="true">{String(position + 1).padStart(2, '0')}</span>
                  {entry.label}
                </NavLink>
              ))}
            </div>

            <a className="settings-rail-link" href={PAPERTOK_REPO_URL} target="_blank" rel="noreferrer">
              <GithubMark size={15} />
              <span>{copy.openSource}</span>
              <ArrowSquareOut size={13} aria-hidden="true" />
              <span className="visually-hidden">{copy.opensNewTab}</span>
            </a>
          </nav>

          <div className="settings-content">
            <Page />
          </div>
        </div>
      </div>
    </main>
  );
}
