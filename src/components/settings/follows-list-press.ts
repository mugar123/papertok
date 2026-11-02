import type { ActionStart } from '../ui/toast.ts';
import { actionStart, sameAccount } from '../ui/toast.ts';

/**
 * `actionStart()` for a press in the Follows list, noted as it is made,
 * leaving out the overlays that leave with it: the phone sheet the list is
 * in, while it is open, and for an Unfollow the question that asks first,
 * where it is pressed. The unfollow is written once the question has left
 * (`onOpenChangeComplete`), but noted then, an overlay the reader opened
 * while the question left, such as the search palette, would count as open
 * before the press, and the unfollow's refusal would not wait for it.
 */
export function followsListPress({ press, inOpenSheet }: { press: 'unfollow' | 'undo'; inOpenSheet: boolean }) {
  return actionStart({ leaving: Number(press === 'unfollow') + Number(inOpenSheet) });
}

/**
 * The unfollow to write once the question has left: the entity it asked
 * about, with the press noted when Unfollow was pressed in it. None when the
 * question was cancelled, or when the account changed during its leave: the
 * write would then unfollow in the account signed in now.
 */
export function unfollowOnLeave<Entity>({ confirmedAt, unfollowing }: { confirmedAt: ActionStart | null; unfollowing: Entity | null }) {
  if (!confirmedAt || !unfollowing || !sameAccount(confirmedAt)) return null;
  return { entity: unfollowing, startedAt: confirmedAt };
}
