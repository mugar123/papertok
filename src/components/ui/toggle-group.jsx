import { useContext } from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '../../lib/utils.js';
import { ToggleGroupContext } from './toggle-group-context.js';

function ToggleGroup({ className, size = 'default', children, ...props }) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn('flex items-center gap-1 rounded-md border border-border bg-secondary p-1', className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({ className, children, ...props }) {
  const { size } = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors',
        'text-muted-foreground hover:text-foreground',
        // The selected state is a raised white chip on the sunken track.
        'data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[var(--shadow-sm)] data-[state=on]:font-semibold',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-[0.75rem]' : 'h-8 px-3 text-[0.8125rem]',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
