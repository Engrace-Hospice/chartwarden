// apps/backend/src/modules/06-admission/jobs/cron-store.ts
//
// M6 scheduled-job Drizzle reads.
// The caller owns the `withOrgContext` transaction; this file never opens
// its own tenancy envelope.
//
// Phase 2:
// - F2F due reminders use face_to_face_encounter.scheduled_date
// - election_period is joined to recover the owning admission

import { type DbClient, schema } from "@wardenx/db";
import { and, eq, isNotNull } from "drizzle-orm";

const F2F = schema.faceToFaceEncounters;
const CTI = schema.certificationsOfTerminalIllness;
const EP = schema.electionPeriods;

export interface F2fDueCronRow {
  readonly f2fId: string;
  readonly electionPeriodId: string;
  readonly admissionId: string;
  readonly performedByUserId: string;
  readonly scheduledDate: string;
  readonly status: string;
}

/**
 * Return every scheduled F2F with a usable due date for one organization.
 *
 * We intentionally keep `completed` F2Fs in the result:
 * performing the encounter is not the terminal compliance state —
 * the F2F requirement is complete only once it reaches `attested`.
 *
 * `attested` rows are excluded because they need no further due reminders.
 */
export async function f2fDueRowsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<F2fDueCronRow[]> {
  const rows = await tx
    .select({
      f2fId: F2F.id,
      electionPeriodId: F2F.electionPeriodId,
      admissionId: EP.admissionId,
      performedByUserId: F2F.performedByUserId,
      scheduledDate: F2F.scheduledDate,
      status: F2F.status,
    })
    .from(F2F)
    .innerJoin(EP, eq(EP.id, F2F.electionPeriodId))
    .where(
      and(
        eq(F2F.organizationId, organizationId),
        isNotNull(F2F.scheduledDate),
      ),
    );

  return rows
    .filter(
      (
        row,
      ): row is typeof row & {
        scheduledDate: string;
      } => row.scheduledDate !== null,
    )
    .map((row) => ({
      f2fId: row.f2fId,
      electionPeriodId: row.electionPeriodId,
      admissionId: row.admissionId,
      performedByUserId: row.performedByUserId,
      scheduledDate: row.scheduledDate,
      status: row.status,
    }));
}

export interface CtiSignatureDueCronRow {
  readonly ctiId: string;
  readonly electionPeriodId: string;
  readonly hospiceMdId: string;
  readonly signatureRequestedAt: string;
  readonly signatureDueAt: string;
  readonly hospiceMdSignedAt: string | null;
}

const isoInstant = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

export async function ctiSignatureDueRowsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<CtiSignatureDueCronRow[]> {
  const rows = await tx
    .select({
      ctiId: CTI.id,
      electionPeriodId: CTI.electionPeriodId,
      hospiceMdId: CTI.hospiceMdId,
      signatureRequestedAt: CTI.signatureRequestedAt,
      signatureDueAt: CTI.signatureDueAt,
      hospiceMdSignedAt: CTI.hospiceMdSignedAt,
    })
    .from(CTI)
    .where(
      and(
        eq(CTI.organizationId, organizationId),
        isNotNull(CTI.signatureRequestedAt),
        isNotNull(CTI.signatureDueAt),
      ),
    );

  return rows
    .filter(
      (
        row,
      ): row is typeof row & {
        signatureRequestedAt: Date | string;
        signatureDueAt: Date | string;
      } =>
        row.signatureRequestedAt !== null &&
        row.signatureDueAt !== null,
    )
    .map((row) => ({
      ctiId: row.ctiId,
      electionPeriodId: row.electionPeriodId,
      hospiceMdId: row.hospiceMdId,
      signatureRequestedAt: isoInstant(row.signatureRequestedAt),
      signatureDueAt: isoInstant(row.signatureDueAt),
      hospiceMdSignedAt: row.hospiceMdSignedAt
        ? isoInstant(row.hospiceMdSignedAt)
        : null,
    }));
}