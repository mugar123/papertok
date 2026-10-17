import type { Icon } from '@phosphor-icons/react';
import type { ComponentProps, MouseEvent } from 'react';

import { Menu } from '@base-ui/react/menu';
import { DrawerClose } from '../ui/drawer.tsx';
import RailMenu from './RailMenu.tsx';

/**
 * The rail's "more" button: the card's secondary actions (mark as read, skip,
 * citation export). `items` is `{ id, label, Icon, onSelect }`; picking one
 * closes the surface first. Only actions on the paper inside PaperTok belong
 * here: a link out (the DOI record) stays a chip in the metadata band.
 */
export default function MoreActions({ trigger, items }: { trigger: ComponentProps<typeof RailMenu>['trigger']; items: Array<{ id: string; label: string; Icon: Icon; onSelect: (event: MouseEvent) => void }> }) {
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
