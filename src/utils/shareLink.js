/**
 * Share a link through the platform share sheet when there is one, falling
 * back to the clipboard when there is not — or when the sheet refuses, which
 * happens legitimately: transient user activation can expire while an await
 * (say, publishing the list) sits between the click and the share call.
 *
 * The caller supplies `copy` because every screen already has its own
 * clipboard routine with its own analytics and feedback; this helper only
 * decides which path ran, it does not own the consequences.
 */

function defaultNativeShare() {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return null;
  return data => navigator.share(data);
}

/**
 * Returns how the link left the app:
 *   'shared'  — the native sheet took it; the sheet itself was the feedback.
 *   'aborted' — the user opened the sheet and closed it; nothing happened,
 *               and re-showing feedback for it would read as an error.
 *   'copied'  — clipboard path, either as fallback or because there is no
 *               native sheet. A clipboard failure propagates to the caller,
 *               which already knows how to render that.
 */
export async function shareOrCopyLink({ url, title, copy, share }) {
  if (typeof copy !== 'function') throw new TypeError('A copy fallback is required.');
  const nativeShare = share === undefined ? defaultNativeShare() : share;

  if (nativeShare) {
    try {
      await nativeShare(title ? { title, url } : { url });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'aborted';
      // NotAllowedError, DataError, anything else: the sheet did not take it.
    }
  }

  await copy(url);
  return 'copied';
}
