// apps/backend/src/modules/05-patient/privacy-flag-reader.ts — M5 `PatientPrivacyFlagReader` seam impl
// (GAP-061).
//
// The two facts M37's §2.2 shared-room occupancy gate needs about a patient before it may place them in
// a bed whose room already holds someone else: the patient's sex class, and their active privacy flags.
// A seam, not a shared service import, so M37 gains no schema edge into M5 (ADR-0005) — mirrors the
// `PatientAddressReader` / `PatientCoverageReader` precedents.
//
// Reads run under `withOrgContext` so Postgres RLS scopes them to the calling org, and the projection is
// deliberately narrow: the gate reads the CURRENT ROOMMATES' records, and a roommate is a patient the
// assigning nurse may have no other right to see. Sex class + flags cross the seam; name, MRN and DOB
// never do.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientPrivacyFlagReader, PatientSexClass } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Collapse M5's `patient.sex_assigned_at_birth` USCDI code to a rooming sex class. M5 writes the HL7
 * administrative-gender codes (`M` / `F` / `U` / `O`, with `UNK` as the unrecorded default — see
 * `patient-route-service-db.ts` and the `PatientMutationPatch.administrativeSex` union), and tolerates
 * a spelled-out or SNOMED-coded value from an M29 ingest. Anything this cannot read as male or female
 * is `unspecified` — which the consumer must treat as "cannot prove same-sex", never as a match.
 */
export function toSexClass(code: string | null | undefined): PatientSexClass {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "M" || c === "MALE" || c === "248153007") return "male";
  if (c === "F" || c === "FEMALE" || c === "248152002") return "female";
  return "unspecified";
}

export function buildPatientPrivacyFlagReader(db: DbClient): PatientPrivacyFlagReader {
  const P = schema.patients;
  const S = schema.patientPrivacyFlagSnapshots;

  return {
    async roomingFactsFor({ organizationId, patientIds }) {
      const ids = [...new Set(patientIds)];
      if (ids.length === 0) return [];
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        // LEFT JOIN, not two queries: the snapshot is a cache (M5 §3.5 / D10) and most patients have no
        // row. An absent snapshot means "no flag recorded" — it must not drop the patient from the
        // result, because a dropped patient reads to the consumer as an unreadable one.
        const rows = await tx
          .select({
            patientId: P.id,
            sexAssignedAtBirth: P.sexAssignedAtBirth,
            flags: S.flags,
            invalidatedAt: S.invalidatedAt,
          })
          .from(P)
          .leftJoin(S, eq(S.patientId, P.id))
          .where(and(eq(P.organizationId, organizationId), inArray(P.id, ids)));
        return rows.map((r) => ({
          patientId: r.patientId,
          sexClass: toSexClass(r.sexAssignedAtBirth),
          // An invalidated snapshot is stale by M5's own marker — its flags are not active facts.
          privacyFlags: r.invalidatedAt === null ? (r.flags ?? []) : [],
        }));
      });
    },
  };
}
