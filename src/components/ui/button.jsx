import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '../../lib/utils.js';
import { buttonVariants } from './button-variants.js';

/**
 * The only button (design.md, rule 5) — shadcn's Base UI button, with this
 * project's variants. The primitive owns the native-button semantics; to
 * compose with something that is not a `<button>` (a link, a router Link,
 * another Base UI trigger) pass it through `render`:
 *
 *   <Button variant="outline" render={<a href={url} />}>Open</Button>
 *
 * That is what Radix's `asChild` used to do. A non-button `render` is told
 * apart so the primitive stops pretending it is one (`nativeButton`), unless
 * the caller says otherwise.
 */
export function Button({ className, variant, size, render, nativeButton, ...props }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      render={render}
      nativeButton={nativeButton ?? (render ? render.type === 'button' : true)}
      {...props}
    />
  );
}
