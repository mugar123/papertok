import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '../../lib/utils.js';

/**
 * A range on a rail. One thumb for a value, two for a span (`value` as a
 * pair): the date range of the report. Base UI handles the keyboard, the
 * touch, `aria-valuetext` and the hidden inputs; `thumbAlignment="edge"`
 * keeps the thumbs inside the rail at both ends.
 *
 * `getAriaLabel(index)` names each thumb — bilingual copy, from the
 * caller. Meters are the one place `--radius-full` is allowed (rule 4).
 */
function Slider({ className, defaultValue, value, min = 0, max = 100, getAriaLabel, ...props }) {
  const values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min];
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn('w-full', className)}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-6 w-full touch-none select-none items-center data-disabled:opacity-50">
        <SliderPrimitive.Track data-slot="slider-track" className="relative h-1 w-full grow overflow-hidden rounded-full bg-[var(--border-default)]">
          <SliderPrimitive.Indicator data-slot="slider-range" className="h-full bg-primary" />
        </SliderPrimitive.Track>
        {values.map((_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            index={index}
            getAriaLabel={getAriaLabel}
            className={cn(
              'relative block size-4 shrink-0 rounded-full border border-[var(--border-ink)] bg-card shadow-[var(--shadow-sm)]',
              'transition-transform data-dragging:scale-110 disabled:pointer-events-none',
              // Focus lands on the hidden range input inside the thumb, where
              // the global ring cannot be seen: the thumb wears it instead.
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)]',
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
