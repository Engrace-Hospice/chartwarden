// apps/backend/src/modules/14-idg/jobs/cron-store.ts — GAP-092: the `idg.review-clock-sweep` cron's
// Drizzle reader over `idg_patient_packet` (the M9 `09-assessments/jobs/cron-store.ts` shape). ORG-scoped,
// caller-owned `withOrgContext` tx — this file never opens its own tenancy envelope; `cron-workers.ts`'s
// per-org fan-out owns that.
//
// No per-patient AGGREGATE read existed before this file: every other M14 packet read
// (`idg-route-service-db.ts`'s `listPackets`/`getPacket`/`getPatientIdgHistory`) is per-meeting or
// per-(meeting,patient), never "every patient's most-recent review across ALL their meetings, org-wide".
import { type DbClient, schema } from "@wardenx/db";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { ReviewClockSnapshot } from "./index";

const PKT = schema.idgPatientPacket;
const MTG = schema.idgMeeting;
const POL = schema.idgRecurringPolicy;

/** Coerce a Drizzle timestamp (Date or string, depending on column mode) to an ISO string. */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

interface PatientAgg {
  admissionId: string;
  locationId: string;
  lastIdgReviewedAt: Date | string | null;
  earliestCursor: string;
  earliestBuiltAt: Date | string;
  latestBuiltAt: Date | string;
}

/** `idg.review-clock-sweep` (§4.8 daily) read: one row per DISTINCT patient with at least one packet in
 * the org, aggregated across ALL their packets (not just the latest — a packet's OWN `last_idg_reviewed_at`
 * is only stamped when ITS OWN meeting adjourns, so an older, already-adjourned packet may carry the
 * patient's true last-reviewed date while a newer, not-yet-adjourned packet still reads null). Takes:
 * MAX(last_idg_reviewed_at) across every packet; the EARLIEST packet's `since_cursor_iso` as the never-
 * reviewed fallback origin; admissionId/locationId from the MOST RECENT packet (current facts). */
export async function reviewClockPatientsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<ReviewClockSnapshot[]> {
  const rows = await tx
    .select({
      patientId: PKT.patientId,
      admissionId: PKT.admissionId,
      locationId: PKT.locationId,
      lastIdgReviewedAt: PKT.lastIdgReviewedAt,
      sinceCursorIso: PKT.sinceCursorIso,
      builtAt: PKT.builtAt,
    })
    .from(PKT)
    .where(eq(PKT.organizationId, organizationId));

  const byPatient = new Map<string, PatientAgg>();
  for (const r of rows) {
    const existing = byPatient.get(r.patientId);
    if (!existing) {
      byPatient.set(r.patientId, {
        admissionId: r.admissionId,
        locationId: r.locationId,
        lastIdgReviewedAt: r.lastIdgReviewedAt,
        earliestCursor: r.sinceCursorIso,
        earliestBuiltAt: r.builtAt,
        latestBuiltAt: r.builtAt,
      });
      continue;
    }
    if (
      r.lastIdgReviewedAt &&
      (!existing.lastIdgReviewedAt ||
        new Date(r.lastIdgReviewedAt) > new Date(existing.lastIdgReviewedAt))
    ) {
      existing.lastIdgReviewedAt = r.lastIdgReviewedAt;
    }
    if (new Date(r.builtAt) < new Date(existing.earliestBuiltAt)) {
      existing.earliestBuiltAt = r.builtAt;
      existing.earliestCursor = r.sinceCursorIso;
    }
    if (new Date(r.builtAt) > new Date(existing.latestBuiltAt)) {
      existing.latestBuiltAt = r.builtAt;
      existing.admissionId = r.admissionId;
      existing.locationId = r.locationId;
    }
  }

  return Array.from(byPatient.entries()).map(([patientId, a]) => ({
    patientId,
    admissionId: a.admissionId,
    locationId: a.locationId,
    lastIdgReviewedAt: a.lastIdgReviewedAt ? iso(a.lastIdgReviewedAt) : null,
    earliestSinceCursorIso: a.earliestCursor,
  }));
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
