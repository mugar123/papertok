/**
 * How the paper viewer shows a paper on this device, like the theme
 * (`theme.ts`): a display choice, kept in this browser and read by every open
 * tab. Absent means the default, which is to start at the paper's first section.
 */
export const SHOW_ABSTRACT_STORAGE_KEY = 'papertok_reader_show_abstract';

const changes = new EventTarget();

export function readShowAbstract() {
  try {
    return window.localStorage.getItem(SHOW_ABSTRACT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveShowAbstract(show: boolean) {
  try {
    if (show) window.localStorage.setItem(SHOW_ABSTRACT_STORAGE_KEY, 'true');
    else window.localStorage.removeItem(SHOW_ABSTRACT_STORAGE_KEY);
  } catch {
    // Unavailable storage: the choice is not kept.
  }
  changes.dispatchEvent(new Event('change'));
}

export function subscribeShowAbstract(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === SHOW_ABSTRACT_STORAGE_KEY) onChange(); };
  changes.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    changes.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
  };
}
