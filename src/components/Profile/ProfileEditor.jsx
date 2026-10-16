import { Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowRight,
  ArrowSquareOut,
  CircleNotch,
  FolderOpen,
  GlobeHemisphereWest,
  IdentificationCard,
  Lock,
  PushPin,
  PushPinSlash,
} from '@phosphor-icons/react';
import { USER_PROFILE_LIMITS } from '../../services/userProfileService.js';
import VisibilityList from './VisibilityList.jsx';
import VisibilityPrompt from './VisibilityPrompt.jsx';
import { getIcon } from '../../utils/icons.js';
import { HANDLE_MAX_LENGTH } from '../../utils/userHandle.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.jsx';
import { buttonVariants } from '../ui/button-variants.js';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Switch } from '../ui/switch.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './ProfileEditor.css';

/*
 * The public profile editor's sections, rendered by the two settings pages
 * that edit the profile from one `useProfileEditor()` each.
 */

const copy = {
  createIntro: 'Pick a handle to create your profile at its own link. Who can see it is your choice, on the Privacy page.',
  visibilityNeededBefore: 'Before you create it, choose who can see your profile on the ',
  visibilityNeededLink: 'Privacy page',
  draftNotice: 'You have no profile yet. These choices are kept for when you create it in Profile & account, and a reload clears them.',
  draftNoticeLink: 'Go to Profile & account',
  editIntro: 'How you appear on your public page.',
  sectionIdentity: 'Public identity',
  handle: 'Handle',
  handleHint: 'Lowercase letters, numbers and underscores.',
  displayName: 'Display name',
  bio: 'Bio',
  sectionPublicPage: 'Public page',
  publicPageIntro: 'What anyone with your public link can see.',
  publicNow: 'Public on your page',
  publicItems: ['Handle', 'Display name', 'Bio', 'Photo (if on)', 'Lists you show'],
  neverPublic: 'Never public',
  neverItems: ['Email', 'Saved papers and likes', 'Reading history', 'Unpublished lists', 'Who you follow'],
  showPhoto: 'Show my account photo',
  showPhotoHint: 'Off: your page shows your initial instead of the picture.',
  allowContact: 'Let other users contact me',
  allowContactHint: 'Your email is never shown or shared either way.',
  save: 'Save changes',
  saving: 'Saving...',
  pinned: 'Lists on my profile',
  pinnedHint: 'Publishing a list shows it on your profile. Here you choose which ones appear and which stay pinned on top.',
  noLists: 'You have not published any lists yet.',
  goToLists: 'Go to My lists',
  loadingLists: 'Looking for your published lists...',
  pin: 'Pin',
  unpin: 'Unpin from top',
  onProfile: 'On my profile',
  offProfile: 'Not on my profile',
  migrating: 'Updating your pinned lists to the new model…',
  migrationFailed: 'Your pinned lists could not be updated to the new model. Nothing changed; it will retry on your next visit.',
  hiddenPinsTitle: 'You had hidden pinned lists',
  hiddenPinsBody: 'Lists no longer hide as a group: each published list now has its own "On my profile" switch. Do you want those lists shown on your profile?',
  hiddenPinsShow: 'Show them',
  hiddenPinsKeep: 'Keep them off',
  viewPublic: 'View public profile',
  viewPublicNewTab: 'View public profile (opens in a new tab)',
  papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
  loading: 'Loading your profile...',
  loadError: 'Your profile could not be loaded.',
  loadSlow: 'Your profile is taking longer than usual.',
  loadOffline: 'There seems to be no connection.',
  loadSlowHint: 'Still trying — nothing has been changed.',
  loadErrorHint: 'Check your connection and try again — nothing has been changed.',
  retry: 'Try again',
};

function Heading({ id, title, description }) {
  return (
    <div className="settings-section-heading">
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
    </div>
  );
}


export function ProfileReadState({ read }) {
  if (read.status === 'loading') {
    return (
      <p className="profile-loading profile-read-state">
        <CircleNotch size={18} className="profile-spin" aria-hidden="true" /> {copy.loading}
      </p>
    );
  }
  // 'slow' and 'offline' are waits with a read still running behind them;
  // only 'error' is the editor giving up. The Try again is offered in all
  // three, because pressing it is never wrong.
  const waiting = read.status !== 'error';
  return (
    <div className="profile-load-error profile-read-state" role="alert" aria-busy={waiting}>
      <h2>{read.status === 'offline' ? copy.loadOffline : read.status === 'slow' ? copy.loadSlow : copy.loadError}</h2>
      <p>{waiting ? copy.loadSlowHint : copy.loadErrorHint}</p>
      <Button variant="outline" size="sm" onClick={read.retry}>{copy.retry}</Button>
    </div>
  );
}

function SaveFoot({ form }) {
  return (
    <div className="profile-form-foot">
      {form.needsVisibility && (
        <p id="profile-visibility-needed" className="profile-hint">
          {copy.visibilityNeededBefore}
          <Link to="/settings/privacy">{copy.visibilityNeededLink}</Link>.
        </p>
      )}
      <div className="profile-actions">
        <Button
          type="submit"
          disabled={form.saving || form.deleting || !form.handleCheck.valid || form.needsVisibility}
          aria-describedby={form.needsVisibility ? 'profile-visibility-needed' : undefined}
        >
          {form.saving ? copy.saving : copy.save}
        </Button>
      </div>
    </div>
  );
}

/**
 * Public identity. `photo` is the account photo row, which the settings page
 * owns: it is the picture the public page shows unless Privacy turns it off.
 */
export function IdentitySection({ form, photo }) {
  const { handleDraft, handleError, displayName, bio } = form;
  return (
    <form onSubmit={form.submit}>
      <section className="settings-section" aria-labelledby="profile-identity-title">
        <Heading
          id="profile-identity-title"
          title={copy.sectionIdentity}
          description={form.isNew ? copy.createIntro : copy.editIntro}
        />

        <div className="profile-fields">
          {photo}
          <div className="profile-identity-fields">
            <div className="profile-field">
              <Label htmlFor="profile-handle">{copy.handle}</Label>
              <div className="profile-handle-row">
                <div className="profile-handle-input">
                  <span aria-hidden="true">@</span>
                  <Input
                    id="profile-handle"
                    value={handleDraft}
                    onChange={event => form.setHandleDraft(event.target.value.toLowerCase())}
                    maxLength={HANDLE_MAX_LENGTH}
                    autoComplete="off"
                    spellCheck="false"
                    aria-invalid={handleError ? 'true' : undefined}
                    aria-describedby="profile-handle-hint"
                  />
                </div>
                {/* The page the saved handle names (the draft may not exist
                    yet), in a new tab so unsaved edits stay here. A link drawn
                    as a button, not a Button rendered as a link: Base UI gives
                    a non-button element `role="button"`, and this navigates. */}
                {form.publicPath && (
                  <a
                    href={form.publicPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'profile-handle-open')}
                    aria-label={copy.viewPublicNewTab}
                    title={copy.viewPublic}
                  >
                    <ArrowSquareOut size={17} aria-hidden="true" />
                  </a>
                )}
              </div>
              <p id="profile-handle-hint" className={`profile-hint${handleError ? ' is-error' : ''}`} aria-live="polite">
                {handleError || copy.handleHint}
              </p>
            </div>

            <div className="profile-field">
              <Label htmlFor="profile-name">{copy.displayName}</Label>
              <Input
                id="profile-name"
                value={displayName}
                onChange={event => form.setDisplayName(event.target.value)}
                maxLength={USER_PROFILE_LIMITS.displayName}
                autoComplete="name"
              />
            </div>
          </div>

          <div className="profile-field">
            <div className="profile-field-head">
              <Label htmlFor="profile-bio">{copy.bio}</Label>
              <span id="profile-bio-count" className="profile-char-count">
                {bio.length} / {USER_PROFILE_LIMITS.bio}
              </span>
            </div>
            <Textarea
              id="profile-bio"
              value={bio}
              rows={4}
              onChange={event => form.setBio(event.target.value)}
              maxLength={USER_PROFILE_LIMITS.bio}
              aria-describedby="profile-bio-count"
            />
          </div>
        </div>

        {/* One label in both states. Creating waits for a Privacy answer,
            and says where to give it. */}
        <SaveFoot form={form} />
      </section>
    </form>
  );
}

function PrivacySummary() {
  const groups = [
    { title: copy.publicNow, Icon: GlobeHemisphereWest, items: copy.publicItems, tone: 'public' },
    { title: copy.neverPublic, Icon: Lock, items: copy.neverItems, tone: 'never' },
  ];
  return (
    <div className="profile-chips">
      {groups.map(({ title, Icon, items, tone }) => (
        <div key={tone} className={`profile-chips-row is-${tone}`}>
          <span className="profile-chips-title"><Icon size={14} aria-hidden="true" /> {title}</span>
          <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}


export function PublicPageSection({ form, visibility }) {
  return (
    <div
      key={form.reborn ? 'form-reborn' : 'form'}
      className={`profile-form${form.reborn ? ' is-reborn' : ''}`}
    >
      <section className="settings-section" aria-labelledby="profile-public-page-title">
        <Heading id="profile-public-page-title" title={copy.sectionPublicPage} description={copy.publicPageIntro} />
        <div className="profile-fields">
          {/* Nothing below is saved until the profile exists, so say so
              rather than let the controls look like they took effect. */}
          {form.isNew && (
            <div className="profile-empty-lists">
              <p className="profile-empty">{copy.draftNotice}</p>
              <Link className="profile-empty-action" to="/settings/profile">
                <IdentificationCard size={15} aria-hidden="true" />
                <span>{copy.draftNoticeLink}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          )}

          <PrivacySummary />
          <div>
            <VisibilityList
              idPrefix="profile-visibility"
              value={visibility.value}
              onChange={visibility.change}
              commitOnPress={!visibility.isNew}
              privateFirst
            />
          </div>

          <Label className="profile-switch">
            <span className="profile-switch-copy">
              <span className="profile-switch-label">{copy.showPhoto}</span>
              <span className="profile-switch-hint">{copy.showPhotoHint}</span>
            </span>
            <Switch checked={form.showPhoto} onCheckedChange={form.setShowPhoto} disabled={form.switchBusy} />
          </Label>

          <Label className="profile-switch">
            <span className="profile-switch-copy">
              <span className="profile-switch-label">{copy.allowContact}</span>
              <span className="profile-switch-hint">{copy.allowContactHint}</span>
            </span>
            <Switch checked={form.allowContact} onCheckedChange={form.setAllowContact} disabled={form.switchBusy} />
          </Label>
        </div>
      </section>
    </div>
  );
}

export function ProfileListsSection({ lists }) {
  const { items, pinnedShareIds, locked, migration, settling } = lists;
  return (
    <section className="settings-section" aria-labelledby="profile-pinned-title">
      <Heading id="profile-pinned-title" title={copy.pinned} description={copy.pinnedHint} />
      <div className="profile-fields">
        {/* The one decision the F12 migration cannot take alone: pins the
            owner had explicitly hidden. Everything else migrates silently. */}
        {lists.hiddenPinsPrompt && (
          <div className="profile-stale" role="alert">
            <div>
              <strong>{copy.hiddenPinsTitle}</strong>
              <p>{copy.hiddenPinsBody}</p>
            </div>
            <div className="profile-stale-actions">
              <Button variant="outline" size="sm" onClick={() => lists.resolveHiddenPins(true)}>
                {copy.hiddenPinsShow}
              </Button>
              <Button variant="outline" size="sm" onClick={() => lists.resolveHiddenPins(false)}>
                {copy.hiddenPinsKeep}
              </Button>
            </div>
          </div>
        )}
        {migration === 'failed' && <p className="profile-hint" role="alert">{copy.migrationFailed}</p>}

        {items === null ? (

          <p className="profile-empty" aria-busy="true">{copy.loadingLists}</p>
        ) : items.length === 0 ? (
          <div className="profile-empty-lists">
            <p className="profile-empty">{copy.noLists}</p>
            <Link className="profile-empty-action" to="/lists">
              <FolderOpen size={15} aria-hidden="true" />
              <span>{copy.goToLists}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            {migration === 'running' && <p className="profile-hint" aria-busy="true">{copy.migrating}</p>}
            <ul className="profile-pin-list">
              {items.map(list => {
                const attributed = list.onProfile === true;
                const isPinned = attributed && pinnedShareIds.includes(list.shareId);
                const pinsFull = !isPinned && pinnedShareIds.length >= USER_PROFILE_LIMITS.pinnedShareIds;
                // `emoji` holds an icon name from utils/icons.js, not a literal emoji.
                const Icon = getIcon(list.emoji);
                const settlingHere = settling?.shareId === list.shareId ? settling.kind : null;
                return (
                  <li
                    key={list.shareId}
                    className={settlingHere ? 'is-flashing' : undefined}
                    onAnimationEnd={lists.settleDone}
                  >
                    <span className="profile-pin-emoji" aria-hidden="true"><Icon size={20} aria-hidden="true" /></span>
                    <span className="profile-pin-copy">
                      <span className="profile-pin-title">{list.title}</span>
                      <span className="profile-pin-count">{copy.papers(list.paperCount)}</span>
                    </span>
                    <span className="profile-pin-actions">
                      <Toggle
                        className={`profile-pin-toggle${attributed ? ' is-pinned' : ''}${settlingHere === 'attribution' ? ' is-settling' : ''}`}
                        pressed={attributed}
                        onPressedChange={() => lists.toggleAttribution(list)}
                        disabled={locked}
                      >
                        {attributed ? <GlobeHemisphereWest size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
                        {attributed ? copy.onProfile : copy.offProfile}
                      </Toggle>
                      {attributed && (
                        <Toggle
                          className={`profile-pin-toggle${isPinned ? ' is-pinned' : ''}${settlingHere === 'pin' ? ' is-settling' : ''}`}
                          pressed={isPinned}
                          onPressedChange={() => lists.togglePin(list.shareId)}
                          disabled={locked || pinsFull}
                        >
                          {isPinned ? <PushPinSlash size={16} aria-hidden="true" /> : <PushPin size={16} aria-hidden="true" />}
                          {isPinned ? copy.unpin : copy.pin}
                        </Toggle>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/** The one-time visibility question for profiles that predate F8. */
export function ProfileVisibilityPrompt({ prompt }) {
  return (
    <AnimatePresence>
      {prompt.open && (
        <VisibilityPrompt onResolved={prompt.resolve} onDismiss={prompt.dismiss} />
      )}
    </AnimatePresence>
  );
}
