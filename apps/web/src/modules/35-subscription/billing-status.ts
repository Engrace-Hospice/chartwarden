// apps/web/src/modules/35-subscription — shared status presentation for the M35 tenant billing surfaces.
// Every M35 §5.1 screen renders the same StatusPill for a given wire enum by resolving it through these
// tone maps, so the §6.6 badge taxonomy is applied once. The wire enums mirror the backend
// `subscription-typebox.ts` literal unions the tenant routes serve (SubscriptionStatusLit / DunningStageLit
// / InvoiceStatusLit and the usage threshold-state). Lantern maps design intent onto the StatusTone
// vocabulary: progress(primary)≈"in flight", success≈healthy, warning≈needs attention,
// error≈failed/irreversible, neutral≈inert, critical≈the §10 gold reserved for controlled/urgent acts
// (the day_28_suspend+ dunning stages are the assertive-alert states per §5.5).
import type { StatusTone } from "@wardenx/ui";

/** §2 subscription lifecycle status → §6.6 tone (SubscriptionStatusLit). */
export const SUBSCRIPTION_TONE: Record<string, StatusTone> = {
  trialing: "progress", // in the trial window
  active: "success", // green — healthy
  past_due: "warning", // orange — payment overdue, remediation open
  at_risk: "warning", // orange — dunning escalating
  suspended: "error", // red — access blocked by billing
  canceled: "neutral", // inert terminal
  paused: "neutral", // inert hold
};

/**
 * §4.15 dunning stage → tone. `none`/`resolved` are inert; the early nudges are in-flight; the two
 * terminal-leaning stages (suspend, cancel) read `critical` — the §5.5 assertive-alert states.
 */
export const DUNNING_TONE: Record<string, StatusTone> = {
  none: "neutral",
  day_1: "progress",
  day_7: "progress",
  day_14: "warning",
  day_21: "warning",
  day_28_suspend: "critical", // access-blocking imminent — role="alert" aria-live="assertive"
  day_60_cancel: "critical", // irreversible cancellation imminent
  resolved: "success",
};

/** Invoice status → tone (InvoiceStatusLit). `uncollectible` is a write-off — the terminal failure. */
export const INVOICE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  open: "progress", // awaiting payment
  paid: "success",
  void: "neutral",
  uncollectible: "error",
};

/** Usage meter threshold state → tone (UsageMeterDto.thresholdState). */
export const USAGE_THRESHOLD_TONE: Record<string, StatusTone> = {
  ok: "success",
  warning: "warning", // approaching the included quantity
  breached: "error", // over the included quantity — overage accruing
};

/** Title-case an underscore enum value, e.g. `past_due` → `Past Due`, `day_28_suspend` → `Day 28 Suspend`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Title-case helper alias for any word/phrase. */
export const cap = (s: string): string => statusLabel(s);

/** Resolve a subscription status to its tone, defaulting to neutral for unknown values. */
export function subscriptionTone(status: string): StatusTone {
  return SUBSCRIPTION_TONE[status] ?? "neutral";
}

/** Resolve a dunning stage to its tone, defaulting to neutral for unknown values. */
export function dunningTone(stage: string): StatusTone {
  return DUNNING_TONE[stage] ?? "neutral";
}

/** Resolve an invoice status to its tone, defaulting to neutral for unknown values. */
export function invoiceTone(status: string): StatusTone {
  return INVOICE_TONE[status] ?? "neutral";
}

/** True for the two §5.5 assertive-alert dunning stages (access-blocking / cancellation imminent). */
export function isCriticalDunningStage(stage: string): boolean {
  return DUNNING_TONE[stage] === "critical";
}

/**
 * Format an integer minor-unit amount (cents) into a localized currency string. The backend serves all
 * monetary amounts as integer cents (`*Cents`) + a `currencyCode`; the UI never does cents arithmetic
 * beyond this single conversion boundary (D3 — money stays integer end to end).
 */
export function formatCents(cents: number, currencyCode = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode || "USD",
  }).format(cents / 100);
}

/** Format an ISO instant/date as a short local date, tolerant of null (renders an em dash). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}
