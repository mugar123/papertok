import { cn } from '../../lib/utils.js';

/**
 * The multi-line field, drawn like Input. `field-sizing: content` lets it
 * grow with what is typed until its `max-h`, which a caller sets in
 * viewport units (design.md, rule 7) — never a fixed `em`.
 */
function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-20 w-full rounded-md border border-border bg-card px-3 py-2 text-base leading-relaxed text-foreground transition-colors field-sizing-content',
        'placeholder:text-[var(--text-tertiary)] hover:border-[var(--border-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--tint-red-fg)]',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
