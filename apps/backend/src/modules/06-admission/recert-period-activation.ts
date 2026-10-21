// apps/backend/src/modules/06-admission/recert-period-activation.ts
//
// The ONE place a RECERTIFICATION benefit period (sequence >= 2 with an earlier period on the same admission)
// is gated and started. Two callers share it:
//   * `signCtiHospiceMd` — the recert CTI signature. It runs the F2F/CTI adequacy gate (fail closed) and
//     starts the period ONLY when the period's start date has already arrived (a late recert);
//   * the hourly period auto-end cron — after completing period N on its end date it starts the signed
//     period N+1 on its start date (§2.3.2 `signed --> active: setActive (... on prior period auto-close)`).
//
// Why (bug: overlapping benefit periods). Benefit periods are CONTIGUOUS — 90/90/60/60… days, each starting
// the day after the previous one ends (42 CFR 418.21(a)) — and a recertification may be signed up to 15
// days BEFORE the next period starts (42 CFR 418.22(a)(3)). The sign path used to flip the next period to
// `active` immediately and date it from the SIGNING day, so an early signature left two `active` periods
// overlapping by up to two weeks and every later period shifted earlier. The start date is now the
// preceding period's end + 1 day, and the period stays `pending` until that day.
import { type DbClient, schema } from "@wardenx/db";
import type { LocalDate } from "@wardenx/types";
import { ChartWardenError } from "@wardenx/types";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  type AdequacyResult,
  evaluatePeriodAdequacy,
  summarizeAdequacy,
} from "./certification/adequacy";
import { resolveF2fWindowStart } from "./certification/f2f-window";
import { addCalendarDays } from "./certification/window-math";
import {
  type ElectionPeriodOutboxPort,
  completeActiveElectionPeriod,
} from "./election-period-completion";
import {
  type ElectionPeriodState,
  RECERT_SEQUENCE_FLOOR,
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
  transitionElectionPeriod,
} from "./state-machines/election-period";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;

/** The org timezone the adequacy predicate's late-signature math has always used. */
export const DEFAULT_ORG_TZ = "America/Los_Angeles";

/** Bound on one cron tick's activation batch; the next hourly tick drains the remainder. */
const RECERT_ACTIVATION_BATCH = 500;

/** R-F2F-04 — does this period carry an ATTESTED face-to-face encounter (not merely a scheduled one)? */
export async function hasAttestedF2f(tx: DbClient, periodId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: F2F.id })
    .from(F2F)
    .where(
      and(
        eq(F2F.electionPeriodId, periodId),
        eq(F2F.status, "attested"),
        isNotNull(F2F.attestationSignedAt),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * F-226 - the start a period's F2F window is anchored to (see `resolveF2fWindowStart`): its stored
 * `expected_start`, else the preceding period's `scheduled_end_at` + 1, else its own `effective_at`.
 */
export async function resolvePeriodF2fWindowStart(
  tx: DbClient,
  periodId: string,
): Promise<{ start: string; source: string } | null> {
  const [ep] = await tx
    .select({
      admissionId: EP.admissionId,
      sequenceNumber: EP.sequenceNumber,
      expectedStart: EP.expectedStart,
      effectiveAt: EP.effectiveAt,
    })
    .from(EP)
    .where(eq(EP.id, periodId))
    .limit(1);
  if (!ep) return null;
  const [prior] = await tx
    .select({ scheduledEndAt: EP.scheduledEndAt })
    .from(EP)
    .where(
      and(eq(EP.admissionId, ep.admissionId), eq(EP.sequenceNumber, Number(ep.sequenceNumber) - 1)),
    )
    .limit(1);
  // Readmission workflow — an admission's FIRST period (a re-election into period 3+) has no predecessor on the
  // admission to derive a start from; its start is the admission date.
  let admissionDay: string | null = null;
  const [earlier] =
    !prior && !ep.expectedStart && !ep.effectiveAt
      ? await tx
          .select({ id: EP.id })
          .from(EP)
          .where(
            and(
              eq(EP.admissionId, ep.admissionId),
              lt(EP.sequenceNumber, Number(ep.sequenceNumber)),
            ),
          )
          .limit(1)
      : [{ id: "n/a" }];
  // Only the admission's FIRST period falls back to the admission date; a recert with a missing predecessor
  // stays unverifiable (fail closed, F-226).
  if (!earlier) {
    const [adm] = await tx
      .select({ admissionAt: ADM.admissionAt })
      .from(ADM)
      .where(eq(ADM.id, ep.admissionId))
      .limit(1);
    admissionDay = adm?.admissionAt ? adm.admissionAt.toISOString().slice(0, 10) : null;
  }
  return resolveF2fWindowStart({
    expectedStart: ep.expectedStart ?? admissionDay,
    priorScheduledEnd: prior?.scheduledEndAt ?? null,
    effectiveAt: ep.effectiveAt,
  });
}

/**
 * F-217 — load every fact the F2F/CTI adequacy predicate (`certification/adequacy.ts`) needs for one
 * election period, org-scoped (RLS via the caller's `withOrgContext`), and evaluate it. `startDate` is the
 * org-local first day of the benefit period (for a recert: the preceding period's end + 1, see
 * `recertPeriodStartInTx`) — the anchor of the CTI late-signature math.
 * F-226 - `windowBasis: 'strict'`: the gate recomputes the R-F2F-02 window from the REAL `encounter_date`
 * against the period's EXPECTED start and ALSO requires the persisted `within_window` to be `true`; a
 * NULL/false flag, a missing date or an undeterminable start fails closed.
 */
export async function evaluateAdequacyForPeriod(
  tx: DbClient,
  periodId: string,
  startDate: string,
): Promise<AdequacyResult | null> {
  const [ep] = await tx
    .select({
      id: EP.id,
      sequenceNumber: EP.sequenceNumber,
      periodKind: EP.periodKind,
      admissionId: EP.admissionId,
    })
    .from(EP)
    .where(eq(EP.id, periodId))
    .limit(1);
  if (!ep) return null;
  const [adm] = await tx
    .select({ hospicePhysicianId: ADM.hospicePhysicianId })
    .from(ADM)
    .where(eq(ADM.id, ep.admissionId))
    .limit(1);
  const f2fStart = await resolvePeriodF2fWindowStart(tx, periodId);
  const ctis = await tx
    .select({
      electionPeriodId: CTI.electionPeriodId,
      status: CTI.status,
      hospiceMdId: CTI.hospiceMdId,
      hospiceMdSignedAt: CTI.hospiceMdSignedAt,
      attendingMdId: CTI.attendingMdId,
      attendingMdSignedAt: CTI.attendingMdSignedAt,
      narrative: CTI.narrative,
      signedLate: CTI.signedLate,
      lateReason: CTI.lateReason,
    })
    .from(CTI)
    .where(eq(CTI.electionPeriodId, periodId))
    .orderBy(asc(CTI.createdAt));
  const f2fs = await tx
    .select({
      electionPeriodId: F2F.electionPeriodId,
      status: F2F.status,
      performerRole: F2F.performerRole,
      encounterDate: F2F.encounterDate,
      withinWindow: F2F.withinWindow,
      windowOverride: F2F.windowOverride,
      windowOverrideReason: F2F.windowOverrideReason,
      windowOverrideBy: F2F.windowOverrideBy,
      attestationSignedAt: F2F.attestationSignedAt,
    })
    .from(F2F)
    .where(eq(F2F.electionPeriodId, periodId))
    .orderBy(asc(F2F.createdAt));
  return evaluatePeriodAdequacy({
    period: {
      electionPeriodId: ep.id,
      sequenceNumber: Number(ep.sequenceNumber),
      periodKind: ep.periodKind,
      startDate,
      f2fWindowStart: f2fStart?.start ?? null,
    },
    admissionHospicePhysicianId: adm?.hospicePhysicianId ?? null,
    timeZone: DEFAULT_ORG_TZ,
    windowBasis: "strict",
    ctis: ctis.map((c) => ({
      ...c,
      hospiceMdSignedAt: c.hospiceMdSignedAt ? c.hospiceMdSignedAt.toISOString() : null,
      attendingMdSignedAt: c.attendingMdSignedAt ? c.attendingMdSignedAt.toISOString() : null,
    })),
    f2fs: f2fs.map((f) => ({
      ...f,
      attestationSignedAt: f.attestationSignedAt ? f.attestationSignedAt.toISOString() : null,
    })),
  });
}

/** The recert period plus the period that precedes it on the same admission (highest lower sequence). */
export interface RecertPeriodContext {
  readonly id: string;
  readonly admissionId: string;
  readonly sequenceNumber: number;
  readonly status: ElectionPeriodState;
  readonly prior: {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly status: string;
    readonly scheduledEndAt: string | null;
    readonly actualEndAt: string | null;
    readonly completedByCause: string | null;
  } | null;
  /**
   * The period's first day: the prior period's (actual, else scheduled) last day + 1 (contiguous, 42 CFR
   * 418.21(a)), else the stored `expected_start`; `null` = not derivable (legacy rows with no dates).
   */
  readonly startDate: LocalDate | null;
}

/** Pure: the start of a period that follows `prior` (its actual end, else scheduled end, + 1 day). */
export function recertPeriodStartDate(
  prior: { readonly scheduledEndAt: string | null; readonly actualEndAt: string | null } | null,
  expectedStart: string | null,
): LocalDate | null {
  const priorEnd = prior?.actualEndAt ?? prior?.scheduledEndAt ?? null;
  if (priorEnd) return addCalendarDays(priorEnd, 1);
  return expectedStart;
}

/** Load a period + its predecessor; `prior === null` means it is the admission's FIRST period. */
export async function recertPeriodContextInTx(
  tx: DbClient,
  periodId: string,
): Promise<RecertPeriodContext | null> {
  const [ep] = await tx
    .select({
      id: EP.id,
      admissionId: EP.admissionId,
      sequenceNumber: EP.sequenceNumber,
      status: EP.status,
      expectedStart: EP.expectedStart,
    })
    .from(EP)
    .where(eq(EP.id, periodId))
    .limit(1);
  if (!ep) return null;
  const [prior] = await tx
    .select({
      id: EP.id,
      sequenceNumber: EP.sequenceNumber,
      status: EP.status,
      scheduledEndAt: EP.scheduledEndAt,
      actualEndAt: EP.actualEndAt,
      completedByCause: EP.completedByCause,
    })
    .from(EP)
    .where(and(eq(EP.admissionId, ep.admissionId), lt(EP.sequenceNumber, ep.sequenceNumber)))
    .orderBy(desc(EP.sequenceNumber))
    .limit(1);
  const priorFacts = prior
    ? {
        id: prior.id,
        sequenceNumber: Number(prior.sequenceNumber),
        status: prior.status,
        scheduledEndAt: prior.scheduledEndAt,
        actualEndAt: prior.actualEndAt,
        completedByCause: prior.completedByCause,
      }
    : null;
  return {
    id: ep.id,
    admissionId: ep.admissionId,
    sequenceNumber: Number(ep.sequenceNumber),
    status: ep.status as ElectionPeriodState,
    prior: priorFacts,
    startDate: recertPeriodStartDate(priorFacts, ep.expectedStart),
  };
}

/**
 * Can this recert period take over from its predecessor? Only when the predecessor is still running into
 * it (it is completed here as `next_period`) or already ended on its own date (`next_period`). A
 * predecessor ended by discharge / revocation / transfer ended the ELECTION — nothing follows it.
 */
export function predecessorHandsOver(ctx: RecertPeriodContext): boolean {
  const { prior } = ctx;
  if (!prior) return false;
  if (prior.status === "active") return true;
  return prior.status === "completed" && prior.completedByCause === "next_period";
}

/**
 * The fail-closed recert gate (no writes): the §2.3.2 `setActive` guards (signed CTI, R-F2F-04 attested F2F
 * from period 3) and the F-217 F2F/CTI adequacy predicate, evaluated against the period's REAL start date.
 * Throws the machine's typed error, or 409 `ELECTION_PERIOD_ADEQUACY_FAILED` with the reason codes.
 */
export async function assertRecertPeriodReady(
  tx: DbClient,
  ctx: RecertPeriodContext,
  startDate: LocalDate,
): Promise<AdequacyResult | null> {
  transitionElectionPeriod(ctx.status, {
    type: "setActive",
    certificationSigned: true, // callers reach here only with the hospice-MD signature on file
    admissionActivated: true,
    sequence: ctx.sequenceNumber,
    f2fAttested:
      ctx.sequenceNumber >= RECERT_SEQUENCE_FLOOR ? await hasAttestedF2f(tx, ctx.id) : true,
    effectiveAt: startDate,
  });
  const adequacy = await evaluateAdequacyForPeriod(tx, ctx.id, startDate);
  if (adequacy && adequacy.verdict === "inadequate") {
    throw new ChartWardenError(
      "ELECTION_PERIOD_ADEQUACY_FAILED",
      `The election period cannot start: its certification of terminal illness and/or face-to-face encounter is not adequate (${adequacy.reasonCodes.join(", ")}).`,
      409,
      adequacy.reasonCodes.map((code) => ({ code, message: code })),
    );
  }
  return adequacy;
}

/**
 * Start a gated recert period on `startDate`: complete the predecessor if it is still `active` (cause
 * `next_period`, last day = `startDate - 1`, publishing `m6.election.period_ended`), stamp the 42 CFR
 * 418.21(a) window from `startDate`, and publish `m6.election.period_started` — once, guarded by the
 * status-conditional UPDATE. Returns `false` when a concurrent writer already started it.
 */
export async function startRecertPeriodInTx(
  tx: DbClient,
  deps: { readonly outbox: ElectionPeriodOutboxPort; readonly now: () => Date },
  input: {
    readonly organizationId: string;
    readonly ctx: RecertPeriodContext;
    readonly startDate: LocalDate;
    readonly adequacy: AdequacyResult | null;
  },
): Promise<boolean> {
  const { ctx, startDate, organizationId } = input;
  if (ctx.prior?.status === "active") {
    await completeActiveElectionPeriod(tx, deps, {
      organizationId,
      period: {
        id: ctx.prior.id,
        admissionId: ctx.admissionId,
        sequenceNumber: ctx.prior.sequenceNumber,
        status: "active",
      },
      cause: "next_period",
      endDate: addCalendarDays(startDate, -1),
    });
  }
  const scheduledEndAt = electionPeriodScheduledEnd(
    startDate,
    electionPeriodKindForSequence(ctx.sequenceNumber),
  );
  const updated = await tx
    .update(EP)
    .set({
      status: "active",
      effectiveAt: startDate,
      scheduledEndAt,
      version: sql`${EP.version} + 1`,
      updatedAt: deps.now(),
    })
    .where(and(eq(EP.id, ctx.id), inArray(EP.status, ["pending", "signed"])))
    .returning({ id: EP.id });
  if (updated.length === 0) return false;
  await deps.outbox.publish(tx, {
    eventName: "m6.election.period_started",
    payload: {
      electionPeriodId: ctx.id,
      sequence: ctx.sequenceNumber,
      admissionId: ctx.admissionId,
      startDate,
      endDate: scheduledEndAt,
      ...(input.adequacy ? { adequacy: summarizeAdequacy(input.adequacy) } : {}),
    },
    organizationId,
    aggregateKind: "election_period",
    aggregateId: ctx.id,
  });
  return true;
}

/**
 * Cron half (§2.3.2 "setActive … on prior period auto-close"): start every not-yet-active recert period of
 * the org whose CTI is signed and whose start date (`prior end + 1`) is on or before `today` (org-local).
 * Each period is re-gated (a CTI voided or an F2F withdrawn after signing keeps it `pending`); a refusal is
 * skipped, never thrown, so one bad period cannot block the org's tick. Returns the number started.
 */
export async function startDueRecertPeriodsForOrg(
  tx: DbClient,
  deps: { readonly outbox: ElectionPeriodOutboxPort; readonly now: () => Date },
  organizationId: string,
  today: LocalDate,
): Promise<number> {
  const candidates = await tx
    .selectDistinct({ id: EP.id, sequenceNumber: EP.sequenceNumber })
    .from(EP)
    .innerJoin(CTI, eq(CTI.electionPeriodId, EP.id))
    .where(
      and(
        eq(EP.organizationId, organizationId),
        inArray(EP.status, ["pending", "signed"]),
        sql`${EP.sequenceNumber} >= 2`,
        eq(CTI.status, "signed"),
      ),
    )
    .orderBy(EP.sequenceNumber)
    .limit(RECERT_ACTIVATION_BATCH);
  let started = 0;
  for (const candidate of candidates) {
    const ctx = await recertPeriodContextInTx(tx, candidate.id);
    if (!ctx?.startDate || ctx.startDate > today || !predecessorHandsOver(ctx)) continue;
    let adequacy: AdequacyResult | null;
    try {
      adequacy = await assertRecertPeriodReady(tx, ctx, ctx.startDate);
    } catch {
      continue; // still inadequate: it stays `pending` and the recert-due window keeps escalating
    }
    if (
      await startRecertPeriodInTx(tx, deps, {
        organizationId,
        ctx,
        startDate: ctx.startDate,
        adequacy,
      })
    )
      started += 1;
  }
  return started;
}
