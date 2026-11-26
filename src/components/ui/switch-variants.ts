import { cva } from 'class-variance-authority';

// Lives apart from switch.tsx so that file exports only a component.
// Track, thumb and travel are all rem, so the switch grows with the browser's
// text size as one piece. The track is `box-content`: its 1px hairline sits
// outside the rem box, and the thumb keeps the same inset on every side.
export const switchTrack = cva(
  'peer relative box-content inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-colors border-[var(--border-strong)] bg-[var(--bg-sunken)] data-checked:border-[var(--border-ink)] data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-5 w-9',
        sm: 'h-4 w-7',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

// Off, the thumb is muted ink on the sunken track; on, paper on the ink one.
// A paper thumb would all but vanish on the sunken track (about 1.1:1), where
// a control's state needs 3:1; muted ink is 5.15:1 (6.95:1 dark), and the
// lighter border tokens stay under 3:1. Its colour changes with the track's
// under reduced motion too; only the travel is gated.
export const switchThumb = cva(
  'pointer-events-none block rounded-full bg-[var(--text-tertiary)] data-checked:bg-card shadow-[var(--shadow-sm)] transition-[background-color] duration-150 motion-safe:transition-[translate,background-color] translate-x-0.5',
  {
    variants: {
      size: {
        default: 'size-4 data-checked:translate-x-4.5',
        sm: 'size-3 data-checked:translate-x-3.5',
      },
    },
    defaultVariants: { size: 'default' },
  },
);
