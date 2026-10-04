// M5 admission-clearance seam. M6 receives only the high-level decision plus a coarse, category-free
// `restriction` kind naming the workflow that can lift it; privacy flag details stay in M5.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientAdmissionClearanceReader, PatientAdmissionRestriction } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

/**
 * Pure — which workflow lifts the snapshot's restriction. Only the `sud` flag has a lifting workflow
 * today: a DocLens interim flag (`sud_flag_origin = 'm22_intake_unconfirmed'`, M22 §7.4 W4 / M5 D10)
 * is resolved by the intake reviewer's confirm/reject; any other `sud` flag (a confirmed detection, or
 * M39 consent state with no §2.31 release on file) is lifted by a Part 2 consent (M39). Every other
 * flag has no self-service path from the admission screen.
 *
 * F-238 — M6 treats `INTAKE_DETECTION_UNREVIEWED` as advisory (it does not block activation), so it is
 * reported ONLY when the interim DocLens flag is the patient's sole flag. Any other flag alongside it
 * is the binding restriction and is reported as `RESTRICTED`. The flag itself is untouched: it still
 * restricts access and disclosure exactly as before.
 */
export function restrictionOf(
  flags: readonly string[],
  sudFlagOrigin: string | null,
): PatientAdmissionRestriction {
  if (flags.includes("sud")) {
    if (sudFlagOrigin !== "m22_intake_unconfirmed") return "CONSENT_REQUIRED";
    return flags.every((f) => f === "sud") ? "INTAKE_DETECTION_UNREVIEWED" : "RESTRICTED";
  }
  return "RESTRICTED";
}

export function buildPatientAdmissionClearanceReader(
  db: DbClient,
): PatientAdmissionClearanceReader {
  const P = schema.patients;
  const S = schema.patientPrivacyFlagSnapshots;

  return {
    async evaluatePatientAdmissionClearance({ organizationId, patientId }) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({
            patientId: P.id,
            flags: S.flags,
            sudFlagOrigin: S.sudFlagOrigin,
            invalidatedAt: S.invalidatedAt,
          })
          .from(P)
          .leftJoin(S, and(eq(S.patientId, P.id), eq(S.organizationId, organizationId)))
          .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
          .limit(1);
        if (!row) return { allowed: false, reason: "PATIENT_NOT_FOUND" };
        const flags = row.invalidatedAt === null ? (row.flags ?? []) : [];
        if (flags.length > 0) {
          return {
            allowed: false,
            reason: "PRIVACY_RESTRICTION",
            restriction: restrictionOf(flags, row.sudFlagOrigin ?? null),
            overrideAllowed: true,
          };
        }
        return { allowed: true };
      });
    },
  };
}
