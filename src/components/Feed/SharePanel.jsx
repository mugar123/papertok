import { Copy, InstagramLogo, LinkedinLogo, LinkSimple, RedditLogo, WhatsappLogo, XLogo } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Menu } from '@base-ui/react/menu';
import { DrawerClose } from '../ui/drawer.jsx';
import { paperShareData } from '../../utils/shareLink.js';
import RailMenu from './RailMenu.jsx';

const enc = encodeURIComponent;

// Where a paper can go: each network's own share link, built from the title
// as plain text and the link. Instagram has none on the web, so it comes
// last and copies the link, saying where to paste it.
const NETWORKS = [
  { id: 'x', name: 'X', Icon: XLogo, href: ({ text, url }) => `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
  { id: 'reddit', name: 'Reddit', Icon: RedditLogo, href: ({ text, url }) => `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(text)}` },
  { id: 'linkedin', name: 'LinkedIn', Icon: LinkedinLogo, href: ({ url }) => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  { id: 'whatsapp', name: 'WhatsApp', Icon: WhatsappLogo, href: ({ text, url }) => `https://wa.me/?text=${enc(`${text} ${url}`)}` },
  { id: 'instagram', name: 'Instagram', Icon: InstagramLogo, href: null },
];

const INSTAGRAM_NOTE = 'Link copied. Paste it in your Instagram story or bio.';

async function copyLink({ url, onShared, method, message, position }) {
  try {
    await navigator.clipboard.writeText(url);
  } catch (error) {
    console.error('Could not copy paper link', error);
    toast.error('Could not copy the link', { position });
    return;
  }
  onShared?.(method);
  toast.success(message, { position });
}

/**
 * The paper card's share panel, opened by `trigger` (the rail's share
 * button), in the rail's own surface (RailMenu): the same plain list either
 * way, the way an OS share menu reads: the link first (the share most people
 * want), then each network by name, Instagram last since it can only copy.
 */
export default function SharePanel({ title, url, onShared, trigger }) {
  const { text = '' } = paperShareData({ title, url });
  const shown = url.replace(/^https?:\/\//, '');
  // Either surface closes on a pick, so a copy confirms in a toast; on a phone
  // it comes in at the top, clear of the thumb and of the sheet leaving below.
  const copy = (method, message, position) => copyLink({ url, onShared, method, message, position });
  return (
    <RailMenu
      title="Share paper"
      trigger={trigger}
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
        </>
      )}
    />
  );
}
