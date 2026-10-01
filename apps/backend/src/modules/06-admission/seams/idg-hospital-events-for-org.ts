// apps/backend/src/modules/06-admission/seams/idg-hospital-events-for-org.ts — the org-explicit, BATCHED
// "hospital / ER event" read the M14 IDG packet's `sinceLastIdg.flaggedEvents` block needs (M14 spec §2.4
// "flagged events (hospitalizations, ER visits, ...)"; the `hospitalisation` / `er_visit` kinds).
//
// SOURCE (the only structured hospitalisation signal in the platform): M6's `compliance_window` rows of kind
// `concurrent_hospital_admission`, opened by the `AdmissionEventApplier` (`consumers/admission-event-applier.ts`)
// when an inbound ADT admit for a patient on ACTIVE hospice is human-accepted through M29's proposal flow.
// The window's `payload` carries the HL7 event time (`eventTimestamp`) and PV1-2 `patientClass`
// ('I' inpatient, 'E' emergency, 'O' outpatient, ...). This seam PROJECTS them; it derives nothing beyond:
//   • `E`                       → `er_visit`
//   • `I` or absent             → `hospitalisation` (the applier only opens this window for an ADMIT signal)
//   • any other explicit class  → dropped (an outpatient / pre-admit / recurring registration is not a
//     hospitalisation; showing it would raise a false level-of-care flag on the IDG cover)
// `occurredAt` is the message's `eventTimestamp` (when the event happened at the sending facility), falling
// back to the window's `starts_at` (when M6 recorded it) only if the payload time is missing/unparseable.
// A CLOSED window is still an event that happened (triage closing it does not un-admit the patient), so every
// status is read. `severity` is `urgent` for both kinds. NO facility name / narrative crosses this seam —
// ids, an enum, an instant and a severity only. SEAM PULL: M14 reads on demand at packet build.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const CW = schema.complianceWindows;
const ADM = schema.admissions;

/** A read with no acting human (the `ADMISSION_READER_SYSTEM_USER_ID` convention). */
const HOSPITAL_EVENTS_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_HOSPITAL_EVENTS_MAX_PATIENTS = 500;

/** One projected hospital / ER event (structural twin of M14's `PacketFlaggedEventDigest`). */
export interface IdgHospitalEvent {
  readonly kind: "hospitalisation" | "er_visit";
  /** The M6 `compliance_window.id` — the back-reference. */
  readonly sourceId: string;
  /** ISO instant the event occurred at the sending facility (else when M6 recorded it). */
  readonly occurredAt: string;
  readonly severity: "urgent";
}

/** Pure projection of one window row (exported for unit tests — no DB). Null ⇒ not a hospital/ER event. */
export function projectHospitalEvent(row: {
  readonly id: string;
  readonly startsAt: Date | string;
  readonly payload: unknown;
}): IdgHospitalEvent | null {
  const payload =
    typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const rawClass = typeof payload.patientClass === "string" ? payload.patientClass.trim() : "";
  const patientClass = rawClass.toUpperCase();
  let kind: IdgHospitalEvent["kind"];
  if (patientClass === "E") kind = "er_visit";
  else if (patientClass === "I" || patientClass === "") kind = "hospitalisation";
  else return null;

  const eventTs =
    typeof payload.eventTimestamp === "string" ? Date.parse(payload.eventTimestamp) : Number.NaN;
  const startsAt = new Date(row.startsAt).getTime();
  const at = Number.isFinite(eventTs) ? eventTs : startsAt;
  if (!Number.isFinite(at)) return null;
  return { kind, sourceId: row.id, occurredAt: new Date(at).toISOString(), severity: "urgent" };
}

/**
 * Hospital / ER events for each patient in `patientIds`, strictly AFTER `sinceIso` (the earliest §1.1 cursor in
 * the batch — M14's builder re-filters per patient). Patients with none are absent from the map. ONE query.
 */
export async function idgHospitalEventsForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  sinceIso: string,
): Promise<ReadonlyMap<string, readonly IdgHospitalEvent[]>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgHospitalEvent[]>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_HOSPITAL_EVENTS_MAX_PATIENTS) {
    throw new Error(
      `idgHospitalEventsForOrg: ${ids.length} patients exceeds the ${IDG_HOSPITAL_EVENTS_MAX_PATIENTS} cap`,
    );
  }
  const since = Date.parse(sinceIso);
  return withOrgContext(
    db,
    { organizationId, userId: HOSPITAL_EVENTS_SYSTEM_USER_ID },
    async (tx) => {
      const t = tx as unknown as DbClient;
      const rows = await t
        .select({
          id: CW.id,
          patientId: ADM.patientId,
          startsAt: CW.startsAt,
          payload: CW.payload,
        })
        .from(CW)
        .innerJoin(ADM, eq(ADM.id, CW.admissionId))
        .where(
          and(
            eq(CW.organizationId, organizationId),
            eq(CW.windowKind, "concurrent_hospital_admission"),
            inArray(ADM.patientId, ids),
          ),
        );
      for (const r of rows) {
        const event = projectHospitalEvent(r);
        if (!event || !(Date.parse(event.occurredAt) > since)) continue;
        const list = out.get(r.patientId) ?? [];
        list.push(event);
        out.set(r.patientId, list);
      }
      return out;
    },
  );
}
