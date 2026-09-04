import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowRight, Check, ExternalLink, FolderOpen, Globe2, Loader2, Lock, Pin, PinOff,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { isTransientReadError, patientRead, withReadTimeout } from '../../utils/boundedRead.js';
import {
  forgetOwnProfile,
  ownProfileCache,
  ownProfileKey,
  pinnableListsCache,
  rememberOwnProfile,
} from '../../utils/profileSessionCaches.js';
import { useLanguage } from '../../context/LanguageContext.jsx';
import {
  HandleUnavailableError,
  PROFILE_VISIBILITY,
  USER_PROFILE_LIMITS,
  changeUserHandle,
  createUserProfile,
  deleteOwnUserProfile,
  migrateHiddenPins,
  migrateLegacyPins,
  needsLegacyPinMigration,
  needsVisibilityChoice,
  partitionStalePins,
  profileIsPublic,
  publicAvatarFrom,
  readOwnUserProfile,
  readPinnableLists,
  savePinnedShareIds,
  saveProfileVisibility,
  savePublicProfilePhoto,
  updateUserProfile,
} from '../../services/userProfileService.js';
import { attributePublicList } from '../../services/publicListService.js';
import VisibilityChoice from './VisibilityChoice.jsx';
import { visibilityCopy } from './visibilityCopy.js';
import VisibilityPrompt from './VisibilityPrompt.jsx';
import SettingsSubheader from '../Settings/SettingsSubheader.jsx';
import { SETTINGS_BREADCRUMB } from '../Settings/settingsBreadcrumb.js';
import { cameFromProfile } from './editorOrigin.js';
import { getIcon } from '../../utils/icons.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { clearStoredProfile } from '../../utils/userScopedStorage.js';
import { HANDLE_ERRORS, HANDLE_MAX_LENGTH, inspectHandle } from '../../utils/userHandle.js';
import { loadProfileFonts } from '../../utils/loadDisplayFonts.js';
import './ProfilePage.css';

const HANDLE_ERROR_COPY = {
  en: {
    [HANDLE_ERRORS.empty]: 'Choose a handle.',
    [HANDLE_ERRORS.tooShort]: 'A handle needs at least 3 characters.',
    [HANDLE_ERRORS.tooLong]: 'A handle can have at most 40 characters.',
    [HANDLE_ERRORS.charset]: 'Use lowercase letters, numbers and underscores only.',
    [HANDLE_ERRORS.numericOnly]: 'A handle needs at least one letter.',
    [HANDLE_ERRORS.reserved]: 'That handle is reserved.',
  },
  es: {
    [HANDLE_ERRORS.empty]: 'Elige un handle.',
    [HANDLE_ERRORS.tooShort]: 'Un handle necesita al menos 3 caracteres.',
    [HANDLE_ERRORS.tooLong]: 'Un handle puede tener como mucho 40 caracteres.',
    [HANDLE_ERRORS.charset]: 'Usa solo minúsculas, números y guiones bajos.',
    [HANDLE_ERRORS.numericOnly]: 'Un handle necesita al menos una letra.',
    [HANDLE_ERRORS.reserved]: 'Ese handle está reservado.',
  },
};

/**
 * Which numbered section is currently in the reading band below the navbar.
 * Same idea as the settings hub: document order, not whichever observer
 * callback arrived last, so two overlapping sections cannot flicker the
 * marker between them.
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
 * The owner's view of their public profile: create it, edit it, decide what it
 * shows, and unpublish it.
 *
 * Privacy here is subtractive, not additive: the public document only ever
 * carries what this screen writes, so "choose what is public" means choosing
 * what gets written — the photo toggle controls whether the `photo` field
 * exists at all, and unpublishing deletes the document plus its handle in one
 * batch. Nothing needs new rules, because nothing new becomes readable.
 *
 * Pinning happens here rather than on the lists screen because attribution is
 * opt-in: a public list stays anonymous until its owner decides, from their own
 * profile, to put their name on it.
 */
export default function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profilePhoto } = useAuth();
  const { isEnglish } = useLanguage();

  useEffect(() => {
    void loadProfileFonts();
  }, []);

  // Seeded from the cache the public profile page fills (and fills for it), so
  // the crossing between the two screens paints instead of spinning.
  const seededKey = ownProfileKey(user?.uid);
  const seeded = seededKey ? ownProfileCache.get(seededKey) : undefined;
  const [profile, setProfile] = useState(seeded ? seeded.profile : null);
  // `null` is "not asked yet", `[]` is "asked, and there are none". Decoupling
  // this read from the profile means the section can render before its answer
  // arrives, and only the second of those two states may claim the account has
  // published nothing.
  const [pinnableLists, setPinnableLists] = useState(
    () => (user?.uid ? pinnableListsCache.get(user.uid) ?? null : null),
  );
  const [status, setStatus] = useState(() => {
    if (!seeded) return 'loading';
    return seeded.profile ? 'ready' : 'new';
  });
  const [handleDraft, setHandleDraft] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [allowContact, setAllowContact] = useState(false);
  const [showPhoto, setShowPhoto] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  // Null until chosen, on purpose: the create button stays disabled while it
  // is null, so a profile cannot be born with a visibility nobody picked.
  const [visibilityDraft, setVisibilityDraft] = useState(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [pinsBusy, setPinsBusy] = useState(false);
  // Which list's toggle just changed, so it pops and its row flashes once.
  // State rather than a keyframe on `.is-pinned`: that would fire for every
  // already-pinned list each time the page opens. Cleared when the row's own
  // animation ends (the button's pop bubbles up first and is ignored).
  const [settling, setSettling] = useState(null);
  const settleDone = (event) => {
    if (event.target === event.currentTarget) setSettling(null);
  };
  // Set once by an unpublish: the create-a-profile form that replaces the
  // sections just deleted remounts and rises instead of flicking into place.
  const [reborn, setReborn] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Bumped on every successful save. It is the `key` of the preview's flashing
  // parts, so a second save remounts them and the highlight replays instead of
  // sitting there already-finished.
  const [savedTick, setSavedTick] = useState(0);
  // F12 migration of the legacy pin model. 'idle' until the profile answers;
  // 'prompt' when hidden pins need the owner's decision; 'failed' leaves the
  // legacy artifacts untouched for the next visit's retry.
  const [migration, setMigration] = useState('idle');

  const copy = isEnglish ? {
    back: 'Back',
    backToProfile: 'Back to profile',
    eyebrowFromProfile: 'Profile · Settings',
    title: 'Public profile',
    createIntro: 'Pick a handle and your profile becomes visible at its own public link.',
    editIntro: 'This screen decides everything your public page shows.',
    sectionIdentity: 'Public identity',
    handle: 'Handle',
    handleHint: 'Lowercase letters, numbers and underscores.',
    displayName: 'Display name',
    bio: 'Bio',
    photoMirror: 'Your profile picture is the one from your account.',
    photoMirrorAction: 'Change it in Settings',
    sectionPrivacy: 'Privacy',
    privacyIntro: 'What anyone with your public link can see.',
    visibilityLabel: 'Public profile',
    visibilityHintPublic: 'Anyone with the link can open your profile.',
    visibilityHintPrivate: 'Only you can open your profile. Its page does not exist for anyone else.',
    visibilityFailed: 'The visibility could not be saved. Try again.',
    privateNotice: 'Your profile is private: only you can open it.',
    publicNow: 'Public on your page',
    publicItems: ['Handle and display name', 'Bio', 'Account photo (only if enabled below)', 'Published lists shown on your profile'],
    neverPublic: 'Never public',
    neverItems: ['Email address', 'Saved papers and likes', 'Reading history', 'Unpublished lists', 'Who and what you follow'],
    showPhoto: 'Show my account photo',
    showPhotoHint: 'Off: your page shows your initial instead of the picture.',
    allowContact: 'Let other users contact me',
    allowContactHint: 'Your email is never shown or shared either way.',
    create: 'Create my profile',
    save: 'Save changes',
    autosaveNote: 'Lists and unpublishing save on their own, without this button.',
    saving: 'Saving...',
    saved: 'Saved',
    pinned: 'Lists on my profile',
    pinnedHint: 'Publishing a list shows it on your profile. Here you choose which ones appear and which stay pinned on top.',
    noLists: 'You have not published any lists yet.',
    goToLists: 'Go to My lists',
    loadingLists: 'Looking for your published lists...',
    pin: 'Pin',
    unpin: 'Unpin from top',
    toc: 'On this page',
    tocLabel: 'Sections of the public profile editor',
    preview: 'Preview · your public page',
    previewHint: 'This is your page as anyone with the link sees it. It follows what you save here.',
    previewUrl: 'Public URL',
    previewPublicBadge: 'Public',
    previewPrivateBadge: 'Private',
    previewNoBio: 'No bio yet.',
    previewLists: 'Lists',
    previewNoLists: 'No lists on your profile yet.',
    previewPinned: 'pinned',
    previewPrivate: 'Private — only you can open this page.',
    section: (current, total) => `Section ${current} / ${total}`,
    onProfile: 'On my profile',
    offProfile: 'Not on my profile',
    showcaseFull: 'Your profile already shows the maximum number of lists.',
    migrating: 'Updating your pinned lists to the new model…',
    migrationFailed: 'Your pinned lists could not be updated to the new model. Nothing changed; it will retry on your next visit.',
    hiddenPinsTitle: 'You had hidden pinned lists',
    hiddenPinsBody: 'Lists no longer hide as a group: each published list now has its own "On my profile" switch. Do you want those lists shown on your profile?',
    hiddenPinsShow: 'Show them',
    hiddenPinsKeep: 'Keep them off',
    viewPublic: 'View public profile',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    handleTaken: 'That handle is already taken.',
    genericError: 'Something went wrong. Try again.',
    loading: 'Loading your profile...',
    loadError: 'Your profile could not be loaded.',
    loadSlow: 'Your profile is taking longer than usual.',
    loadOffline: 'There seems to be no connection.',
    loadSlowHint: 'Still trying — nothing has been changed.',
    loadErrorHint: 'Check your connection and try again — nothing has been changed.',
    retry: 'Try again',
    nameRequired: 'A display name is required.',
    pinLimit: `You can pin at most ${USER_PROFILE_LIMITS.pinnedShareIds} lists.`,
    sectionDanger: 'Unpublish',
    unpublishTitle: 'Unpublish my profile',
    unpublishBody: handle => `Deletes your public page and frees @${handle}. Published lists stay published but stop carrying your name. You can create a profile again whenever you want.`,
    unpublishAction: 'Unpublish profile',
    unpublishConfirm: handle => `Unpublish your public profile? Your page will stop existing and @${handle} becomes available to anyone.`,
    unpublished: 'Profile unpublished.',
  } : {
    back: 'Volver',
    backToProfile: 'Volver al perfil',
    eyebrowFromProfile: 'Perfil · Ajustes',
    title: 'Perfil público',
    createIntro: 'Elige un handle y tu perfil pasa a ser visible en su propio enlace público.',
    editIntro: 'Esta pantalla decide todo lo que muestra tu página pública.',
    sectionIdentity: 'Identidad pública',
    handle: 'Handle',
    handleHint: 'Minúsculas, números y guiones bajos.',
    displayName: 'Nombre visible',
    bio: 'Biografía',
    photoMirror: 'Tu foto de perfil es la de tu cuenta.',
    photoMirrorAction: 'Cámbiala en Ajustes',
    sectionPrivacy: 'Privacidad',
    privacyIntro: 'Lo que puede ver cualquiera con tu enlace público.',
    visibilityLabel: 'Perfil público',
    visibilityHintPublic: 'Cualquiera con el enlace puede abrir tu perfil.',
    visibilityHintPrivate: 'Solo tú puedes abrir tu perfil. Su página no existe para nadie más.',
    visibilityFailed: 'No se pudo guardar la visibilidad. Inténtalo de nuevo.',
    privateNotice: 'Tu perfil es privado: solo tú puedes abrirlo.',
    publicNow: 'Público en tu página',
    publicItems: ['Handle y nombre visible', 'Biografía', 'Foto de cuenta (solo si la activas abajo)', 'Listas publicadas que muestras en tu perfil'],
    neverPublic: 'Nunca es público',
    neverItems: ['Tu correo', 'Guardados y me gusta', 'Historial de lectura', 'Listas sin publicar', 'A quién y qué sigues'],
    showPhoto: 'Mostrar mi foto de cuenta',
    showPhotoHint: 'Apagado: tu página muestra tu inicial en lugar de la foto.',
    allowContact: 'Permitir que otros usuarios me contacten',
    allowContactHint: 'Tu correo no se muestra ni se comparte en ningún caso.',
    create: 'Crear mi perfil',
    save: 'Guardar cambios',
    autosaveNote: 'Las listas y despublicar se guardan al momento, sin este botón.',
    saving: 'Guardando...',
    saved: 'Guardado',
    pinned: 'Listas en mi perfil',
    pinnedHint: 'Publicar una lista la muestra en tu perfil. Aquí eliges cuáles aparecen y cuáles quedan destacadas arriba.',
    noLists: 'Todavía no has publicado ninguna lista.',
    goToLists: 'Ir a Mis listas',
    loadingLists: 'Buscando tus listas publicadas...',
    pin: 'Fijar',
    unpin: 'Desfijar',
    toc: 'En esta página',
    tocLabel: 'Secciones del editor del perfil público',
    preview: 'Vista previa · tu página pública',
    previewHint: 'Así ve tu página cualquiera con el enlace. Se actualiza con lo que guardes aquí.',
    previewUrl: 'URL pública',
    previewPublicBadge: 'Público',
    previewPrivateBadge: 'Privado',
    previewNoBio: 'Todavía sin biografía.',
    previewLists: 'Listas',
    previewNoLists: 'Todavía no muestras ninguna lista en tu perfil.',
    previewPinned: 'fijada',
    previewPrivate: 'Privado — solo tú puedes abrir esta página.',
    section: (current, total) => `Sección ${current} / ${total}`,
    onProfile: 'En mi perfil',
    offProfile: 'Fuera de mi perfil',
    showcaseFull: 'Tu perfil ya muestra el máximo de listas.',
    migrating: 'Actualizando tus listas fijadas al modelo nuevo…',
    migrationFailed: 'No se pudieron actualizar tus listas fijadas al modelo nuevo. No ha cambiado nada; se reintentará en tu próxima visita.',
    hiddenPinsTitle: 'Tenías listas fijadas ocultas',
    hiddenPinsBody: 'Las listas ya no se ocultan en bloque: cada lista publicada tiene ahora su propio interruptor "En mi perfil". ¿Quieres que esas listas se muestren en tu perfil?',
    hiddenPinsShow: 'Mostrarlas',
    hiddenPinsKeep: 'No mostrarlas',
    viewPublic: 'Ver perfil público',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    handleTaken: 'Ese handle ya está ocupado.',
    genericError: 'Algo ha ido mal. Inténtalo de nuevo.',
    loading: 'Cargando tu perfil...',
    loadError: 'No se ha podido cargar tu perfil.',
    loadSlow: 'Tu perfil está tardando más de lo normal.',
    loadOffline: 'Parece que no hay conexión.',
    loadSlowHint: 'Seguimos intentándolo — no se ha cambiado nada.',
    loadErrorHint: 'Revisa tu conexión y vuelve a intentarlo — no se ha cambiado nada.',
    retry: 'Reintentar',
    nameRequired: 'El nombre visible es obligatorio.',
    pinLimit: `Puedes fijar como mucho ${USER_PROFILE_LIMITS.pinnedShareIds} listas.`,
    sectionDanger: 'Despublicar',
    unpublishTitle: 'Despublicar mi perfil',
    unpublishBody: handle => `Borra tu página pública y libera @${handle}. Las listas publicadas siguen publicadas, pero dejan de llevar tu nombre. Puedes volver a crear el perfil cuando quieras.`,
    unpublishAction: 'Despublicar perfil',
    unpublishConfirm: handle => `¿Despublicar tu perfil público? Tu página dejará de existir y @${handle} quedará libre para cualquiera.`,
    unpublished: 'Perfil despublicado.',
  };

  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    // The retry loop outlives the promise; leaving must end it.
    const controller = new AbortController();
    const uid = user.uid;

    // Two independent reads, no longer joined by `Promise.all`: the form only
    // needs the profile, and pairing them made the whole screen wait on the
    // slower of the two. The profile read gets patience rather than a
    // guillotine: a slow answer is announced as slow, retried, and accepted
    // whenever it lands — "could not be loaded" is reserved for a read that
    // actually failed.
    const applyProfile = (ownProfile) => {
      rememberOwnProfile(uid, ownProfile);
      if (!active) return;
      setProfile(ownProfile);
      setDisplayName(ownProfile?.displayName || user.displayName || '');
      setBio(ownProfile?.bio || '');
      setAllowContact(ownProfile?.allowContact === true);
      // The toggle reflects reality: public photo = the field exists.
      setShowPhoto(ownProfile ? Boolean(ownProfile.photo) : true);
      setHandleDraft(ownProfile?.handle || '');
      setStatus(ownProfile ? 'ready' : 'new');
    };
    patientRead(() => readOwnUserProfile(), {
      attempts: 2,
      label: 'own profile',
      signal: controller.signal,
      onSlow: (attemptNumber, info) => {
        if (active && !seeded) setStatus(info?.offline ? 'offline' : 'slow');
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

  // Write-through for every edit this screen makes. There are a dozen places
  // that move `profile` — save, rename, visibility, pinning, unpublish — and
  // chasing each one would leave the shared view stale the day a thirteenth is
  // added; watching the value covers them all.
  useEffect(() => {
    if (!user?.uid || status === 'loading' || status === 'error') return;
    rememberOwnProfile(user.uid, profile);
  }, [profile, status, user?.uid]);

  // The tab keeps saying which screen this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    const ours = isEnglish ? 'Public profile | PaperTok' : 'Perfil público | PaperTok';
    document.title = ours;
    // Only restore if nothing claimed the title since (the outgoing route
    // stays mounted ~200ms into the next one under AnimatePresence).
    return () => { if (document.title === ours) document.title = previous; };
  }, [isEnglish]);

  /**
   * A write landed: say so, and bump the tick the preview highlights on.
   * Both happen here rather than in an effect watching `feedback`, which
   * would be a render cascade for something the write already knows.
   */
  const markSaved = useCallback((message) => {
    setFeedback({ state: 'saved', message });
    setSavedTick(tick => tick + 1);
  }, []);

  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleDraft && !handleCheck.valid
    ? HANDLE_ERROR_COPY[isEnglish ? 'en' : 'es'][handleCheck.code]
    : '';
  // A profile still being created has only the two sections it can fill; the
  // pinned lists and the unpublish block arrive with the profile itself.
  const sectionTotal = status === 'ready' ? 4 : 2;
  const editorSections = useMemo(() => {
    const identity = { id: 'profile-identity', label: copy.sectionIdentity };
    const privacy = { id: 'profile-privacy', label: copy.sectionPrivacy };
    if (status !== 'ready') return [identity, privacy];
    return [
      identity,
      privacy,
      { id: 'profile-pinned', label: copy.pinned },
      { id: 'profile-danger', label: copy.sectionDanger },
    ];
  }, [copy.pinned, copy.sectionDanger, copy.sectionIdentity, copy.sectionPrivacy, status]);
  const editorSectionIds = useMemo(
    () => editorSections.map(section => section.id),
    [editorSections],
  );
  const activeSection = useSectionSpy(editorSectionIds);
  const jumpToSection = useCallback((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    node.focus({ preventScroll: true });
  }, []);
  const pinnedShareIds = profile?.pinnedShareIds || [];
  /** What the public page will actually show, pinned lists first. */
  const previewLists = useMemo(() => {
    if (!pinnableLists) return null;
    const attributed = pinnableLists.filter(list => list.onProfile === true);
    const pinned = profile?.pinnedShareIds || [];
    return [...attributed].sort(
      (left, right) => Number(pinned.includes(right.shareId)) - Number(pinned.includes(left.shareId)),
    );
  }, [pinnableLists, profile?.pinnedShareIds]);
  const publicPath = profile ? getPublicProfilePath(profile.handle) : null;
  const isPublicProfile = profileIsPublic(profile);
  const caveats = visibilityCopy(isEnglish);
  // Asked here as well as on the profile page: both screens have already read
  // the profile, so the question costs nothing extra on either.
  const askVisibility = status === 'ready' && needsVisibilityChoice(profile) && !promptDismissed;
  // Whatever the rest of the app shows, bounded to what the public document
  // may carry. Saving the profile is what mirrors it across.
  const appAvatar = useMemo(
    () => publicAvatarFrom(profilePhoto, user?.photoURL),
    [profilePhoto, user?.photoURL],
  );

  // The editor is reachable from the profile page and from Settings; going
  // "back" means the one the visitor actually came from. The fallback covers
  // a direct URL load, where there is no in-app history to return to.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/profile');
  };
  // Which door was used. The profile's gear and "Edit profile" say so and the
  // heading answers in the profile's voice; the hub says nothing and keeps
  // the hub's. A direct load has no history and returns to the profile, so
  // its back control borrows the profile's label too.
  const fromProfile = cameFromProfile(location);
  const returnsToProfile = fromProfile || location.key === 'default';

  const reportError = useCallback((error) => {
    console.error('Profile write failed:', error);
    setFeedback({
      state: 'error',
      message: error instanceof HandleUnavailableError ? copy.handleTaken : copy.genericError,
    });
  }, [copy.genericError, copy.handleTaken]);

  const onSubmit = async (event) => {
    event.preventDefault();
    if (saving || deleting) return;
    if (!displayName.trim()) {
      setFeedback({ state: 'error', message: copy.nameRequired });
      return;
    }
    if (!handleCheck.valid) {
      setFeedback({ state: 'error', message: handleError || copy.genericError });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const payload = {
        displayName,
        bio,
        allowContact,
        photo: showPhoto ? appAvatar : '',
        // A stale pin — its list unpublished or republished — makes the rules
        // refuse the whole write, so carrying it along turns "Save changes"
        // into a permission error with no visible cause. Once the pin picker
        // has answered, the stale entries are dropped here exactly as the
        // banner offers; before it answers, the save keeps what it has rather
        // than guess every pin stale.
        pinnedLists: pinnableLists === null
          ? profile?.pinnedLists
          : partitionStalePins(profile?.pinnedLists, pinnableLists).pinned,
      };
      if (!profile) {
        const created = await createUserProfile({
          ...payload,
          handle: handleCheck.handle,
          visibility: visibilityDraft,
        });
        setProfile({ ...created, pinnedLists: created.pinnedLists || [] });
        setStatus('ready');
      } else {
        if (handleCheck.handle !== profile.handle) {
          await changeUserHandle(handleCheck.handle, profile.handle);
          // The public profile page files entries under the handle too, so the
          // name just given up must not keep serving this profile.
          forgetOwnProfile(null, profile.handle);
        }
        const updated = await updateUserProfile(payload);
        // Sanitization drops an empty photo from the update payload, which
        // leaves an already-stored one in place — removing it is an explicit
        // field delete.
        if (!showPhoto && profile.photo) {
          await savePublicProfilePhoto(null);
        }
        setProfile(current => ({
          ...current,
          ...updated,
          handle: handleCheck.handle,
          ...(showPhoto ? {} : { photo: undefined }),
        }));
      }
      markSaved(copy.saved);
    } catch (error) {
      reportError(error);
      // The handle may or may not have changed; re-read rather than guess.
      readOwnUserProfile().then(fresh => {
        if (!fresh) return;
        setProfile(fresh);
        setHandleDraft(fresh.handle);
      }).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  /**
   * The two privacy switches. Each writes immediately rather than waiting for
   * "Save changes": a privacy control that needs a second confirmation is a
   * control people believe they have already used.
   */
  const toggleVisibility = async (makePublic) => {
    if (!profile || visibilityBusy) return;
    const next = makePublic ? PROFILE_VISIBILITY.public : PROFILE_VISIBILITY.private;
    const previous = profile.visibility;
    setVisibilityBusy(true);
    setFeedback(null);
    setProfile(current => ({ ...current, visibility: next }));
    try {
      await saveProfileVisibility(next);
      markSaved(copy.saved);
    } catch (error) {
      setProfile(current => ({ ...current, visibility: previous }));
      console.error('Error saving profile visibility:', error);
      setFeedback({ state: 'error', message: copy.visibilityFailed });
    } finally {
      setVisibilityBusy(false);
    }
  };

  /** Applies a finished migration's result to the screen's state. */
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
  useEffect(() => {
    if (status !== 'ready' || !profile || migrationStarted.current) return undefined;
    if (!needsLegacyPinMigration(profile) || profile.showPinnedLists === false) return undefined;
    migrationStarted.current = true;
    let active = true;
    Promise.resolve()
      .then(() => {
        if (active) setMigration('running');
        return migrateLegacyPins({ attribute: attributePublicList });
      })
      .then(result => {
        if (!active) return;
        applyMigrationResult(result);
        setMigration('done');
      })
      .catch(error => {
        console.error('The pin migration failed; the legacy pins stay for a retry:', error);
        if (active) setMigration('failed');
      });
    return () => { active = false; };
    // `applyMigrationResult` only wraps state setters; listing it would re-run
    // this on every render for nothing — the ref guard makes reruns no-ops
    // anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, profile]);

  /** The hidden-pins banner's answer. */
  const resolveHiddenPins = async (showOnProfile) => {
    if (migration === 'running') return;
    setMigration('running');
    setFeedback(null);
    try {
      const result = await migrateHiddenPins({
        attribute: attributePublicList, showOnProfile,
      });
      applyMigrationResult(result);
      setMigration('done');
      markSaved(copy.saved);
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
    setFeedback(null);
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
      markSaved(copy.saved);
    } catch (error) {
      if (error?.code === 'PROFILE_LISTS_FULL') {
        setFeedback({ state: 'error', message: copy.showcaseFull });
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
      setFeedback({ state: 'error', message: copy.pinLimit });
      return;
    }
    const next = isPinned
      ? previous.filter(id => id !== shareId)
      : [...previous, shareId];
    setPinsBusy(true);
    setFeedback(null);
    setProfile(current => ({ ...current, pinnedShareIds: next }));
    try {
      await savePinnedShareIds(next);
      // After the save lands: a pin that rolls back must not pop as if it had.
      setSettling({ shareId, kind: 'pin' });
    } catch (error) {
      setProfile(current => ({ ...current, pinnedShareIds: previous }));
      reportError(error);
    } finally {
      setPinsBusy(false);
    }
  };

  const unpublishProfile = async () => {
    if (!profile || saving || deleting) return;
    // Same convention as unpublishing a list: environments without confirm()
    // proceed, an explicit cancel stops.
    const confirmed = globalThis.confirm?.(copy.unpublishConfirm(profile.handle));
    if (confirmed === false) return;
    setDeleting(true);
    setFeedback(null);
    try {
      const unpublishedHandle = profile?.handle;
      await deleteOwnUserProfile();
      forgetOwnProfile(user.uid, unpublishedHandle);
      clearStoredProfile(user.uid);
      setProfile(null);
      setStatus('new');
      setReborn(true);
      setShowPhoto(true);
      // Creating a profile again is creating a profile: the choice is asked
      // from scratch rather than inherited from the one just deleted.
      setVisibilityDraft(null);
      setFeedback({ state: 'saved', message: copy.unpublished });
    } catch (error) {
      reportError(error);
    } finally {
      setDeleting(false);
    }
  };

  if (!user) return null;
  if (status === 'loading') {
    return (
      <main className="profile-page">
        <div className="profile-shell">
          <p className="profile-loading"><Loader2 size={18} className="profile-spin" /> {copy.loading}</p>
        </div>
      </main>
    );
  }
  // Before this existed, a failed load fell through to the form below with
  // every `status === 'ready'` branch switched off: a half-built editor for a
  // profile that had not been read.
  if (status === 'error' || status === 'slow' || status === 'offline') {
    // 'slow' and 'offline' are waits with a read still running behind them;
    // only 'error' is the screen giving up. The Try again is offered in all
    // three, because pressing it is never wrong.
    const waiting = status !== 'error';
    return (
      <main className="profile-page">
        <div className="profile-shell">
          <div className="profile-load-error" role="alert" aria-busy={waiting}>
            <h1>{status === 'offline' ? copy.loadOffline : status === 'slow' ? copy.loadSlow : copy.loadError}</h1>
            <p>{waiting ? copy.loadSlowHint : copy.loadErrorHint}</p>
            <button
              type="button"
              className="profile-empty-action"
              onClick={() => {
                setStatus('loading');
                setReloadToken(token => token + 1);
              }}
            >
              {copy.retry}
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="profile-page">
      <div className="profile-shell">
        {/* One grid for the whole screen. The heading is its first row, so
            the back control lines up with the index rail and the title with
            the form; the preview spans both rows and rises to meet it. */}
        <div className="profile-layout">
          <SettingsSubheader
            eyebrow={fromProfile ? copy.eyebrowFromProfile : SETTINGS_BREADCRUMB[isEnglish ? 'en' : 'es']}
            title={copy.title}
            subtitle={status === 'new' ? copy.createIntro : copy.editIntro}
            backLabel={returnsToProfile ? copy.backToProfile : copy.back}
            onBack={goBack}
          />

          <nav className="profile-toc" aria-label={copy.tocLabel}>
            <span className="profile-toc-title">{copy.toc}</span>
            <div
              className="profile-toc-list"
              style={{ '--profile-toc-active': Math.max(0, editorSections.findIndex(section => section.id === activeSection)) }}
            >
              <span className="profile-toc-marker" aria-hidden="true" />
              {editorSections.map((section, position) => {
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
                    {section.label}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="profile-main">
            {/* The one decision the F12 migration cannot take alone: pins the
                owner had explicitly hidden. Everything else migrates silently. */}
            {hiddenPinsPrompt && (
              <div className="profile-stale" role="alert">
                <div>
                  <strong>{copy.hiddenPinsTitle}</strong>
                  <p>{copy.hiddenPinsBody}</p>
                </div>
                <div className="profile-stale-actions">
                  <button type="button" className="profile-secondary" onClick={() => resolveHiddenPins(true)}>
                    {copy.hiddenPinsShow}
                  </button>
                  <button type="button" className="profile-secondary" onClick={() => resolveHiddenPins(false)}>
                    {copy.hiddenPinsKeep}
                  </button>
                </div>
              </div>
            )}
            {migration === 'failed' && (
              <p className="profile-hint" role="alert">{copy.migrationFailed}</p>
            )}

            <form
              key={reborn ? 'form-reborn' : 'form'}
              className={`profile-form${reborn ? ' is-reborn' : ''}`}
              onSubmit={onSubmit}
            >
              <section
                id="profile-identity"
                tabIndex={-1}
                className="profile-section"
                aria-labelledby="profile-identity-title"
              >
                <div className="profile-section-head">
                  <span className="profile-section-index">{copy.section(1, sectionTotal)}</span>
                  <h2 id="profile-identity-title">{copy.sectionIdentity}</h2>
                </div>

                <div className="profile-identity">
                  <div className="profile-identity-avatar">
                    {showPhoto && appAvatar
                      ? (
                        <img
                          src={appAvatar}
                          alt=""
                          referrerPolicy="no-referrer"
                          // The page's own masthead avatar, visible on load --
                          // not lazy. `.profile-identity-avatar img` renders at
                          // 56x56.
                          decoding="async"
                          width="56"
                          height="56"
                        />
                      )
                      : (
                        <span aria-hidden="true">
                          {(displayName || user.email || '?').trim().charAt(0).toUpperCase()}
                        </span>
                      )}
                  </div>
                  <p className="profile-identity-hint">
                    {copy.photoMirror}{' '}
                    <Link className="profile-inline-link" to="/settings">
                      {copy.photoMirrorAction}
                    </Link>
                  </p>
                </div>

                <div className="profile-identity-fields">
                  <div className="profile-field">
                    <label htmlFor="profile-handle">{copy.handle}</label>
                    <div className="profile-handle-input">
                      <span aria-hidden="true">@</span>
                      <input
                        id="profile-handle"
                        value={handleDraft}
                        onChange={event => setHandleDraft(event.target.value.toLowerCase())}
                        maxLength={HANDLE_MAX_LENGTH}
                        autoComplete="off"
                        spellCheck="false"
                        aria-invalid={handleError ? 'true' : undefined}
                        aria-describedby="profile-handle-hint"
                      />
                    </div>
                    <p id="profile-handle-hint" className={`profile-hint${handleError ? ' is-error' : ''}`} aria-live="polite">
                      {handleError || copy.handleHint}
                    </p>
                  </div>

                  <div className="profile-field">
                    <label htmlFor="profile-name">{copy.displayName}</label>
                    <input
                      id="profile-name"
                      value={displayName}
                      onChange={event => setDisplayName(event.target.value)}
                      maxLength={USER_PROFILE_LIMITS.displayName}
                      autoComplete="name"
                    />
                  </div>
                </div>

                <div className="profile-field">
                  <div className="profile-field-head">
                    <label htmlFor="profile-bio">{copy.bio}</label>
                    <span id="profile-bio-count" className="profile-char-count">
                      {bio.length} / {USER_PROFILE_LIMITS.bio}
                    </span>
                  </div>
                  <textarea
                    id="profile-bio"
                    value={bio}
                    rows={4}
                    onChange={event => setBio(event.target.value)}
                    maxLength={USER_PROFILE_LIMITS.bio}
                    aria-describedby="profile-bio-count"
                  />
                </div>
              </section>

              <section
                id="profile-privacy"
                tabIndex={-1}
                className="profile-section"
                aria-labelledby="profile-privacy-title"
              >
                <div className="profile-section-head">
                  <span className="profile-section-index">{copy.section(2, sectionTotal)}</span>
                  <h2 id="profile-privacy-title">{copy.sectionPrivacy}</h2>
                </div>
                <p className="profile-hint">{copy.privacyIntro}</p>

                {/* Creating the profile: the choice itself, with nothing
                    preselected. The submit button below stays disabled until it
                    has an answer. */}
                {status === 'new' && (
                  <VisibilityChoice
                    value={visibilityDraft}
                    onChange={setVisibilityDraft}
                    isEnglish={isEnglish}
                    idPrefix="profile-create"
                  />
                )}

                {/* Editing an existing profile: the same decision as a switch,
                    saved on the spot. */}
                {status === 'ready' && (
                  <>
                    <label className="profile-switch">
                      <span className="profile-switch-copy">
                        <span className="profile-switch-label">{copy.visibilityLabel}</span>
                        <span className="profile-switch-hint">
                          {isPublicProfile ? copy.visibilityHintPublic : copy.visibilityHintPrivate}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={isPublicProfile}
                        disabled={visibilityBusy}
                        onChange={event => toggleVisibility(event.target.checked)}
                      />
                      <span className="profile-switch-track" aria-hidden="true">
                        <span className="profile-switch-thumb" />
                      </span>
                    </label>

                    {/* The limits of the promise, on the screen that makes it. */}
                    <div className="visibility-caveats">
                      <p className="visibility-caveats-title">{caveats.notProtectedTitle}</p>
                      <ul>
                        {caveats.notProtected.map(item => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  </>
                )}

                <div className="profile-privacy-summary">
                  <div className="profile-privacy-column">
                    <h3>{copy.publicNow}</h3>
                    <ul>
                      {copy.publicItems.map(item => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                  <div className="profile-privacy-column is-private">
                    <h3><ShieldCheck size={14} aria-hidden="true" /> {copy.neverPublic}</h3>
                    <ul>
                      {copy.neverItems.map(item => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                </div>

                <label className="profile-switch">
                  <span className="profile-switch-copy">
                    <span className="profile-switch-label">{copy.showPhoto}</span>
                    <span className="profile-switch-hint">{copy.showPhotoHint}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={showPhoto}
                    onChange={event => setShowPhoto(event.target.checked)}
                  />
                  <span className="profile-switch-track" aria-hidden="true">
                    <span className="profile-switch-thumb" />
                  </span>
                </label>

                <label className="profile-switch">
                  <span className="profile-switch-copy">
                    <span className="profile-switch-label">{copy.allowContact}</span>
                    <span className="profile-switch-hint">{copy.allowContactHint}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={allowContact}
                    onChange={event => setAllowContact(event.target.checked)}
                  />
                  <span className="profile-switch-track" aria-hidden="true">
                    <span className="profile-switch-thumb" />
                  </span>
                </label>
              </section>

              {/* The form ends here and says so: the two sections below save
                  on their own, so without the rule and the note the page read
                  as if it stopped at Privacy. */}
              <div className="profile-form-foot">
                <div className="profile-actions">
                  <button
                    type="submit"
                    className="profile-primary"
                    disabled={saving || deleting || !handleCheck.valid
                      || (status === 'new' && !visibilityDraft)}
                  >
                    {saving ? copy.saving : (status === 'new' ? copy.create : copy.save)}
                  </button>
                  {feedback && (
                    <span className={`profile-feedback is-${feedback.state}`} role="status">
                      {feedback.state === 'saved' && <Check size={16} />} {feedback.message}
                    </span>
                  )}
                </div>
                {status === 'ready' && (
                  <p className="profile-actions-note">{copy.autosaveNote}</p>
                )}
              </div>
            </form>

            {status === 'ready' && (
              <section
                id="profile-pinned"
                tabIndex={-1}
                className="profile-section profile-pinned"
                aria-labelledby="profile-pinned-title"
              >
                <div className="profile-section-head">
                  <span className="profile-section-index">{copy.section(3, sectionTotal)}</span>
                  <h2 id="profile-pinned-title">{copy.pinned}</h2>
                </div>
                <p className="profile-hint">{copy.pinnedHint}</p>
                {pinnableLists === null ? (
                  // Not asked yet. Saying "you have published none" here would be
                  // a guess, and the answer is usually a few hundred milliseconds
                  // away, so the section simply holds its place.
                  <p className="profile-empty" aria-busy="true">{copy.loadingLists}</p>
                ) : pinnableLists.length === 0 ? (
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
                    {migration === 'running' && (
                      <p className="profile-hint" aria-busy="true">{copy.migrating}</p>
                    )}
                    <ul className="profile-pin-list">
                      {pinnableLists.map(list => {
                        const attributed = list.onProfile === true;
                        const isPinned = attributed && pinnedShareIds.includes(list.shareId);
                        const pinsFull = !isPinned
                          && pinnedShareIds.length >= USER_PROFILE_LIMITS.pinnedShareIds;
                        // `emoji` holds a lucide icon name, not a literal emoji.
                        const Icon = getIcon(list.emoji);
                        const settlingHere = settling?.shareId === list.shareId ? settling.kind : null;
                        return (
                          <li
                            key={list.shareId}
                            className={settlingHere ? 'is-flashing' : undefined}
                            onAnimationEnd={settleDone}
                          >
                            <span className="profile-pin-emoji" aria-hidden="true"><Icon size={20} /></span>
                            <span className="profile-pin-copy">
                              <span className="profile-pin-title">{list.title}</span>
                              <span className="profile-pin-count">{copy.papers(list.paperCount)}</span>
                            </span>
                            <span className="profile-pin-actions">
                              <button
                                type="button"
                                className={`profile-pin-toggle${attributed ? ' is-pinned' : ''}${settlingHere === 'attribution' ? ' is-settling' : ''}`}
                                onClick={() => toggleAttribution(list)}
                                disabled={pinsBusy || migration === 'running'}
                                aria-pressed={attributed}
                              >
                                {attributed ? <Globe2 size={16} /> : <Lock size={16} />}
                                {attributed ? copy.onProfile : copy.offProfile}
                              </button>
                              {attributed && (
                                <button
                                  type="button"
                                  className={`profile-pin-toggle${isPinned ? ' is-pinned' : ''}${settlingHere === 'pin' ? ' is-settling' : ''}`}
                                  onClick={() => togglePin(list.shareId)}
                                  disabled={pinsBusy || migration === 'running' || pinsFull}
                                  aria-pressed={isPinned}
                                >
                                  {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
                                  {isPinned ? copy.unpin : copy.pin}
                                </button>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
            )}

            {status === 'ready' && profile && (
              <section
                id="profile-danger"
                tabIndex={-1}
                className="profile-section profile-danger"
                aria-labelledby="profile-danger-title"
              >
                <div className="profile-section-head">
                  <span className="profile-section-index">{copy.section(4, sectionTotal)}</span>
                  <h2 id="profile-danger-title">{copy.sectionDanger}</h2>
                </div>
                <div className="profile-danger-row">
                  <div>
                    <strong>{copy.unpublishTitle}</strong>
                    <p>{copy.unpublishBody(profile.handle)}</p>
                  </div>
                  <button
                    type="button"
                    className="profile-danger-button"
                    onClick={unpublishProfile}
                    disabled={saving || deleting}
                  >
                    {deleting ? copy.saving : copy.unpublishAction}
                  </button>
                </div>
              </section>
            )}
          </div>

          {/* The page being edited, as its link shows it. Rendered from the
              same state the form writes, so it moves as they type — and the
              parts a save just committed light up. */}
          <aside className="profile-preview" aria-label={copy.preview}>
            <span className="profile-preview-label">{copy.preview}</span>
            <div className="profile-preview-card">
              <div className="profile-preview-chrome">
                <span className="profile-preview-url-label">{copy.previewUrl}</span>
                <span className="profile-preview-url">
                  {publicPath || `/public/user/${handleCheck.valid ? handleCheck.handle : (handleDraft || '…')}`}
                </span>
                <span className={`profile-preview-badge${status === 'ready' && !isPublicProfile ? ' is-private' : ''}`}>
                  {status === 'ready' && !isPublicProfile
                    ? <><Lock size={11} aria-hidden="true" /> {copy.previewPrivateBadge}</>
                    : <><Globe2 size={11} aria-hidden="true" /> {copy.previewPublicBadge}</>}
                </span>
              </div>
              <div className="profile-preview-body">
              <div className="profile-preview-identity">
                <div className="profile-preview-avatar">
                  {showPhoto && appAvatar
                    ? <img src={appAvatar} alt="" referrerPolicy="no-referrer" />
                    : <span>{(displayName || user.email || '?').trim().charAt(0).toUpperCase()}</span>}
                </div>
                <div className="profile-preview-name">
                  <strong
                    key={`name-${savedTick}`}
                    className={savedTick > 0 ? 'is-flashing' : undefined}
                  >
                    {displayName || '—'}
                  </strong>
                  <span
                    key={`handle-${savedTick}`}
                    className={savedTick > 0 ? 'is-flashing' : undefined}
                  >
                    @{handleCheck.valid ? handleCheck.handle : (handleDraft || '…')}
                  </span>
                </div>
              </div>

              <p
                key={`bio-${savedTick}`}
                className={`profile-preview-bio${bio ? '' : ' is-empty'}${savedTick > 0 ? ' is-flashing' : ''}`}
              >
                {bio || copy.previewNoBio}
              </p>

              {status === 'ready' && !isPublicProfile && (
                <p className="profile-preview-private">
                  <Lock size={12} aria-hidden="true" /> {copy.previewPrivate}
                </p>
              )}

              {/* `null` is "not read yet": saying the profile shows no lists
                  before the answer arrives would be a guess. */}
              {previewLists !== null && (
                <div className="profile-preview-lists">
                  <span className="profile-preview-lists-label">{copy.previewLists}</span>
                  {previewLists.length === 0 ? (
                    <p className="profile-preview-empty">{copy.previewNoLists}</p>
                  ) : previewLists.map(list => {
                    const Icon = getIcon(list.emoji);
                    const isPinned = pinnedShareIds.includes(list.shareId);
                    return (
                      <div className={`profile-preview-list${isPinned ? ' is-pinned' : ''}`} key={list.shareId}>
                        <Icon size={16} aria-hidden="true" />
                        <span>
                          <strong>{list.title}</strong>
                          <small>
                            {copy.papers(list.paperCount)}
                            {isPinned ? ` · ${copy.previewPinned}` : ''}
                          </small>
                        </span>
                        {isPinned && <Pin size={12} aria-hidden="true" />}
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
              {/* The way to the page itself, at the foot of its likeness. It
                  used to be a pill under the title, saying what the URL row
                  above already says. */}
              {publicPath && (
                <Link className="profile-preview-open" to={publicPath}>
                  <span>{copy.viewPublic}</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </Link>
              )}
            </div>
            <p className="profile-preview-hint">{copy.previewHint}</p>
          </aside>
        </div>
      </div>

      <AnimatePresence>
        {askVisibility && (
          <VisibilityPrompt
            isEnglish={isEnglish}
            onResolved={visibility => setProfile(current => ({ ...current, visibility }))}
            onDismiss={() => setPromptDismissed(true)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
