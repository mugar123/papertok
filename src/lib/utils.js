import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges class names, letting a caller's utility win over a component default. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
