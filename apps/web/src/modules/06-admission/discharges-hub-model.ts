// apps/web/src/modules/06-admission — pure helpers of the "Discharge / transfer" hub (discharges-hub.tsx): the
// worklist row shape (GET /api/v1/discharges/worklist), display gating per row action, the patient search and the
// short labels. Display gating only — the server enforces every key on the workflow it links to.
import { DISCHARGE_WORKFLOW_PERMISSIONS } from "./admission-status";

export type WorklistBucket = "ready" | "needs_details" | "awaiting_cosign" | "recently_discharged";

export interface WorklistItem {
  admissionId: string;
  patientId: string;
  admissionState: string;
  admissionAt: string | null;
  dischargedAt: string | null;
  missing: "place_of_death" | "receiving_care_setting" | null;
  dischargeEventId: string | null;
  transferEventId: string | null;
  dischargeType: string | null;
  effectiveDate: string | null;
  /**
   * `recently_discharged` rows only: the name + MRN the server read through M5 (a readmission candidate is usually
   * off the caller's caseload, so the patient read would 404). `null` = M5 could not resolve it; absent = read it.
   */
  patient?: { firstName: string; lastName: string; mrn: string } | null;
}

export interface HubPatient {
  id: string;
  mrn?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** The `recently_discharged` look-back, in days (the server's RECENTLY_DISCHARGED_DAYS). */
export const RECENTLY_DISCHARGED_DAYS = 90;

/** Rows fetched per bucket page — the patient reads stay bounded by what is on screen. */
export const HUB_PAGE_SIZE = 25;

export interface HubAbilities {
  /** Discharge / revocation / transfer-out stepper (any of its keys). */
  readonly discharge: boolean;
  /** Death & pronouncement workflow. */
  readonly death: boolean;
  /** For-cause cosign queue (route 40). */
  readonly cosign: boolean;
  /** Readmit a live-discharged patient (a new admission). */
  readonly readmit: boolean;
}

/** What the actor may start from the hub. An unknown permission set (null) shows nothing gated. */
export function hubAbilities(permissions: readonly string[] | null | undefined): HubAbilities {
  const has = (key: string): boolean => permissions?.includes(key) ?? false;
  return {
    discharge: DISCHARGE_WORKFLOW_PERMISSIONS.some(has),
    death: has("discharge.death"),
    cosign: has("discharge.cosign_for_cause"),
    readmit: has("admission.create"),
  };
}

export function patientName(patient: HubPatient | undefined, fallback: string): string {
  const name = [patient?.firstName, patient?.lastName].filter(Boolean).join(" ").trim();
  return name || patient?.mrn || fallback;
}

/** Case-insensitive match on the patient's name or MRN; an empty query matches every row. */
export function matchesPatient(patient: HubPatient | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [patient?.firstName, patient?.lastName, patient?.mrn]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export const MISSING_LABEL: Record<NonNullable<WorklistItem["missing"]>, string> = {
  place_of_death: "Place of death",
  receiving_care_setting: "Receiving care setting",
};

const END_LABEL: Record<string, string> = {
  death: "Death",
  transfer: "Transfer out",
  transfer_out: "Transfer out",
  for_cause: "For cause",
  moved_out_of_service_area: "Moved out of area",
  revocation: "Revocation",
  no_longer_terminal: "No longer terminal",
  other: "Other",
};

export function endLabel(dischargeType: string | null): string {
  if (!dischargeType) return "—";
  return END_LABEL[dischargeType] ?? dischargeType.replace(/_/g, " ");
}

/** The patients the server already named on the rows (`patient` present, even `null`) — never read again. */
export function embeddedPatients(rows: readonly WorklistItem[]): Record<string, HubPatient | null> {
  const out: Record<string, HubPatient | null> = {};
  for (const r of rows) {
    if (r.patient === undefined) continue;
    out[r.patientId] = r.patient ? { id: r.patientId, ...r.patient } : null;
  }
  return out;
}

/** The patient ids of `rows` not yet in `known` (nor named on the row) — the reads still owed for what is on screen. */
export function unresolvedPatientIds(
  rows: readonly WorklistItem[],
  known: Readonly<Record<string, unknown>>,
): string[] {
  return [...new Set(rows.filter((r) => r.patient === undefined).map((r) => r.patientId))].filter(
    (id) => !(id in known),
  );
}

/** Whole days from `isoDate` (yyyy-mm-dd or an instant) to `today` (yyyy-mm-dd); `null` when unknown. */
export function daysSince(isoDate: string | null, today: string): number | null {
  if (!isoDate) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}
