import type { ComponentProps } from 'react';

import { CheckCircle, CircleNotch, Info, Warning, XCircle } from '@phosphor-icons/react';
import { Toaster as Sonner } from 'sonner';
import { useTheme } from '../../context/ThemeContext.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';

/**
 * shadcn's Sonner wrapper, adapted: the theme comes from the app's own
 * ThemeContext (the light or dark actually in effect), the icons are Phosphor,
 * and the surface uses the app's tokens; on a phone it sits at the top.
 * Mounted once in App.jsx; anywhere
 * else calls `toast()` from 'sonner'. Sonner announces each toast to screen
 * readers through its own live region.
 */
function Toaster(props: ComponentProps<typeof Sonner>) {
  const { theme } = useTheme();
  const isPhone = useIsPhone();
  return (
    <Sonner
      theme={theme}
      // On a phone the bottom is the thumb's: the rail, the composer, the
      // sheets. Toasts come in at the top there, just under the navbar.
      position={isPhone ? 'top-center' : undefined}
      mobileOffset={{ top: 'calc(var(--nav-total) + var(--space-2))' }}
      className="toaster group"
      icons={{
        success: <CheckCircle size={16} weight="fill" aria-hidden="true" />,
        info: <Info size={16} aria-hidden="true" />,
        warning: <Warning size={16} aria-hidden="true" />,
        error: <XCircle size={16} weight="fill" aria-hidden="true" />,
        loading: <CircleNotch size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />,
      }}
      style={{
        '--normal-bg': 'var(--bg-card)',
        '--normal-text': 'var(--text-primary)',
        '--normal-border': 'var(--border-default)',
        '--border-radius': 'var(--radius-lg)',
      }}
      toastOptions={{ style: { fontFamily: 'var(--font-body)' } }}
      {...props}
    />
  );
}

export { Toaster };
