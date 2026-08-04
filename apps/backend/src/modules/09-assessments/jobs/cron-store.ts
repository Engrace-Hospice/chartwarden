// apps/backend/src/modules/09-assessments/jobs/cron-store.ts — TASK-040D: the M9 `license`/`changes`/
// `cadence` crons' Drizzle reader/writer over `scale_license`, `significant_change_event`, and
// `clinical_assessment` (the M7 `07-care-plan/jobs/cron-store.ts` shape). ORG-scoped, caller-owned
// `withOrgContext` tx — this file never opens its own tenancy envelope; `cron-workers.ts`'s per-org
// fan-out owns that so a scan's reads, the outbox publish, and the write-back commit atomically.
//
// No org-wide precedent existed for any of these three reads before this file: `../seams/drizzle-store.ts`
// and `../assessments-route-service-db.ts` are all request-context-bound (single patient / single scale).
import { type DbClient, schema } from "@wardenx/db";
import type { ScaleLicenseStatus } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type {
  ReassessmentSnapshot,
  ScaleLicenseSnapshot,
  SignificantChangeSnapshot,
} from "./index";

const LIC = schema.scaleLicenses;
const SCE = schema.significantChangeEvents;
const CA = schema.clinicalAssessments;

/** Coerce a Drizzle `timestamptz` to an ISO instant (date columns already come back as `YYYY-MM-DD`
 * strings — see `assessments-route-service-db.ts`'s `scoredForWrite`, which passes `LIC.effectiveDate`/
 * `LIC.expiresAt` straight into `computeScaleLicenseStatus` with no conversion). */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** `license-status-scan` (§4.8 daily) read: every `scale_license` row for the org (small table, no
 * further filter needed). */
export async function scaleLicensesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<ScaleLicenseSnapshot[]> {
  const rows = await tx
    .select({
      id: LIC.id,
      scaleType: LIC.scaleType,
      status: LIC.status,
      effectiveDate: LIC.effectiveDate,
      expiresAt: LIC.expiresAt,
    })
    .from(LIC)
    .where(eq(LIC.organizationId, organizationId));
  return rows.map((r) => ({
    scaleLicenseId: r.id,
    scaleType: r.scaleType,
    status: r.status,
    effectiveDate: r.effectiveDate,
    expiresAt: r.expiresAt,
  }));
}

/** `license-status-scan` write-back: persist a license's recomputed status (§2.2.3 transition). This is
 * the FIRST writer of `scale_license.status` anywhere in the codebase — nothing else has ever updated it
 * (confirmed by prior research); the license-admin route only inserts/edits the licensure facts. */
export async function updateLicenseStatus(
  tx: DbClient,
  scaleLicenseId: string,
  status: ScaleLicenseStatus,
): Promise<void> {
  await tx.update(LIC).set({ status }).where(eq(LIC.id, scaleLicenseId));
}

/** `change-escalation` (§4.8 hourly) read: every `open` significant-change event for the org, mirroring
 * the query shape at `assessments-route-service-db.ts`'s `listSignificantChanges` (widened from that call
 * site's patient scope to org-wide, and filtered to `status = 'open'` since only open rows can escalate). */
export async function openSignificantChangesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<SignificantChangeSnapshot[]> {
  const rows = await tx
    .select({ id: SCE.id, ruleId: SCE.ruleId, status: SCE.status, detectedAt: SCE.detectedAt })
    .from(SCE)
    .where(and(eq(SCE.organizationId, organizationId), eq(SCE.status, "open")));
  return rows.map((r) => ({
    eventId: r.id,
    ruleId: r.ruleId,
    status: r.status,
    detectedAt: iso(r.detectedAt),
  }));
}

/** `change-escalation` write-back: flip one event to `escalated`, mirroring the `.update()` shape at
 * `assessments-route-service-db.ts`'s `acknowledgeChange` (same table, different target fields). */
export async function escalateSignificantChange(
  tx: DbClient,
  eventId: string,
  escalatedAt: Date,
): Promise<void> {
  await tx.update(SCE).set({ status: "escalated", escalatedAt }).where(eq(SCE.id, eventId));
}

/** `reassessment-due-scan` (§4.8 daily) read: the latest `clinical_assessment` row per (patient,
 * scale_type) for the org — `DISTINCT ON` via Drizzle's `selectDistinctOn` (no existing precedent for
 * this "latest per group, org-wide" shape; `../seams/drizzle-store.ts`'s `latestActiveBatch` is per-
 * single-patient only). Scoped to `organizationId` + `status = 'active'`, matching the partial index
 * `clinical_assessment_patient_scale_captured_idx` (org, patient, scale, captured_at desc) so the scan
 * stays sargable against the partitioned table.
 *
 * SCOPE NOTE: this scans every patient with ANY active row in `clinical_assessment` for the org, not only
 * patients with an active M6 admission — M9's `dependsOn` (architecture/module-manifest.ts) is `[1, 38]`
 * only (no M6), and no published seam answers "every actively-admitted patient in an org" today. A
 * discharged patient's last capture may therefore be flagged overdue; a documented, bounded scope cut
 * rather than a new cross-module seam.
 */
export async function latestAssessmentsPerPatientScaleForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<ReassessmentSnapshot[]> {
  const rows = await tx
    .selectDistinctOn([CA.patientId, CA.scaleType], {
      patientId: CA.patientId,
      scaleType: CA.scaleType,
      capturedAt: CA.capturedAt,
    })
    .from(CA)
    .where(and(eq(CA.organizationId, organizationId), eq(CA.status, "active")))
    .orderBy(CA.patientId, CA.scaleType, desc(CA.capturedAt));
  return rows.map((r) => ({
    patientId: r.patientId,
    scaleType: r.scaleType,
    lastCapturedAt: iso(r.capturedAt),
  }));
}
