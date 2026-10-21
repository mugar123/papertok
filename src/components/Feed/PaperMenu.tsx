import type { Icon } from '@phosphor-icons/react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, ReactElement, ReactNode, SyntheticEvent } from 'react';
import type { ExternalToast } from 'sonner';
import type { Shared } from './shareTargets.ts';

export interface PaperMenuAction { id: string; label: string; hint: string; Icon: Icon; onSelect: (event: MouseEvent) => void }
export interface PaperMenuPanel { id: string; title: string; content: ReactNode; className?: string; style?: CSSProperties; onBack: () => void }

import { cloneElement, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, LinkSimple } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import { cn } from '../../lib/utils.ts';
import { paperShareData } from '../../utils/shareLink.ts';
import { INSTAGRAM_NOTE, NETWORKS, copyLink } from './shareTargets.ts';
import './SharePanel.css';

export default function PaperMenu({ title, url, onShared, actions, trigger, open, onOpenChange, panel }: {
  title: string; url?: string | null; onShared?: Shared; actions: PaperMenuAction[]; trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean; onOpenChange: (open: boolean) => void; panel?: PaperMenuPanel | null;
}) {
  const isPhone = useIsPhone();
  const listRef = useRef<HTMLUListElement>(null);
  const leftPanel = useRef<string | null>(null);
  // Whether the actions on screen were reached by the back arrow, so they
  // come in from the side they went out by. A fresh open is the surface's own
  // arrival and moves nothing inside it.
  const [cameBack, setCameBack] = useState(false);
  if (!open && cameBack) setCameBack(false);
  useEffect(() => {
    if (panel) {
      leftPanel.current = panel.id;
      return;
    }
    const back = leftPanel.current;
    leftPanel.current = null;
    if (back) listRef.current?.querySelector<HTMLElement>(`[data-action="${back}"]`)?.focus();
  }, [panel]);
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const position: ExternalToast['position'] = isPhone ? 'top-center' : undefined;
  const { text = '' } = url ? paperShareData({ title, url }) : {};
  const shown = url?.replace(/^https?:\/\//, '') ?? '';
  const pick = (run: () => void) => () => { onOpenChange(false); run(); };
  // One level under the title: an h2 in the dialog, an h3 in the sheet.
  const ShareHeading = isPhone ? 'h4' : 'h3';

  const rows = (
    <>
      <ul ref={listRef} className="pc-menu-group" aria-label="Paper actions">
        {actions.map(({ id, label, hint, Icon, onSelect }) => (
          <li key={id}>
            <button type="button" className="pc-menu-item" data-action={id} onClick={(event) => { onOpenChange(false); onSelect(event); }}>
              <span className="pc-menu-item-icon">
                <Icon size={20} aria-hidden="true" />
              </span>
              <span>
                <span className="pc-menu-item-label">{label}</span>
                <span className="pc-menu-item-hint">{hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {url && (
        <>
          <ShareHeading className="pc-menu-heading">{'Share'}</ShareHeading>
          <div className="pc-menu-group pc-menu-share">
            <button type="button" className="pc-menu-link" aria-label={`Copy link ${shown}`} onClick={pick(() => copyLink({ url, onShared, method: 'clipboard', message: 'Link copied', position }))}>
              <LinkSimple size={16} aria-hidden="true" />
              <span>{shown}</span>
              <Copy size={16} aria-hidden="true" />
            </button>
            <ul className="pc-menu-nets" aria-label="Share paper">
              {NETWORKS.map(({ id, name, Icon, href }) => (
                <li key={id}>
                  {href ? (
                    <a className="pc-menu-net" href={href({ text, url })} target="_blank" rel="noopener noreferrer" aria-label={name} title={name} onClick={pick(() => onShared?.(id))}>
                      <Icon size={18} aria-hidden="true" />
                    </a>
                  ) : (
                    <button type="button" className="pc-menu-net" aria-label={`${name}, copies the link`} title={name} onClick={pick(() => copyLink({ url, onShared, method: id, message: INSTAGRAM_NOTE, position }))}>
                      <Icon size={18} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );

  const opener = cloneElement(trigger, {
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    onClick: (event: MouseEvent) => { event.stopPropagation(); onOpenChange(true); },
  });

  const heading = panel?.title ?? 'Paper options';
  const enter = panel ? 'forward' : cameBack ? 'back' : undefined;
  const body = (
    <div key={panel?.id ?? 'actions'} className="pc-menu-stage" data-enter={enter}>
      <div className="pc-menu-head">
        {panel && (
          <button type="button" className="pc-menu-back" aria-label={'Back to paper options'} onClick={() => { setCameBack(true); panel.onBack(); }} autoFocus>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        )}
        {isPhone
          ? <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{heading}</DrawerTitle>
          : <DialogTitle className="pc-share-sheet-title">{heading}</DialogTitle>}
      </div>
      <div className={cn('pc-menu-view', panel?.className)} style={panel?.style}>
        {panel ? panel.content : rows}
      </div>
    </div>
  );

  return (
    <>
      {opener}
      {isPhone ? (
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent className="pc-share-sheet" viewportProps={{ onClick: stop }}>
            <DrawerHandle />
            {body}
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="pc-paper-menu" onClick={stop}>
            {body}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
