import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  BarChart3,
  BookOpen,
  Building2,
  BriefcaseBusiness,
  Camera,
  Check,
  ChevronRight,
  Code2,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  KeyRound,
  Languages,
  LoaderCircle,
  LogOut,
  Mail,
  MessageCircle,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
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
import { profileIsPublic, savePublicProfilePhoto } from '../../services/userProfileService';
import { ownProfileCache, ownProfileKey } from '../../utils/profileSessionCaches.js';
import { SIGN_IN_PROVIDERS } from '../../services/authIdentityService';
import { getUiErrorMessage } from '../../utils/errorMessages';
import EditInterestsModal from './EditInterestsModal';
import DeleteAccountDialog from './DeleteAccountDialog';
import EmailNotificationModal from '../Following/EmailNotificationModal';
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

/**
 * The index rail down the left of the hub, and the identity of every section
 * on the page. Order is document order: the spy below picks the first entry
 * that touches the reading band, so this array must stay in sync with the
 * order the sections are rendered in.
 */
const SETTINGS_SECTIONS = [
  { id: 'settings-account', label: { es: 'Cuenta', en: 'Account' } },
  { id: 'settings-discovery', label: { es: 'Descubrimiento', en: 'Discovery' } },
  { id: 'settings-reading', label: { es: 'Lectura e IA', en: 'Reading and AI' } },
  { id: 'settings-interface', label: { es: 'Interfaz', en: 'Interface' } },
  { id: 'settings-notifications', label: { es: 'Notificaciones', en: 'Notifications' } },
  { id: 'settings-privacy', label: { es: 'Privacidad', en: 'Privacy' } },
  { id: 'settings-community', label: { es: 'Comunidad', en: 'Community' } },
  { id: 'settings-access', label: { es: 'Acceso y sesión', en: 'Access and session' } },
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

const SETTINGS_COPY = {
  es: {
    eyebrow: 'Ajustes de usuario',
    title: 'Configuración',
    subtitle: 'Tu cuenta, tus preferencias de descubrimiento y tus herramientas de lectura.',
    index: 'Índice',
    indexLabel: 'Secciones de los ajustes',
    indexHint: 'Los cambios se guardan al momento, sección a sección.',
    account: 'Cuenta',
    defaultUser: 'Usuario de PaperTok',
    googleAccount: 'Cuenta gestionada con Google',
    githubAccount: 'Cuenta gestionada con GitHub',
    accountBothProviders: 'Entras con Google y con GitHub',
    genericAccount: 'Cuenta de PaperTok',
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
    followedContent: 'Lo que sigues',
    loadingFollowing: 'Cargando tus seguimientos...',
    followedOne: 'entidad seguida',
    followedMany: 'entidades seguidas',
    recommendationsSuffix: 'influyen en tus recomendaciones',
    followingSummary: 'Resumen de contenido seguido',
    viewAll: 'Ver todo',
    publicProfile: 'Perfil público',
    publicProfileDescription: 'Tu handle, tu biografía y las listas que decidas mostrar',
    profileIsPublicBadge: 'público',
    profileIsPrivateBadge: 'privado',
    myComments: 'Mis comentarios',
    myCommentsDescription: 'Lo que has escrito en los papers, incluido lo moderado',
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
    deleteAccount: 'Eliminar cuenta',
    deleteAccountDescription: 'Borra tu perfil, tus datos y el acceso. No se puede deshacer.',
    deleteAccountAction: 'Eliminar',
    community: 'Comunidad',
    communityDescription: 'Descubre el proyecto y participa en su desarrollo.',
    openSource: 'PaperTok es open source',
    openSourceDescription: 'Consulta el código, comparte ideas o contribuye en GitHub.',
    viewOnGitHub: 'Ver en GitHub',
    opensNewTab: 'se abre en una pestaña nueva',
    access: 'Acceso y sesión',
    accessDescription: 'Distintas puertas, la misma cuenta y los mismos datos.',
    session: 'Sesión',
    sessionDescription: 'La información personalizada permanece asociada a esta cuenta.',
    signOut: 'Cerrar sesión',
    signInMethods: 'Formas de entrar',
    signInMethodsDescription: 'Distintas puertas, la misma cuenta y los mismos datos.',
    githubMethod: 'Entrar con GitHub',
    githubLinked: 'Conectado. Ya puedes entrar con GitHub.',
    githubUnlinked: 'Conéctalo y podrás entrar con GitHub además de como entras hoy.',
    connect: 'Conectar',
    connecting: 'Conectando...',
    connected: 'Conectado',
    linkSuccess: 'GitHub conectado. La próxima vez puedes entrar con cualquiera de los dos.',
    linkTaken: 'Esa cuenta de GitHub ya abre otra cuenta de PaperTok. Las dos no se fusionan: entra en la otra si es la que quieres conservar, o conecta una cuenta de GitHub distinta.',
  },
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
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageFeedback, setLanguageFeedback] = useState(null);
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
        setLinkFeedback({ tone: 'error', text: getUiErrorMessage(linkError, language, 'AUTH_LINK_FAILED') });
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
        return count > 0 ? { id, label: language === 'en' ? area.labelEn : area.label, count } : null;
      })
      .filter(Boolean);
  }, [language, userPreferences]);

  // The tab keeps saying which screen this is; restored on the way out so the
  // pages that manage their own metadata are not affected.
  useEffect(() => {
    const previous = document.title;
    const ours = language === 'en' ? 'Settings | PaperTok' : 'Configuración | PaperTok';
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

  const handleAccountDeleted = async () => {
    try {
      await signOut();
    } catch {
      // The Auth user may already be gone; the tab still has to leave.
    }
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
                      <LoaderCircle size={22} />
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
                    <span className="settings-row-icon is-purple"><UserRound size={20} /></span>
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
                    <button className="settings-row-action" onClick={() => navigate('/settings/profile')}>
                      {copy.edit} <ChevronRight size={17} />
                    </button>
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 1 }}>
                    <span className="settings-row-icon is-purple"><MessageCircle size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.myComments}</h3>
                      <p>{copy.myCommentsDescription}</p>
                    </div>
                    <button className="settings-row-action" onClick={() => navigate('/settings/comments')}>
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

              <section id="settings-reading" tabIndex={-1} className="settings-section" aria-labelledby="reading-heading">
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

              <section id="settings-interface" tabIndex={-1} className="settings-section" aria-labelledby="interface-heading">
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

                  <div className="settings-row" style={{ '--settings-index': 6 }}>
                    <span className="settings-row-icon is-rose"><Trash2 size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.deleteAccount}</h3>
                      <p>{copy.deleteAccountDescription}</p>
                    </div>
                    <button
                      type="button"
                      className="settings-signout"
                      onClick={() => setDeleteAccountOpen(true)}
                    >
                      {copy.deleteAccountAction}
                    </button>
                  </div>
                </div>
              </section>

              <section id="settings-community" tabIndex={-1} className="settings-section settings-section--community" aria-labelledby="community-heading">
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

              {/* Signing in and signing out are one subject — how this account is
                  reached — so they are one section with two rows, not two sections
                  a scroll apart. */}
              <section id="settings-access" tabIndex={-1} className="settings-section" aria-labelledby="access-heading">
                <div className="settings-section-heading">
                  <KeyRound size={18} />
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
                      <button
                        type="button"
                        className="settings-row-action"
                        onClick={handleLinkGitHub}
                        disabled={linkingGitHub}
                      >
                        {linkingGitHub ? copy.connecting : copy.connect}
                        {!linkingGitHub && <ChevronRight size={17} />}
                      </button>
                    )}
                  </div>

                  <div className="settings-row" style={{ '--settings-index': 7 }}>
                    <span className="settings-row-icon is-rose"><UserRound size={20} /></span>
                    <div className="settings-row-content">
                      <h3>{copy.session}</h3>
                      <p>{copy.sessionDescription}</p>
                    </div>
                    <button className="settings-signout" onClick={handleSignOut}>
                      <LogOut size={18} /> {copy.signOut}
                    </button>
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
