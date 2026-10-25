/**
 * The order of an account deletion once the person has typed the phrase.
 *
 * Browsers block a popup that is not opened by the user's gesture, so
 * `reauthenticate` is the first thing called, before anything is awaited.
 * The uid it returns, the account that just signed in again, is the one
 * deleted: the session can switch while the sign-in window is open, so
 * whoever holds it afterwards is never asked.
 */
export async function deleteConfirmedAccount({ reauthenticate, onSignedIn, deleteAccount, onDeleted }: {
  reauthenticate: () => Promise<string>;
  onSignedIn: () => void;
  deleteAccount: (confirmedUid: string) => Promise<unknown>;
  onDeleted: () => void | Promise<void>;
}) {
  const confirmedUid = await reauthenticate();
  onSignedIn();
  await deleteAccount(confirmedUid);
  await onDeleted();
}
