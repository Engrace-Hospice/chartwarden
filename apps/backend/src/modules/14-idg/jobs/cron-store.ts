// apps/backend/src/modules/14-idg/jobs/cron-store.ts — GAP-092: the `idg.review-clock-sweep` cron's
// Drizzle reader over `idg_patient_packet` (the per-admission review stamps; the active-admission POPULATION comes from M6, GAP-042) (the M9 `09-assessments/jobs/cron-store.ts` shape). ORG-scoped,
// caller-owned `withOrgContext` tx — this file never opens its own tenancy envelope; `cron-workers.ts`'s
// per-org fan-out owns that.
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, eq, gte, inArray, max } from "drizzle-orm";

const PKT = schema.idgPatientPacket;
const MTG = schema.idgMeeting;
const POL = schema.idgRecurringPolicy;

/** Coerce a Drizzle timestamp (Date or string, depending on column mode) to an ISO string. */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** Admissions per `IN (...)` read — keeps the bind-parameter count far below Postgres' 65 535 ceiling. */
const ADMISSION_CHUNK = 1000;

/** `idg.review-clock-sweep` (§4.8 daily) read: the latest IDG review stamp per ADMISSION, for the given
 * (M6-sourced) active admissions — MAX(last_idg_reviewed_at) across every packet of the admission (a
 * packet's OWN stamp is only set when ITS meeting adjourns, so an older adjourned packet may carry the
 * true last-reviewed date while a newer not-yet-adjourned one still reads null). An admission with no
 * packet, or none ever reviewed, is ABSENT from the map (⇒ the caller falls back to `activated_at`).
 * Keyed on admission (not patient) so a readmission never inherits the prior stay's review. Caller-owned
 * org `withOrgContext` tx. */
export async function lastReviewedByAdmissionForOrg(
  tx: DbClient,
  organizationId: string,
  admissionIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < admissionIds.length; i += ADMISSION_CHUNK) {
    const chunk = admissionIds.slice(i, i + ADMISSION_CHUNK);
    const rows = await tx
      .select({ admissionId: PKT.admissionId, lastReviewed: max(PKT.lastIdgReviewedAt) })
      .from(PKT)
      .where(and(eq(PKT.organizationId, organizationId), inArray(PKT.admissionId, chunk)))
      .groupBy(PKT.admissionId);
    for (const r of rows) if (r.lastReviewed) out.set(r.admissionId, iso(r.lastReviewed));
  }
  return out;
}

/** The IDG coordinator of each given location, for the M36 review-clock alert's coordinator tier: the coordinator of
 * the location's NEXT upcoming meeting (`scheduled | packets_building | packets_ready | live`, not yet ended), else the
 * location's ACTIVE recurring policy's default coordinator. A location with neither is ABSENT from the map (the alert
 * then reaches only its role tiers — never a guessed coordinator). Same caller-owned org `withOrgContext` tx. */
export async function locationCoordinatorsForOrg(
  tx: DbClient,
  organizationId: string,
  locationIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (locationIds.length === 0) return out;
  const meetings = await tx
    .select({
      locationId: MTG.locationId,
      coordinator: MTG.coordinatorMembershipId,
    })
    .from(MTG)
    .where(
      and(
        eq(MTG.organizationId, organizationId),
        inArray(MTG.locationId, [...locationIds]),
        inArray(MTG.status, ["scheduled", "packets_building", "packets_ready", "live"] as never),
        gte(MTG.scheduledEnd, now),
      ),
    )
    .orderBy(asc(MTG.scheduledStart));
  for (const m of meetings) if (!out.has(m.locationId)) out.set(m.locationId, m.coordinator);
  const missing = locationIds.filter((l) => !out.has(l));
  if (missing.length > 0) {
    const policies = await tx
      .select({ locationId: POL.locationId, coordinator: POL.defaultCoordinatorMembershipId })
      .from(POL)
      .where(
        and(
          eq(POL.organizationId, organizationId),
          inArray(POL.locationId, missing),
          eq(POL.active, true),
        ),
      );
    for (const p of policies) if (!out.has(p.locationId)) out.set(p.locationId, p.coordinator);
  }
  return out;
}
