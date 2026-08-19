import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, ExternalLink, ImagePlus, Loader2, Pin, PinOff, Trash2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import {
  HandleUnavailableError,
  USER_PROFILE_LIMITS,
  changeUserHandle,
  createUserProfile,
  partitionStalePins,
  pinListEntry,
  readOwnUserProfile,
  readPinnableLists,
  savePinnedLists,
  unpinListEntry,
  updateUserProfile,
} from '../../services/userProfileService.js';
import { PUBLIC_AVATAR_PRESET, prepareProfileImage } from '../../utils/profileImage.js';
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
 * The owner's view of their public profile: create it, edit it, and choose
 * which published lists appear on it.
 *
 * Pinning happens here rather than on the lists screen because attribution is
 * opt-in: a public list stays anonymous until its owner decides, from their own
 * profile, to put their name on it.
 */
export default function ProfilePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isEnglish } = useLanguage();
  const fileInputRef = useRef(null);

  const [profile, setProfile] = useState(null);
  const [pinnableLists, setPinnableLists] = useState([]);
  const [status, setStatus] = useState('loading');
  const [handleDraft, setHandleDraft] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [photo, setPhoto] = useState('');
  const [allowContact, setAllowContact] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const copy = isEnglish ? {
    back: 'Back to settings',
    title: 'Public profile',
    createIntro: 'Pick a handle and your profile becomes visible at its own public link.',
    editIntro: 'Anything here is public. Your reading history and notes are not.',
    handle: 'Handle',
    handleHint: 'Lowercase letters, numbers and underscores.',
    displayName: 'Display name',
    bio: 'Bio',
    photo: 'Photo',
    choosePhoto: 'Choose photo',
    removePhoto: 'Remove photo',
    allowContact: 'Let other users contact me',
    create: 'Create my profile',
    save: 'Save changes',
    saving: 'Saving...',
    saved: 'Saved',
    changeHandle: 'Change handle',
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
  } : {
    back: 'Volver a ajustes',
    title: 'Perfil público',
    createIntro: 'Elige un handle y tu perfil pasa a ser visible en su propio enlace público.',
    editIntro: 'Todo lo de aquí es público. Tu historial de lectura y tus notas no lo son.',
    handle: 'Handle',
    handleHint: 'Minúsculas, números y guiones bajos.',
    displayName: 'Nombre visible',
    bio: 'Biografía',
    photo: 'Foto',
    choosePhoto: 'Elegir foto',
    removePhoto: 'Quitar foto',
    allowContact: 'Permitir que otros usuarios me contacten',
    create: 'Crear mi perfil',
    save: 'Guardar cambios',
    saving: 'Guardando...',
    saved: 'Guardado',
    changeHandle: 'Cambiar handle',
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
        setPhoto(ownProfile?.photo || '');
        setAllowContact(ownProfile?.allowContact === true);
        setHandleDraft(ownProfile?.handle || '');
        setStatus(ownProfile ? 'ready' : 'new');
      })
      .catch(error => {
        console.error('Error loading own profile:', error);
        if (active) setStatus('error');
      });
    return () => { active = false; };
  }, [user]);

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

  const reportError = useCallback((error) => {
    console.error('Profile write failed:', error);
    setFeedback({
      state: 'error',
      message: error instanceof HandleUnavailableError ? copy.handleTaken : copy.genericError,
    });
  }, [copy.genericError, copy.handleTaken]);

  const onPickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      // Recompressed against the public budget, not the private one.
      setPhoto(await prepareProfileImage(file, PUBLIC_AVATAR_PRESET));
      setFeedback(null);
    } catch (error) {
      setFeedback({ state: 'error', message: error?.message || copy.genericError });
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
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
      const payload = { displayName, bio, photo, allowContact, pinnedLists: profile?.pinnedLists };
      if (!profile) {
        const created = await createUserProfile({ ...payload, handle: handleCheck.handle });
        setProfile({ ...created, pinnedLists: created.pinnedLists || [] });
        setStatus('ready');
      } else {
        if (handleCheck.handle !== profile.handle) {
          await changeUserHandle(handleCheck.handle, profile.handle);
        }
        const updated = await updateUserProfile(payload);
        setProfile(current => ({ ...current, ...updated, handle: handleCheck.handle }));
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
          <button type="button" className="profile-back" onClick={() => navigate('/settings')}>
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

          <div className="profile-field">
            <span className="profile-field-label">{copy.photo}</span>
            <div className="profile-photo-row">
              <div className="profile-photo-preview">
                {photo ? <img src={photo} alt="" /> : <span aria-hidden="true" />}
              </div>
              <button type="button" className="profile-secondary" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus size={16} /> {copy.choosePhoto}
              </button>
              {photo && (
                <button type="button" className="profile-secondary" onClick={() => setPhoto('')}>
                  <Trash2 size={16} /> {copy.removePhoto}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={onPickPhoto}
              />
            </div>
          </div>

          <label className="profile-checkbox">
            <input
              type="checkbox"
              checked={allowContact}
              onChange={event => setAllowContact(event.target.checked)}
            />
            {copy.allowContact}
          </label>

          <div className="profile-actions">
            <button type="submit" className="profile-primary" disabled={saving || !handleCheck.valid}>
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
          <section className="profile-pinned" aria-labelledby="profile-pinned-title">
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
      </div>
    </main>
  );
}
