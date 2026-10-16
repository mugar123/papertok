/**
 * Copy text to the clipboard, with the `execCommand` path for the browsers
 * that still refuse the async API outside a narrow set of conditions.
 *
 * Lifted out of ListsPage so the public list page shares one definition
 * instead of growing a second, subtly different copy — the async API alone
 * silently does nothing on older Safari, which reads as "the button is
 * broken" rather than as a missing capability.
 *
 * Throws when the copy did not happen, so callers can tell success from
 * failure instead of showing "copied" over nothing.
 */
export async function copyText(value) {
  // Presence is not permission: `writeText` exists and still rejects with
  // NotAllowedError inside embedded browsers, in non-secure contexts, and when
  // the document lost transient activation. Falling through on rejection —
  // rather than only when the method is missing — is what makes the button work
  // there instead of reporting a failure the older path would have handled.
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(value);
      return;
    } catch {
      // fall through to the execCommand path below
    }
  }
  if (typeof document === 'undefined') throw new Error('Clipboard access is unavailable.');
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}
