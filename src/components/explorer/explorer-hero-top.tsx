import type { ReactNode } from 'react';
import { ArrowLeft } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';

/**
 * The bar over the explorer hero, shared by the skeleton and the live hero so
 * both put Back, the actions and Privacy in the same slots. React then keeps
 * one instance of each across the swap: a visitor who opened Privacy while the
 * entity was coming keeps it open, with focus, when the entity arrives.
 * `actions` may be empty (the skeleton has none); its slot stays.
 */
export default function ExplorerHeroTop({ onBack, actions, privacy }: {
  onBack: () => void;
  actions?: ReactNode;
  privacy?: ReactNode;
}) {
  return (
    <div className="explorer-hero-top">
      <div className="eht-left">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={'Back'} title={'Back'}>
          <ArrowLeft size={20} />
        </Button>
      </div>
      {actions ?? null}
      {privacy ?? null}
    </div>
  );
}
