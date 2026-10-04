import { StatusPill } from "@wardenx/ui";
// apps/web/src/modules/35-subscription — the shared §5.5 dunning banner.
// Rendered on `/billing` (overview) and `/billing/dunning` when the org is in dunning. Per §5.5 the
// banner uses role="alert" with aria-live="assertive" for the critical stages (day_28_suspend onward)
// and aria-live="polite" for the lower nudges; it always offers the "Update payment method" remediation
// CTA (the only in-app remediation path — mobile has none per §5.3). Lantern: CSS-var tokens, §6.6
// StatusPill for the stage chip.
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { cap, dunningTone, isCriticalDunningStage } from "./billing-status";

export function DunningBanner({
  stage,
  daysUntilSuspension,
  isBlocked,
}: {
  stage: string;
  daysUntilSuspension: number | null;
  isBlocked: boolean;
}): JSX.Element {
  const critical = isCriticalDunningStage(stage);
  const headline = isBlocked
    ? "Billing blocked — please update your payment method"
    : "A payment is overdue on your account";
  const detail =
    daysUntilSuspension != null && daysUntilSuspension > 0
      ? `Access will be suspended in ${daysUntilSuspension} day${daysUntilSuspension === 1 ? "" : "s"} if the balance is not paid.`
      : "Update your payment method to keep your account in good standing.";

  return (
    <div
      role="alert"
      aria-live={critical ? "assertive" : "polite"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "1rem 1.25rem",
        borderRadius: "var(--radius-lg, 0.75rem)",
        // Tinted notice (same treatment as the app's other alerts) instead of a side rail.
        background: `color-mix(in srgb, ${critical ? "var(--color-error)" : "var(--color-warning)"} 8%, var(--color-surface-lowest))`,
        border: `1px solid color-mix(in srgb, ${critical ? "var(--color-error)" : "var(--color-warning)"} 35%, transparent)`,
      }}
    >
      <StatusPill label={cap(stage)} tone={dunningTone(stage)} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{headline}</span>
        <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          {detail}
        </span>
      </div>
      <Link
        to="/subscription/payment_methods"
        style={{
          padding: "0.5rem 1rem",
          borderRadius: "var(--radius-md, 0.5rem)",
          background: "var(--color-primary)",
          color: "var(--color-on-primary)",
          textDecoration: "none",
          fontSize: "0.875rem",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        Update payment method
      </Link>
    </div>
  );
}
