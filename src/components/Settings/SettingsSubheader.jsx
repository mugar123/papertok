import { ArrowLeft } from 'lucide-react';
import './SettingsSubheader.css';

/**
 * The heading every screen under /settings/* wears.
 *
 * The three sub-pages grew their own headers separately and ended up with
 * three back affordances and three different eyebrows for what the hub files
 * under one section. This is that header, once: the square back control, the
 * breadcrumb that names the hub section the page belongs to, and the title.
 *
 * `children` is the slot for a page-specific line under the subtitle — the
 * public profile's link to its own page is the only one so far.
 */
export default function SettingsSubheader({
  eyebrow,
  title,
  subtitle,
  backLabel,
  onBack,
  children,
}) {
  return (
    <header className="settings-subheader">
      <button
        type="button"
        className="settings-subheader-back"
        onClick={onBack}
        aria-label={backLabel}
        title={backLabel}
      >
        <ArrowLeft size={18} />
      </button>
      <div className="settings-subheader-copy">
        <span className="settings-subheader-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </div>
    </header>
  );
}
