/**
 * The breadcrumb every /settings/* sub-page wears above its title.
 *
 * All three sub-pages are reached from one section of the hub, so they say so
 * in one voice — and in one place, because three copies of this string drift
 * the day the hub renumbers its sections. The number tracks
 * SETTINGS_SECTIONS in SettingsPage.jsx.
 *
 * Lives in its own module rather than beside the component that renders it:
 * a file that exports both a component and a constant loses Fast Refresh.
 */
export const SETTINGS_BREADCRUMB = {
  es: 'Ajustes · 02 Descubrimiento',
  en: 'Settings · 02 Discovery',
};
