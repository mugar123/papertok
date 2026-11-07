import { analyticsConsentState } from './analytics-service.ts';
import { auth } from './firebase.ts';

/**
 * The consent and account an analytics session (the PDF viewer's, the reader's
 * time) belongs to, read when asked rather than from the last render: a session
 * that ends in the commit that switches the account would otherwise compare
 * against the old account and send its time after PostHog was identified as
 * the new one.
 */
export function analyticsSessionContext() {
  return `${analyticsConsentState()}|${auth.currentUser?.uid ?? ''}`;
}
