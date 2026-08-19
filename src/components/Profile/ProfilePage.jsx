import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, ExternalLink, Loader2, Pin, PinOff, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import {
  HandleUnavailableError,
  USER_PROFILE_LIMITS,
  changeUserHandle,
  createUserProfile,
  deleteOwnUserProfile,
  partitionStalePins,
  pinListEntry,
  publicAvatarFrom,
  readOwnUserProfile,
  readPinnableLists,
  savePinnedLists,
  savePublicProfilePhoto,
  unpinListEntry,
  updateUserProfile,
} from '../../services/userProfileService.js';
import { getIcon } from '../../utils/icons.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { HANDLE_ERRORS, HANDLE_MAX_LENGTH, inspectHandle } from '../../utils/userHandle.js';
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

  const [profile, setProfile] = useState(null);
  const [pinnableLists, setPinnableLists] = useState([]);
  const [status, setStatus] = useState('loading');
  const [handleDraft, setHandleDraft] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [allowContact, setAllowContact] = useState(false);
  const [showPhoto, setShowPhoto] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const copy = isEnglish ? {
    back: 'Back',
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
    publicNow: 'Public on your page',
    publicItems: ['Handle and display name', 'Bio', 'Account photo (only if enabled below)', 'Pinned lists'],
    neverPublic: 'Never public',
    neverItems: ['Email address', 'Saved papers and likes', 'Reading history', 'Unpublished lists', 'Who and what you follow'],
    showPhoto: 'Show my account photo',
    showPhotoHint: 'Off: your page shows your initial instead of the picture.',
    allowContact: 'Let other users contact me',
    allowContactHint: 'Your email is never shown or shared either way.',
    create: 'Create my profile',
    save: 'Save changes',
    saving: 'Saving...',
    saved: 'Saved',
    pinned: 'Lists on my profile',
    pinnedHint: 'Only lists you have already published can be pinned. Pinning is what puts your name on a list.',
    noLists: 'You have not published any lists yet.',
    pin: 'Pin',
    unpin: 'Unpin',
    viewPublic: 'View public profile',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    handleTaken: 'That handle is already taken.',
    genericError: 'Something went wrong. Try again.',
    loading: 'Loading your profile...',
    nameRequired: 'A display name is required.',
    pinLimit: `You can pin at most ${USER_PROFILE_LIMITS.pinnedLists} lists.`,
    staleTitle: 'Some pinned lists are no longer published',
    staleBody: 'They cannot stay on your profile. Remove them to save any other change.',
    staleAction: 'Remove them',
    sectionDanger: 'Unpublish',
    unpublishTitle: 'Unpublish my profile',
    unpublishBody: handle => `Deletes your public page and frees @${handle}. Published lists stay published but stop carrying your name. You can create a profile again whenever you want.`,
    unpublishAction: 'Unpublish profile',
    unpublishConfirm: handle => `Unpublish your public profile? Your page will stop existing and @${handle} becomes available to anyone.`,
    unpublished: 'Profile unpublished.',
  } : {
    back: 'Volver',
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
    publicNow: 'Público en tu página',
    publicItems: ['Handle y nombre visible', 'Biografía', 'Foto de cuenta (solo si la activas abajo)', 'Listas fijadas'],
    neverPublic: 'Nunca es público',
    neverItems: ['Tu correo', 'Guardados y me gusta', 'Historial de lectura', 'Listas sin publicar', 'A quién y qué sigues'],
    showPhoto: 'Mostrar mi foto de cuenta',
    showPhotoHint: 'Apagado: tu página muestra tu inicial en lugar de la foto.',
    allowContact: 'Permitir que otros usuarios me contacten',
    allowContactHint: 'Tu correo no se muestra ni se comparte en ningún caso.',
    create: 'Crear mi perfil',
    save: 'Guardar cambios',
    saving: 'Guardando...',
    saved: 'Guardado',
    pinned: 'Listas en mi perfil',
    pinnedHint: 'Solo puedes fijar listas que ya hayas publicado. Fijar una lista es lo que le pone tu nombre.',
    noLists: 'Todavía no has publicado ninguna lista.',
    pin: 'Fijar',
    unpin: 'Quitar',
    viewPublic: 'Ver perfil público',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    handleTaken: 'Ese handle ya está ocupado.',
    genericError: 'Algo ha ido mal. Inténtalo de nuevo.',
    loading: 'Cargando tu perfil...',
    nameRequired: 'El nombre visible es obligatorio.',
    pinLimit: `Puedes fijar como mucho ${USER_PROFILE_LIMITS.pinnedLists} listas.`,
    staleTitle: 'Algunas listas fijadas ya no están publicadas',
    staleBody: 'No pueden seguir en tu perfil. Quítalas para poder guardar cualquier otro cambio.',
    staleAction: 'Quitarlas',
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
    Promise.all([readOwnUserProfile(), readPinnableLists()])
      .then(([ownProfile, lists]) => {
        if (!active) return;
        setProfile(ownProfile);
        setPinnableLists(lists);
        setDisplayName(ownProfile?.displayName || user.displayName || '');
        setBio(ownProfile?.bio || '');
        setAllowContact(ownProfile?.allowContact === true);
        // The toggle reflects reality: public photo = the field exists.
        setShowPhoto(ownProfile ? Boolean(ownProfile.photo) : true);
        setHandleDraft(ownProfile?.handle || '');
        setStatus(ownProfile ? 'ready' : 'new');
      })
      .catch(error => {
        console.error('Error loading own profile:', error);
        if (active) setStatus('error');
      });
    return () => { active = false; };
  }, [user]);

  // The tab keeps saying which screen this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    document.title = isEnglish ? 'Public profile | PaperTok' : 'Perfil público | PaperTok';
    return () => { document.title = previous; };
  }, [isEnglish]);

  const handleCheck = useMemo(() => inspectHandle(handleDraft), [handleDraft]);
  const handleError = handleDraft && !handleCheck.valid
    ? HANDLE_ERROR_COPY[isEnglish ? 'en' : 'es'][handleCheck.code]
    : '';
  const pinnedIds = useMemo(
    () => new Set((profile?.pinnedLists || []).map(list => list.shareId)),
    [profile],
  );
  // `pinnableLists` is exactly the set of still-published lists, so the stale
  // pins fall out of it without another read.
  const stalePins = useMemo(
    () => partitionStalePins(profile?.pinnedLists, pinnableLists).stale,
    [pinnableLists, profile],
  );
  const publicPath = profile ? getPublicProfilePath(profile.handle) : null;
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
        pinnedLists: profile?.pinnedLists,
      };
      if (!profile) {
        const created = await createUserProfile({ ...payload, handle: handleCheck.handle });
        setProfile({ ...created, pinnedLists: created.pinnedLists || [] });
        setStatus('ready');
      } else {
        if (handleCheck.handle !== profile.handle) {
          await changeUserHandle(handleCheck.handle, profile.handle);
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
      setFeedback({ state: 'saved', message: copy.saved });
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

  const dropStalePins = async () => {
    if (!profile || saving) return;
    setSaving(true);
    setFeedback(null);
    const previous = profile.pinnedLists || [];
    try {
      const next = partitionStalePins(previous, pinnableLists).pinned;
      setProfile(current => ({ ...current, pinnedLists: next }));
      await savePinnedLists(next);
      setFeedback({ state: 'saved', message: copy.saved });
    } catch (error) {
      setProfile(current => ({ ...current, pinnedLists: previous }));
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (list) => {
    if (!profile || saving) return;
    setSaving(true);
    setFeedback(null);
    const previous = profile.pinnedLists || [];
    try {
      const next = pinnedIds.has(list.shareId)
        ? unpinListEntry(previous, list.shareId)
        : pinListEntry(previous, list);
      setProfile(current => ({ ...current, pinnedLists: next }));
      await savePinnedLists(next);
    } catch (error) {
      setProfile(current => ({ ...current, pinnedLists: previous }));
      if (error instanceof RangeError) {
        setFeedback({ state: 'error', message: copy.pinLimit });
      } else {
        reportError(error);
      }
    } finally {
      setSaving(false);
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
      await deleteOwnUserProfile();
      setProfile(null);
      setStatus('new');
      setShowPhoto(true);
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

  return (
    <main className="profile-page">
      <div className="profile-shell">
        <header className="profile-heading">
          <button type="button" className="profile-back" onClick={goBack}>
            <ArrowLeft size={18} /> {copy.back}
          </button>
          <h1>{copy.title}</h1>
          <p className="profile-intro">{status === 'new' ? copy.createIntro : copy.editIntro}</p>
          {publicPath && (
            <Link className="profile-public-link" to={publicPath}>
              {copy.viewPublic} <ExternalLink size={14} />
            </Link>
          )}
        </header>

        {stalePins.length > 0 && (
          <div className="profile-stale" role="alert">
            <div>
              <strong>{copy.staleTitle}</strong>
              <p>{copy.staleBody}</p>
              <ul>
                {stalePins.map(pin => <li key={pin.shareId}>{pin.title}</li>)}
              </ul>
            </div>
            <button type="button" className="profile-secondary" onClick={dropStalePins} disabled={saving}>
              {copy.staleAction}
            </button>
          </div>
        )}

        <form className="profile-form" onSubmit={onSubmit}>
          <section className="profile-section" aria-labelledby="profile-identity-title">
            <h2 id="profile-identity-title">{copy.sectionIdentity}</h2>

            <div className="profile-identity">
              <div className="profile-identity-avatar">
                {showPhoto && appAvatar
                  ? <img src={appAvatar} alt="" referrerPolicy="no-referrer" />
                  : <span>{(displayName || user.email || '?').trim().charAt(0).toUpperCase()}</span>}
              </div>
              <p className="profile-identity-hint">
                {copy.photoMirror}{' '}
                <button type="button" className="profile-inline-link" onClick={() => navigate('/settings')}>
                  {copy.photoMirrorAction}
                </button>
              </p>
            </div>

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
                  aria-describedby="profile-handle-hint"
                />
              </div>
              <p id="profile-handle-hint" className={`profile-hint${handleError ? ' is-error' : ''}`}>
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
              />
            </div>

            <div className="profile-field">
              <label htmlFor="profile-bio">{copy.bio}</label>
              <textarea
                id="profile-bio"
                value={bio}
                rows={4}
                onChange={event => setBio(event.target.value)}
                maxLength={USER_PROFILE_LIMITS.bio}
              />
              <p className="profile-hint">{bio.length} / {USER_PROFILE_LIMITS.bio}</p>
            </div>
          </section>

          <section className="profile-section" aria-labelledby="profile-privacy-title">
            <h2 id="profile-privacy-title">{copy.sectionPrivacy}</h2>
            <p className="profile-hint">{copy.privacyIntro}</p>

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

          <div className="profile-actions">
            <button type="submit" className="profile-primary" disabled={saving || deleting || !handleCheck.valid}>
              {saving ? copy.saving : (status === 'new' ? copy.create : copy.save)}
            </button>
            {feedback && (
              <span className={`profile-feedback is-${feedback.state}`} role="status">
                {feedback.state === 'saved' && <Check size={16} />} {feedback.message}
              </span>
            )}
          </div>
        </form>

        {status === 'ready' && (
          <section className="profile-section profile-pinned" aria-labelledby="profile-pinned-title">
            <h2 id="profile-pinned-title">{copy.pinned}</h2>
            <p className="profile-hint">{copy.pinnedHint}</p>
            {pinnableLists.length === 0 ? (
              <p className="profile-empty">
                {copy.noLists} <Link to="/lists">/lists</Link>
              </p>
            ) : (
              <ul className="profile-pin-list">
                {pinnableLists.map(list => {
                  const isPinned = pinnedIds.has(list.shareId);
                  // `emoji` holds a lucide icon name, not a literal emoji.
                  const Icon = getIcon(list.emoji);
                  return (
                    <li key={list.shareId}>
                      <span className="profile-pin-emoji" aria-hidden="true"><Icon size={20} /></span>
                      <span className="profile-pin-copy">
                        <span className="profile-pin-title">{list.title}</span>
                        <span className="profile-pin-count">{copy.papers(list.paperCount)}</span>
                      </span>
                      <button
                        type="button"
                        className={`profile-pin-toggle${isPinned ? ' is-pinned' : ''}`}
                        onClick={() => togglePin(list)}
                        disabled={saving}
                      >
                        {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
                        {isPinned ? copy.unpin : copy.pin}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {status === 'ready' && profile && (
          <section className="profile-section profile-danger" aria-labelledby="profile-danger-title">
            <h2 id="profile-danger-title">{copy.sectionDanger}</h2>
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
    </main>
  );
}
