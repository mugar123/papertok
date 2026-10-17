import { Menu } from '@base-ui/react/menu';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.jsx';
import useIsPhone from '../../hooks/useIsPhone.js';
// The rail's two overflow buttons open the same surface (SharePanel.css).
import './SharePanel.css';

/**
 * What a rail button opens: a menu to the left of it on desktop, or a bottom
 * drawer of thumb-sized rows on a phone (useIsPhone, followed live). `menu`
 * holds the Menu items, `sheet` the drawer's `<li>` rows; either closes on an
 * outside press, Escape or (the drawer) a swipe down, and gives focus back to
 * the button.
 */
export default function RailMenu({ title, trigger, menu, sheet }) {
  // Either surface portals to the body, but React still bubbles its clicks
  // up to the card, whose double tap is a like.
  const stop = (event) => event.stopPropagation();
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="pc-share-sheet" onClick={stop}>
          <DrawerHandle />
          <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{title}</DrawerTitle>
          <ul className="pc-share-list">{sheet}</ul>
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
