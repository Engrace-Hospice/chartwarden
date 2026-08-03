// apps/admin/src/modules/35-subscription-billing — shared status presentation for the M35 §5.2 platform-ops
// console. The admin analogue of the tenant slice's billing-status.ts: every §5.2 screen resolves a wire
// enum to the §6.6 StatusPill taxonomy through these maps, so the badge vocabulary is applied once. The wire
// enums mirror the backend `subscription-typebox.ts` literal unions the /api/admin routes serve.
import type { StatusTone } from "@wardenx/ui";

/** Subscription lifecycle status → §6.6 tone (SubscriptionStatusLit). */
export const SUBSCRIPTION_TONE: Record<string, StatusTone> = {
  trialing: "progress",
  active: "success",
  past_due: "warning",
  at_risk: "warning",
  suspended: "error",
  canceled: "neutral",
  paused: "neutral",
};

/** §4.15 dunning stage → tone. The two terminal-leaning stages read `critical` (§5.5 assertive alerts). */
export const DUNNING_TONE: Record<string, StatusTone> = {
  none: "neutral",
  day_1: "progress",
  day_7: "progress",
  day_14: "warning",
  day_21: "warning",
  day_28_suspend: "critical",
  day_60_cancel: "critical",
  resolved: "success",
};

/** Refund lifecycle status → tone (RefundStatus). `executed_failed`/`denied` are the failure ends. */
export const REFUND_TONE: Record<string, StatusTone> = {
  requested: "progress",
  approved: "success",
  denied: "neutral",
  executed_success: "success",
  executed_failed: "error",
};

/** Usage meter threshold state → tone (UsageMeterDto.thresholdState). */
export const USAGE_THRESHOLD_TONE: Record<string, StatusTone> = {
  ok: "success",
  warning: "warning",
  breached: "error",
};

/** Title-case an underscore enum value, e.g. `past_due` → `Past Due`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
export const cap = (s: string): string => statusLabel(s);

export const subscriptionTone = (status: string): StatusTone => SUBSCRIPTION_TONE[status] ?? "neutral";
export const dunningTone = (stage: string): StatusTone => DUNNING_TONE[stage] ?? "neutral";
export const refundTone = (status: string): StatusTone => REFUND_TONE[status] ?? "neutral";
export const usageThresholdTone = (state: string): StatusTone => USAGE_THRESHOLD_TONE[state] ?? "neutral";

/** True for the two §5.5 assertive-alert dunning stages (access-blocking / cancellation imminent). */
export const isCriticalDunningStage = (stage: string): boolean => DUNNING_TONE[stage] === "critical";

/**
 * Format an integer minor-unit amount (cents) into a localized currency string. The backend serves all
 * monetary amounts as integer cents (`*Cents`) + a `currencyCode`; the UI never does cents arithmetic
 * beyond this single conversion boundary (money stays integer end to end).
 */
export function formatCents(cents: number, currencyCode = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode || "USD" }).format(
    cents / 100,
  );
}

/** Format an ISO instant as a short local date, tolerant of null (renders an em dash). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/** An org label for a cross-tenant row: the resolved display name, or the shortened id when unresolved. */
export function orgLabel(name: string | null | undefined, id: string): string {
  return name && name.length > 0 ? name : id.slice(0, 8);
}

/** A fresh idempotency key for a mutating platform action (§4.17 — the server caches 24h replays). */
export function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `idem-${Date.now()}`;
}

/** The set of live dunning stages a subscription can occupy (for the dunning-screen filter). */
export const DUNNING_STAGES = [
  "day_1",
  "day_7",
  "day_14",
  "day_21",
  "day_28_suspend",
  "day_60_cancel",
] as const;

/** The subscription statuses the cross-tenant list can filter on. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "at_risk",
  "suspended",
  "canceled",
  "paused",
] as const;
