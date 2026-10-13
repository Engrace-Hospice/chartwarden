// WP 2.11 loading state (06-ux-design §4): placeholder rows while a list or timeline has not been read yet. The wrapper
// is aria-busy; the status region inside it carries the label as (visually hidden) text so it is read when reached.
import type { JSX } from "react";

const ROW_KEYS = ["a", "b", "c", "d", "e"] as const;

export function SkeletonRows({
  label,
  className,
}: {
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      aria-busy="true"
      className={className ? `wx-messaging-skeleton ${className}` : "wx-messaging-skeleton"}
    >
      <output className="wx-sr-only">{label}</output>
      {ROW_KEYS.map((key) => (
        <span key={key} className="wx-messaging-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
