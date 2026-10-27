import type { PopupReadiness, PopupReadinessState } from '../services/popup-redirect-resolver.ts';
import { useSyncExternalStore } from 'react';

const subscribeToNothing = () => () => {};

/**
 * Whether a press could open a Google or GitHub window inside the tap
 * (popup-redirect-resolver.ts). A control that opens one stays disabled until
 * this is `ready`. `null` is a control that opens no window right now.
 */
export default function usePopupReady(readiness: PopupReadiness | null): PopupReadinessState {
  return useSyncExternalStore(readiness?.subscribe ?? subscribeToNothing, () => readiness?.state ?? 'ready');
}
