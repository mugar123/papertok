import { createElement } from 'react';
import './empty-state.css';

/**
 * The app's empty state, so every one reads the same on desktop and phone:
 * `art` (a Petri pose, or an icon with `icon`), the `title`, the `children`
 * as the body line, and `actions` underneath. `as` is the title's heading
 * level for where it sits; other props (role, aria-*) land on the wrapper.
 */
export function EmptyState({ art, icon = false, title, children, actions, as = 'h2', className = '', ...props }) {
  return (
    <div className={`empty-state ${className}`.trim()} {...props}>
      {art && <div className={`empty-state-art${icon ? ' empty-state-art--icon' : ''}`} aria-hidden="true">{art}</div>}
      {createElement(as, { className: 'empty-state-title' }, title)}
      {children && <p className="empty-state-body">{children}</p>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}
