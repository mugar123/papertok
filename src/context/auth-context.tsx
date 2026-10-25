import type { Dispatch, PropsWithChildren, SetStateAction } from 'react';
import type { User } from 'firebase/auth';
import type { DocumentReference, DocumentSnapshot } from 'firebase/firestore';

export type AppUser = Pick<User, 'uid' | 'displayName' | 'email' | 'photoURL'> & {
  providerData: Array<Pick<User['providerData'][number], 'providerId'> & Partial<Pick<User['providerData'][number], 'email' | 'displayName'>>>;
};
type ReadingPreferences = ReturnType<typeof normalizeReadingPreferences>;
interface StoredProfile {
  onboardingComplete?: boolean;
  preferences?: string[];
  selectedCategories?: string[];
  deselectedPreferences?: unknown;
  addedPreferences?: unknown;
  followedAuthors?: string[];
  readingPreferences?: Parameters<typeof normalizeReadingPreferences>[0];
  emailDigestOptIn?: boolean;
  institution?: Parameters<typeof normalizeInstitution>[0];
}
export interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  onboardingComplete: boolean;
  userPreferences: string[] | null;
  // Subareas this account removed from its interests; always empty for a guest.
  deselectedPreferences: string[];
  // Subareas this account added to its interests after onboarding; always
  // empty for a guest.
  addedPreferences: string[];
  followedAuthors: string[];
  readingPreferences: ReadingPreferences;
  emailDigestPending: boolean;
  profileLoadError: string | null;
  signInProviders: string[];
  institution: ReturnType<typeof normalizeInstitution>;
  signInWithGoogle: () => Promise<{ isNewUser: boolean; providerId: string }>;
  signInWithGitHub: () => Promise<{ isNewUser: boolean; providerId: string }>;
  linkSignInMethod: typeof linkSignInProvider;
  linkInstitution: typeof linkInstitutionAccount;
  completeInstitutionVerification: typeof completeInstitutionVerificationAccount;
  unlinkInstitution: () => Promise<void>;
  signOut: () => Promise<void>;
  completeOnboarding: (preferences: string[]) => Promise<void>;
  settleEmailDigestOptIn: () => Promise<void>;
  updatePreferences: (preferences: string[]) => Promise<void>;
  setUserPreferences: Dispatch<SetStateAction<string[] | null>>;
  toggleFollowAuthor: (authorName: string) => Promise<void>;
  updateReadingPreferences: (updates: Partial<ReadingPreferences>) => Promise<ReadingPreferences>;
  retryProfileLoad: () => void;
}

/* eslint-disable react-refresh/only-export-components -- the context module exports its provider together with its hook */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './contexts.ts';
import { auth, db } from '../services/firebase.ts';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import {
  SIGN_IN_PROVIDERS,
  linkSignInProvider,
  providerIdsOf,
  signInWithProvider,
} from '../services/auth-identity-service.ts';
import { deleteField, doc, getDoc, getDocFromCache, setDoc } from 'firebase/firestore';
import {
  linkInstitution as linkInstitutionAccount,
  completeInstitutionVerification as completeInstitutionVerificationAccount,
  pendingInstitutionVerification,
  normalizeInstitution,
  unlinkInstitution as unlinkInstitutionAccount,
} from '../services/institution-service.ts';
import {
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
} from '../utils/user-settings.ts';
import { settleWithin } from '../utils/async-timing.ts';
import { isReadTimeout, patientRead } from '../utils/bounded-read.ts';
import { documentIsAuthoritative } from '../utils/cache-authority.ts';
import { saveStoredOnboarding } from '../utils/user-scoped-storage.ts';
import { adoptOnboardedProfile, closeAccountSession, openAccountSession } from './account-session.ts';
import { confirmOnboardingWrite, profileReadOutcome } from './profile-load.ts';
import { writeOptimistically } from './optimistic-write.ts';
import { clearRewriteCache } from '../services/paper-rewrite-service.ts';
import { accountLooksOnboarded } from '../utils/account-onboarding.ts';
import { nextAdded, nextDeselected } from '../utils/interest-memory.ts';
import { readGuestInterests } from '../utils/guest-interests.ts';
import { toggleFollowedAuthor } from '../utils/followed-authors.ts';

const PROFILE_CACHE_TIMEOUT_MS = 800;
const PROFILE_NETWORK_TIMEOUT_MS = 7000;

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [userPreferences, setUserPreferences] = useState<string[] | null>(null);
  const [deselectedPreferences, setDeselectedPreferences] = useState<string[]>([]);
  const [addedPreferences, setAddedPreferences] = useState<string[]>([]);
  const [followedAuthors, setFollowedAuthors] = useState<string[]>([]);
  const [readingPreferences, setReadingPreferences] = useState<ReadingPreferences>(DEFAULT_READING_PREFERENCES);
  // A yes to the email digest given in the guest welcome, saved on the
  // account at onboarding and waiting for the first follow: the digest is
  // built from follows, so EmailNotificationsContext turns the subscription
  // on then and settles this flag.
  const [emailDigestPending, setEmailDigestPending] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  // Which doors this account has (F5). Kept in state rather than read from
  // `user.providerData` at render time because linking does not always
  // re-emit an auth state change, and a settings row that still says
  // "Connect" right after connecting is a row nobody trusts.
  const [signInProviders, setSignInProviders] = useState<string[]>([]);
  // The university a verified address resolved to, written by the Worker
  // (institution-link.js) and read here with the rest of the user document.
  const [institution, setInstitution] = useState<ReturnType<typeof normalizeInstitution>>(null);
  const [profileReloadKey, setProfileReloadKey] = useState(0);

  useEffect(() => {

    let authChangeId = 0;
    let disposed = false;
    const handleAuthChange = async (currentUser: User | null) => {
      const changeId = ++authChangeId;
      // Here rather than in signOut: another tab can end this session too.
      clearRewriteCache();
      setLoading(true);
      setProfileLoadError(null);
      setUser(currentUser);
      setFollowedAuthors([]);
      setDeselectedPreferences([]);
      setAddedPreferences([]);
      setReadingPreferences(DEFAULT_READING_PREFERENCES);
      setEmailDigestPending(false);
      setSignInProviders(providerIdsOf(currentUser));
      setInstitution(null);
      pendingInstitutionVerification({ currentUser: () => currentUser });

      if (currentUser) {
        const storedOnboarding = openAccountSession(currentUser.uid);
        if (storedOnboarding?.complete) {
          setOnboardingComplete(true);
          if (storedOnboarding.preferences.length > 0) {
            setUserPreferences(storedOnboarding.preferences);
          }
        } else {
          setOnboardingComplete(false);
          setUserPreferences(null);
        }
        const userRef = doc(db, 'users', currentUser.uid) as DocumentReference<StoredProfile>;
        const isCurrent = () => !disposed && changeId === authChangeId;
        const applyProfile = (snapshot: DocumentSnapshot<StoredProfile>) => {
          if (!snapshot?.exists() || !isCurrent()) return false;
          const data = snapshot.data();
          const onboarded = accountLooksOnboarded(data);
          setOnboardingComplete(onboarded);
          const preferences = data.preferences || data.selectedCategories || null;
          setUserPreferences(preferences);
          setFollowedAuthors(data.followedAuthors || []);
          // Anything but a list of strings counts as none.
          setDeselectedPreferences(Array.isArray(data.deselectedPreferences) ? data.deselectedPreferences.filter((id): id is string => typeof id === 'string') : []);
          setAddedPreferences(Array.isArray(data.addedPreferences) ? data.addedPreferences.filter((id): id is string => typeof id === 'string') : []);
          setReadingPreferences(normalizeReadingPreferences(data.readingPreferences));
          setEmailDigestPending(data.emailDigestOptIn === true);
          setInstitution(normalizeInstitution(data.institution));
          // An account that already chose its interests is the authority on
          // them. A guest pick left waiting on this device would only ever
          // seed the NEXT new account here with someone else's areas.
          if (onboarded) adoptOnboardedProfile(currentUser.uid, Array.isArray(preferences) ? preferences : []);
          return true;
        };

        const cached = await settleWithin(
          getDocFromCache(userRef),
          PROFILE_CACHE_TIMEOUT_MS,
        );
        if (!isCurrent()) return;

        const hydratedFromCache = cached.status === 'fulfilled' && applyProfile(cached.value);
        if (hydratedFromCache) setLoading(false);

        // The server is the authority on whether the document exists. A
        // remembered onboarding only decided the paint while this read was
        // in flight; it does not get to overrule a missing document.
        const applyRemote = (snapshot: DocumentSnapshot<StoredProfile>) => {
          if (!applyProfile(snapshot)) {
            setOnboardingComplete(false);
            saveStoredOnboarding(currentUser.uid, { complete: false, preferences: [] });
          }
        };
        // This used to be one `getDoc` under a seven-second guillotine. Against
        // a listen stream that had died under the client — a laptop back from
        // sleep, a network changed under the tab — the read never answered,
        // the seven seconds ended in "your profile could not be loaded", and
        // Retry asked the same dead stream again. `patientRead` kicks the
        // stream at DEFAULT_STALL_MS and re-asks on the rebuilt one; `isAnswer`
        // refuses the cache-served absence the kick flushes, which is not the
        // server's word on whether the document exists; and an answer that
        // lands after the verdict still applies, clearing the error itself.
        const remote = await settleWithin(
          patientRead(() => getDoc(userRef), {
            attempts: 1,
            ms: PROFILE_NETWORK_TIMEOUT_MS,
            label: 'account profile',
            isAnswer: documentIsAuthoritative,
            onLateResult: (snapshot) => {
              if (!isCurrent()) return;
              setProfileLoadError(null);
              applyRemote(snapshot);
              setLoading(false);
            },
          }),
          PROFILE_NETWORK_TIMEOUT_MS,
        );
        if (!isCurrent()) return;

        const outcome = profileReadOutcome(remote, hydratedFromCache);
        if (outcome.kind === 'apply') {
          applyRemote(outcome.snapshot);
        } else if (outcome.kind === 'failed') {
          setProfileLoadError(outcome.code);
          if (remote.status === 'rejected' && !isReadTimeout(remote.reason)) {
            console.error('Error fetching user data', remote.reason);
          } else {
            console.warn('Profile loading exceeded the timeout');
          }
        }
      } else {
        setOnboardingComplete(false);
        setUserPreferences(null);
      }
      if (!disposed && changeId === authChangeId) setLoading(false);
    };
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => { void handleAuthChange(currentUser); });

    return () => {
      disposed = true;
      authChangeId += 1;
      unsubscribe();
    };
  }, [profileReloadKey]);

  const retryProfileLoad = useCallback(() => {
    setProfileLoadError(null);
    setProfileReloadKey(key => key + 1);
  }, []);

  // No reactive read besides state setters and module-level constants, so this
  // never needs to be recreated — every context consumer that depends on it
  // (both sign-in buttons below) inherits that stability.
  const signInWith = useCallback(async (providerId: string) => {
    setError(null);

    try {
      return await signInWithProvider(providerId);
    } catch (err) {
      // Closing the window, or pressing again so a new one replaces it, is the
      // reader's own choice, not a failure to report.
      if ((err as { code?: string } | null)?.code !== 'auth/popup-closed-by-user' && (err as { code?: string } | null)?.code !== 'auth/cancelled-popup-request') {
        setError((err as { code?: string } | null)?.code || 'AUTH_FAILED');
      }
      throw err;
    }
  }, []);

  const signInWithGoogle = useCallback(
    () => signInWith(SIGN_IN_PROVIDERS.google),
    [signInWith],
  );
  const signInWithGitHub = useCallback(
    () => signInWith(SIGN_IN_PROVIDERS.github),
    [signInWith],
  );

  /**
   * Attaches a second sign-in method to the account already in session (F5).
   * Both providers open the same uid afterwards, so nothing in Firestore moves
   * and nothing needs migrating. Errors are classified by the service and
   * thrown on: the caller shows them next to the button that was pressed,
   * rather than in the page-wide banner meant for a failed sign-in.
   */

  const linkSignInMethod = useCallback(async (providerId: string) => {
    const result = await linkSignInProvider(providerId);
    setSignInProviders(providerIdsOf(result.user || auth.currentUser));
    return result;
  }, []);

  // The Worker writes the field and answers with what it wrote; that answer is
  // applied here, guarded by uid like the profile writes below, so an account
  // switched during verification cannot inherit the other's.
  const linkInstitution = useCallback(async (email: string) => {
    const userId = user?.uid;
    const linked = await linkInstitutionAccount(email);
    if (auth.currentUser?.uid === userId) setInstitution(linked);
    return linked;
  }, [user?.uid]);

  const completeInstitutionVerification = useCallback(async (link: string) => {
    const userId = user?.uid;
    const linked = await completeInstitutionVerificationAccount(link);
    if (auth.currentUser?.uid === userId) setInstitution(linked);
    return linked;
  }, [user?.uid]);

  const unlinkInstitution = useCallback(async () => {
    const userId = user?.uid;
    await unlinkInstitutionAccount();
    if (auth.currentUser?.uid === userId) setInstitution(null);
  }, [user?.uid]);

  // `user?.uid` rather than `user`: Firebase re-emits `currentUser` on token
  // refresh with the same uid but a new object reference, and that must not
  // recreate a function whose only reactive read is the id.
  const signOut = useCallback(async () => {
    const signingOutUserId = user?.uid;

    try {
      await firebaseSignOut(auth);
      closeAccountSession(signingOutUserId);
    } catch (err) {
      setError((err as { code?: string } | null)?.code || 'AUTH_FAILED');
    }
  }, [user?.uid]);

  // The flag flips only once the document holds it. Flipping first sent the
  // onboarding on its way (its effect navigates the moment the flag is true)
  // while the write was still in flight, so a refused write — a list over the
  // rules' cap, a rule that changed under the client — failed against an
  // unmounted page, left no local memory either, and the next reload asked
  // the same questions again. The
  // failure reaches handleFinish's catch, on screen, with the pick intact.
  const completeOnboarding = useCallback(async (preferences: string[]) => {
    const guestAnswer = readGuestInterests();
    const guestLevel = guestAnswer?.readingLevel;
    // Only an explicit yes reaches the account.
    const guestEmailDigest = guestAnswer?.emailDigest === true;
    const guestReading = guestLevel
      ? normalizeReadingPreferences({ ...readingPreferences, aiExplanationLevel: guestLevel })
      : null;

    const userId = user?.uid;
    if (userId) {
      // Throws unless the write is fulfilled in time: the flag and the
      // preferences below stay unflipped.
      await confirmOnboardingWrite(
        setDoc(doc(db, 'users', userId), {
          onboardingComplete: true,
          ...(guestReading ? { readingPreferences: guestReading } : {}),
          preferences
        }, { merge: true }),
        PROFILE_NETWORK_TIMEOUT_MS,
      );
      if (guestReading) setReadingPreferences(guestReading);
      // The email opt-in is its own write, after the onboarding's and never
      // awaited by it: the frontend and the Firestore rules deploy separately,
      // and a refusal here (rules that do not know the field yet, a stalled
      // connection) must cost the reader the opt-in, not the account. They can
      // still turn email on in Settings.
      if (guestEmailDigest) {
        void settleWithin(
          setDoc(doc(db, 'users', userId), { emailDigestOptIn: true }, { merge: true }),
          PROFILE_NETWORK_TIMEOUT_MS,
        ).then((optIn) => {
          if (optIn.status !== 'fulfilled') {
            console.warn('Could not save the email digest opt-in', (optIn as { reason?: unknown }).reason || optIn.status);
            return;
          }
          if (auth.currentUser?.uid === userId) setEmailDigestPending(true);
        });
      }
      // The interests a guest picked before signing up have now reached the
      // profile (the onboarding pre-selects from them); the bridge is done.
      adoptOnboardedProfile(userId, preferences);
    }
    setUserPreferences(preferences);
    setOnboardingComplete(true);
  }, [readingPreferences, user?.uid]);

  const updatePreferences = useCallback(async (newPreferences: string[]) => {
    setUserPreferences(newPreferences);

    const userId = user?.uid;
    if (userId) {
      // Set with the preferences, so a second edit before the write settles
      // still starts from every result of the first edit. Onboarding writes
      // no added list: its picks start established.
      const deselected = nextDeselected(userPreferences ?? [], newPreferences, deselectedPreferences);
      const added = nextAdded(userPreferences ?? [], newPreferences, addedPreferences, deselectedPreferences);
      setDeselectedPreferences(deselected);
      setAddedPreferences(added);
      await setDoc(doc(db, 'users', userId), {
        preferences: newPreferences,
        deselectedPreferences: deselected,
        addedPreferences: added
      }, { merge: true });
      saveStoredOnboarding(userId, { complete: true, preferences: newPreferences });
    }
  }, [addedPreferences, deselectedPreferences, user?.uid, userPreferences]);

  // Needs the previous list itself, not just its owner's id: the new array is
  // written to Firestore in this same call,
  // so a functional state update alone would not hand it back for that.
  const toggleFollowAuthor = useCallback(async (authorName: string) => {
    const { next, patch } = toggleFollowedAuthor(followedAuthors, authorName);
    setFollowedAuthors(next);

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), patch, { merge: true });
    }
  }, [followedAuthors, user?.uid]);

  // Same reasoning: `previous` is what a failed write rolls back to, read from
  // the closure rather than from a functional update the error path could not
  // reach.
  const updateReadingPreferences = useCallback((updates: Partial<ReadingPreferences>) => {
    const userId = user?.uid;
    return writeOptimistically({
      previous: readingPreferences,
      next: normalizeReadingPreferences({ ...readingPreferences, ...updates }),
      apply: setReadingPreferences,
      startedBy: userId,
      signedInUid: () => auth.currentUser?.uid,
      write: async (next) => {

        if (userId) {
          await setDoc(doc(db, 'users', userId), {
            readingPreferences: next,
          }, { merge: true });
        }
      },
    });
  }, [readingPreferences, user?.uid]);

  // The pending yes is spent once the subscription exists (or the reader has
  // since decided for themselves), so a later unsubscribe is never undone.
  const settleEmailDigestOptIn = useCallback(async () => {
    const userId = user?.uid;
    if (!userId) return;
    await setDoc(doc(db, 'users', userId), { emailDigestOptIn: deleteField() }, { merge: true });
    if (auth.currentUser?.uid === userId) setEmailDigestPending(false);
  }, [user?.uid]);

  // Every key here is either a primitive/state value (already stable — React
  // only replaces it when its own setter is called) or one of the callbacks
  // above, each wrapped in `useCallback` with the narrowest deps its body
  // actually reads. Wrapping this object without that would have changed
  // nothing: a `useMemo` recomputes whenever anything in its dependency list
  // has a new identity, and an unwrapped function has a new identity every
  // render regardless of what it reads.
  const value = useMemo(() => ({
    user,
    loading,
    error,
    onboardingComplete,
    userPreferences,
    deselectedPreferences,
    addedPreferences,
    followedAuthors,
    readingPreferences,
    emailDigestPending,
    profileLoadError,
    signInProviders,
    institution,
    signInWithGoogle,
    signInWithGitHub,
    linkSignInMethod,
    linkInstitution,
    completeInstitutionVerification,
    unlinkInstitution,
    signOut,
    completeOnboarding,
    settleEmailDigestOptIn,
    updatePreferences,
    setUserPreferences,
    toggleFollowAuthor,
    updateReadingPreferences,
    retryProfileLoad,
  }), [
    addedPreferences, completeOnboarding, completeInstitutionVerification, deselectedPreferences, emailDigestPending, error, followedAuthors, institution, linkInstitution,
    linkSignInMethod, loading, onboardingComplete, profileLoadError, readingPreferences,
    retryProfileLoad, setUserPreferences, settleEmailDigestOptIn, signInProviders, signInWithGitHub,
    signInWithGoogle, signOut, toggleFollowAuthor, unlinkInstitution, updatePreferences,
    updateReadingPreferences, user, userPreferences,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
