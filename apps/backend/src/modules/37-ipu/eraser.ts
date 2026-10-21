// apps/backend/src/modules/37-ipu/eraser.ts — M37 §7.7 / D8 the `ipu_record` destruction eraser.
//
// M37 registers an eraseFn with M4's destruction-cert workflow (§7.7). Under a destruction certificate it
// deletes the patient's IPU subtree in FK order (satellites → the ipu_admission root), plus the patient's
// per-patient visitor restrictions. M37 tables GRANT DELETE to wardenx_app (migration 0153), so the delete
// runs under RLS in the tenant pool — no BYPASSRLS. Registered via the composition root's registerModuleErasers
// hook over the Phase-0 `ipu_record` deny-stub (it runs AFTER wireErasers() / before validateErasers()).
//
// The free-text PHI (restraint justification, GIP data/rationale, visitor name, body-release rep name) lives
// in the deleted rows; the audit-of-audit trail survives per M4 (the destruction certificate records the
// per-table affected-row counts). Aggregate census snapshots survive right-to-erasure (they carry no
// patient_id — the D14 reproducibility rule, mirroring M26's `cap` posture).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq, inArray } from "drizzle-orm";

import { registerEraser } from "../../bootstrap/index";

/**
 * §7.7 — erase the patient's IPU record. Collects the patient's ipu_admission ids, deletes the FK-restricted
 * satellites (restraint reassessment → event, GIP reassessment → criteria, IRC episode, IV overlay, body
 * release, remote episode, bed assignment, transition), then the append-only ledgers (state history, visitor,
 * meal), then the per-patient visitor restrictions, then the ipu_admission roots. Returns the total row count.
 */
export async function eraseIpuRecord(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<number> {
  return withOrgContext(db, { organizationId, userId: "" }, async (txUnknown) => {
    const tx = txUnknown as DbClient;
    const admissions = await tx
      .select({ id: schema.ipuAdmission.id })
      .from(schema.ipuAdmission)
      .where(eq(schema.ipuAdmission.patientId, patientId));
    const ids = admissions.map((a) => a.id);
    let n = 0;

    if (ids.length > 0) {
      const restraintEvents = await tx
        .select({ id: schema.ipuRestraintEvent.id })
        .from(schema.ipuRestraintEvent)
        .where(inArray(schema.ipuRestraintEvent.ipuAdmissionId, ids));
      const reIds = restraintEvents.map((r) => r.id);
      if (reIds.length > 0) {
        n += (
          await tx
            .delete(schema.ipuRestraintReassessment)
            .where(inArray(schema.ipuRestraintReassessment.restraintEventId, reIds))
            .returning({ id: schema.ipuRestraintReassessment.id })
        ).length;
      }
      n += (
        await tx
          .delete(schema.ipuRestraintEvent)
          .where(inArray(schema.ipuRestraintEvent.ipuAdmissionId, ids))
          .returning({ id: schema.ipuRestraintEvent.id })
      ).length;
      n += (
        await tx
          .delete(schema.gipCriteriaReassessment)
          .where(inArray(schema.gipCriteriaReassessment.ipuAdmissionId, ids))
          .returning({ id: schema.gipCriteriaReassessment.id })
      ).length;
      n += (
        await tx
          .delete(schema.gipAdmissionCriteria)
          .where(inArray(schema.gipAdmissionCriteria.ipuAdmissionId, ids))
          .returning({ id: schema.gipAdmissionCriteria.id })
      ).length;
      n += (
        await tx
          .delete(schema.ircEpisode)
          .where(inArray(schema.ircEpisode.ipuAdmissionId, ids))
          .returning({ id: schema.ircEpisode.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuIvSafetyOverlay)
          .where(inArray(schema.ipuIvSafetyOverlay.ipuAdmissionId, ids))
          .returning({ id: schema.ipuIvSafetyOverlay.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuBodyRelease)
          .where(inArray(schema.ipuBodyRelease.ipuAdmissionId, ids))
          .returning({ id: schema.ipuBodyRelease.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuRemoteInpatientEpisode)
          .where(inArray(schema.ipuRemoteInpatientEpisode.ipuAdmissionId, ids))
          .returning({ id: schema.ipuRemoteInpatientEpisode.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuBedAssignment)
          .where(inArray(schema.ipuBedAssignment.ipuAdmissionId, ids))
          .returning({ id: schema.ipuBedAssignment.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuAdmissionTransition)
          .where(inArray(schema.ipuAdmissionTransition.ipuAdmissionId, ids))
          .returning({ id: schema.ipuAdmissionTransition.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuAdmissionStateHistory)
          .where(inArray(schema.ipuAdmissionStateHistory.ipuAdmissionId, ids))
          .returning({ id: schema.ipuAdmissionStateHistory.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuVisitor)
          .where(inArray(schema.ipuVisitor.ipuAdmissionId, ids))
          .returning({ id: schema.ipuVisitor.id })
      ).length;
      n += (
        await tx
          .delete(schema.ipuMealService)
          .where(inArray(schema.ipuMealService.ipuAdmissionId, ids))
          .returning({ id: schema.ipuMealService.id })
      ).length;
    }

    // Per-patient visitor restrictions (scope='patient').
    n += (
      await tx
        .delete(schema.ipuVisitorRestriction)
        .where(eq(schema.ipuVisitorRestriction.patientId, patientId))
        .returning({ id: schema.ipuVisitorRestriction.id })
    ).length;
    // The admission roots last.
    n += (
      await tx
        .delete(schema.ipuAdmission)
        .where(eq(schema.ipuAdmission.patientId, patientId))
        .returning({ id: schema.ipuAdmission.id })
    ).length;
    return n;
  });
}

/**
 * Register M37's REAL `ipu_record` eraser over the Phase-0 deny-stub. Called by the composition root after
 * wireErasers() and before validateErasers(). `subjectId` is the patient being destroyed.
 */
export function registerIpuErasers(db: DbClient): void {
  const eraser: DataEraser = {
    async erase(scope, subjectId) {
      const erased = await eraseIpuRecord(db, scope.orgId, subjectId);
      return { erased };
    },
  };
  registerEraser("ipu_record", eraser);
}
