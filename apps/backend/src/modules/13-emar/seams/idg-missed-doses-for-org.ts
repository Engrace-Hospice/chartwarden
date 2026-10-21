// apps/backend/src/modules/13-emar/seams/idg-missed-doses-for-org.ts — the org-explicit, BATCHED "missed dose"
// read the M14 IDG packet's `sinceLastIdg.flaggedEvents` block needs (M14 spec §2.4 "flagged events
// (hospitalizations, ER visits, missed doses, ...)"; the `missed_dose` kind).
//
// SOURCE: M13's own `missed_dose` table — one row per `scheduled_dose` that lapsed its grace window (detected by
// the sweep) or was intentionally held / refused (§2.5 D4). This seam only PROJECTS it: `occurredAt` =
// `detected_at`; `severity` is derived deterministically from the row's own facts (never from free text) —
//   • `detected_by_sweep` on a controlled substance → `urgent`; a sweep-detected lapse → `attention`
//   • `patient_refused` → `attention` (a comfort-med refusal the team should hear about)
//   • `intentionally_held` → `info` (a deliberate clinical hold)
// `missed_reason` (free text, audit-denylisted) NEVER crosses this seam; nor does any drug name — M14's digest
// is an id, an enum, an instant and a severity. SEAM PULL at packet build; RLS scopes by `app.org_id`.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray } from "drizzle-orm";

const MD = schema.missedDoses;

/** A read with no acting human (the empty-GUC system convention). */
const MISSED_DOSES_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_MISSED_DOSES_MAX_PATIENTS = 500;

/** One projected missed dose (structural twin of M14's `PacketFlaggedEventDigest`). */
export interface IdgMissedDoseEvent {
  readonly kind: "missed_dose";
  /** The M13 `missed_dose.id` — the back-reference. */
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly severity: "info" | "attention" | "urgent";
}

/** Pure severity rule (exported for unit tests). */
export function missedDoseSeverity(
  missedKind: string,
  isControlledSubstance: boolean,
): IdgMissedDoseEvent["severity"] {
  if (missedKind === "detected_by_sweep") return isControlledSubstance ? "urgent" : "attention";
  if (missedKind === "patient_refused") return "attention";
  return "info"; // intentionally_held
}

/**
 * Missed doses for each patient in `patientIds`, strictly AFTER `sinceIso` (the earliest §1.1 cursor in the
 * batch — M14's builder re-filters per patient). Patients with none are absent from the map. ONE query.
 */
export async function idgMissedDosesForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  sinceIso: string,
): Promise<ReadonlyMap<string, readonly IdgMissedDoseEvent[]>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgMissedDoseEvent[]>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_MISSED_DOSES_MAX_PATIENTS) {
    throw new Error(
      `idgMissedDosesForOrg: ${ids.length} patients exceeds the ${IDG_MISSED_DOSES_MAX_PATIENTS} cap`,
    );
  }
  return withOrgContext(db, { organizationId, userId: MISSED_DOSES_SYSTEM_USER_ID }, async (tx) => {
    const rows = await (tx as unknown as DbClient)
      .select({
        id: MD.id,
        patientId: MD.patientId,
        detectedAt: MD.detectedAt,
        missedKind: MD.missedKind,
        isControlledSubstance: MD.isControlledSubstance,
      })
      .from(MD)
      .where(
        and(
          eq(MD.organizationId, organizationId),
          inArray(MD.patientId, ids),
          gt(MD.detectedAt, new Date(sinceIso)),
        ),
      );
    for (const r of rows) {
      const list = out.get(r.patientId) ?? [];
      list.push({
        kind: "missed_dose",
        sourceId: r.id,
        occurredAt: new Date(r.detectedAt).toISOString(),
        severity: missedDoseSeverity(r.missedKind, r.isControlledSubstance),
      });
      out.set(r.patientId, list);
    }
    return out;
  });
}
