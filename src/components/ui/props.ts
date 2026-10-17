import type { ComponentProps, ElementType } from 'react';

// These wrappers merge class names with cn; they do not invoke Base UI class callbacks.
export type StyledProps<T extends ElementType> = Omit<ComponentProps<T>, 'className'> & {
  className?: string;
};
