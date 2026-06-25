// apps/web/src/modules/05-patient — shared patient-lifecycle presentation helpers (R1, Lantern).
// The patient status enum (spec §"Statuses") maps to the §6.6 badge taxonomy tone so every M5
// surface (census, chart banner, global-search hits) renders the same StatusPill for a status.
import type { StatusTone } from "@wardenx/ui";

export const STATUS_TONE: Record<string, StatusTone> = {
  prospective: "progress",
  active: "success",
  on_hold: "warning",
  discharged: "neutral",
  deceased: "neutral",
  merged: "neutral",
};

/** Title-case an underscore enum value, e.g. `on_hold` → `On Hold`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Whole years from an ISO date-of-birth; null on an unparseable/future date. */
export function ageFromDob(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}
