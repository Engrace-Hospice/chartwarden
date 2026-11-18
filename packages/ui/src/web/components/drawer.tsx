// @chartwarden/ui — Drawer. The redesign's right-hand drawer for a record's form or detail: the
// `aside.wx-admission-drawer` column (sticky beside its list inside `.wx-list-drawer.has-drawer`), a head
// of [icon · title · subtitle · Close] and one body card. Focus, Escape and focus-return are `useDrawerA11y`'s.
// A confirmation or a signing ceremony is a Modal, not a Drawer: those must block the page until answered.
import type { JSX, ReactNode } from "react";
import { useDrawerA11y } from "../hooks/use-drawer-a11y";
import { Glyph, type GlyphName } from "../system/glyphs";
import { Button } from "./button";

export interface DrawerProps {
  title: string;
  subtitle?: ReactNode;
  icon?: GlyphName;
  /** The landmark's accessible name; usually the title. */
  label: string;
  onClose: () => void;
  /** When this changes the form was reset (saved, switched record): Escape closes the drawer again. */
  resetKey?: unknown;
  /** The action row under the body (Save, Cancel). */
  footer?: ReactNode;
  children: ReactNode;
}

export function Drawer({
  title,
  subtitle,
  icon,
  label,
  onClose,
  resetKey,
  footer,
  children,
}: DrawerProps): JSX.Element {
  const a11y = useDrawerA11y<HTMLElement>(onClose, resetKey);
  return (
    <aside className="wx-admission-drawer" {...a11y} aria-label={label}>
      <header className="wx-drawer-head">
        {icon ? (
          <span className="wx-rail-icon" aria-hidden="true">
            <Glyph name={icon} size={20} />
          </span>
        ) : null}
        <div>
          <h2>{title}</h2>
          {subtitle ? <div className="wx-row-sub">{subtitle}</div> : null}
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">{children}</section>
        {footer ? <div className="wx-action-row is-end">{footer}</div> : null}
      </div>
    </aside>
  );
}
