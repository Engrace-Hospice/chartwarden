import type { JSX } from "react";
// apps/admin/src/shell — the WardenX Platform Ops brand lockup for the console's chromeless cards (sign in,
// organization select, step-up). The same shield mark and two-line "WardenX / Platform Ops" wordmark as the
// sidebar's brand block (layout.tsx), on the shared app-shell classes. Screen readers get one name
// ("WardenX Platform Ops"); the two visible lines are hidden from them so it is not read in pieces.
export function BrandLockup(): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2.5 text-left">
      <span className="wx-brand-logo" aria-hidden>
        <svg width="22" height="24" viewBox="0 0 22 24" fill="none" aria-hidden="true">
          <path
            d="M11 1 2 4.6v6.2C2 16.6 5.9 21.5 11 23c5.1-1.5 9-6.4 9-12.2V4.6L11 1Z"
            fill="currentColor"
          />
          <path
            d="M11 7.2a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Zm0 2.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z"
            fill="var(--color-on-emphasis)"
          />
        </svg>
      </span>
      <span className="wx-brand-text" aria-hidden>
        <span className="wx-brand">WardenX</span>
        <span className="wx-brand-sub">Platform Ops</span>
      </span>
      <span className="wx-sr-only">WardenX Platform Ops</span>
    </div>
  );
}
