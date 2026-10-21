import type { JSX } from "react";
// apps/admin/src/shell — the WardenX Platform Ops brand lockup for the console's chromeless cards (sign in,
// organization select, step-up). The same shield mark and two-line "WardenX / Platform Ops" wordmark as the
// sidebar's brand block (layout.tsx), on the shared app-shell classes. Screen readers get one name
// ("WardenX Platform Ops"); the two visible lines are hidden from them so it is not read in pieces.
export function BrandLockup(): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2.5 text-left">
      <span className="wx-brand-logo" aria-hidden>
        <img src="/chartwarden-mark.svg" width="28" height="28" alt="" />
      </span>
      <span className="wx-brand-text" aria-hidden>
        <span className="wx-brand">ChartWarden</span>
        <span className="wx-brand-sub">Platform Ops</span>
      </span>
      <span className="wx-sr-only">ChartWarden Platform Ops</span>
    </div>
  );
}
