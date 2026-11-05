import type { StyledProps } from './props.ts';
import type { ComponentProps } from 'react';

import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';
import { cn } from '../../lib/utils.ts';

/**
 * A card that opens while a link is hovered or focused, to see where it leads
 * before following it. A pointer that cannot hover just follows the link.
 */
function PreviewCard(props: ComponentProps<typeof PreviewCardPrimitive.Root>) {
  return <PreviewCardPrimitive.Root data-slot="preview-card" {...props} />;
}

function PreviewCardTrigger(props: ComponentProps<typeof PreviewCardPrimitive.Trigger>) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

function PreviewCardContent({
  className,
  align = 'center',
  side = 'bottom',
  sideOffset = 8,
  positionerClassName,
  ...props
}: StyledProps<typeof PreviewCardPrimitive.Popup> & Pick<ComponentProps<typeof PreviewCardPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'> & { positionerClassName?: string }) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className={cn('isolate z-[12110]', positionerClassName)}>
        <PreviewCardPrimitive.Popup
          data-slot="preview-card-content"
          className={cn(
            'w-80 origin-(--transform-origin) rounded-xl border border-border bg-card p-4 text-[0.8125rem] text-foreground shadow-[var(--shadow-lg)] outline-none',
            'motion-safe:[transition:opacity_150ms_linear,scale_180ms_var(--ease-out-expo)]',
            'motion-reduce:[transition:opacity_150ms_linear]',
            'motion-safe:data-ending-style:[transition:opacity_120ms_linear,scale_120ms_var(--ease-out-expo)]',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.96] data-ending-style:opacity-0 data-ending-style:scale-[0.98]',
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardContent, PreviewCardTrigger };
