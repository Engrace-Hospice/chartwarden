// apps/backend/src/modules/06-admission/jobs/cron-store.ts
//
// M6 scheduled-job Drizzle reads.
// The caller owns the `withOrgContext` transaction; this file never opens
// its own tenancy envelope.
//
// Phase 2:
// - F2F due reminders use face_to_face_encounter.scheduled_date
// - election_period is joined to recover the owning admission

import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import { addCalendarDays } from "../certification/window-math";

const F2F = schema.faceToFaceEncounters;
const CTI = schema.certificationsOfTerminalIllness;
const EP = schema.electionPeriods;
const CW = schema.complianceWindows;
const ADM = schema.admissions;

/** 42 CFR 418.22(a)(4)/R-F2F-04 — F2F is required starting the 3rd benefit period. */
const F2F_RECERT_SEQUENCE_FLOOR = 3;

/** Admission statuses whose benefit-period recert cycle is over — a lingering `pending`/`signed`
 *  recert period on one of these (discharge deliberately leaves it untouched, see
 *  admission-route-service-db.ts's `end_election_period` effect) must never false-positive as missed. */
const F2F_TERMINAL_ADMISSION_STATUSES = ["discharged", "bereavement", "closed"] as const;

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
    .where(and(eq(F2F.organizationId, organizationId), isNotNull(F2F.scheduledDate)));

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
      } => row.signatureRequestedAt !== null && row.signatureDueAt !== null,
    )
    .map((row) => ({
      ctiId: row.ctiId,
      electionPeriodId: row.electionPeriodId,
      hospiceMdId: row.hospiceMdId,
      signatureRequestedAt: isoInstant(row.signatureRequestedAt),
      signatureDueAt: isoInstant(row.signatureDueAt),
      hospiceMdSignedAt: row.hospiceMdSignedAt ? isoInstant(row.hospiceMdSignedAt) : null,
    }));
}

/**
 * Candidate recert (sequence >= {@link F2F_RECERT_SEQUENCE_FLOOR}) election periods for the F2F
 * window-missed scan (F-178b, #248), with every fact `planF2fWindowMissedScan` (./index) needs already
 * resolved: `periodStartDate` off the PRECEDING period's `scheduled_end_at + 1 day` (the period's own
 * `effective_at`/`scheduled_end_at` are not populated until IT activates — election-period.ts), whether
 * it already carries an attested F2F, and whether a non-closed `f2f_recert_30d_prior` compliance_window
 * row is already open (the scan's own idempotency ledger).
 *
 * Three flat selects + an in-memory join (matching this file's existing style) rather than one query
 * with a self-join, since Drizzle self-joins have no other precedent in this module.
 */
export async function f2fWindowMissedCandidatesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<F2fWindowMissedCandidateRow[]> {
  const pending = await tx
    .select({
      electionPeriodId: EP.id,
      admissionId: EP.admissionId,
      sequenceNumber: EP.sequenceNumber,
    })
    .from(EP)
    .innerJoin(ADM, eq(ADM.id, EP.admissionId))
    .where(
      and(
        eq(EP.organizationId, organizationId),
        inArray(EP.status, ["pending", "signed"]),
        notInArray(ADM.status, [...F2F_TERMINAL_ADMISSION_STATUSES]),
      ),
    );

  const candidates = pending.filter((p) => p.sequenceNumber >= F2F_RECERT_SEQUENCE_FLOOR);
  if (candidates.length === 0) return [];

  const admissionIds = [...new Set(candidates.map((c) => c.admissionId))];
  const electionPeriodIds = candidates.map((c) => c.electionPeriodId);

  // The PRECEDING period per candidate — every period this org has on file for the same admissions;
  // small and bounded (a handful of periods per admission), joined in JS below.
  const priorPeriods = await tx
    .select({
      admissionId: EP.admissionId,
      sequenceNumber: EP.sequenceNumber,
      scheduledEndAt: EP.scheduledEndAt,
    })
    .from(EP)
    .where(and(eq(EP.organizationId, organizationId), inArray(EP.admissionId, admissionIds)));
  const priorEndByAdmissionSeq = new Map<string, string>();
  for (const p of priorPeriods) {
    if (p.scheduledEndAt)
      priorEndByAdmissionSeq.set(`${p.admissionId}:${p.sequenceNumber}`, p.scheduledEndAt);
  }

  const attestedRows = await tx
    .select({ electionPeriodId: F2F.electionPeriodId })
    .from(F2F)
    .where(
      and(
        eq(F2F.organizationId, organizationId),
        inArray(F2F.electionPeriodId, electionPeriodIds),
        eq(F2F.status, "attested"),
      ),
    );
  const attestedPeriodIds = new Set(attestedRows.map((r) => r.electionPeriodId));

  const flaggedRows = await tx
    .select({ admissionId: CW.admissionId })
    .from(CW)
    .where(
      and(
        eq(CW.organizationId, organizationId),
        inArray(CW.admissionId, admissionIds),
        eq(CW.windowKind, "f2f_recert_30d_prior"),
        ne(CW.status, "closed"),
      ),
    );
  const flaggedAdmissionIds = new Set(flaggedRows.map((r) => r.admissionId));

  const out: F2fWindowMissedCandidateRow[] = [];
  for (const c of candidates) {
    const priorEnd = priorEndByAdmissionSeq.get(`${c.admissionId}:${c.sequenceNumber - 1}`);
    if (!priorEnd) continue; // preceding period unresolved (not yet active) — window unknowable
    out.push({
      electionPeriodId: c.electionPeriodId,
      admissionId: c.admissionId,
      periodStartDate: addCalendarDays(priorEnd, 1),
      attested: attestedPeriodIds.has(c.electionPeriodId),
      alreadyFlagged: flaggedAdmissionIds.has(c.admissionId),
    });
  }
  return out;
}

export interface F2fWindowMissedCandidateRow {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  readonly periodStartDate: string;
  readonly attested: boolean;
  readonly alreadyFlagged: boolean;
}

export interface PeriodPastEndRow {
  readonly id: string;
  readonly admissionId: string;
  readonly sequenceNumber: number;
  readonly status: string;
  /** The period's last covered day (`YYYY-MM-DD`, inclusive) — the event's `endDate`. */
  readonly scheduledEndAt: string;
}

/** Bound on one tick's batch; the next hourly tick drains the remainder. */
const PERIOD_AUTO_END_BATCH = 500;

/**
 * ACTIVE benefit periods whose last covered day is strictly before `today` (org-local `YYYY-MM-DD`).
 * `scheduled_end_at` is the INCLUSIVE last day (state-machines/election-period.ts), so a period is over
 * once `today` is past it. Oldest first so a backlog drains in order.
 */
export async function activePeriodsPastEndForOrg(
  tx: DbClient,
  organizationId: string,
  today: string,
): Promise<PeriodPastEndRow[]> {
  const rows = await tx
    .select({
      id: EP.id,
      admissionId: EP.admissionId,
      sequenceNumber: EP.sequenceNumber,
      status: EP.status,
      scheduledEndAt: EP.scheduledEndAt,
    })
    .from(EP)
    .where(
      and(
        eq(EP.organizationId, organizationId),
        eq(EP.status, "active"),
        isNotNull(EP.scheduledEndAt),
        lt(EP.scheduledEndAt, today),
      ),
    )
    .orderBy(EP.scheduledEndAt)
    .limit(PERIOD_AUTO_END_BATCH);
  return rows.flatMap((r) =>
    r.scheduledEndAt === null ? [] : [{ ...r, scheduledEndAt: r.scheduledEndAt }],
  );
}
