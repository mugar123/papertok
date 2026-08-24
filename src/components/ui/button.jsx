import { Slot } from '@radix-ui/react-slot';
import { cn } from '../../lib/utils.js';
import { buttonVariants } from './button-variants.js';

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
