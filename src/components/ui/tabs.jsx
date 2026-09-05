import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '../../lib/utils.js';

/**
 * Tabs in the app's two shapes. `line` (default): a row over a hairline,
 * the active tab underlined in the brand yellow — that is one of the four
 * places the yellow is allowed (design.md, rule 3). `pill`: the sunken
 * track with a raised chip, for a compact switch inside a sheet.
 *
 * Base UI marks the selected tab with `data-active` and gives the list
 * arrow-key navigation; `Tabs.Indicator` is drawn under the active tab
 * with the `--active-tab-*` variables it exposes, so it slides between
 * tabs with a transition and never needs measuring.
 */
function Tabs({ className, orientation = 'horizontal', ...props }) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn('flex gap-3 data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

function TabsList({ className, variant = 'line', children, ...props }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        'relative flex items-center',
        variant === 'line' && 'gap-1 border-b border-border',
        variant === 'pill' && 'w-fit gap-1 rounded-md border border-border bg-secondary p-1',
        className,
      )}
      {...props}
    >
      {children}
      {variant === 'line' && (
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className={cn(
            'absolute bottom-[-1px] left-0 h-[3px] w-(--active-tab-width) translate-x-(--active-tab-left) bg-brand',
            'motion-safe:transition-[translate,width] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]',
          )}
        />
      )}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium text-muted-foreground transition-colors',
        'hover:text-foreground data-active:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        // line: a text tab with breathing room above the rule
        'in-data-[variant=line]:min-h-10 in-data-[variant=line]:px-2 in-data-[variant=line]:text-[0.8125rem] in-data-[variant=line]:data-active:font-semibold',
        // pill: the raised chip
        'in-data-[variant=pill]:h-7 in-data-[variant=pill]:rounded-sm in-data-[variant=pill]:px-3 in-data-[variant=pill]:text-[0.75rem]',
        'in-data-[variant=pill]:data-active:bg-card in-data-[variant=pill]:data-active:font-semibold in-data-[variant=pill]:data-active:shadow-[var(--shadow-sm)]',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
