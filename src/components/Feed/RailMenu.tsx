import type { ComponentProps, ReactNode, SyntheticEvent } from 'react';

import { Menu } from '@base-ui/react/menu';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
// The rail's two overflow buttons open the same surface (SharePanel.css).
import './SharePanel.css';

/**
 * What a rail button opens: a menu to the left of it on desktop, or a bottom
 * drawer of thumb-sized rows on a phone (useIsPhone, followed live). `menu`
 * holds the Menu items, `sheet` the drawer's `<li>` rows; either closes on an
 * outside press, Escape or (the drawer) a swipe down, and gives focus back to
 * the button.
 */
export default function RailMenu({ title, trigger, menu, sheet }: { title: string; trigger: ComponentProps<typeof Menu.Trigger>['render']; menu?: ReactNode; sheet: ReactNode }) {
  // Either surface portals to the body, but React still bubbles its clicks
  // up to the card, whose double tap is a like.
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="pc-share-sheet" viewportProps={{ onClick: stop }}>
          <DrawerHandle />
          <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{title}</DrawerTitle>
          <ul className="pc-menu-group">{sheet}</ul>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="pc-share-menu-positioner" side="left" align="center" sideOffset={12}>
          <Menu.Popup className="pc-share-menu" aria-label={title} onClick={stop}>{menu}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
