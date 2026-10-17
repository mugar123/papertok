import { Menu } from '@base-ui/react/menu';
import { DrawerClose } from '../ui/drawer.jsx';
import RailMenu from './RailMenu.jsx';

/**
 * The rail's "more" button: the card's secondary actions (mark as read, skip,
 * citation export). `items` is `{ id, label, Icon, onSelect }`; picking one
 * closes the surface first. Only actions on the paper inside PaperTok belong
 * here: a link out (the DOI record) stays a chip in the metadata band.
 */
export default function MoreActions({ trigger, items }) {
  return (
    <RailMenu
      title="More actions"
      trigger={trigger}
      menu={items.map(({ id, label, Icon, onSelect }) => (
        <Menu.Item key={id} className="pc-share-menu-item" onClick={onSelect}>
          <Icon size={16} aria-hidden="true" />
          {label}
        </Menu.Item>
      ))}
      sheet={items.map(({ id, label, Icon, onSelect }) => (
        <li key={id}>
          <DrawerClose className="pc-share-row" onClick={onSelect}>
            <Icon size={20} aria-hidden="true" />
            {label}
          </DrawerClose>
        </li>
      ))}
    />
  );
}
