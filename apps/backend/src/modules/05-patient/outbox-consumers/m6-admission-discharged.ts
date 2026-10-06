// apps/backend/src/modules/05-patient/outbox-consumers/m6-admission-discharged.ts — the §2.4.1
// `active → discharged` / `on_hold → discharged` edges ("revoke / discharge for cause / transfer (M6)").
//
// Nothing applied them: M5 was not a declared consumer of `m6.admission.discharged`, so a patient
// discharged alive (moved out of the service area, transfer out, revocation, no longer terminal, for
// cause after the cosign, other) stayed `active` forever — on every census, worklist and ABAC gate that
// keys off `patient.status`. M6 emits this event from `dischargeAdmissionTx` for EVERY discharge path
// (the discharge route, the for-cause cosign, revocation and transfer out), with `reason` set to the
// §4.2.7 reason (`death` | `moved_out_of_service_area` | `no_longer_terminal` | `for_cause` | `other`)
// or to `revocation` / `transfer` for the two paths that file no `discharge_event`.
//
// DEATH IS NOT HANDLED HERE: a `reason: "death"` delivery returns at once. The `→ deceased` edge (with
// `deceased_date`, `m5.patient.deceased`) belongs to the `m6.discharge.death` cascade (`deceased-db.ts`);
// moving the chart to `discharged` first would race it.
//
// RE-ADMISSION GUARD: `admission_patient_open_idx` allows one open admission per patient, but a
// discharge delivered late (a retry, a redelivery) can land after the patient's NEXT admission has
// already activated — and the activation consumer (`m6-admission-activated.ts`) has moved the chart back
// to `active`. M6's org-explicit `AdmissionStatusReader.getAdmissionPatientCare` reports whether another
// of the patient's admissions is `active`/`on_hold`; if one is, the patient stays under care.
//
// CROSS-MODULE BOUNDARY: M5 does not depend on M6 (manifest `dependsOn`), so the patient id and the
// re-admission fact come through the registered seam, never an import or a read of `admission`.
//
// IDEMPOTENT: a redelivery finds the chart already `discharged` and writes/emits nothing. `deceased`,
// `merged` and `prospective` charts have no §2.4.1 discharge edge and are left alone without an error.
// The write runs as the NULL (system) audit actor (`systemOrgContext`).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { M5OutboxPort } from "../deceased-db";
import { isDeathDischargeReason, liveDischargeTransitionFrom } from "../patient-status-transitions";

const P = schema.patients;

export const M5_ADMISSION_DISCHARGED_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m5.m6-admission-discharged",
} as const;

/** Admission states a discharge leaves behind (`bereavement`/`closed` follow `discharged`). */
const ENDED_ADMISSION_STATES: ReadonlySet<string> = new Set([
  "discharged",
  "bereavement",
  "closed",
]);

export interface AdmissionDischargedDeps {
  readonly db: DbClient;
  /** Emits `m5.patient.status_changed` when the discharge moves the chart (§2.4.1). */
  readonly outbox: M5OutboxPort;
}

/** What one delivery did (returned for tests and logs; the relay ignores it). */
export type AdmissionDischargedOutcome =
  | "discharged"
  | "skipped_death"
  | "skipped_unknown_admission"
  | "skipped_admission_not_ended"
  | "skipped_other_admission_under_care"
  | "skipped_unknown_patient"
  | "already_discharged"
  | "skipped_status";

interface AdmissionDischargedPayload {
  readonly admissionId: string;
  readonly reason: string;
}

function factsOf(payload: unknown): AdmissionDischargedPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M5_ADMISSION_DISCHARGED_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return { admissionId: read("admissionId"), reason: read("reason") };
}

/** Apply the §2.4.1 live-discharge edge to the patient row, in one org-scoped tx with its event. */
async function dischargePatient(
  deps: AdmissionDischargedDeps,
  organizationId: string,
  patientId: string,
): Promise<AdmissionDischargedOutcome> {
  return withOrgContext(deps.db, systemOrgContext(organizationId), async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const [row] = await tx
      .select({ status: P.status })
      .from(P)
      .where(eq(P.id, patientId))
      .limit(1)
      .for("update");
    if (!row) return "skipped_unknown_patient";
    const transition = liveDischargeTransitionFrom(row.status);
    if (transition === "already_discharged") return "already_discharged";
    if (transition === "skip") return "skipped_status";
    await tx
      .update(P)
      .set({ status: "discharged", updatedAt: new Date() })
      .where(eq(P.id, patientId));
    await deps.outbox.publish(tx, {
      eventName: "m5.patient.status_changed",
      payload: { patientId, organizationId, fromStatus: row.status, toStatus: "discharged" },
      organizationId,
      aggregateKind: "patient",
      aggregateId: patientId,
    });
    return "discharged";
  });
}

/** M5's live `m6.admission.discharged` binding — see the file header. */
export function buildM5AdmissionDischargedConsumer(deps: AdmissionDischargedDeps) {
  return {
    consumerName: M5_ADMISSION_DISCHARGED_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_ADMISSION_DISCHARGED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<AdmissionDischargedOutcome> {
      const facts = factsOf(event.payload);
      if (isDeathDischargeReason(facts.reason)) return "skipped_death";

      const care = await getSeam("AdmissionStatusReader").getAdmissionPatientCare(
        event.organizationId,
        facts.admissionId,
      );
      // Unknown / cross-tenant admission id: nothing of this tenant's to discharge.
      if (!care) return "skipped_unknown_admission";
      if (!ENDED_ADMISSION_STATES.has(care.status)) return "skipped_admission_not_ended";
      if (care.otherAdmissionUnderCare) return "skipped_other_admission_under_care";

      return dischargePatient(deps, event.organizationId, care.patientId);
    },
  };
}
