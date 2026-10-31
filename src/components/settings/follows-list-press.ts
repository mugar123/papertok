import { actionStart } from '../ui/toast.ts';

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
