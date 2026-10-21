// apps/web/src/modules/27-cost-report — shared status presentation for the M27 Cost Report surfaces (R2,
// §5 / §6.6). Every M27 screen renders the same StatusPill for a given wire enum through these tone maps, so
// the §6.6 badge taxonomy is applied ONCE (the M23 billing-status.ts / M26 cap-status.ts precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/safe · warning≈needs-attention · error≈failed
// · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@chartwarden/ui";

/** cost_report.state → §6.6 tone. submitted/accepted are terminal-ish; reopened is the audit-heavy amber. */
export const STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  populating: "progress",
  validating: "progress",
  ready_for_review: "warning",
  approved_for_submit: "progress",
  submitted: "progress",
  accepted: "success",
  rejected: "error",
  reopened: "warning",
  closed: "neutral",
};

/** validation per-rule outcome → tone. */
export const OUTCOME_TONE: Record<string, StatusTone> = {
  pass: "success",
  fail: "error",
  warn: "warning",
  skip: "neutral",
};

/** validation-run status → tone. */
export const RUN_TONE: Record<string, StatusTone> = {
  running: "progress",
  complete_pass: "success",
  complete_fail: "error",
  failed_to_run: "error",
};

/** rule severity → tone (block = hard stop, warn = advisory, info = inert). */
export const SEVERITY_TONE: Record<string, StatusTone> = {
  block: "error",
  warn: "warning",
  info: "neutral",
};

/** ECR submission status → tone. accepted is the success terminal; rejected the breach. */
export const SUBMISSION_TONE: Record<string, StatusTone> = {
  generating: "progress",
  generated: "progress",
  uploaded: "warning",
  accepted: "success",
  rejected: "error",
};

/** filing-deadline alert tier → tone (escalating toward the deadline). */
export const TIER_TONE: Record<string, StatusTone> = {
  none: "neutral",
  t4_months: "neutral",
  t4_5_months: "warning",
  t4_75_months: "warning",
  past_deadline: "error",
};

/** The realigned Form CMS-1984-14 worksheet set (17 codes) + short labels for the workspace nav. */
export const WORKSHEET_NAV: ReadonlyArray<{ code: string; label: string }> = [
  { code: "S", label: "Cost & Data" },
  { code: "S-1", label: "Identification" },
  { code: "S-2", label: "Reimbursement Q." },
  { code: "A", label: "Trial Balance" },
  { code: "A-1", label: "Reclass — CHC" },
  { code: "A-2", label: "Reclass — RHC" },
  { code: "A-3", label: "Reclass — IRC" },
  { code: "A-4", label: "Reclass — GIP" },
  { code: "A-6", label: "Reclassifications" },
  { code: "A-8", label: "Adjustments" },
  { code: "A-8-1", label: "Related-Org Costs" },
  { code: "B", label: "Cost Allocation" },
  { code: "B-1", label: "Statistical Basis" },
  { code: "C", label: "Per-Diem Cost" },
  { code: "F", label: "Balance Sheet" },
  { code: "F-1", label: "Fund Balances" },
  { code: "F-2", label: "Revenues" },
];

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — empty string is valid). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/lower wire enum for display (e.g. `ready_for_review` → "Ready for review"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Render integer cents as USD (e.g. 3446534 → "$34,465.34"). */
export function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** Whole-number days from now until an ISO date (negative = past). */
export function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const then = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((then - Date.now()) / 86_400_000);
}
