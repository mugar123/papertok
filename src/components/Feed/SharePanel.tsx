import type { ComponentProps } from 'react';
import type { ExternalToast } from 'sonner';
import type { Shared } from './shareTargets.ts';

import { ArrowSquareOut, Copy, LinkSimple } from '@phosphor-icons/react';
import { Menu } from '@base-ui/react/menu';
import { DrawerClose } from '../ui/drawer.tsx';
import { paperShareData } from '../../utils/shareLink.ts';
import RailMenu from './RailMenu.tsx';
import { INSTAGRAM_NOTE, NETWORKS, copyLink } from './shareTargets.ts';

/**
 * A share menu opened by `trigger`, in the rail's surface (RailMenu): a menu
 * on desktop, a drawer on a phone, the same plain list either way: the link
 * first, then each network by name, Instagram last since it can only copy.
 * `links` are outside pages the drawer lists after the networks; on desktop
 * the caller shows them beside the trigger.
 */
export default function SharePanel({ title, url, onShared, trigger, heading = 'Share', side, align, links = [] }: {
  title: string; url: string; onShared?: Shared; trigger: ComponentProps<typeof RailMenu>['trigger'];
  heading?: string; links?: { label: string; href: string }[]; side?: ComponentProps<typeof RailMenu>['side']; align?: ComponentProps<typeof RailMenu>['align'];
}) {
  const { text = '' } = paperShareData({ title, url });
  const shown = url.replace(/^https?:\/\//, '');
  // Either surface closes on a pick, so a copy confirms in a toast; on a phone
  // it comes in at the top, clear of the thumb and of the sheet leaving below.
  const copy = (method: string, message: string, position?: ExternalToast['position']) => { void copyLink({ url, onShared, method, message, position }); };
  return (
    <RailMenu
      title={heading}
      trigger={trigger}
      side={side}
      align={align}
      menu={(
        <>
          <Menu.Item className="pc-share-menu-item" onClick={() => copy('clipboard', 'Link copied')}>
            <LinkSimple size={16} aria-hidden="true" />
            Copy link
          </Menu.Item>
          <Menu.Separator className="pc-share-menu-separator" />
          {NETWORKS.map(({ id, name, Icon, href }) => (href ? (
            <Menu.LinkItem
              key={id}
              className="pc-share-menu-item"
              href={href({ text, url })}
              target="_blank"
              rel="noopener noreferrer"
              closeOnClick
              onClick={() => onShared?.(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {name}
            </Menu.LinkItem>
          ) : (
            <Menu.Item key={id} className="pc-share-menu-item" onClick={() => copy(id, INSTAGRAM_NOTE)}>
              <Icon size={16} aria-hidden="true" />
              {name}
              <span className="pc-share-menu-note">copies link</span>
            </Menu.Item>
          )))}
        </>
      )}
      // Phone: rows a thumb can hit (52px). The first row shows the link
      // itself, with a copy button; the whole row copies.
      sheet={(
        <>
          <li>
            <DrawerClose className="pc-share-row pc-share-row--link" aria-label={`Copy link ${shown}`} onClick={() => copy('clipboard', 'Link copied', 'top-center')}>
              <LinkSimple size={20} aria-hidden="true" />
              <span className="pc-share-url">{shown}</span>
              <span className="pc-share-copy" aria-hidden="true"><Copy size={16} /></span>
            </DrawerClose>
          </li>
          <li className="pc-share-list-separator" aria-hidden="true" />
          {NETWORKS.map(({ id, name, Icon, href }) => (
            <li key={id}>
              {href ? (
                <a className="pc-share-row" href={href({ text, url })} target="_blank" rel="noopener noreferrer" onClick={() => onShared?.(id)}>
                  <Icon size={20} aria-hidden="true" />
                  {name}
                </a>
              ) : (
                <DrawerClose className="pc-share-row" onClick={() => copy(id, INSTAGRAM_NOTE, 'top-center')}>
                  <Icon size={20} aria-hidden="true" />
                  {name}
                  <span className="pc-share-menu-note">copies link</span>
                </DrawerClose>
              )}
            </li>
          ))}
          {links.length > 0 && <li className="pc-share-list-separator" aria-hidden="true" />}
          {links.map(({ label, href }) => (
            <li key={href}>
              <a className="pc-share-row" href={href} target="_blank" rel="noopener noreferrer">
                <ArrowSquareOut size={20} aria-hidden="true" />
                {label}
              </a>
            </li>
          ))}
        </>
      )}
    />
  );
}
