import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  isTransientReadError, patientRead, slowNoticeStatus, withReadTimeout,
} from '../../utils/boundedRead.js';
import {
  forgetOwnProfile,
  ownProfileCache,
  ownProfileKey,
  pinnableListsCache,
  rememberOwnProfile,
} from '../../utils/profileSessionCaches.js';
import {
  HandleUnavailableError,
  PROFILE_VISIBILITY,
  USER_PROFILE_LIMITS,
  changeUserHandle,
  createUserProfile,
  deleteOwnUserProfile,
  isVisibilityChoice,
  migrateHiddenPins,
  migrateLegacyPins,
  needsLegacyPinMigration,
  needsVisibilityChoice,
  partitionStalePins,
  profileIsPublic,
  profileShowsPhoto,
  publicAvatarFrom,
  readConfirmedOwnUserProfile,
  readOwnUserProfile,
  readPinnableLists,
  savePinnedShareIds,
  saveProfileVisibility,
  updateUserProfile,
} from '../../services/userProfileService.js';
import { attributePublicList } from '../../services/publicListService.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { clearStoredProfile } from '../../utils/userScopedStorage.js';
import { HANDLE_ERROR_MESSAGES, inspectHandle } from '../../utils/userHandle.js';
import { loadProfileFonts } from '../../utils/loadDisplayFonts.js';

/*
 * The public profile editor's state and writes, shared by the two settings
 * pages that edit the profile (SettingsPage.jsx): Profile & account edits
 * who the page says you are, Privacy decides what it shows and takes it
 * down. The sections they render from it are in ProfileEditor.jsx.
 *
 * Privacy here is subtractive, not additive: the public document only ever
 * carries what this editor writes, so "choose what is public" means choosing
 * what gets written — the photo toggle controls whether the `photo` field
 * exists at all, and unpublishing deletes the document plus its handle in one
 * batch. Nothing needs new rules, because nothing new becomes readable.
 *
 * Pinning happens here rather than on the lists screen because attribution is
 * opt-in: a public list stays anonymous until its owner decides, from their own
 * profile, to put their name on it.
 */


/** What the editor says about its own writes. */
const MESSAGES = {
  visibilityFailed: 'The visibility could not be saved. Try again.',
  // Successes: a title, and what changed for the public page.
  created: (handle, visibility) => ({
    title: 'Profile created',
    description: visibility === PROFILE_VISIBILITY.public
      ? `@${handle} is yours, and anyone with the link can open your page.`
      : `@${handle} is yours. Only you can open your page until you make it public.`,
  }),
  renamed: handle => ({ title: 'Profile saved', description: `Your page now lives at @${handle}. The old handle is free.` }),
  profileSaved: { title: 'Profile saved', description: 'Your public page shows your new name and bio.' },
  madePublic: { title: 'Profile is public', description: 'Anyone with the link can open your page.' },
  madePrivate: { title: 'Profile is private', description: 'Only you can open your page now.' },
  photoShown: { title: 'Photo shown', description: 'Your public page shows your account photo.' },
  photoHidden: { title: 'Photo hidden', description: 'Your public page shows your initial instead.' },
  contactOn: { title: 'Contact on', description: 'Other readers can contact you. Your email stays hidden.' },
  contactOff: { title: 'Contact off', description: 'Other readers can no longer contact you.' },
  listShown: title => ({ title: 'On your profile', description: `“${title}” now appears on your public page.` }),
  listHidden: title => ({ title: 'Off your profile', description: `“${title}” no longer appears on your public page.` }),
  listPinned: title => ({ title: 'Pinned', description: `“${title}” now sits at the top of your lists.` }),
  listUnpinned: title => ({ title: 'Unpinned', description: `“${title}” goes back among your other lists.` }),
  hiddenPinsShown: { title: 'Lists shown', description: 'The pinned lists you had hidden are on your profile again.' },
  hiddenPinsKept: { title: 'Lists kept off', description: 'Those lists stay off your profile. You can add them one by one below.' },
  unpublished: handle => ({ title: 'Profile unpublished', description: `Your page is gone and @${handle} is free. Your account and lists stay.` }),
  showcaseFull: 'Your profile already shows the maximum number of lists.',
  handleTaken: 'That handle is already taken.',
  genericError: 'Something went wrong. Try again.',
  nameRequired: 'A display name is required.',
  visibilityRequired: 'Choose who can see your profile on the Privacy page first.',
  noPublicPhoto: 'There is no photo your public page can show. Upload one in Profile & account.',
  pinLimit: `You can pin at most ${USER_PROFILE_LIMITS.pinnedShareIds} lists.`,
};

/*
 * The editor is split across two pages (identity on Profile, who can see it
 * on Privacy), and each page is its own route with its own editor, so unsaved
 * answers are kept here: the identity fields until they are saved, and the
 * creation answers until the profile exists. `null` means "not touched", so
 * the stored value shows instead. Filed under the uid, so another account
 * signing in on this tab starts blank.
 * ponytail: module memory, lost on reload; enough for a form draft.
 */
const BLANK_DRAFT = {
  handle: null, displayName: null, bio: null, allowContact: false, showPhoto: true,
  // No preselection: a profile is never created with a visibility nobody
  // picked (docs/plan/04-PHASES.md, P15).
  visibility: null,
};
let creationDraft = { uid: null, ...BLANK_DRAFT };
const draftFor = (uid) => {
  if (creationDraft.uid !== uid) creationDraft = { uid, ...BLANK_DRAFT };
  return creationDraft;
};
const clearCreationDraft = (uid) => { creationDraft = { uid, ...BLANK_DRAFT }; };

// "Decide later" on the one-time visibility question, for this tab: both
// settings pages ask it, and each mounts its own editor.
let promptDismissedFor = null;

const copy = MESSAGES;

export function useProfileEditor() {
  const { user, profilePhoto, institution } = useAuth();

  useEffect(() => {
    void loadProfileFonts();
  }, []);

  // Seeded from the cache the public profile page and the other settings
  // page fill, so moving between them paints instead of spinning.
  const seededKey = ownProfileKey(user?.uid);
  const seeded = seededKey ? ownProfileCache.get(seededKey) : undefined;
  const seededProfile = seeded?.profile;
  const draft = draftFor(user?.uid ?? null);
  const [profile, setProfile] = useState(seeded ? seededProfile : null);
  // `null` is "not asked yet", `[]` is "asked, and there are none". Decoupling
  // this read from the profile means the section can render before its answer
  // arrives, and only the second of those two states may claim the account has
  // published nothing.
  const [pinnableLists, setPinnableLists] = useState(
    () => (user?.uid ? pinnableListsCache.get(user.uid) ?? null : null),
  );
  const [status, setStatus] = useState(() => {
    if (!seeded) return 'loading';
    return seededProfile ? 'ready' : 'new';
  });
  const [handleDraft, setHandleDraftState] = useState(draft.handle ?? (seededProfile?.handle || ''));
  const [displayName, setDisplayNameState] = useState(
    draft.displayName ?? (seededProfile?.displayName || user?.displayName || ''),
  );
  const [bio, setBioState] = useState(draft.bio ?? (seededProfile?.bio || ''));
  const [allowContact, setAllowContactState] = useState(seededProfile
    ? seededProfile.allowContact === true
    : draft.allowContact);
  const [showPhoto, setShowPhotoState] = useState(seededProfile ? profileShowsPhoto(seededProfile) : draft.showPhoto);
  const [visibilityDraft, setVisibilityDraftState] = useState(draft.visibility);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [pinsBusy, setPinsBusy] = useState(false);
  // Which list's toggle just changed, so it pops and its row flashes once.
  // State rather than a keyframe on `.is-pinned`: that would fire for every
  // already-pinned list each time the page opens. Cleared when the row's own
  // animation ends (the button's pop bubbles up first and is ignored).
  const [settling, setSettling] = useState(null);
  const settleDone = (event) => {
    if (event.target === event.currentTarget) setSettling(null);
  };
  // Set once by an unpublish: the form that replaces the sections just
  // deleted remounts and rises instead of flicking into place.
  const [reborn, setReborn] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState(
    () => Boolean(user?.uid) && promptDismissedFor === user.uid,
  );
  const [reloadToken, setReloadToken] = useState(0);
  // F12 migration of the legacy pin model. 'idle' until the profile answers;
  // 'prompt' when hidden pins need the owner's decision; 'failed' leaves the
  // legacy artifacts untouched for the next visit's retry.
  const [migration, setMigration] = useState('idle');

  // Every answer also goes to the draft, so leaving for the other page and
  // coming back keeps it. The switches of an existing profile save on the spot
  // and never pass through here.
  const drafted = (setState, key) => (value) => {
    draft[key] = value;
    setState(value);
  };
  const setHandleDraft = drafted(setHandleDraftState, 'handle');
  const setDisplayName = drafted(setDisplayNameState, 'displayName');
  const setBio = drafted(setBioState, 'bio');
  const setAllowContact = drafted(setAllowContactState, 'allowContact');
  const setShowPhoto = drafted(setShowPhotoState, 'showPhoto');
  const setVisibilityDraft = drafted(setVisibilityDraftState, 'visibility');

  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    // The retry loop outlives the promise; leaving must end it.
    const controller = new AbortController();
    const uid = user.uid;
    const startedAt = Date.now();

    // Two independent reads, no longer joined by `Promise.all`: the form only
    // needs the profile, and pairing them made the whole screen wait on the
    // slower of the two. The profile read gets patience rather than a
    // guillotine: a slow answer is announced as slow, retried, and accepted
    // whenever it lands — "could not be loaded" is reserved for a read that
    // actually failed.
    //
    // And the patience only means something because the read is the confirmed
    // one. `readOwnUserProfile` RESOLVES a document the local cache merely
    // failed to find — half a millisecond, no rejection — and a success is
    // not something `patientRead` can retry, so a stalled channel settled
    // this screen on "create your profile" for an account that has one, and
    // wrote that same non-answer into the cache the comments sheet reads.
    // An unconfirmed absence now rejects as `unavailable`, which is a
    // transient error: the loop keeps asking and only a server answer
    // settles anything.
    const applyProfile = (ownProfile) => {
      rememberOwnProfile(uid, ownProfile);
      if (!active) return;
      const pending = draftFor(uid);
      setProfile(ownProfile);
      // An unsaved edit (typed on this page before leaving for the other one)
      // wins over the stored value.
      setDisplayNameState(pending.displayName ?? (ownProfile?.displayName || user.displayName || ''));
      setBioState(pending.bio ?? (ownProfile?.bio || ''));
      setAllowContactState(ownProfile ? ownProfile.allowContact === true : pending.allowContact);
      setShowPhotoState(ownProfile ? profileShowsPhoto(ownProfile) : pending.showPhoto);
      setHandleDraftState(pending.handle ?? (ownProfile?.handle || ''));
      if (!ownProfile) setVisibilityDraftState(pending.visibility);
      setStatus(ownProfile ? 'ready' : 'new');
    };
    patientRead(() => readConfirmedOwnUserProfile(), {
      attempts: 2,
      label: 'own profile',
      signal: controller.signal,
      // `onSlow` fires at every intermediate timeout AND at every transient
      // rejection, and an unconfirmed absence is the instant kind: without
      // the gate the loading line became the whole "this is taking longer
      // than usual" panel inside the first frame, before anything had taken
      // long. Being offline is exempt, which is why the gate decides that
      // too instead of this line.
      onSlow: (attemptNumber, info) => {
        if (!active || seeded) return;
        const waited = slowNoticeStatus(Date.now() - startedAt, info);
        if (waited) setStatus(waited);
      },
      onLateResult: applyProfile,
    })
      .then(applyProfile)
      .catch(error => {
        if (isTransientReadError(error)) {
          // Already showing 'slow'; the late answer stays armed above.
          console.warn('The profile did not answer in time', error);
          return;
        }
        console.error('Error loading own profile:', error);
        if (!active) return;
        // A failed refresh behind an already-seeded view keeps the view; only
        // a first load with nothing to show reports the failure.
        if (seeded) return;
        setStatus('error');
      });

    // The pinnable lists are a secondary section. They fill in when they
    // arrive and their failure is not the screen's failure.
    withReadTimeout(readPinnableLists(), { label: 'pinnable lists' })
      .then(lists => {
        pinnableListsCache.set(uid, lists);
        if (active) setPinnableLists(lists);
      })
      .catch(error => {
        if (isTransientReadError(error)) console.warn('The pinnable lists did not answer in time', error);
        else console.error('Error loading pinnable lists:', error);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // `seeded` is read once to decide whether a failure is reportable; it is
    // derived from this same uid, so it adds nothing to re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, reloadToken]);

  // Write-through for every edit this editor makes. There are a dozen places
  // that move `profile` — save, rename, visibility, pinning, unpublish — and
  // chasing each one would leave the shared view stale the day a thirteenth is
  // added; watching the value covers them all.
  //
  // An allow-list of the two settled answers, not a list of the states to
  // skip: 'slow' and 'offline' are waits with `profile` still null, and this
  // effect runs on every status change, so a deny-list published exactly the
  // unconfirmed absence the read above refuses to settle on — into the cache
  // the comments sheet seeds its footer from.
  useEffect(() => {
    if (!user?.uid || (status !== 'ready' && status !== 'new')) return;
    rememberOwnProfile(user.uid, profile);
  }, [profile, status, user?.uid]);

  /** A write landed: say so in a toast, which also announces it. */
  const markSaved = ({ title, description }) => {
    toast.success(title, { description });
  };

  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleDraft && !handleCheck.valid
    ? HANDLE_ERROR_MESSAGES[handleCheck.code]
    : '';
  const pinnedShareIds = useMemo(() => profile?.pinnedShareIds || [], [profile?.pinnedShareIds]);
  // Asked on both editor pages: both have already read the profile, so the
  // question costs nothing extra on either.
  const askVisibility = status === 'ready' && needsVisibilityChoice(profile) && !promptDismissed;
  // Whatever the rest of the app shows, bounded to what the public document
  // may carry. Saving the profile is what mirrors it across.
  const appAvatar = useMemo(
    () => publicAvatarFrom(profilePhoto, user?.photoURL),
    [profilePhoto, user?.photoURL],
  );

  const errorMessage = error => (error instanceof HandleUnavailableError ? copy.handleTaken : copy.genericError);

  const reportError = (error) => {
    console.error('Profile write failed:', error);
    toastError(errorMessage(error));
  };

  // A stale pin — its list unpublished or republished — makes the rules refuse
  // the whole write, so carrying it along turns a save into a permission error
  // with no visible cause. Once the pin picker has answered, the stale entries
  // are dropped here exactly as the banner offers; before it answers, the save
  // keeps what it has rather than guess every pin stale.
  const livePins = () => (pinnableLists === null
    ? profile?.pinnedLists
    : partitionStalePins(profile?.pinnedLists, pinnableLists).pinned);

  const onSubmit = async (event) => {
    event.preventDefault();
    if (saving || deleting) return;
    if (!displayName.trim()) {
      toastError(copy.nameRequired);
      return;
    }
    if (!handleCheck.valid) {
      toastError(handleError || copy.genericError);
      return;
    }
    if (!profile && !isVisibilityChoice(visibilityDraft)) {
      toastError(copy.visibilityRequired);
      return;
    }

    setSaving(true);
    const message = !profile
      ? copy.created(handleCheck.handle, visibilityDraft)
      : handleCheck.handle !== profile.handle ? copy.renamed(handleCheck.handle) : copy.profileSaved;
    try {
      if (!profile) {
        const created = await createUserProfile({
          displayName,
          bio,
          allowContact,
          photo: showPhoto ? appAvatar : '',
          showPhoto,
          handle: handleCheck.handle,
          visibility: visibilityDraft,
          institution,
        });
        clearCreationDraft(user.uid);
        setProfile({ ...created, pinnedLists: created.pinnedLists || [] });
        setStatus('ready');
      } else {
        if (handleCheck.handle !== profile.handle) {
          await changeUserHandle(handleCheck.handle, profile.handle);
          // The public profile page files entries under the handle too, so the
          // name just given up must not keep serving this profile.
          forgetOwnProfile(null, profile.handle);
        }
        // Name and bio only. The photo and contact switches belong to
        // Privacy, which saves them on the spot; writing them from this page's
        // snapshot could undo a switch saved there a moment ago.
        const updated = await updateUserProfile({ displayName, bio, pinnedLists: livePins() });
        clearCreationDraft(user.uid);
        setProfile(current => ({ ...current, ...updated, handle: handleCheck.handle }));
      }
      markSaved(message);
    } catch (error) {
      reportError(error);
      // The handle may or may not have changed; re-read rather than guess.
      readOwnUserProfile().then(fresh => {
        if (!fresh) return;
        setProfile(fresh);
        // The stored handle is not an edit: keep it out of the draft, or a
        // later rename elsewhere would be undone by the next save here.
        draftFor(user.uid).handle = null;
        setHandleDraftState(fresh.handle);
      }).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  /**
   * Who can see the profile writes immediately rather than waiting for
   * "Save changes": a privacy control that needs a second confirmation is a
   * control people believe they have already used. The list calls this only
   * on an explicit press, never while arrow keys move through it.
   */
  const toggleVisibility = async (makePublic) => {
    if (!profile || visibilityBusy) return;
    const next = makePublic ? PROFILE_VISIBILITY.public : PROFILE_VISIBILITY.private;
    // The stored field, not the effective value: pressing Public on a profile
    // that never chose is the answer the one-time question waits for.
    if (profile.visibility === next) return;
    const previous = profile.visibility;
    setVisibilityBusy(true);
    setProfile(current => ({ ...current, visibility: next }));
    try {
      await saveProfileVisibility(next);
      markSaved(makePublic ? copy.madePublic : copy.madePrivate);
    } catch (error) {
      setProfile(current => ({ ...current, visibility: previous }));
      console.error('Error saving profile visibility:', error);
      toastError(copy.visibilityFailed);
    } finally {
      setVisibilityBusy(false);
    }
  };

  /**
   * The photo and contact switches save on the spot, like the visibility
   * choice beside them. Each writes only its own field, so a name or bio
   * waiting on the other page is neither saved nor undone. While the profile
   * is being created they are answers kept for its creation.
   */
  const saveSwitch = async (field, value) => {
    if (!profile) {
      if (field === 'showPhoto') setShowPhoto(value); else setAllowContact(value);
      return;
    }
    if (switchBusy || saving || deleting) return;
    const isPhoto = field === 'showPhoto';
    // Nothing the public document may carry (a provider avatar off the
    // allowlist, an upload over the public budget): "Photo shown" would lie.
    if (isPhoto && value && !appAvatar) {
      toastError(copy.noPublicPhoto);
      return;
    }
    const setState = isPhoto ? setShowPhotoState : setAllowContactState;
    const previous = isPhoto ? showPhoto : allowContact;
    setState(value);
    setSwitchBusy(true);
    try {
      const updated = await updateUserProfile({
        ...(isPhoto ? { photo: value ? appAvatar : null, showPhoto: value } : { allowContact: value }),
        pinnedLists: livePins(),
      });
      // An unpublish can land while this write is in flight; there is no
      // profile left to merge into then.
      setProfile(current => (current ? { ...current, ...updated } : current));
      markSaved(isPhoto
        ? (value ? copy.photoShown : copy.photoHidden)
        : (value ? copy.contactOn : copy.contactOff));
    } catch (error) {
      setState(previous);
      reportError(error);
    } finally {
      setSwitchBusy(false);
    }
  };

  /** Applies a finished migration's result to the editor's state. */
  const applyMigrationResult = (result) => {
    setProfile(current => {
      const next = { ...current, pinnedLists: [], pinnedShareIds: result.pinnedShareIds };
      delete next.showPinnedLists;
      return next;
    });
    // The Worker just stamped `onProfile` on the migrated lists; the picker
    // rows and their cache follow without a re-read.
    setPinnableLists(current => {
      const updated = (current || []).map(item => (
        result.attributedShareIds.includes(item.shareId)
          ? { ...item, onProfile: true }
          : item
      ));
      if (user?.uid) pinnableListsCache.set(user.uid, updated);
      return updated;
    });
  };

  // The hidden-pins decision (the F8 stash) is the owner's, so it renders as
  // a banner instead of migrating on its own; answering it removes the
  // retired flag, which is what makes this condition disappear.
  const hiddenPinsPrompt = status === 'ready'
    && profile?.showPinnedLists === false
    && migration !== 'running';

  /**
   * F12 migration, run once per visit when the profile still carries the
   * legacy pin model with the pins VISIBLE. The pinned card WAS public
   * attribution, so attributing the list widens nothing and no question is
   * needed. Attribution goes through the Worker and is idempotent; a failure
   * leaves everything as it was for the next visit's retry.
   */
  const migrationStarted = useRef(false);
  // Leaving the page is the only thing that may drop the migration's result.
  // The effect below re-runs whenever `profile` changes, and the editor's own
  // read lands while the migration is in flight: cancelling on that left the
  // toggles locked on 'running' and the shared cache on the legacy shape.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (status !== 'ready' || !profile || migrationStarted.current) return;
    if (!needsLegacyPinMigration(profile) || profile.showPinnedLists === false) return;
    migrationStarted.current = true;
    Promise.resolve()
      .then(() => {
        if (mounted.current) setMigration('running');
        return migrateLegacyPins({ attribute: attributePublicList });
      })
      .then(result => {
        if (!mounted.current) return;
        applyMigrationResult(result);
        setMigration('done');
      })
      .catch(error => {
        console.error('The pin migration failed; the legacy pins stay for a retry:', error);
        if (mounted.current) setMigration('failed');
      });
    // `applyMigrationResult` only wraps state setters; listing it would re-run
    // this on every render for nothing — the ref guard makes reruns no-ops
    // anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, profile]);

  /** The hidden-pins banner's answer. */
  const resolveHiddenPins = async (showOnProfile) => {
    if (migration === 'running') return;
    setMigration('running');
    try {
      const result = await migrateHiddenPins({
        attribute: attributePublicList, showOnProfile,
      });
      applyMigrationResult(result);
      setMigration('done');
      markSaved(showOnProfile ? copy.hiddenPinsShown : copy.hiddenPinsKept);
    } catch (error) {
      reportError(error);
      setMigration('idle');
    }
  };

  /**
   * The per-list attribution switch: the Worker moves the showcase card and
   * the `onProfile` mirror together. Taking a list off the profile also
   * unpins it — a pin over a card that no longer exists paints nothing, but
   * leaving it stored would resurrect the pin on a later re-attribution the
   * owner never asked to restore.
   */
  const toggleAttribution = async (list) => {
    if (pinsBusy || migration === 'running') return;
    const next = !list.onProfile;
    setPinsBusy(true);
    try {
      await attributePublicList(list.shareId, next);
      setPinnableLists(current => {
        const updated = (current || []).map(item => (
          item.shareId === list.shareId ? { ...item, onProfile: next } : item
        ));
        if (user?.uid) pinnableListsCache.set(user.uid, updated);
        return updated;
      });
      setSettling({ shareId: list.shareId, kind: 'attribution' });
      if (!next && pinnedShareIds.includes(list.shareId)) {
        const remaining = pinnedShareIds.filter(id => id !== list.shareId);
        await savePinnedShareIds(remaining);
        setProfile(current => ({ ...current, pinnedShareIds: remaining }));
      }
      markSaved(next ? copy.listShown(list.title) : copy.listHidden(list.title));
    } catch (error) {
      if (error?.code === 'PROFILE_LISTS_FULL') {
        toastError(copy.showcaseFull);
      } else {
        reportError(error);
      }
    } finally {
      setPinsBusy(false);
    }
  };

  /** The pin, as F12 leaves it: an order of at most three ids, one write. */
  const togglePin = async (shareId) => {
    if (!profile || pinsBusy) return;
    const previous = pinnedShareIds;
    const isPinned = previous.includes(shareId);
    if (!isPinned && previous.length >= USER_PROFILE_LIMITS.pinnedShareIds) {
      toastError(copy.pinLimit);
      return;
    }
    const next = isPinned
      ? previous.filter(id => id !== shareId)
      : [...previous, shareId];
    setPinsBusy(true);
    setProfile(current => ({ ...current, pinnedShareIds: next }));
    try {
      await savePinnedShareIds(next);
      // After the save lands: a pin that rolls back must not pop as if it had.
      setSettling({ shareId, kind: 'pin' });
      const title = pinnableLists?.find(item => item.shareId === shareId)?.title ?? '';
      markSaved(isPinned ? copy.listUnpinned(title) : copy.listPinned(title));
    } catch (error) {
      setProfile(current => ({ ...current, pinnedShareIds: previous }));
      reportError(error);
    } finally {
      setPinsBusy(false);
    }
  };

  const unpublishProfile = async () => {
    // The page asks first (UnpublishDialog in SettingsPage.jsx); this only
    // does it. A switch or visibility write still in flight would land on a
    // deleted document, so they hold it too.
    if (!profile || saving || deleting || switchBusy || visibilityBusy) return;
    setDeleting(true);
    try {
      const unpublishedHandle = profile?.handle;
      await deleteOwnUserProfile();
      forgetOwnProfile(user.uid, unpublishedHandle);
      clearStoredProfile(user.uid);
      // Creating a profile again is creating a profile: every answer starts
      // from the defaults (no visibility picked) rather than being inherited
      // from the one just deleted.
      clearCreationDraft(user.uid);
      setProfile(null);
      setStatus('new');
      setReborn(true);
      setHandleDraftState('');
      setDisplayNameState(user.displayName || '');
      setBioState('');
      setShowPhotoState(BLANK_DRAFT.showPhoto);
      setAllowContactState(BLANK_DRAFT.allowContact);
      setVisibilityDraftState(BLANK_DRAFT.visibility);
      markSaved(copy.unpublished(unpublishedHandle));
    } catch (error) {
      reportError(error);
    } finally {
      setDeleting(false);
    }
  };

  const retry = () => {
    setStatus('loading');
    setReloadToken(token => token + 1);
  };

  const isNew = status === 'new';
  const isPublicProfile = profileIsPublic(profile);

  // Grouped by the section that uses each part, so a section receives only
  // what it renders and changes.
  return {
    read: {
      status,
      ready: status === 'ready' || isNew,
      retry,
    },
    form: {
      isNew,
      needsVisibility: isNew && !isVisibilityChoice(visibilityDraft),
      handleDraft,
      setHandleDraft,
      handleCheck,
      handleError,
      displayName,
      setDisplayName,
      bio,
      setBio,
      allowContact,
      setAllowContact: value => saveSwitch('allowContact', value),
      showPhoto,
      setShowPhoto: value => saveSwitch('showPhoto', value),
      switchBusy,
      submit: onSubmit,
      saving,
      deleting,
      reborn,
      // Only a profile that exists has a page to open.
      publicPath: profile ? getPublicProfilePath(profile.handle) : null,
    },
    visibility: {
      isNew,
      // While creating, the choice is a draft saved with the profile; once it
      // exists, a change is saved on the spot.
      // An older profile that never chose is public in effect, so that is
      // what the list shows.
      value: isNew
        ? visibilityDraft
        : (isPublicProfile ? PROFILE_VISIBILITY.public : PROFILE_VISIBILITY.private),
      change: next => (isNew
        ? setVisibilityDraft(next)
        : toggleVisibility(next === PROFILE_VISIBILITY.public)),
      busy: visibilityBusy,
    },
    lists: {
      items: pinnableLists,
      pinnedShareIds,
      // A write in flight, or the pin migration running, holds every toggle.
      locked: pinsBusy || migration === 'running',
      migration,
      settling,
      settleDone,
      toggleAttribution,
      togglePin,
      hiddenPinsPrompt,
      resolveHiddenPins,
    },
    prompt: {
      open: askVisibility,
      resolve: visibility => setProfile(current => ({ ...current, visibility })),
      dismiss: () => {
        promptDismissedFor = user?.uid ?? null;
        setPromptDismissed(true);
      },
    },
    unpublish: {
      // Only a profile that exists can be taken down.
      handle: status === 'ready' ? profile?.handle ?? null : null,
      run: unpublishProfile,
      busy: deleting,
      blocked: saving || deleting || switchBusy || visibilityBusy,
    },
  };
}
