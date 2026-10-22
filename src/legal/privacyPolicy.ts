/**
 * The privacy policy version the app announces. privacy.html promises that a
 * meaningful change updates its "Last updated" date and is announced in the
 * app; NudgeHost shows PRIVACY_POLICY_CHANGE to each reader until they dismiss
 * this PRIVACY_POLICY_VERSION.
 *
 * Whoever makes such a change to privacy.html sets the version to its new date
 * and rewrites the change to say what changed since the previous version, in
 * one sentence. privacy.test.ts fails while the version and the page's date
 * disagree. A second change on a day that already has a version takes a suffix
 * ('2026-10-22.2'), so readers who dismissed the first notice still hear of it.
 */
export const PRIVACY_POLICY_VERSION = '2026-10-22';

export const PRIVACY_POLICY_CHANGE = 'Technical error reports go to Sentry, your feed sends our server the identifiers of papers you liked or saved to rank new ones, and Brevo delivers university verification emails.';
