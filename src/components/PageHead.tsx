import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';

interface PageHeadProps {
  /** Glyph beside the title, from the wallet's own icon set. */
  icon: IconName;
  title: string;
  /** One line explaining what the view is for. Optional, but almost always worth it. */
  sub?: string;
  /** Controls that belong to the whole view rather than to one card inside it. */
  actions?: ReactNode;
}

/**
 * The heading every view opens with: one `<h1>`, a subtitle, and an optional
 * action slot on the right.
 *
 * It exists as a component because the app previously had six heading elements in
 * total, all of them inside modals — every view was a stack of cards with no
 * top-level title, which left both the screen reader outline and the visual "where
 * am I" empty. Making it a component is also what keeps the heading level at one
 * per page: a view cannot accidentally ship a second `<h1>`.
 */
export function PageHead({ icon, title, sub, actions }: PageHeadProps) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">
          <span className="icon">
            <Icon name={icon} size={22} />
          </span>
          {title}
        </h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
