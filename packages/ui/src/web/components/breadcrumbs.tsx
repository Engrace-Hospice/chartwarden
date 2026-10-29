import type { JSX } from "react";
import { Link } from "react-router-dom";

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page or a parent the actor cannot open. */
  href?: string;
}

/** One accessible, route-driven breadcrumb for a chromed page. */
export function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <nav className="wx-route-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.href ?? "current"}-${index}`}>
            {index > 0 ? (
              <span className="wx-route-breadcrumb-separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {item.href && index < items.length - 1 ? (
              <Link to={item.href}>{item.label}</Link>
            ) : (
              <span aria-current={index === items.length - 1 ? "page" : undefined}>
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
