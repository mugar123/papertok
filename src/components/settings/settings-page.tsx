import type { ComponentProps } from 'react';
import type { Icon } from '@phosphor-icons/react';
import type { ReadingLevel } from '../../utils/user-settings.ts';
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CircleNotch,
  GearSix,
  GraduationCap,
  LinkBreak,
  LinkSimple,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { usePageRestored } from '../../hooks/use-page-restored.ts';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { ANALYTICS_CONSENT } from '../../services/analytics-service.ts';
import { readAuthorMetricsConsent, writeAuthorMetricsConsent } from '../../services/author-metrics-service.ts';
import { emailServiceState } from '../../utils/email-health.ts';
import { PAPER_REWRITE_LEVELS } from '../../services/paper-rewrite-service.ts';
import { CATEGORIES } from '../../data/categories.ts';
import { SIGN_IN_PROVIDERS } from '../../services/auth-identity-service.ts';
import { popupReadiness } from '../../services/firebase.ts';
import GoogleMark from '../public/google-mark.tsx';
import { PreparingNote } from '../public/provider-sign-in.tsx';
import InstitutionDialog from '../institution/institution-dialog.tsx';
import InstitutionPill from '../institution/institution-pill.tsx';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import EditInterestsModal from './edit-interests-modal.tsx';
import SummaryHistory from './summary-history.tsx';
import { LEVEL_DETAILS } from './reading-levels.ts';
import { FollowingDialog, FollowingSheet } from './following-settings-page.tsx';
import FeedsDialog from './feeds-dialog.tsx';
import DeleteAccountDialog from './delete-account-dialog.tsx';
import { DELETE_ACCOUNT_DESCRIPTION } from './delete-account-description.ts';
import EmailNotificationModal from '../following/email-notification-modal.tsx';
import { Button } from '../ui/button.tsx';
import { connectZotero, disconnectZotero, zoteroStatus, type ZoteroStatus } from '../../services/zotero-service.ts';
import { authorMetricsAnswer, zoteroAnswer } from '../../utils/profile-session-caches.ts';
import { GithubMark } from '../ui/github-mark.tsx';
import { Label } from '../ui/label.tsx';
import { ZoteroMark } from '../pdf/zotero-mark.tsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.tsx';
import { Switch } from '../ui/switch.tsx';
import { readShowAbstract, saveShowAbstract, subscribeShowAbstract } from '../../utils/reader-preferences.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { SETTINGS_PAGES, isFollowsPath } from './settings-pages.ts';
import { SettingsRail, SettingsSwitcher } from './settings-pages-nav.tsx';
import usePopupReady from '../../hooks/use-popup-ready.ts';
import './settings-page.css';

const SETTINGS_COPY = {
  title: 'Settings',
  subtitle: 'Your account, discovery preferences, and reading tools.',
  discovery: 'Discovery',
  discoveryDescription: 'Signals PaperTok uses to build your feeds.',
  followedContent: 'Follows',
  loadingFollowing: 'Loading the content you follow...',
  followingDescription: 'Entities that influence your recommendations',
  editFollowing: 'Edit follows',
  feeds: 'Feeds',
  feedsDescription: 'Feeds you made from topics, authors, journals and keywords',
  editFeeds: 'Edit feeds',
  interests: 'Interests',
  interestsDescription: 'Subcategories used to train your feed',
  selectedAreas: 'Selected areas',
  edit: 'Edit',
  editInterests: 'Edit interests',
  readingAi: 'Reading & AI',
  readingAiDescription: 'Adjust the depth of your AI explanations.',
  aiLevelLabel: 'Default AI level, preselected when you ask AI to explain a paper',
  levelSaved: (label: string) => ({ title: 'Explanation level set', description: `New AI explanations start at the ${label} level.` }),
  levelError: { title: 'Level not saved', description: 'Your previous level is still in use. Try again.' },
  readAloudFromPosition: 'Start reading aloud from where I am',
  readAloudFromPositionHint: 'When off, the voice starts at the top of the paper.',
  readAloudError: { title: 'Setting not saved', description: 'Reading aloud still starts where it did. Try again.' },
  notifications: 'Notifications',
  notificationsDescription: 'Choose whether to receive updates while PaperTok is closed.',
  emailUpdates: 'Email updates',
  configure: 'Configure',
  configureEmail: 'Configure email updates',
  usageAnalytics: 'Usage analytics',
  usageAnalyticsDescription: 'Control what PaperTok measures to improve the app.',
  analyticsToggleLabel: 'Allow usage analytics',
  analyticsHint: 'Measures repeat visits, papers viewed and opened, and reading time. Uses a persistent browser identifier linked to your account when signed in. Saved in this browser.',
  institution: 'University',
  institutionDescription: 'Verify your university email to link your library.',
  institutionLinked: (name: string) => `Verified with ${name}.`,
  link: 'Link',
  manage: 'Manage',
  institutionLink: 'Link your university',
  institutionManage: 'Manage your university',
  dangerZone: 'Danger zone',
  dangerZoneDescription: 'Irreversible actions.',
  deleteAccount: 'Delete account',
  access: 'Access',
  accessDescription: 'The ways you sign in. Each one opens the same account and the same data.',
  connectedAs: 'Connected as ',
  connected: 'Connected',
  onlyMethod: 'Your only way to sign in, so it cannot be disconnected.',
  methodUnlinked: 'Connect it and you can sign in with it as well as the way you sign in today.',
  connectShort: 'Connect',
  connect: (label: string) => `Connect ${label}`,
  connecting: (label: string) => `Connecting ${label}…`,
  alreadyLinked: (label: string) => ({ title: 'Already connected', description: `You can sign in with ${label} now.` }),
  linkSuccess: (label: string) => ({ title: `${label} connected`, description: 'Next time you can sign in with either one. Both open this same account.' }),
  linkTaken: (label: string) => ({
    title: `That ${label} account is already in use`,
    description: `It opens a different PaperTok account. The two are not merged: sign in to that one if it is the account you want to keep, or connect a different ${label} account.`,
  }),
  linkFailed: (label: string) => `${label} not connected`,
};

const copy = SETTINGS_COPY;


// Errors stay until dismissed (ui/toast.js); successes leave on their own.
const notify = (kind: 'success' | 'error', { title, description }: { title: string; description: string }) => (kind === 'error'
  ? toastError(title, { description })
  : toast[kind](title, { description }));

function SectionHeading({ id, title, description }: { id: string; title: string; description?: string }) {
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
function RowAction({ label, text = label, Icon, variant = 'outline', ...props }: ComponentProps<typeof Button> & { label: string; text?: string; Icon: Icon }) {
  return (
    <Button variant={variant} size="sm" className="settings-row-action" aria-label={label === text ? undefined : label} {...props}>
      <Icon size={15} aria-hidden="true" />
      {text}
    </Button>
  );
}

/**
 * Keyed by the account where it is used, so a new account starts from its own
 * last answer or from an unchecked state. The check runs on every visit; a
 * failed one leaves the last answer on screen.
 */
function ZoteroSection({ uid }: { uid: string }) {
  const [status, setStatus] = useState<ZoteroStatus | null>(() => zoteroAnswer.get(uid) ?? null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const keep = zoteroAnswer.startRead(uid);
    zoteroStatus().then(next => {
      // A left visit's check may be older than the next visit's.
      if (!live) return;
      // A disconnect that finished while this check was out is newer than its answer.
      const shown = keep(next) ? next : zoteroAnswer.get(uid);
      if (shown) setStatus(shown);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [uid]);

  usePageRestored(() => setBusy(false));

  async function connectOrDisconnect() {
    setBusy(true);
    try {
      if (status?.connected) {
        const record = zoteroAnswer.startChange(uid);
        await disconnectZotero();
        const disconnected = { connected: false, username: null, sentAt: null };
        record(disconnected);
        setStatus(disconnected);
        toast.success('Zotero is disconnected.');
        setBusy(false);
      } else {
        await connectZotero(uid, null);
      }
    } catch (error) {
      setBusy(false);
      toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'));
    }
  }

  const description = status?.connected ? `Connected${status.username ? ` as ${status.username}` : ''}. Papers you send while reading go to your personal library.`
    : status ? 'Send the papers you read, with your highlights, to your Zotero library.'
      : failed ? 'The Zotero connection could not be checked. You can still connect it.'
        : 'Checking your Zotero connection…';

  return (
    <section className="settings-section" aria-labelledby="settings-zotero-heading">
      <SectionHeading id="settings-zotero-heading" title="Zotero" description={description} />
      <div className="settings-list">
        <div className="settings-row settings-row-side">
          <div className="settings-row-content">
            <h3 className="settings-method-name"><span className="settings-brand-plate"><ZoteroMark size={18} /></span>Zotero</h3>
          </div>
          {(status || failed) && (
            <RowAction
              Icon={status?.connected ? LinkBreak : LinkSimple}
              label={status?.connected ? 'Disconnect Zotero' : 'Connect Zotero'}
              text={status?.connected ? 'Disconnect' : 'Connect'}
              onClick={() => { void connectOrDisconnect(); }}
              disabled={busy}
              focusableWhenDisabled
            />
          )}
        </div>
      </div>
    </section>
  );
}

function emailStatus(preferences: ReturnType<typeof useEmailNotifications>['preferences'], health: ReturnType<typeof useEmailNotifications>['health'], loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      description: 'Loading your email settings',
      tone: 'neutral',
    };
  }
  const service = emailServiceState(health);
  if (service === 'down') {
    return {
      label: 'Unavailable',
      description: 'The email service is not responding right now',
      tone: 'warning',
    };
  }
  // An unchecked service still shows the reader's own choice.
  const unknown = service === 'unknown' ? 'PaperTok could not check the email service just now' : null;
  if (!preferences.enabled) {
    return {
      label: 'Off',
      description: unknown || `Updates will not be sent to ${preferences.email || 'your email'}`,
      tone: 'neutral',
    };
  }
  return {
    label: 'On',
    description: unknown || `Every Monday · up to ${preferences.maxPapers || 5} papers`,
    tone: 'success',
  };
}

function ProfileAccountPage() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { user, signInProviders, linkSignInMethod, signOut, institution } = useAuth();
  // The method being connected, while its popup is open.
  const [linking, setLinking] = useState<string | null>(null);
  // Until the window can open inside the press (usePopupReady), Connect is
  // disabled but keeps focus.
  const readiness = usePopupReady(popupReadiness);
  const preparing = readiness === 'preparing';
  const waiting = readiness !== 'ready';
  const preparingId = useId();
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [institutionOpen, setInstitutionOpen] = useState(false);

  const gitHubLinked = signInProviders.includes(SIGN_IN_PROVIDERS.github);
  const googleLinked = signInProviders.includes(SIGN_IN_PROVIDERS.google);
  // AuthContext has no unlink, so a connected method offers no Disconnect;
  // the only way in says why it never could.
  const onlyMethod = [gitHubLinked, googleLinked].filter(Boolean).length === 1;

  const handleLink = async (method: { id: string; providerId: string; label: string }) => {
    setLinking(method.id);
    try {
      const result = await linkSignInMethod(method.providerId);
      notify('success', result.alreadyLinked ? copy.alreadyLinked(method.label) : copy.linkSuccess(method.label));
    } catch (linkError) {
      // The identity already opens a different uid. Two Firestore trees are
      // never merged behind somebody's back (03-AUTH.md), so the honest move
      // is to say so and let them decide which account they keep.
      if ((linkError as { code?: string } | null)?.code === 'AUTH_IDENTITY_TAKEN') {
        notify('error', copy.linkTaken(method.label));
      } else if ((linkError as { code?: string } | null)?.code === 'auth/popup-closed-by-user'
        || (linkError as { code?: string } | null)?.code === 'auth/cancelled-popup-request') {
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
    void navigate('/feed');
  };

  const identityFor = (providerId: string) => {
    const info = user?.providerData?.find(entry => entry.providerId === providerId);
    return info?.email || info?.displayName || '';
  };
  const methods = [
    { id: 'google', providerId: SIGN_IN_PROVIDERS.google, label: 'Google', Icon: GoogleMark, linked: googleLinked },
    { id: 'github', providerId: SIGN_IN_PROVIDERS.github, label: 'GitHub', Icon: GithubMark, linked: gitHubLinked },
  ];

  return (
    <>
      <section className="settings-section" aria-labelledby="settings-access-heading">
        <SectionHeading id="settings-access-heading" title={copy.access} description={copy.accessDescription} />
        <div className="settings-list">
          {/* Every way in, the ones in use included. A method that is the
              only way in cannot be disconnected: the account would have no
              door. */}
          {methods.map(method => (
            <div key={method.id} className="settings-row settings-row-inline">
              <div className="settings-row-content">
                <h3 className="settings-method-name"><method.Icon size={16} aria-hidden="true" />{method.label}</h3>
                {!method.linked && (
                  <>
                    <PreparingNote id={`${preparingId}-${method.id}`} state={readiness} onRetry={() => popupReadiness.retry()} keepLine={false} />
                    <span id={`${preparingId}-${method.id}-hint`} className="visually-hidden">{copy.methodUnlinked}</span>
                  </>
                )}
              </div>
              {method.linked ? (
                <span className="settings-account-id">
                  <span className="settings-account-dot" aria-hidden="true" />
                  <span className="visually-hidden">{copy.connectedAs}</span>
                  {identityFor(method.providerId) || copy.connected}
                  {onlyMethod && <span className="visually-hidden">{`. ${copy.onlyMethod}`}</span>}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="settings-row-action"
                  onClick={() => { void handleLink(method); }}
                  disabled={Boolean(linking) || waiting}
                  focusableWhenDisabled={waiting}
                  aria-label={linking === method.id ? copy.connecting(method.label) : copy.connect(method.label)}
                  aria-describedby={waiting ? `${preparingId}-${method.id}-hint ${preparingId}-${method.id}` : `${preparingId}-${method.id}-hint`}
                >
                  {linking === method.id || preparing
                    ? <CircleNotch size={15} className="settings-spin" aria-hidden="true" />
                    : <LinkSimple size={15} aria-hidden="true" />}
                  {copy.connectShort}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-university-heading">
        <SectionHeading
          id="settings-university-heading"
          title={copy.institution}
          description={institution ? copy.institutionLinked(institution.name) : copy.institutionDescription}
        />
        <div className="settings-list">
          <div className="settings-row settings-row-side">
            <div className="settings-row-content">
              <h3 className="settings-method-name"><GraduationCap size={16} aria-hidden="true" />{copy.institution}</h3>
              {institution && <InstitutionPill institution={institution} className="settings-row-pill" />}
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

      {user && <ZoteroSection key={user.uid} uid={user.uid} />}

      <section className="settings-section" aria-labelledby="settings-danger-heading">
        <SectionHeading id="settings-danger-heading" title={copy.dangerZone} description={copy.dangerZoneDescription} />
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-content">
              <h3>{copy.deleteAccount}</h3>
              <p>{DELETE_ACCOUNT_DESCRIPTION}</p>
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
  const { user } = useAuth();

  return (
    <>
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
              checked={analyticsConsent !== ANALYTICS_CONSENT.DENIED}
              aria-label={copy.analyticsToggleLabel}
              onCheckedChange={checked => { void updateAnalyticsConsent(
                checked ? ANALYTICS_CONSENT.ENABLED : ANALYTICS_CONSENT.DENIED,
              ); }}
            />
          </Label>
        </div>
      </section>
      {user && <AuthorMetricsSetting key={user.uid} uid={user.uid} />}
    </>
  );
}

const LOADING_PREFERENCE = 'Loading your preference…';

/** Shows the account's last answer at once and reads it again; a failed read leaves that answer on screen. */
function AuthorMetricsSetting({ uid }: { uid: string }) {
  const hintId = useId();
  const [enabled, setEnabled] = useState<boolean | null>(() => authorMetricsAnswer.get(uid) ?? null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(() => authorMetricsAnswer.get(uid) === undefined ? LOADING_PREFERENCE : '');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const keep = authorMetricsAnswer.startRead(uid);
    void readAuthorMetricsConsent(uid).then(value => {
      // A left visit's read may be older than the next visit's.
      if (!active) return;
      // A choice saved while this read was out is newer than its answer.
      const shown = keep(value) ? value : authorMetricsAnswer.get(uid);
      if (shown === undefined) return;
      setEnabled(shown);
      // Clears only the loading line; a save's own message stays.
      setStatus(previous => previous === LOADING_PREFERENCE ? '' : previous);
    }, () => {
      // Only a section still waiting for its first answer reports the failure.
      if (active) setStatus(previous => previous === LOADING_PREFERENCE ? 'Could not load your preference.' : previous);
    });
    return () => { active = false; };
  }, [uid, attempt]);

  async function change(value: boolean) {
    setSaving(true);
    setStatus('Saving your preference…');
    try {
      const record = authorMetricsAnswer.startChange(uid);
      await writeAuthorMetricsConsent(uid, value);
      record(value);
      setEnabled(value);
      setStatus('Preference saved.');
    } catch {
      setStatus('Could not save your preference. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const label = "Count my saves in weekly paper totals";
  return (
    <section className="settings-section" aria-labelledby="settings-author-metrics-heading">
      <SectionHeading id="settings-author-metrics-heading" title="Author statistics" />
      <div className="profile-fields">
        <Label className="profile-switch">
          <span className="profile-switch-copy">
            <span className="profile-switch-label">{label}</span>
            <span className="profile-switch-hint" id={hintId}>
              On by default once your email is verified. Turn off to exclude future saves.
            </span>
          </span>
          <Switch
            className="settings-toggle"
            checked={enabled === true}
            aria-label={label}
            aria-describedby={hintId}
            disabled={enabled === null}
            aria-disabled={saving || undefined}
            onCheckedChange={value => { if (!saving) void change(value); }}
          />
        </Label>
        <div role="status">{status}</div>
        {enabled === null && status.startsWith('Could not') && (
          <Button variant="outline" onClick={() => {
            setStatus(LOADING_PREFERENCE);
            setAttempt(previous => previous + 1);
          }}>Try again</Button>
        )}
      </div>
    </section>
  );
}

function DiscoveryPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { userPreferences } = useAuth();
  const { followedEntities, loading: followingLoading } = useFollowing();
  const { feeds: customFeeds, status: feedsStatus } = useCustomFeeds();
  const [isInterestsOpen, setIsInterestsOpen] = useState(false);
  const [isFollowingOpen, setIsFollowingOpen] = useState(false);
  const [isFeedsOpen, setIsFeedsOpen] = useState(false);
  const isPhone = useIsPhone();
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
          <div className="settings-row settings-row-side">
            <div className="settings-row-content">
              <h3 className="settings-row-title-line">
                {copy.followedContent}{' '}
                {!(followingLoading && followedEntities.length === 0) && <span className="settings-count">({followedEntities.length})</span>}
              </h3>
              <p>{followingLoading && followedEntities.length === 0 ? copy.loadingFollowing : copy.followingDescription}</p>
            </div>
            <RowAction Icon={PencilSimple} label={copy.editFollowing} text={copy.edit} onClick={() => { if (isPhone) setIsFollowingOpen(true); else void navigate('/settings/following'); }} />
          </div>

          <div className="settings-row settings-row-side">
            <div className="settings-row-content">
              <h3 className="settings-row-title-line">
                {copy.feeds}{' '}
                {feedsStatus === 'ready' && <span className="settings-count">({customFeeds.length})</span>}
              </h3>
              <p>{copy.feedsDescription}</p>
            </div>
            <RowAction Icon={PencilSimple} label={copy.editFeeds} text={copy.edit} onClick={() => setIsFeedsOpen(true)} />
          </div>

          <div className="settings-row settings-row-side">
            <div className="settings-row-content">
              <h3 className="settings-row-title-line">{copy.interests} <span className="settings-count">({selectedInterestCount})</span></h3>
              <p>{copy.interestsDescription}</p>
            </div>
            <RowAction Icon={PencilSimple} label={copy.editInterests} text={copy.edit} onClick={() => setIsInterestsOpen(true)} />
            {selectedAreas.length > 0 && (
              <div className="settings-interest-summary settings-row-tags" role="group" aria-label={copy.selectedAreas}>
                {/* Each area in its own field ink (design.md, rule 2). */}
                {selectedAreas.map(area => (
                  <span key={area!.id} style={{ '--area-accent': area!.accent }}>{area!.label} <small>{area!.count}</small></span>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      <EditInterestsModal isOpen={isInterestsOpen} onClose={() => setIsInterestsOpen(false)} />
      <FeedsDialog open={isFeedsOpen} onOpenChange={setIsFeedsOpen} />
      {/* On a phone the follows open in a sheet, like the interests above;
          wider than that in a dialog, which /settings/following opens over
          this page so a link from elsewhere lands on it too. */}
      {isPhone
        ? <FollowingSheet open={isFollowingOpen} onOpenChange={setIsFollowingOpen} />
        : <FollowingDialog open={isFollowsPath(pathname)} />}
    </>
  );
}

function ReadingPage() {
  const { user, readingPreferences, updateReadingPreferences } = useAuth();
  const [savingLevel, setSavingLevel] = useState<string | null>(null);

  const handleLevelChange = async (level: ReadingLevel) => {
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
    <>
      <section className="settings-section" aria-labelledby="settings-reading-heading">
        <SectionHeading id="settings-reading-heading" title={copy.readingAi} description={copy.readingAiDescription} />
        {/* A ruled list of the three levels, like the rows on the other pages. */}
        <RadioGroup
          className="settings-levels"
          aria-label={copy.aiLevelLabel}
          value={readingPreferences.aiExplanationLevel}
          onValueChange={(level: ReadingLevel) => { void handleLevelChange(level); }}
          // Busy, not disabled: disabling the radio that holds focus dropped a
          // keyboard user onto <body>. handleLevelChange ignores a choice made
          // while another is saving.
          aria-busy={Boolean(savingLevel)}
        >
          {PAPER_REWRITE_LEVELS.map(({ id }) => {
            const { label, description, Icon } = LEVEL_DETAILS[id as ReadingLevel];
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
      <ReaderSection />
      {/* Keyed by account: another account starts from an empty list, and a
          page still loading for the previous one is dropped with it. */}
      {user && <SummaryHistory key={user.uid} uid={user.uid} />}
    </>
  );
}

function ReaderSection() {
  const { readingPreferences, updateReadingPreferences } = useAuth();
  const showAbstract = useSyncExternalStore(subscribeShowAbstract, readShowAbstract);
  const label = 'Show the abstract';
  return (
    <section className="settings-section" aria-labelledby="settings-reader-heading">
      <SectionHeading id="settings-reader-heading" title="Reader" description="How a paper's full text opens and is read aloud." />
      <div className="profile-fields">
        <Label className="profile-switch">
          <span className="profile-switch-copy">
            <span className="profile-switch-label">{label}</span>
            <span className="profile-switch-hint" id="settings-reader-abstract-hint">Start each paper with its abstract, above the first section. Saved in this browser.</span>
          </span>
          <Switch className="settings-toggle" checked={showAbstract} aria-label={label} aria-describedby="settings-reader-abstract-hint" onCheckedChange={saveShowAbstract} />
        </Label>
        <Label className="profile-switch">
          <span className="profile-switch-copy">
            <span className="profile-switch-label">{copy.readAloudFromPosition}</span>
            <span className="profile-switch-hint">{copy.readAloudFromPositionHint}</span>
          </span>
          <Switch
            className="settings-toggle"
            checked={readingPreferences.readAloudFromPosition}
            aria-label={copy.readAloudFromPosition}
            onCheckedChange={(checked) => {
              updateReadingPreferences({ readAloudFromPosition: checked }).catch(() => notify('error', copy.readAloudError));
            }}
          />
        </Label>
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
        <SectionHeading id="settings-notifications-heading" title={copy.notifications} description={copy.notificationsDescription} />
        <div className="settings-list">
          <div className="settings-row settings-row-side">
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
  const Page = PAGE_COMPONENTS[active.slug as keyof typeof PAGE_COMPONENTS];
  // The Follows dialog over Discovery has a route of its own and names the tab
  // while it is open, as RouteAnnouncer does (route-metadata.ts).
  const title = `${isFollowsPath(useLocation().pathname) ? 'Follows' : active.label} · Settings | PaperTok`;

  // The tab keeps saying which page this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    // Only restore if nothing claimed the title since (the outgoing route
    // stays mounted ~200ms into the next one under AnimatePresence).
    return () => { if (document.title === title) document.title = previous; };
  }, [title]);

  return (
    <main className="settings-page">
      <div className="settings-shell">
        <header className="settings-heading">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </header>

        <div className="settings-layout">

          <SettingsSwitcher active={active} />
          <SettingsRail />

          <div className="settings-content">
            <Page />
          </div>
        </div>
      </div>
    </main>
  );
}
