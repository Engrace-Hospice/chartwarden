// apps/backend/src/modules/39-consent/part2-consent-state-reader.ts — M39's answer to M5's Privacy Officer
// port `Part2ConsentStateReader` (M5 §4.2 resync "force re-read from M39"; M5 D3 "Module 39 is the source
// of truth"). Bound at the composition root; M5 has no `dependsOn` edge to M39, so M5 cannot read
// `consent_record` itself (table ownership) — M39 reads its own table and hands back ids/dates/status.
//
// The ONE consent type that drives a privacy flag is `42_cfr_part_2_release` → `sud` (M39 §4.3.1; the same
// literal M5's `m39-consent-privacy.ts` consumer keys on). Draft rows are not consent. The answer:
//   active   — a non-expired `active` release exists (the newest by effective date is reported);
//   inactive — releases exist but none is in force (the most recently changed one is reported);
//   none     — M39 holds no non-draft Part 2 release for the patient.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  NO_PART2_CONSENT,
  type Part2ConsentState,
  type Part2ConsentStateReader,
} from "../05-patient/index";

const CR = schema.consentRecord;
const PART2_TYPE = "42_cfr_part_2_release";
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function buildPart2ConsentStateReader(db: DbClient): Part2ConsentStateReader {
  return {
    async part2ConsentState(organizationId, patientId): Promise<Part2ConsentState> {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        (tx as unknown as DbClient)
          .select({
            id: CR.id,
            status: CR.status,
            effectiveAt: CR.effectiveAt,
            expiresAt: CR.expiresAt,
            revokedAt: CR.revokedAt,
            updatedAt: CR.updatedAt,
          })
          .from(CR)
          .where(
            and(eq(CR.patientId, patientId), eq(CR.typeKey, PART2_TYPE), ne(CR.status, "draft")),
          )
          .orderBy(desc(CR.updatedAt), desc(CR.id)),
      );
      if (rows.length === 0) return NO_PART2_CONSENT;
      const now = Date.now();
      const inForce = rows
        .filter(
          (r) => r.status === "active" && (r.expiresAt === null || r.expiresAt.getTime() > now),
        )
        .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0];
      const pick = inForce ?? rows[0];
      if (!pick) return NO_PART2_CONSENT;
      return {
        state: inForce ? "active" : "inactive",
        consentRecordId: pick.id,
        status: String(pick.status),
        effectiveAt: iso(pick.effectiveAt),
        expiresAt: iso(pick.expiresAt),
        revokedAt: iso(pick.revokedAt),
      };
    },
  };
}
