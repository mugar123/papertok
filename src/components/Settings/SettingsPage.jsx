import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  BarChart3,
  BookOpen,
  Building2,
  BriefcaseBusiness,
  Camera,
  ChevronRight,
  Code2,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  Languages,
  LoaderCircle,
  LogOut,
  Mail,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useFollowing } from '../../context/FollowingContext';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService';
import { AI_EXPLANATION_LEVELS } from '../../services/aiExplanationService';
import { CATEGORIES } from '../../data/categories';
import { PUBLIC_AVATAR_PRESET, prepareProfileImage } from '../../utils/profileImage';
import { savePublicProfilePhoto } from '../../services/userProfileService';
import { getUiErrorMessage } from '../../utils/errorMessages';
import EditInterestsModal from './EditInterestsModal';
import EmailNotificationModal from '../Following/EmailNotificationModal';
import './SettingsPage.css';

const LEVEL_DETAILS = {
  beginner: {
    label: { es: 'Principiante', en: 'Beginner' },
    description: {
      es: 'Lenguaje claro y contexto desde cero',
      en: 'Clear language and context from first principles',
    },
    Icon: BookOpen,
  },
  university: {
    label: { es: 'Universitario', en: 'University' },
    description: {
      es: 'Rigor académico sin asumir especialización',
      en: 'Academic rigor without assuming specialization',
    },
    Icon: GraduationCap,
  },
  researcher: {
    label: { es: 'Investigador', en: 'Researcher' },
    description: {
      es: 'Métodos, límites y detalle técnico',
      en: 'Methods, limitations, and technical detail',
    },
    Icon: FlaskConical,
  },
};

const FOLLOW_SUMMARY = [
  { type: 'author', label: { es: 'Autores', en: 'Authors' }, Icon: UserRound },
  { type: 'topic', label: { es: 'Temas', en: 'Topics' }, Icon: Tag },
  { type: 'institution', label: { es: 'Instituciones', en: 'Institutions' }, Icon: Building2 },
  { type: 'project', label: { es: 'Proyectos', en: 'Projects' }, Icon: BriefcaseBusiness },
];

const SETTINGS_COPY = {
  es: {
    eyebrow: 'Ajustes de usuario',
    title: 'Configuración',
    subtitle: 'Tu cuenta, tus preferencias de descubrimiento y tus herramientas de lectura.',
    account: 'Cuenta',
    defaultUser: 'Usuario de PaperTok',
    googleAccount: 'Cuenta gestionada con Google',
    changePhoto: 'Cambiar foto',
    restoreGooglePhoto: 'Restaurar foto de Google',
    removePhoto: 'Quitar foto de perfil',
    photoUpdated: 'Foto de perfil actualizada.',
    googlePhotoRestored: 'Se ha restaurado tu foto de Google.',
    photoRemoved: 'Foto de perfil eliminada.',
    photoSaveError: 'No se pudo guardar la foto de perfil.',
    photoRestoreError: 'No se pudo restaurar la foto de perfil.',
    discovery: 'Descubrimiento',
    discoveryDescription: 'Señales que PaperTok utiliza para construir tus feeds.',
    followedContent: 'Contenido seguido',
    loadingFollowing: 'Cargando tus seguimientos...',
    followedOne: 'entidad seguida',
    followedMany: 'entidades seguidas',
    recommendationsSuffix: 'influyen en tus recomendaciones',
    followingSummary: 'Resumen de contenido seguido',
    viewAll: 'Ver todo',
    publicProfile: 'Perfil público',
    publicProfileDescription: 'Tu handle, tu biografía y las listas que decidas mostrar',
    scientificInterests: 'Intereses científicos',
    selectedOne: 'subcategoría seleccionada',
    selectedMany: 'subcategorías seleccionadas',
    trainFeed: 'para entrenar tu feed',
    selectedAreas: 'Áreas seleccionadas',
    edit: 'Editar',
    readingAi: 'Lectura e IA',
    readingAiDescription: 'Ajusta el nivel de profundidad de tus explicaciones.',
    defaultAiLevel: 'Nivel predeterminado de IA',
    defaultAiDescription: 'Se abrirá seleccionado cuando pidas que la IA explique un paper',
    saving: 'Guardando...',
    preferenceSaved: 'Preferencia guardada',
    saveError: 'No se pudo guardar',
    aiLevelLabel: 'Nivel predeterminado de explicación',
    interface: 'Interfaz',
    interfaceDescription: 'Elige el idioma que PaperTok utiliza en este dispositivo.',
    language: 'Idioma',
    languageDescription: 'Cambia los menús, controles y mensajes de la aplicación.',
    languageLabel: 'Idioma de la interfaz',
    spanish: 'Español',
    english: 'English',
    notifications: 'Notificaciones',
    notificationsDescription: 'Decide si quieres recibir novedades aunque PaperTok esté cerrado.',
    emailUpdates: 'Novedades por email',
    configure: 'Configurar',
    privacy: 'Privacidad',
    privacyDescription: 'Controla las mediciones anónimas utilizadas para mejorar PaperTok.',
    usageAnalytics: 'Analítica de uso',
    usageAnalyticsDescription: 'Solo registra páginas anónimas; nunca búsquedas, papers, intereses ni datos de cuenta.',
    analyticsEnabled: 'Activada',
    analyticsDisabled: 'Desactivada',
    analyticsToggleLabel: 'Permitir analítica de uso',
    community: 'Comunidad',
    communityDescription: 'Descubre el proyecto y participa en su desarrollo.',
    openSource: 'PaperTok es open source',
    openSourceDescription: 'Consulta el código, comparte ideas o contribuye en GitHub.',
    viewOnGitHub: 'Ver en GitHub',
    opensNewTab: 'se abre en una pestaña nueva',
    session: 'Sesión',
    sessionDescription: 'La información personalizada permanece asociada a esta cuenta.',
    signOut: 'Cerrar sesión',
  },
  en: {
    eyebrow: 'User settings',
    title: 'Settings',
    subtitle: 'Your account, discovery preferences, and reading tools.',
    account: 'Account',
    defaultUser: 'PaperTok user',
    googleAccount: 'Account managed with Google',
    changePhoto: 'Change photo',
    restoreGooglePhoto: 'Restore Google photo',
    removePhoto: 'Remove profile photo',
    photoUpdated: 'Profile photo updated.',
    googlePhotoRestored: 'Your Google photo has been restored.',
    photoRemoved: 'Profile photo removed.',
    photoSaveError: 'The profile photo could not be saved.',
    photoRestoreError: 'The profile photo could not be restored.',
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
    interface: 'Interface',
    interfaceDescription: 'Choose the language PaperTok uses on this device.',
    language: 'Language',
    languageDescription: 'Changes the menus, controls, and messages in the app.',
    languageLabel: 'Interface language',
    spanish: 'Español',
    english: 'English',
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
    community: 'Community',
    communityDescription: 'Explore the project and take part in its development.',
    openSource: 'PaperTok is open source',
    openSourceDescription: 'View the code, share ideas, or contribute on GitHub.',
    viewOnGitHub: 'View on GitHub',
    opensNewTab: 'opens in a new tab',
    session: 'Session',
    sessionDescription: 'Your personalized information remains linked to this account.',
    signOut: 'Sign out',
  },
};

function emailStatus(preferences, health, loading, language) {
  const isEnglish = language === 'en';
  if (loading) {
    return {
      label: isEnglish ? 'Checking' : 'Comprobando',
      description: isEnglish ? 'Loading your email settings' : 'Cargando tu configuración de correo',
      tone: 'neutral',
    };
  }
  if (!health.available) {
    return {
      label: isEnglish ? 'Unavailable' : 'No disponible',
      description: isEnglish
        ? 'The email service is not responding right now'
        : 'El servicio de correo no responde en este momento',
      tone: 'warning',
    };
  }
  if (!preferences.enabled) {
    return {
      label: isEnglish ? 'Off' : 'Desactivado',
      description: isEnglish
        ? `Updates will not be sent to ${preferences.email || 'your email'}`
        : `Los avisos no se enviarán a ${preferences.email || 'tu correo'}`,
      tone: 'neutral',
    };
  }
  return {
    label: isEnglish ? 'On' : 'Activado',
    description: isEnglish
      ? `${preferences.frequency === 'weekly' ? 'Every Monday' : 'Every morning'} · up to ${preferences.maxPapers || 5} papers`
      : `${preferences.frequency === 'weekly' ? 'Cada lunes' : 'Cada mañana'} · hasta ${preferences.maxPapers || 5} papers`,
    tone: 'success',
  };
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const profileInputRef = useRef(null);
  const { language, setLanguage } = useLanguage();
  const { consent: analyticsConsent, updateConsent: updateAnalyticsConsent } = useAnalyticsConsent();
  const copy = SETTINGS_COPY[language];
  const {
    user,
    userPreferences,
    readingPreferences,
    profilePhoto,
    updateReadingPreferences,
    updateProfilePhoto,
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
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageFeedback, setLanguageFeedback] = useState(null);

  const selectedAreas = useMemo(() => {
    const selected = new Set(userPreferences || []);
    return Object.entries(CATEGORIES)
      .map(([id, area]) => {
        const count = Object.keys(area.subcategories).filter(key => selected.has(key)).length;
        return count > 0 ? { id, label: language === 'en' ? area.labelEn : area.label, count } : null;
      })
      .filter(Boolean);
  }, [language, userPreferences]);

  const selectedInterestCount = Array.isArray(userPreferences) ? userPreferences.length : 0;
  const notificationStatus = emailStatus(
    notificationPreferences,
    notificationHealth,
    notificationsLoading,
    language,
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

  useEffect(() => {
    if (!languageFeedback) return undefined;
    const timer = window.setTimeout(() => setLanguageFeedback(null), 1_800);
    return () => window.clearTimeout(timer);
  }, [languageFeedback]);

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

  const handlePhotoSelect = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || savingPhoto) return;

    setSavingPhoto(true);
    setPhotoFeedback(null);
    try {
      const preparedPhoto = await prepareProfileImage(file);
      await updateProfilePhoto(preparedPhoto);
      // The public profile keeps its own copy: `users/{uid}` is owner-only, so
      // a signed-out visitor could never see this one. Recompressed again
      // because the public budget is 60 KB against 280 KB here. A failure is
      // not worth losing the photo the user just set, so it only warns.
      try {
        await savePublicProfilePhoto(await prepareProfileImage(file, PUBLIC_AVATAR_PRESET));
      } catch (mirrorError) {
        console.error('Could not mirror the photo to the public profile:', mirrorError);
      }
      setPhotoFeedback({ tone: 'success', text: copy.photoUpdated });
    } catch (error) {
      setPhotoFeedback({
        tone: 'error',
        text: getUiErrorMessage(error, language, 'PROFILE_PHOTO_SAVE_FAILED'),
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
      try {
        await savePublicProfilePhoto(user?.photoURL || null);
      } catch (mirrorError) {
        console.error('Could not mirror the photo to the public profile:', mirrorError);
      }
      setPhotoFeedback({
        tone: 'success',
        text: user?.photoURL ? copy.googlePhotoRestored : copy.photoRemoved,
      });
    } catch {
      setPhotoFeedback({ tone: 'error', text: copy.photoRestoreError });
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const handleLanguageChange = async (nextLanguage) => {
    if (nextLanguage === language || savingLanguage) return;
    setSavingLanguage(true);
    setLanguageFeedback(null);
    try {
      await setLanguage(nextLanguage);
      setLanguageFeedback('saved');
    } catch {
      setLanguageFeedback('error');
    } finally {
      setSavingLanguage(false);
    }
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

          <section className="settings-profile" aria-labelledby="settings-account-title">
            <div className="settings-profile-avatar">
              {visibleProfilePhoto ? (
                <img src={visibleProfilePhoto} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="settings-profile-fallback" aria-hidden="true">
                  {user?.email?.charAt(0).toUpperCase() || 'U'}
                </div>
              )}
              {savingPhoto && (
                <span className="settings-profile-loading" aria-hidden="true">
                  <LoaderCircle size={22} />
                </span>
              )}
            </div>

            <div className="settings-profile-copy">
              <small>{copy.account}</small>
              <h2 id="settings-account-title">{user?.displayName || copy.defaultUser}</h2>
              <p>{user?.email}</p>
              <span><ShieldCheck size={14} /> {copy.googleAccount}</span>
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
              <button
                type="button"
                className="settings-photo-button"
                disabled={savingPhoto}
                onClick={() => profileInputRef.current?.click()}
              >
                <Camera size={17} />
                {copy.changePhoto}
              </button>
              {profilePhoto && (
                <button
                  type="button"
                  className="settings-photo-restore"
                  disabled={savingPhoto}
                  onClick={handleRestorePhoto}
                  aria-label={user?.photoURL ? copy.restoreGooglePhoto : copy.removePhoto}
                  title={user?.photoURL ? copy.restoreGooglePhoto : copy.removePhoto}
                >
                  <RotateCcw size={17} />
                </button>
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

          <section className="settings-section" aria-labelledby="discovery-heading">
            <div className="settings-section-heading">
              <SlidersHorizontal size={18} />
              <div>
                <h2 id="discovery-heading">{copy.discovery}</h2>
                <p>{copy.discoveryDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row" style={{ '--settings-index': 0 }}>
                <span className="settings-row-icon is-purple"><UserRound size={20} /></span>
                <div className="settings-row-content">
                  <h3>{copy.publicProfile}</h3>
                  <p>{copy.publicProfileDescription}</p>
                </div>
                <button className="settings-row-action" onClick={() => navigate('/settings/profile')}>
                  {copy.viewAll} <ChevronRight size={17} />
                </button>
              </div>

              <div className="settings-row" style={{ '--settings-index': 1 }}>
                <span className="settings-row-icon is-purple"><UsersRound size={20} /></span>
                <div className="settings-row-content">
                  <h3>{copy.followedContent}</h3>
                  <p>
                    {followingLoading && followedEntities.length === 0
                      ? copy.loadingFollowing
                      : `${followedEntities.length} ${followedEntities.length === 1 ? copy.followedOne : copy.followedMany} ${copy.recommendationsSuffix}`}
                  </p>
                  <div className="settings-follow-summary" aria-label={copy.followingSummary}>
                    {FOLLOW_SUMMARY.map(({ type, label, Icon }) => (
                      <span key={type}>
                        <Icon size={12} />
                        {label[language]}
                        <strong>{followedByType[type]?.length || 0}</strong>
                      </span>
                    ))}
                  </div>
                </div>
                <button className="settings-row-action" onClick={() => navigate('/settings/following')}>
                  {copy.viewAll} <ChevronRight size={17} />
                </button>
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
                <button className="settings-row-action" onClick={() => setIsInterestsOpen(true)}>
                  {copy.edit} <ChevronRight size={17} />
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="reading-heading">
            <div className="settings-section-heading">
              <Sparkles size={18} />
              <div>
                <h2 id="reading-heading">{copy.readingAi}</h2>
                <p>{copy.readingAiDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row settings-row--levels" style={{ '--settings-index': 2 }}>
                <span className="settings-row-icon is-purple"><Sparkles size={20} /></span>
                <div className="settings-row-content">
                  <h3>{copy.defaultAiLevel}</h3>
                  <p>{copy.defaultAiDescription}</p>
                  <span className={`settings-save-feedback ${levelFeedback ? `is-${levelFeedback}` : ''}`} aria-live="polite">
                    {savingLevel && copy.saving}
                    {!savingLevel && levelFeedback === 'saved' && copy.preferenceSaved}
                    {!savingLevel && levelFeedback === 'error' && copy.saveError}
                  </span>
                </div>
                <div className="settings-levels" role="radiogroup" aria-label={copy.aiLevelLabel}>
                  {AI_EXPLANATION_LEVELS.map(({ id }) => {
                    const { label, description, Icon } = LEVEL_DETAILS[id];
                    const active = readingPreferences.aiExplanationLevel === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={active ? 'is-active' : ''}
                        disabled={Boolean(savingLevel)}
                        onClick={() => handleLevelChange(id)}
                      >
                        <Icon size={18} />
                        <span><strong>{label[language]}</strong><small>{description[language]}</small></span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="interface-heading">
            <div className="settings-section-heading">
              <Languages size={18} />
              <div>
                <h2 id="interface-heading">{copy.interface}</h2>
                <p>{copy.interfaceDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row" style={{ '--settings-index': 3 }}>
                <span className="settings-row-icon is-cyan"><Languages size={20} /></span>
                <div className="settings-row-content">
                  <h3>{copy.language}</h3>
                  <p>{copy.languageDescription}</p>
                  <span className={`settings-save-feedback ${languageFeedback ? `is-${languageFeedback}` : ''}`} aria-live="polite">
                    {savingLanguage && copy.saving}
                    {!savingLanguage && languageFeedback === 'saved' && copy.preferenceSaved}
                    {!savingLanguage && languageFeedback === 'error' && copy.saveError}
                  </span>
                </div>
                <div className="settings-language" role="radiogroup" aria-label={copy.languageLabel}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={language === 'es'}
                    className={language === 'es' ? 'is-active' : ''}
                    disabled={savingLanguage}
                    onClick={() => handleLanguageChange('es')}
                  >
                    {copy.spanish}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={language === 'en'}
                    className={language === 'en' ? 'is-active' : ''}
                    disabled={savingLanguage}
                    onClick={() => handleLanguageChange('en')}
                  >
                    {copy.english}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="notifications-heading">
            <div className="settings-section-heading">
              <Bell size={18} />
              <div>
                <h2 id="notifications-heading">{copy.notifications}</h2>
                <p>{copy.notificationsDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row" style={{ '--settings-index': 4 }}>
                <span className="settings-row-icon is-amber"><Mail size={20} /></span>
                <div className="settings-row-content">
                  <div className="settings-row-title-line">
                    <h3>{copy.emailUpdates}</h3>
                    <span className={`settings-status is-${notificationStatus.tone}`}>
                      {notificationStatus.label}
                    </span>
                  </div>
                  <p>{notificationStatus.description}</p>
                </div>
                <button className="settings-row-action" onClick={() => setIsNotificationsOpen(true)}>
                  {copy.configure} <ChevronRight size={17} />
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="privacy-heading">
            <div className="settings-section-heading">
              <ShieldCheck size={18} />
              <div>
                <h2 id="privacy-heading">{copy.privacy}</h2>
                <p>{copy.privacyDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row" style={{ '--settings-index': 5 }}>
                <span className="settings-row-icon is-cyan"><BarChart3 size={20} /></span>
                <div className="settings-row-content">
                  <h3>{copy.usageAnalytics}</h3>
                  <p>{copy.usageAnalyticsDescription}</p>
                </div>
                <div className="settings-toggle-control">
                  <span>{analyticsConsent === ANALYTICS_CONSENT.GRANTED ? copy.analyticsEnabled : copy.analyticsDisabled}</span>
                  <button
                    type="button"
                    className={`settings-toggle ${analyticsConsent === ANALYTICS_CONSENT.GRANTED ? 'is-active' : ''}`}
                    role="switch"
                    aria-checked={analyticsConsent === ANALYTICS_CONSENT.GRANTED}
                    aria-label={copy.analyticsToggleLabel}
                    onClick={() => updateAnalyticsConsent(
                      analyticsConsent === ANALYTICS_CONSENT.GRANTED
                        ? ANALYTICS_CONSENT.DENIED
                        : ANALYTICS_CONSENT.GRANTED,
                    )}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section settings-section--community" aria-labelledby="community-heading">
            <div className="settings-section-heading">
              <Code2 size={18} />
              <div>
                <h2 id="community-heading">{copy.community}</h2>
                <p>{copy.communityDescription}</p>
              </div>
            </div>

            <div className="settings-list">
              <div className="settings-row" style={{ '--settings-index': 6 }}>
                <span className="settings-row-icon settings-row-icon--github"><Code2 size={20} /></span>
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
                  {copy.viewOnGitHub} <ExternalLink size={16} />
                </a>
              </div>
            </div>
          </section>

          <section className="settings-section settings-section--session" aria-labelledby="session-heading">
            <div className="settings-section-heading">
              <UserRound size={18} />
              <div>
                <h2 id="session-heading">{copy.session}</h2>
                <p>{copy.sessionDescription}</p>
              </div>
            </div>
            <button className="settings-signout" onClick={handleSignOut}>
              <LogOut size={18} /> {copy.signOut}
            </button>
          </section>
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
    </>
  );
}
