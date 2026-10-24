import { hydrateAccountCaches, resetAccountWarmup, warmAccountCaches } from '../services/account-warmup.ts';
import { clearGuestInterests } from '../utils/guest-interests.ts';
import { forgetOwnLists } from '../utils/profile-session-caches.ts';
import { clearUserScopedStorage, readStoredOnboarding, saveStoredOnboarding } from '../utils/user-scoped-storage.ts';

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type WarmupOptions = NonNullable<Parameters<typeof warmAccountCaches>[1]>;

/**
 * An account signed in: this device's copy of its lists goes into the
 * session, a background read refreshes them, and the onboarding this device
 * remembers for the account is returned for the first paint.
 */
export function openAccountSession(uid: string, devices: WarmupOptions = {}) {
  hydrateAccountCaches(uid, { storage: devices.storage });
  void warmAccountCaches(uid, devices);
  return readStoredOnboarding(uid, devices.storage);
}

/**
 * An account signed out: nothing it left on this device or in the session may
 * reach the next account. A guest answer still waiting for adoption belonged
 * to this session too, and a warm-up still in flight writes nothing.
 */
export function closeAccountSession(userId: string | undefined, storage?: DeviceStorage) {
  clearGuestInterests(storage);
  clearUserScopedStorage(userId, storage);
  forgetOwnLists(userId);
  resetAccountWarmup(userId);
}

/**
 * The profile holds the account's interests: this device remembers the
 * onboarding as finished, and the guest answer that seeded it is spent, so it
 * cannot seed the next new account on this device.
 */
export function adoptOnboardedProfile(userId: string, preferences: string[], storage?: DeviceStorage) {
  saveStoredOnboarding(userId, { complete: true, preferences }, storage);
  clearGuestInterests(storage);
}
