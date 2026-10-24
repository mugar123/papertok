import type { PopupReadiness } from '../services/popup-redirect-resolver.ts';
import { useSyncExternalStore } from 'react';

const subscribeToNothing = () => () => {};

/**
 * False while a press could not open a Google or GitHub window inside the tap
 * (popup-redirect-resolver.ts). A control that opens one stays disabled until
 * then. `null` is a control that opens no window right now.
 */
export default function usePopupReady(readiness: PopupReadiness | null) {
  return useSyncExternalStore(readiness?.subscribe ?? subscribeToNothing, () => readiness?.ready ?? true);
}
