/**
 * Where a visit to the public profile editor (/settings/profile) came from.
 *
 * The editor is reached from two places that speak differently: the settings
 * hub, whose section it belongs to, and the owner's own profile page, whose
 * gear and "Edit profile" lead straight to it. The screen's heading names the
 * hub by default; a visit from the profile says so instead, and its back
 * control says where it returns to. Router state carries the fact, because
 * neither the URL nor the history entry knows which door was used.
 *
 * Lives in its own module so the page that sends and the page that reads
 * cannot drift apart on the spelling of one string.
 */
export const EDITOR_ORIGIN_PROFILE = 'profile';

/** The second argument of `navigate('/settings/profile', …)` from the profile. */
export const EDITOR_FROM_PROFILE = Object.freeze({
  state: Object.freeze({ from: EDITOR_ORIGIN_PROFILE }),
});

/** Whether the current location was reached through the profile's doors. */
export function cameFromProfile(location) {
  return location?.state?.from === EDITOR_ORIGIN_PROFILE;
}
