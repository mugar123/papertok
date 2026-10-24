import { useSyncExternalStore } from 'react';

// Where a popover or a menu becomes a bottom sheet.
const PHONE_QUERY = '(max-width: 600px)';

export default function useIsPhone() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
  );
}
