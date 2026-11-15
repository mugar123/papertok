import { useEffect, useEffectEvent } from 'react';

export function usePageRestored(onRestored: () => void) {
  const restored = useEffectEvent(onRestored);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) restored(); };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
}
