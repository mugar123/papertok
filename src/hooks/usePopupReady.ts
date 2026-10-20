import type { PopupReadiness } from '../services/popupRedirectResolver.ts';
import { useSyncExternalStore } from 'react';

const subscribeToNothing = () => () => {};

/**
 * False while a press could not open a Google or GitHub window inside the tap
 * (popupRedirectResolver.ts). A control that opens one stays disabled until
 * then. `null` is a control that opens no window right now.
 */
export default function usePopupReady(readiness: PopupReadiness | null) {
  return useSyncExternalStore(readiness?.subscribe ?? subscribeToNothing, () => readiness?.ready ?? true);
}
