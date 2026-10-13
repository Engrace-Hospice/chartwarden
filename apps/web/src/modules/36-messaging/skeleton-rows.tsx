// WP 2.11 loading state (06-ux-design §4): placeholder rows while a list or timeline has not been read yet. The wrapper
// is a polite status region marked aria-busy so assistive tech announces `label` once, not every placeholder.
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
    <output
      aria-busy="true"
      aria-label={label}
      className={`wx-messaging-skeleton ${className ?? ""}`}
    >
      {ROW_KEYS.map((key) => (
        <span key={key} className="wx-messaging-skeleton-row" aria-hidden="true" />
      ))}
    </output>
  );
}
