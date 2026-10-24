/**
 * Writes a list the owner just created, from the lists page or the save
 * modal, and publishes it empty when it is public from the start.
 *
 * A failed write rejects: CreateListDialog owns the form, keeps itself open
 * and says it could not be created. Ending that failure in the console left
 * an unchanged screen behind. A failed publish leaves the list created but
 * private, and `onPublishFailed` tells the owner so.
 */
export async function writeNewList<List extends object>(newList: List, { isPublic, write, publish, onPublishFailed }: {
  isPublic: boolean;
  write: (list: List) => Promise<void>;
  publish: () => Promise<{ shareId?: string }>;
  onPublishFailed: (publishError: unknown) => void;
}) {
  await write(newList);
  if (!isPublic) return;
  try {
    const { shareId } = await publish();
    Object.assign(newList, { publicShareId: shareId, publicSyncedAt: new Date() });
  } catch (publishError) {
    onPublishFailed(publishError);
  }
}
