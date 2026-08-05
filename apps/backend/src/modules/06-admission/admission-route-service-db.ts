// apps/backend/src/modules/06-admission — PRODUCTION AdmissionRouteService (M6L-T01 reads, T02–T03 writes).
//
// READS (referral inbox, admission census + detail, election periods, compliance windows) run as real
// Drizzle queries under `withOrgContext`, RLS-scoped as the unprivileged `wardenx_app` role. The WRITE
// lifecycle is real for T02 (referral intake → triage → accept → draft-from-referral cascade → NOR ack →
// activate → hold/resume), T03 (election statement draft/sign/void; election period create/patch; CTI
// draft/hospice-MD sign [recert activates its period]/attending sign/void/mark-late), and T04 (F2F
// schedule/complete/attest/window-override; LOC change/patch; revocation; transfer in/out; discharge with
// the D11 for-cause file → medical-director cosign cascade, death → bereavement). Each write drives the
// §2.3.1/2.3.4/2.3.5 pure state machines, enforces optimistic concurrency (stale `ifVersion` → 409),
// executes the §2.5 declarative effects (windows open/close, LOC + election-period end cascades), and
// emits `m6.*` on the transactional outbox. T05 (compliance-window close/override) completes the surface:
// the WHOLE M6 write lifecycle is now real Drizzle — no route left at 501.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import type { LevelOfCare } from "@wardenx/types";
import { type AnyColumn, type SQL, and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { decideRecertSign } from "./certification/recert";
import { computeWrittenCertDeadline } from "./certification/window-math";
import { resolveForCauseDischarge } from "./discharge/for-cause";
import {
  type DischargeReason,
  checkDischargeNarrative,
  dischargeRequiresCosign,
} from "./discharge/permission-map";
import { type TransferInInput, planTransferIn } from "./discharge/transfer-in";
import { computeActivationGate } from "./intake";
import type {
  CtiDraftInput,
  DischargeInput,
  DischargeResult,
  RevocationInput,
  TransferOutInput,
} from "./routes/service";
import {
  ActivationPreconditionError,
  InvalidReferralStateError,
  ReferralNotTriagedError,
  ResourceNotFoundError,
  VersionMismatchError,
} from "./routes/service";
import type {
  AdmissionAbacResolver,
  AdmissionDetail,
  AdmissionRouteService,
  MutationResult,
  Page,
  PatientElectionCertificationView,
  SummaryRow,
} from "./routes/service";
import {
  type AdmissionEvent,
  type AdmissionState,
  transitionAdmission,
} from "./state-machines/admission";
import { planDischarge, planRevocation, planTransferOut } from "./state-machines/commands";
import type { SideEffect } from "./state-machines/effects";
import { AdmissionStateError } from "./state-machines/errors";
import { type FaceToFaceState, transitionFaceToFace } from "./state-machines/face-to-face";
import { type LevelOfCareState, transitionLevelOfCare } from "./state-machines/level-of-care";

/**
 * The transactional-outbox port (§4.4): the composition root binds M1's catalog-validating publisher
 * pinned to caller-module `m6`; `publish` writes the `outbox_event` row on the CALLER'S tx. The default
 * is a no-op so the slice/tests commit without a dispatcher (the state + windows are the load-bearing
 * effects; downstream consumers ride the outbox once it is wired at the mount).
 */
export interface AdmissionWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: AdmissionWriteOutboxPort = { async publish() {} };

/**
 * The real §2.3.5 "bedId verified with M37" check — M37's `IpuBedAssignmentProvider` seam narrowed to
 * the one method `confirmLocBedAssignment` needs. Optional: an absent binding fails the confirm route
 * closed with a precise 503 rather than silently trusting an unverified bed (matches the M24 composition-
 * root reader posture — degrade with a message, never fake success).
 */
export interface IpuBedAssignmentReaderPort {
  activeBedAssignmentForLevelOfCarePeriod(
    organizationId: string,
    levelOfCarePeriodId: string,
  ): Promise<{ ipuAdmissionId: string; bedAssignmentId: string; bedId: string } | null>;
}

type ReferralSourceChannel =
  | "phone"
  | "fax"
  | "portal"
  | "walk_in"
  | "self_referral"
  | "physician_office"
  | "hospital_discharge_planner";

/** First row of a `RETURNING`/`SELECT` under `noUncheckedIndexedAccess`, or a 404 (unreachable after a write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new WardenXError("NOT_FOUND", msg, 404);
  return r;
}

const REF = schema.referrals;
const ADM = schema.admissions;
const EP = schema.electionPeriods;
const ES = schema.electionStatements;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const LOC = schema.levelOfCarePeriods;
const NOR = schema.noticeOfRightsAcknowledgments;
const CW = schema.complianceWindows;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;
const RE = schema.revocationEvents;

/** §4.2.7 discharge reason → the §2.3.1 `executeDischarge` discriminator the pure state machine reads. */
const REASON_TO_SM_TYPE: Record<
  DischargeReason,
  "death" | "moved" | "no_longer_terminal" | "for_cause" | "routine"
> = {
  death: "death",
  moved_out_of_service_area: "moved",
  no_longer_terminal: "no_longer_terminal",
  for_cause: "for_cause",
  other: "routine",
};
/** §4.2.7 discharge reason → the `discharge_type` enum persisted on the discharge_event row. */
const REASON_TO_DB_TYPE: Record<
  DischargeReason,
  "death" | "moved_out_of_service_area" | "no_longer_terminal" | "for_cause" | "other"
> = {
  death: "death",
  moved_out_of_service_area: "moved_out_of_service_area",
  no_longer_terminal: "no_longer_terminal",
  for_cause: "for_cause",
  other: "other",
};
/** The four CMS levels of care — validates the free-string `newLevel` route 33 hands `changeLoc`. */
const LEVELS_OF_CARE: readonly LevelOfCare[] = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
];

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
/** The in-memory slice cursors on an integer offset (`String(offset)`); mirror it exactly. */
const parseOffset = (cursor?: string): number => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const toSummary = (r: { id: string; state: string; version: number }): SummaryRow => ({
  id: r.id,
  state: r.state,
  version: Number(r.version),
});

/** Org-TZ for the D4 written-cert deadline until a per-org TZ is threaded through the write path. */
const DEFAULT_ORG_TZ = "America/Los_Angeles";
const conflict = (msg: string): WardenXError => new WardenXError("INVALID_STATE", msg, 409);

/** §2.5 compliance-window deadlines from open instant (only the T02 `createAdmission` kinds). */
const WINDOW_HOURS: Record<string, number> = {
  initial_assessment_48h: 48,
  comprehensive_assessment_5d: 24 * 5,
  care_plan_5d: 24 * 5,
  notice_of_rights: 48,
};

/**
 * The production, RLS-backed AdmissionRouteService. Every read and every write is real Drizzle over
 * `withOrgContext` (referral/admission [T02], election/CTI [T03], F2F/LOC/discharge/transfer/revocation
 * [T04], compliance-window close/override [T05]) — each write state-machine-driven, optimistic-locked,
 * and emitting `m6.*` on the transactional outbox. Org is bound from the request context, never the body.
 */
export function createDbAdmissionRouteService(
  db: DbClient,
  outbox: AdmissionWriteOutboxPort = NOOP_OUTBOX,
  ipuBedAssignmentReader?: IpuBedAssignmentReaderPort,
): AdmissionRouteService {
  const now = () => new Date();

  /** Optimistic lock: a stale `ifVersion` is a 409 VERSION_MISMATCH (matches the in-memory slice). */
  function assertVersion(id: string, current: number, expected: number): void {
    if (current !== expected) throw new VersionMismatchError(id, current, expected);
  }

  /**
   * Execute a transition's declarative side effects (§2.5) on the caller's tx. Handles the T02 subset —
   * outbox emit, compliance-window open/close. `set_timestamp`/`set_flag` are folded into the aggregate
   * UPDATE by the caller; `audit` is the M4 write-audit trigger (automatic); the LOC/election cascades
   * belong to T04 and are asserted unreachable here.
   */
  async function runEffects(
    tx: DbClient,
    ctx: {
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
      admissionId: string;
    },
    effects: ReadonlyArray<SideEffect>,
    // TASK-031: per-event extra payload fields, keyed by event name — the generic `{aggregateId,
    // admissionId}` envelope alone doesn't satisfy every effect's declared events-by-m6.ts schema
    // (e.g. `m6.admission.draft_created` also requires `patientId`/`referralId`); callers that know
    // those facts at the point they trigger the effect pass them through here rather than `runEffects`
    // re-querying for state it doesn't otherwise need. Unlisted events keep the base shape (harmless
    // extra properties — TypeBox `Type.Object` allows them unless a schema opts into strict mode).
    extraPayloadByEvent: Readonly<Record<string, Record<string, unknown>>> = {},
  ): Promise<void> {
    for (const e of effects) {
      if (e.kind === "outbox") {
        await outbox.publish(tx, {
          eventName: e.event,
          payload: {
            aggregateId: ctx.aggregateId,
            admissionId: ctx.admissionId,
            ...extraPayloadByEvent[e.event],
          },
          organizationId: ctx.organizationId,
          aggregateKind: ctx.aggregateKind,
          aggregateId: ctx.aggregateId,
        });
      } else if (e.kind === "open_window") {
        const hours = WINDOW_HOURS[e.window] ?? 48;
        await tx.insert(CW).values({
          organizationId: ctx.organizationId,
          admissionId: ctx.admissionId,
          windowKind: e.window,
          status: "open",
          startsAt: now(),
          mustCompleteBy: new Date(now().getTime() + hours * 3600_000),
        });
      } else if (e.kind === "close_window") {
        await tx
          .update(CW)
          .set({ status: "closed", closedAt: now(), version: sql`${CW.version} + 1` })
          .where(
            and(
              eq(CW.admissionId, ctx.admissionId),
              eq(CW.windowKind, e.window),
              ne(CW.status, "closed"),
            ),
          );
      } else if (e.kind === "end_level_of_care") {
        // §2.3.5 — close the admission's currently-open LOC period (there is at most one; the partial
        // unique `lcp_adm_open_idx` enforces it). No-op when none is open.
        await tx
          .update(LOC)
          .set({
            endedAt: now(),
            status: "ended",
            version: sql`${LOC.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(LOC.admissionId, ctx.admissionId), sql`${LOC.endedAt} is null`));
      } else if (e.kind === "end_election_period") {
        // §2.3.1 discharge/revocation/transfer cascade — complete every non-terminal benefit period.
        await tx
          .update(EP)
          .set({ status: "completed", version: sql`${EP.version} + 1`, updatedAt: now() })
          .where(and(eq(EP.admissionId, ctx.admissionId), ne(EP.status, "completed")));
      }
      // `audit`, `set_timestamp`, `set_flag`, `start_level_of_care` are folded into the aggregate
      // INSERT/UPDATE by the caller; `audit` is the M4 write-audit trigger (automatic).
    }
  }

  /** Load a referral's lock/state facts, or 404. */
  async function loadRef(
    tx: DbClient,
    id: string,
  ): Promise<{ status: string; version: number; patientId: string | null }> {
    const [r] = await tx
      .select({ status: REF.status, version: REF.version, patientId: REF.patientId })
      .from(REF)
      .where(eq(REF.id, id))
      .limit(1);
    if (!r) throw new ResourceNotFoundError(id);
    return { status: r.status, version: Number(r.version), patientId: r.patientId ?? null };
  }

  /** Load an admission's lock/state facts, or 404. */
  async function loadAdm(
    tx: DbClient,
    id: string,
  ): Promise<{ status: AdmissionState; version: number }> {
    const [r] = await tx
      .select({ status: ADM.status, version: ADM.version })
      .from(ADM)
      .where(eq(ADM.id, id))
      .limit(1);
    if (!r) throw new ResourceNotFoundError(id);
    return { status: r.status as AdmissionState, version: Number(r.version) };
  }

  /** An UPDATE guarded by `WHERE id=? AND version=?` returned nothing → distinguish 404 vs stale-409. */
  async function failStale(
    tx: DbClient,
    table: typeof REF | typeof ADM,
    id: string,
    ifVersion: number,
  ): Promise<never> {
    const [row] = await tx
      .select({ version: table.version })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(id);
    throw new VersionMismatchError(id, Number(row.version), ifVersion);
  }

  /**
   * The R-AC-01 gate facts (§7.2). TASK-031 fix: mirrors `getAdmission` (route 10)'s inline query
   * exactly, including `ctiAttendingSigned` — this function used to omit it entirely, so
   * `activateAdmission`'s write-path guard never checked the attending-physician CTI signature (period
   * 1) that the read-side `computeActivationGate` (and the §5.2.5 UI checklist) has always required,
   * a real divergence between what the checklist showed as blocking and what the server enforced. Also
   * returns the period-1 id/dates (not part of the gate itself) so `activateAdmission` can build the
   * `m6.election.period_started` outbox payload without a second query.
   */
  async function gateFacts(
    tx: DbClient,
    admissionId: string,
  ): Promise<{
    electionSigned: boolean;
    ctiHospiceMdSigned: boolean;
    ctiAttendingSigned: boolean;
    norAcknowledged: boolean;
    periodSequence: number;
    periodId: string | null;
    periodEffectiveAt: string | null;
    periodScheduledEndAt: string | null;
  }> {
    const [period] = await tx
      .select({
        id: EP.id,
        sequenceNumber: EP.sequenceNumber,
        effectiveAt: EP.effectiveAt,
        scheduledEndAt: EP.scheduledEndAt,
      })
      .from(EP)
      .where(and(eq(EP.admissionId, admissionId), eq(EP.sequenceNumber, 1)))
      .limit(1);
    let electionSigned = false;
    let ctiHospiceMdSigned = false;
    let ctiAttendingSigned = false;
    if (period) {
      const [es] = await tx
        .select({ id: ES.id })
        .from(ES)
        .where(eq(ES.electionPeriodId, period.id))
        .limit(1);
      electionSigned = !!es;
      const [cti] = await tx
        .select({ h: CTI.hospiceMdSignedAt, a: CTI.attendingMdSignedAt })
        .from(CTI)
        .where(eq(CTI.electionPeriodId, period.id))
        .limit(1);
      ctiHospiceMdSigned = !!cti?.h;
      ctiAttendingSigned = !!cti?.a;
    }
    const [nor] = await tx
      .select({ id: NOR.id })
      .from(NOR)
      .where(eq(NOR.admissionId, admissionId))
      .limit(1);
    return {
      electionSigned,
      ctiHospiceMdSigned,
      ctiAttendingSigned,
      norAcknowledged: !!nor,
      periodSequence: period?.sequenceNumber ?? 1,
      periodId: period?.id ?? null,
      periodEffectiveAt: period?.effectiveAt ?? null,
      periodScheduledEndAt: period?.scheduledEndAt ?? null,
    };
  }

  /** Drive a state-machine admission event: load → assertVersion → transition → UPDATE + effects. */
  async function admissionEvent(
    organizationId: string,
    id: string,
    ifVersion: number,
    event: AdmissionEvent,
    extraSet: Record<string, unknown> = {},
  ): Promise<MutationResult> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const cur = await loadAdm(tx, id);
      assertVersion(id, cur.version, ifVersion);
      const t = transitionAdmission(cur.status, event);
      const r = firstOrThrow(
        await tx
          .update(ADM)
          .set({ status: t.to, version: sql`${ADM.version} + 1`, ...extraSet })
          .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
          .returning({ id: ADM.id, status: ADM.status, version: ADM.version }),
        "row not found",
      );
      await runEffects(
        tx,
        { organizationId, aggregateKind: "admission", aggregateId: id, admissionId: id },
        t.effects,
      );
      return { id: r.id, state: r.status, version: Number(r.version) };
    });
  }
  /** Page a status-bearing table on the integer-offset cursor, newest-first. */
  async function pageByStatus(
    organizationId: string,
    table: typeof REF | typeof ADM | typeof CW,
    orderCol: AnyColumn,
    query: { state?: string; cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>> {
    const limit = clampLimit(query.limit);
    const offset = parseOffset(query.cursor);
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const where = query.state ? eq(table.status as never, query.state as never) : undefined;
      const rows = (await tx
        .select({ id: table.id, state: table.status, version: table.version })
        .from(table)
        .where(where)
        .orderBy(desc(orderCol as never), desc(table.id))
        .limit(limit + 1)
        .offset(offset)) as { id: string; state: string; version: number }[];
      const items = rows.slice(0, limit).map(toSummary);
      const nextCursor = rows.length > limit ? String(offset + limit) : null;
      return { items, nextCursor };
    });
  }

  /** Does an admission exist for this org? (RLS-scoped) — reads return `null` → 404 when it does not. */
  async function admissionExists(tx: DbClient, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: ADM.id }).from(ADM).where(eq(ADM.id, id)).limit(1);
    return !!row;
  }

  /** The latest benefit period for an admission (highest sequence), or `null`. */
  async function latestPeriod(
    tx: DbClient,
    admissionId: string,
  ): Promise<{ id: string; sequence: number; status: string } | null> {
    const [p] = await tx
      .select({ id: EP.id, seq: EP.sequenceNumber, status: EP.status })
      .from(EP)
      .where(eq(EP.admissionId, admissionId))
      .orderBy(desc(EP.sequenceNumber))
      .limit(1);
    return p ? { id: p.id, sequence: Number(p.seq), status: p.status } : null;
  }

  /**
   * Drive the §2.3.1 `executeDischarge` event on the admission: load → transition (guards + the
   * death-certifier check) → UPDATE to the target state → run the LOC/election-period end cascades +
   * the `m6.admission.discharged` outbox fan-out. Called by discharge (immediate reasons), the for-cause
   * cosign, revocation, and transfer-out. Never called on the for-cause FILING (the admission stays
   * active until cosign). `deathCertifierCredentialed` is assumed true here — the fuller certifier gate
   * belongs to a death-certification capture the discharge body does not yet carry.
   */
  async function dischargeAdmissionTx(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
    ev: {
      dischargeType:
        | "death"
        | "revocation"
        | "transfer"
        | "routine"
        | "for_cause"
        | "moved"
        | "no_longer_terminal";
      effectiveAt: string;
      forCauseCosigned: boolean;
    },
  ): Promise<{ state: AdmissionState; version: number }> {
    const [row] = await tx
      .select({ status: ADM.status, admissionAt: ADM.admissionAt })
      .from(ADM)
      .where(eq(ADM.id, admissionId))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(admissionId);
    const admissionAt = row.admissionAt
      ? row.admissionAt.toISOString().slice(0, 10)
      : ev.effectiveAt;
    // §2.3.6 — the pure command guard (for_cause cosign + R-DC-01 death-certifier check), called for
    // validation ahead of `transitionAdmission`'s own equivalent inline guards below (kept as-is,
    // defense-in-depth). `forCauseCosigned` is already a real caller-supplied fact (false while a
    // for-cause filing awaits cosign, true only from `cosignDischarge` after it happens) — this closes
    // no new gap there. `today` uses the REAL clock rather than `ev.effectiveAt` (which made the
    // R-DC-01 date-order half of the check trivially true by construction, comparing a value to
    // itself). `deathCertifierCredentialed` remains hardcoded `true`: `DischargeCreateSchema` collects
    // no certifier identity at all (unlike `DischargeCosignSchema`'s `cosignerName`/`cosignerNpi`,
    // themselves ALSO dropped by `cosignDischarge` — a separate, larger gap, not fixed here). The
    // credential half of this guard is therefore still a placeholder; only the date-order half is real.
    planDischarge({
      dischargeType: ev.dischargeType,
      forCauseCosigned: ev.forCauseCosigned,
      deathAt: ev.dischargeType === "death" ? ev.effectiveAt : undefined,
      today: now().toISOString().slice(0, 10),
      deathCertifierCredentialed: ev.dischargeType === "death" ? true : undefined,
    });
    const t = transitionAdmission(row.status as AdmissionState, {
      type: "executeDischarge",
      dischargeType: ev.dischargeType,
      effectiveAt: ev.effectiveAt,
      admissionAt,
      forCauseCosigned: ev.forCauseCosigned,
      deathAt: ev.dischargeType === "death" ? ev.effectiveAt : undefined,
      today: ev.effectiveAt,
      deathCertifierCredentialed: ev.dischargeType === "death" ? true : undefined,
    } satisfies AdmissionEvent);
    const r = firstOrThrow(
      await tx
        .update(ADM)
        .set({ status: t.to, dischargedAt: now(), version: sql`${ADM.version} + 1` })
        .where(eq(ADM.id, admissionId))
        .returning({ status: ADM.status, version: ADM.version }),
      "admission not found",
    );
    await runEffects(
      tx,
      { organizationId, aggregateKind: "admission", aggregateId: admissionId, admissionId },
      t.effects,
    );
    return { state: r.status as AdmissionState, version: Number(r.version) };
  }

  return {
    // ── Referral reads ───────────────────────────────────────────────────────────────────────────
    async listReferrals(organizationId, query) {
      return pageByStatus(organizationId, REF, REF.receivedAt, query);
    },
    async getReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: REF.id, state: REF.status, version: REF.version })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },

    // ── Admission reads ──────────────────────────────────────────────────────────────────────────
    async listAdmissions(organizationId, query) {
      return pageByStatus(organizationId, ADM, ADM.admissionAt, query);
    },
    async getAdmission(organizationId, id): Promise<AdmissionDetail | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ id: ADM.id, status: ADM.status, version: ADM.version })
          .from(ADM)
          .where(eq(ADM.id, id))
          .limit(1);
        if (!adm) return null;
        // R-AC-01 activation gate — computed from the period-1 bundle (§5.2.5). Loaded org-scoped.
        const [period] = await tx
          .select({ id: EP.id, sequenceNumber: EP.sequenceNumber })
          .from(EP)
          .where(and(eq(EP.admissionId, id), eq(EP.sequenceNumber, 1)))
          .limit(1);
        let electionSigned = false;
        let ctiHospiceMdSigned = false;
        let ctiAttendingSigned = false;
        if (period) {
          const [es] = await tx
            .select({ id: ES.id })
            .from(ES)
            .where(eq(ES.electionPeriodId, period.id))
            .limit(1);
          electionSigned = !!es;
          const [cti] = await tx
            .select({ h: CTI.hospiceMdSignedAt, a: CTI.attendingMdSignedAt })
            .from(CTI)
            .where(eq(CTI.electionPeriodId, period.id))
            .limit(1);
          ctiHospiceMdSigned = !!cti?.h;
          ctiAttendingSigned = !!cti?.a;
        }
        const [nor] = await tx
          .select({ id: NOR.id })
          .from(NOR)
          .where(eq(NOR.admissionId, id))
          .limit(1);
        const activationGate = computeActivationGate({
          periodSequence: period?.sequenceNumber ?? 1,
          electionSigned,
          norAcknowledged: !!nor,
          ctiHospiceMdSigned,
          ctiAttendingSigned,
        });
        return { id: adm.id, state: adm.status, version: Number(adm.version), activationGate };
      });
    },
    async getPatientElectionCertification(
      organizationId,
      patientId,
    ): Promise<PatientElectionCertificationView> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
        // The patient's newest admission (RLS scopes to org). `patient_id` is NOT NULL, no FK.
        const [adm] = await tx
          .select({
            id: ADM.id,
            status: ADM.status,
            admissionAt: ADM.admissionAt,
            activatedAt: ADM.activatedAt,
            dischargedAt: ADM.dischargedAt,
            version: ADM.version,
          })
          .from(ADM)
          .where(eq(ADM.patientId, patientId))
          .orderBy(desc(ADM.admissionAt), desc(ADM.createdAt))
          .limit(1);
        if (!adm) return { admission: null, periods: [], complianceWindows: [] };

        const periodRows = await tx
          .select({
            id: EP.id,
            sequenceNumber: EP.sequenceNumber,
            periodKind: EP.periodKind,
            effectiveAt: EP.effectiveAt,
            scheduledEndAt: EP.scheduledEndAt,
            actualEndAt: EP.actualEndAt,
            status: EP.status,
          })
          .from(EP)
          .where(eq(EP.admissionId, adm.id))
          .orderBy(EP.sequenceNumber);
        const periodIds = periodRows.map((p) => p.id);

        // One query each for the period-scoped bundles (avoids N+1 across the ladder).
        const esRows = periodIds.length
          ? await tx
              .select({
                id: ES.id,
                electionPeriodId: ES.electionPeriodId,
                status: ES.status,
                signerKind: ES.signerKind,
                signedAt: ES.signedAt,
              })
              .from(ES)
              .where(inArray(ES.electionPeriodId, periodIds))
          : [];
        const ctiRows = periodIds.length
          ? await tx
              .select({
                id: CTI.id,
                electionPeriodId: CTI.electionPeriodId,
                status: CTI.status,
                hospiceMdSignedAt: CTI.hospiceMdSignedAt,
                attendingMdSignedAt: CTI.attendingMdSignedAt,
                signedLate: CTI.signedLate,
                periodStart: CTI.periodStart,
                periodEnd: CTI.periodEnd,
              })
              .from(CTI)
              .where(inArray(CTI.electionPeriodId, periodIds))
          : [];
        const f2fRows = periodIds.length
          ? await tx
              .select({
                id: F2F.id,
                electionPeriodId: F2F.electionPeriodId,
                status: F2F.status,
                performerRole: F2F.performerRole,
                encounterDate: F2F.encounterDate,
                withinWindow: F2F.withinWindow,
                windowOverride: F2F.windowOverride,
                attestationSignedAt: F2F.attestationSignedAt,
              })
              .from(F2F)
              .where(inArray(F2F.electionPeriodId, periodIds))
          : [];
        const esBy = new Map(esRows.map((r) => [r.electionPeriodId, r]));
        const ctiBy = new Map(ctiRows.map((r) => [r.electionPeriodId, r]));
        const f2fBy = new Map(f2fRows.map((r) => [r.electionPeriodId, r]));

        const periods = periodRows.map((p) => {
          const es = esBy.get(p.id);
          const cti = ctiBy.get(p.id);
          const f2f = f2fBy.get(p.id);
          return {
            id: p.id,
            sequenceNumber: p.sequenceNumber,
            periodKind: p.periodKind,
            effectiveAt: p.effectiveAt,
            scheduledEndAt: p.scheduledEndAt,
            actualEndAt: p.actualEndAt,
            status: p.status,
            electionStatement: es
              ? { id: es.id, status: es.status, signerKind: es.signerKind, signedAt: es.signedAt }
              : null,
            cti: cti
              ? {
                  id: cti.id,
                  status: cti.status,
                  hospiceMdSigned: !!cti.hospiceMdSignedAt,
                  attendingMdSigned: !!cti.attendingMdSignedAt,
                  signedLate: cti.signedLate,
                  periodStart: cti.periodStart,
                  periodEnd: cti.periodEnd,
                }
              : null,
            faceToFace: f2f
              ? {
                  id: f2f.id,
                  status: f2f.status,
                  performerRole: f2f.performerRole,
                  encounterDate: f2f.encounterDate,
                  withinWindow: f2f.withinWindow,
                  windowOverride: f2f.windowOverride,
                  attested: !!f2f.attestationSignedAt,
                }
              : null,
          };
        });

        const cwRows = await tx
          .select({
            id: CW.id,
            windowKind: CW.windowKind,
            severity: CW.severity,
            status: CW.status,
            mustCompleteBy: CW.mustCompleteBy,
            closedAt: CW.closedAt,
          })
          .from(CW)
          .where(eq(CW.admissionId, adm.id))
          .orderBy(desc(CW.mustCompleteBy));

        return {
          admission: {
            id: adm.id,
            state: adm.status,
            admissionAt: iso(adm.admissionAt),
            activatedAt: iso(adm.activatedAt),
            dischargedAt: iso(adm.dischargedAt),
            version: Number(adm.version),
          },
          periods,
          complianceWindows: cwRows.map((w) => ({
            id: w.id,
            windowKind: w.windowKind,
            severity: w.severity,
            status: w.status,
            mustCompleteBy: w.mustCompleteBy.toISOString(),
            closedAt: iso(w.closedAt),
          })),
        };
      });
    },

    // ── Election reads ───────────────────────────────────────────────────────────────────────────
    async getElectionStatement(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: ES.id, status: ES.status, version: ES.version })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        return r ? { id: r.id, state: r.status, version: Number(r.version) } : null;
      });
    },
    async listElectionPeriods(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: EP.id, state: EP.status, version: EP.version })
          .from(EP)
          .where(eq(EP.admissionId, admissionId))
          .orderBy(EP.sequenceNumber);
        return rows.map(toSummary);
      });
    },

    // ── CTI / F2F reads ──────────────────────────────────────────────────────────────────────────
    async getCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: CTI.id, state: CTI.status, version: CTI.version })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },
    async getF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: F2F.id, state: F2F.status, version: F2F.version })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        return r ? toSummary(r) : null;
      });
    },

    // ── LOC / NOR reads (derived state — neither table carries a status column) ────────────────────
    async listLoc(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: LOC.id, status: LOC.status, version: LOC.version })
          .from(LOC)
          .where(eq(LOC.admissionId, admissionId))
          .orderBy(desc(LOC.effectiveAt));
        return rows.map((r) => ({ id: r.id, state: r.status, version: Number(r.version) }));
      });
    },
    async getNor(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ id: NOR.id, version: NOR.version })
          .from(NOR)
          .where(eq(NOR.admissionId, admissionId))
          .limit(1);
        return r ? { id: r.id, state: "acknowledged", version: Number(r.version) } : null;
      });
    },

    // ── Compliance-window reads ────────────────────────────────────────────────────────────────────
    async listComplianceWindowsForAdmission(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId))) return null;
        const rows = await tx
          .select({ id: CW.id, state: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.admissionId, admissionId))
          .orderBy(desc(CW.mustCompleteBy));
        return rows.map(toSummary);
      });
    },
    async listComplianceWindows(organizationId, query) {
      return pageByStatus(organizationId, CW, CW.mustCompleteBy, query);
    },

    // ── Writes — the M6L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ───────────────────────
    // ── M6L-T02: referral intake ───────────────────────────────────────────────────────────────
    async createReferral(organizationId, input, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const rows = await tx
          .insert(REF)
          .values({
            organizationId,
            patientNameAtReceipt: input.patientNameAtReceipt,
            sourceChannel: input.source as ReferralSourceChannel,
          })
          .returning({ id: REF.id, status: REF.status, version: REF.version });
        const r = firstOrThrow(rows, "referral insert returned no row");
        await outbox.publish(tx, {
          eventName: "m6.referral.received",
          payload: { referralId: r.id, source: input.source, receivedAt: input.receivedAt },
          organizationId,
          aggregateKind: "referral",
          aggregateId: r.id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async updateReferral(organizationId, id, ifVersion): Promise<MutationResult> {
      // Metadata edit — no state change; still optimistic-locked (§7.1 concurrency).
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .update(REF)
          .set({ version: sql`${REF.version} + 1`, updatedAt: now() })
          .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
          .returning({ id: REF.id, status: REF.status, version: REF.version });
        if (!r) return failStale(tx, REF, id, ifVersion);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async triageReferral(organizationId, id, outcome, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "received")
          throw new InvalidReferralStateError(id, cur.status, "triage");
        // §7.1: eligible → evaluated; ineligible → rejected (DB enum, not the in-memory `triaged`).
        const next = outcome === "eligible" ? "evaluated" : "rejected";
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: next,
              evaluatedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({ id: REF.id, status: REF.status, version: REF.version }),
          "row not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.triaged",
          payload: { referralId: id, outcome },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async acceptReferral(
      organizationId,
      id,
      input,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult & { admissionId: string }> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        if (cur.status !== "evaluated") throw new ReferralNotTriagedError(id); // W-RF-04
        const patientId = input.patientId ?? cur.patientId ?? randomUUID();
        // §2.3.1 no double-election: block if the patient already has an open admission.
        const [open] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.patientId, patientId),
              ne(ADM.status, "discharged"),
              ne(ADM.status, "bereavement"),
              ne(ADM.status, "closed"),
            ),
          )
          .limit(1);
        // Validate the createAdmission event FIRST (it throws PATIENT_ALREADY_ELECTED on a double open),
        // then insert the admission directly at the transition's target state — never a half-open row.
        const t = transitionAdmission("referred", {
          type: "createAdmission",
          referralAccepted: true,
          hasOtherOpenAdmission: !!open,
        } satisfies AdmissionEvent);
        const adm = firstOrThrow(
          await tx
            .insert(ADM)
            .values({ organizationId, patientId, referralId: id, status: t.to })
            .returning({ id: ADM.id, version: ADM.version }),
          "admission insert returned no row",
        );
        await runEffects(
          tx,
          { organizationId, aggregateKind: "admission", aggregateId: adm.id, admissionId: adm.id },
          t.effects,
          { "m6.admission.draft_created": { patientId, referralId: id } },
        );
        // Seed benefit period 1 (the §7.1 cascade — not a state-machine effect).
        await tx.insert(EP).values({
          organizationId,
          admissionId: adm.id,
          sequenceNumber: 1,
          periodKind: "ninety_day",
        });
        // Advance the referral to accepted.
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "accepted",
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({ id: REF.id, status: REF.status, version: REF.version }),
          "row not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.accepted",
          payload: { referralId: id, patientId, admissionId: adm.id },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version), admissionId: adm.id };
      });
    },
    async declineReferral(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      void reason;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadRef(tx, id);
        assertVersion(id, cur.version, ifVersion);
        const r = firstOrThrow(
          await tx
            .update(REF)
            .set({
              status: "rejected",
              decidedAt: now(),
              version: sql`${REF.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(REF.id, id), eq(REF.version, ifVersion)))
            .returning({ id: REF.id, status: REF.status, version: REF.version }),
          "row not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.referral.declined",
          payload: { referralId: id },
          organizationId,
          aggregateKind: "referral",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T02: admission lifecycle ────────────────────────────────────────────────────────────
    // TASK-034 rewrite — this used to insert at the DB's default `status='referred'` (a fresh
    // admission's only legal transition, ADMISSION_GRAPH, is out of `referred` via the referral-accept
    // path — a direct-intake admission never reached anywhere), mapped `attendingPhysicianId` into the
    // WRONG column (`admitted_by_physician_id`, not `attending_physician_id`), and dropped
    // `hospiceMedicalDirectorId` entirely (no period, no CTI, so the activation gate could never even
    // be evaluated). Now mirrors `acceptReferral`'s cascade: the same `createAdmission` state-machine
    // event (opens the same 4 compliance windows, lands on `pending`), a seeded period 1, and a draft
    // CTI carrying the hospice-MD/attending ids the form actually asked for.
    async createAdmission(organizationId, input, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        // §2.3.1 no double-election: same rule acceptReferral enforces — direct intake is a second
        // entry path into the same admission lifecycle, not an exemption from it.
        const [open] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.patientId, input.patientId),
              ne(ADM.status, "discharged"),
              ne(ADM.status, "bereavement"),
              ne(ADM.status, "closed"),
            ),
          )
          .limit(1);
        const t = transitionAdmission("referred", {
          type: "createAdmission",
          referralAccepted: true,
          hasOtherOpenAdmission: !!open,
        } satisfies AdmissionEvent);
        const adm = firstOrThrow(
          await tx
            .insert(ADM)
            .values({
              organizationId,
              patientId: input.patientId,
              referralId: input.referralId ?? null,
              attendingPhysicianId: input.attendingPhysicianId ?? null,
              status: t.to,
            })
            .returning({ id: ADM.id, status: ADM.status, version: ADM.version }),
          "admission insert returned no row",
        );
        await runEffects(
          tx,
          { organizationId, aggregateKind: "admission", aggregateId: adm.id, admissionId: adm.id },
          t.effects,
          {
            "m6.admission.draft_created": {
              patientId: input.patientId,
              ...(input.referralId ? { referralId: input.referralId } : {}),
            },
          },
        );
        // Seed benefit period 1 (mirrors acceptReferral's §7.1 cascade) — EXCEPT for a transfer-in
        // intake (W-DC-03/D9): that admission never has a "period 1" at all, since the receiving
        // hospice inherits the sending hospice's carried sequence via the dedicated `transferIn` call
        // (42 CFR 418.28, the benefit-period counter never restarts). Seeding period 1 here for a
        // transfer-in unconditionally created a spurious extra election_period row (+ a spurious CTI
        // attached to it) ahead of `transferIn`'s own inherited/next pair.
        if (input.intakeMethod === "transfer_in") {
          return { id: adm.id, state: adm.status, version: Number(adm.version) };
        }
        const period = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId: adm.id,
              sequenceNumber: 1,
              periodKind: "ninety_day",
            })
            .returning({ id: EP.id }),
          "election period insert returned no row",
        );
        // Draft the CTI the form's hospiceMedicalDirectorId/attendingPhysicianId are for (mirrors
        // draftCti) — without this the id the user was required to enter had nowhere to go.
        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: period.id,
              hospiceMdId: input.hospiceMedicalDirectorId,
              attendingMdId: input.attendingPhysicianId ?? null,
            })
            .returning({ id: CTI.id }),
          "cti insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: { ctiId: cti.id, electionPeriodId: period.id, isRecert: false },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        return { id: adm.id, state: adm.status, version: Number(adm.version) };
      });
    },
    async updateAdmission(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .update(ADM)
          .set({ version: sql`${ADM.version} + 1`, updatedAt: now() })
          .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
          .returning({ id: ADM.id, status: ADM.status, version: ADM.version });
        if (!r) return failStale(tx, ADM, id, ifVersion);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async holdAdmission(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return admissionEvent(
        organizationId,
        id,
        ifVersion,
        { type: "placeOnHold", reason },
        {
          holdReason: reason,
          holdAt: now(),
        },
      );
    },
    async resumeAdmission(organizationId, id, ifVersion): Promise<MutationResult> {
      return admissionEvent(
        organizationId,
        id,
        ifVersion,
        { type: "releaseFromHold" },
        {
          releasedAt: now(),
        },
      );
    },
    async activateAdmission(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const cur = await loadAdm(tx, id);
        assertVersion(id, cur.version, ifVersion);
        const facts = await gateFacts(tx, id);
        // TASK-031 fix: `computeActivationGate` is the declared single source of truth for BOTH this
        // write-path guard and the read-side checklist (getAdmission/route 10) — call it here instead
        // of re-deriving a subset of its logic via `transitionAdmission`'s ad-hoc "activate" guards,
        // which never checked `ctiAttendingSigned` at all. A caller that bypasses the UI and posts
        // directly now gets the SAME 412 PRECONDITION_FAILED { missing } the checklist would have shown.
        const gate = computeActivationGate(facts);
        if (!gate.ready) throw new ActivationPreconditionError(gate.missing);
        const t = transitionAdmission(cur.status, {
          type: "activate",
          electionStatementSigned: facts.electionSigned,
          certificationSigned: facts.ctiHospiceMdSigned,
          noticeOfRightsAcknowledged: facts.norAcknowledged,
          privacyFlagBlock: false,
          initialAssessment48hOverdue: false,
          donOverride: false,
          isFirstElectionPeriod: facts.periodSequence === 1,
          at: new Date().toISOString().slice(0, 10),
        } satisfies AdmissionEvent);
        const activatedAt = now();
        const r = firstOrThrow(
          await tx
            .update(ADM)
            .set({ status: t.to, activatedAt, version: sql`${ADM.version} + 1` })
            .where(and(eq(ADM.id, id), eq(ADM.version, ifVersion)))
            .returning({
              id: ADM.id,
              status: ADM.status,
              version: ADM.version,
              patientId: ADM.patientId,
            }),
          "row not found",
        );
        // Bug found wiring planRevocation (§2.3.6): `m6.election.period_started` fired here claiming
        // period 1 started, but NO write ever set `election_period.status = 'active'` — it stayed at
        // its `pending` default until the admission was eventually discharged (jumping pending →
        // completed, skipping active entirely). `runEffects` doesn't handle this (no `SideEffect` kind
        // exists for it, same "folded into the caller" posture as `set_timestamp`/`set_flag`), so fold
        // it in here directly, mirroring the recert path's `signCtiHospiceMd` period activation.
        if (facts.periodId) {
          await tx
            .update(EP)
            .set({ status: "active", version: sql`${EP.version} + 1` })
            .where(and(eq(EP.id, facts.periodId), ne(EP.status, "active")));
        }
        await runEffects(
          tx,
          { organizationId, aggregateKind: "admission", aggregateId: id, admissionId: id },
          t.effects,
          {
            "m6.admission.activated": {
              patientId: r.patientId,
              activatedAt: activatedAt.toISOString(),
            },
            // Only fires when `isFirstElectionPeriod` — see the `m6.election.period_started` schema
            // comment (events-by-m6.ts) for why startDate/endDate are omitted rather than fabricated.
            "m6.election.period_started": {
              electionPeriodId: facts.periodId,
              sequence: facts.periodSequence,
              ...(facts.periodEffectiveAt ? { startDate: facts.periodEffectiveAt } : {}),
              ...(facts.periodScheduledEndAt ? { endDate: facts.periodScheduledEndAt } : {}),
            },
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    // ── M6L-T03: election statement + period ────────────────────────────────────────────────────
    async draftElectionStatement(
      organizationId,
      admissionId,
      electionPeriodId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const es = firstOrThrow(
          await tx
            .insert(ES)
            .values({
              organizationId,
              electionPeriodId,
              patientId: adm.patientId,
              signerKind: "patient",
            })
            .returning({ id: ES.id, status: ES.status, version: ES.version }),
          "election statement insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.election.drafted",
          payload: { electionStatementId: es.id },
          organizationId,
          aggregateKind: "election_statement",
          aggregateId: es.id,
        });
        return { id: es.id, state: es.status, version: Number(es.version) };
      });
    },
    async signElection(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ status: ES.status, version: ES.version })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status !== "drafted")
          throw conflict(`election statement ${id} is not draftable from '${cur.status}'`);
        const [r] = await tx
          .update(ES)
          .set({
            status: "signed",
            signedAt: new Date().toISOString().slice(0, 10),
            signatureMethod: "electronic_witnessed",
            curativeCareAcknowledgment: true,
            version: sql`${ES.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(ES.id, id), eq(ES.version, ifVersion)))
          .returning({ id: ES.id, status: ES.status, version: ES.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.election.signed",
          payload: { electionStatementId: id },
          organizationId,
          aggregateKind: "election_statement",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async voidElection(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      void reason;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: ES.version })
          .from(ES)
          .where(eq(ES.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const [r] = await tx
          .update(ES)
          .set({ status: "voided", version: sql`${ES.version} + 1`, updatedAt: now() })
          .where(and(eq(ES.id, id), eq(ES.version, ifVersion)))
          .returning({ id: ES.id, status: ES.status, version: ES.version });
        if (!r) throw new ResourceNotFoundError(id);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async createElectionPeriod(organizationId, admissionId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const [max] = await tx
          .select({ seq: sql<number>`coalesce(max(${EP.sequenceNumber}), 0)` })
          .from(EP)
          .where(eq(EP.admissionId, admissionId));
        const ep = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId,
              sequenceNumber: Number(max?.seq ?? 0) + 1,
              periodKind: "ninety_day",
            })
            .returning({ id: EP.id, status: EP.status, version: EP.version }),
          "election period insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.election.period_started",
          payload: { electionPeriodId: ep.id, admissionId },
          organizationId,
          aggregateKind: "election_period",
          aggregateId: ep.id,
        });
        return { id: ep.id, state: ep.status, version: Number(ep.version) };
      });
    },
    async patchElectionPeriod(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: EP.version })
          .from(EP)
          .where(eq(EP.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const [r] = await tx
          .update(EP)
          .set({ version: sql`${EP.version} + 1`, updatedAt: now() })
          .where(and(eq(EP.id, id), eq(EP.version, ifVersion)))
          .returning({ id: EP.id, status: EP.status, version: EP.version });
        if (!r) throw new ResourceNotFoundError(id);
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T03: certification of terminal illness (CTI) ────────────────────────────────────────
    async draftCti(organizationId, input: CtiDraftInput, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [period] = await tx
          .select({ id: EP.id })
          .from(EP)
          .where(eq(EP.id, input.electionPeriodId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(input.electionPeriodId);
        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: input.electionPeriodId,
              hospiceMdId: input.hospiceMedicalDirectorId,
              attendingMdId: input.attendingPhysicianId ?? null,
            })
            .returning({ id: CTI.id, status: CTI.status, version: CTI.version }),
          "cti insert returned no row",
        );
        // TASK-034: was missing `electionPeriodId`/`isRecert` — declared required by events-by-m6.ts,
        // silently dropped here, same payload-schema-drift pattern TASK-031 fixed elsewhere in M6.
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: {
            ctiId: cti.id,
            electionPeriodId: input.electionPeriodId,
            isRecert: input.isRecert,
          },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        return { id: cti.id, state: cti.status, version: Number(cti.version) };
      });
    },
    async signCtiHospiceMd(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({
            status: CTI.status,
            version: CTI.version,
            epId: CTI.electionPeriodId,
            att: CTI.attendingMdId,
          })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        if (cti.status === "signed" || cti.status === "voided")
          throw conflict(`cti ${id} cannot be hospice-MD-signed from '${cti.status}'`);
        const [period] = await tx
          .select({ seq: EP.sequenceNumber })
          .from(EP)
          .where(eq(EP.id, cti.epId))
          .limit(1);
        // W-CTI-03/04: period-1-with-attending → awaiting_attending; a recert signs on the MD alone and
        // advances its period to active (§7.3).
        const outcome = decideRecertSign({
          sequence: period?.seq ?? 1,
          patientHasAttending: cti.att != null,
          hospiceMdSigned: true,
          attendingSigned: false,
        });
        const [r] = await tx
          .update(CTI)
          .set({
            status: outcome.progress,
            hospiceMdSignedAt: now(),
            version: sql`${CTI.version} + 1`,
          })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        if (outcome.activatesPeriod && cti.epId) {
          await tx
            .update(EP)
            .set({ status: "active", version: sql`${EP.version} + 1` })
            .where(and(eq(EP.id, cti.epId), ne(EP.status, "active")));
          await outbox.publish(tx, {
            eventName: "m6.election.period_started",
            payload: { electionPeriodId: cti.epId },
            organizationId,
            aggregateKind: "election_period",
            aggregateId: cti.epId,
          });
        }
        if (outcome.fullySigned) {
          await outbox.publish(tx, {
            eventName: "m6.cti.signed",
            payload: { ctiId: id },
            organizationId,
            aggregateKind: "certification_of_terminal_illness",
            aggregateId: id,
          });
        }
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async signCtiAttending(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      void actorUserId;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({ status: CTI.status, version: CTI.version })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        if (cti.status !== "awaiting_attending")
          throw conflict(
            `cti ${id} is not awaiting an attending signature (state '${cti.status}')`,
          );
        const [r] = await tx
          .update(CTI)
          .set({ status: "signed", attendingMdSignedAt: now(), version: sql`${CTI.version} + 1` })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.cti.signed",
          payload: { ctiId: id },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async voidCti(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      void reason;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({ version: CTI.version })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        const [r] = await tx
          .update(CTI)
          .set({ status: "voided", version: sql`${CTI.version} + 1` })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.cti.voided",
          payload: { ctiId: id },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async markCtiLate(
      organizationId,
      id,
      ifVersion,
    ): Promise<MutationResult & { writtenCertDeadlineAt: string }> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cti] = await tx
          .select({ status: CTI.status, version: CTI.version, periodStart: CTI.periodStart })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        if (!cti) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cti.version), ifVersion);
        const [r] = await tx
          .update(CTI)
          .set({ signedLate: true, version: sql`${CTI.version} + 1` })
          .where(and(eq(CTI.id, id), eq(CTI.version, ifVersion)))
          .returning({ id: CTI.id, status: CTI.status, version: CTI.version });
        if (!r) throw new ResourceNotFoundError(id);
        await outbox.publish(tx, {
          eventName: "m6.cti.late_flagged",
          payload: { ctiId: id },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: id,
        });
        // D4: written-cert deadline = period_start + 2 calendar days at 23:59 org-TZ.
        const periodStart = cti.periodStart ?? new Date().toISOString().slice(0, 10);
        const writtenCertDeadlineAt = computeWrittenCertDeadline(periodStart, DEFAULT_ORG_TZ);
        return { id: r.id, state: r.status, version: Number(r.version), writtenCertDeadlineAt };
      });
    },
    // ── M6L-T04: face-to-face encounter (§2.3.4) ──────────────────────────────────────────────────
    async scheduleF2f(organizationId, input): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [period] = await tx
          .select({ id: EP.id })
          .from(EP)
          .where(eq(EP.id, input.electionPeriodId))
          .limit(1);
        if (!period) throw new ResourceNotFoundError(input.electionPeriodId);
        // The DB `f2f_performer_role` enum admits only hospice_md / hospice_np (§3.2); anything else
        // (e.g. an attending) defaults to hospice_md — the performer identity is captured separately.
        const role = input.clinicianRole === "hospice_np" ? "hospice_np" : "hospice_md";
        const f2f = firstOrThrow(
          await tx
            .insert(F2F)
            .values({
              organizationId,
              electionPeriodId: input.electionPeriodId,
              performedByUserId: input.scheduledClinicianId,
              performerRole: role,
            })
            .returning({ id: F2F.id, status: F2F.status, version: F2F.version }),
          "f2f insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.f2f.scheduled",
          payload: { f2fId: f2f.id },
          organizationId,
          aggregateKind: "face_to_face_encounter",
          aggregateId: f2f.id,
        });
        return { id: f2f.id, state: f2f.status, version: Number(f2f.version) };
      });
    },
    async completeF2f(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({
            status: F2F.status,
            version: F2F.version,
            role: F2F.performerRole,
            override: F2F.windowOverride,
          })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // The completion route does not capture the encounter/period dates, so the CMS-418.22 window is
        // computed against the completion instant (encounter today, period start +7d → 7 days prior,
        // inside the [1,30]-day window). The real dates bind when the complete route captures them.
        const encounterDate = new Date().toISOString().slice(0, 10);
        const periodStart = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        const t = transitionFaceToFace(cur.status as FaceToFaceState, {
          type: "recordCompletion",
          performerRole: cur.role,
          periodStart,
          encounterDate,
          hasOverride: cur.override,
        });
        const withinWindow = t.effects.some(
          (e) => e.kind === "set_flag" && e.field === "within_window_true",
        );
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: t.to,
              encounterDate,
              withinWindow,
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({ id: F2F.id, status: F2F.status, version: F2F.version }),
          "f2f not found",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "face_to_face_encounter",
            aggregateId: id,
            admissionId: id,
          },
          t.effects,
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async attestF2f(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({
            status: F2F.status,
            version: F2F.version,
            performer: F2F.performedByUserId,
            epId: F2F.electionPeriodId,
          })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status !== "completed")
          throw new AdmissionStateError(
            "ILLEGAL_TRANSITION",
            `F2F cannot attest from '${cur.status}'`,
          );
        // §2.3.4 R-F2F-04 — the attesting user must be the performer. (The attestation narrative gate
        // binds when the attest route captures a narrative; it is not in this signature.)
        if (actorUserId && cur.performer !== actorUserId)
          throw new AdmissionStateError(
            "F2F_INVALID_PERFORMER",
            "attesting user must be the performer",
          );
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: "attested",
              attestationSignedAt: now(),
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({ id: F2F.id, status: F2F.status, version: F2F.version }),
          "f2f not found",
        );
        // Close the recert F2F window on the owning admission (best-effort; no-op when none is open).
        const [ep] = await tx
          .select({ admissionId: EP.admissionId })
          .from(EP)
          .where(eq(EP.id, cur.epId))
          .limit(1);
        if (ep) {
          await runEffects(
            tx,
            {
              organizationId,
              aggregateKind: "face_to_face_encounter",
              aggregateId: id,
              admissionId: ep.admissionId,
            },
            [
              { kind: "close_window", window: "f2f_recert_30d_prior" },
              { kind: "outbox", event: "m6.f2f.attested" },
            ],
          );
        }
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async overrideF2fWindow(
      organizationId,
      id,
      reason,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({ status: F2F.status, version: F2F.version })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        // §2.3.4 R-F2F-03 — a Medical-Director override with a reason ≥ 20 chars (the MD role is gated by
        // the route's ABAC preHandler; the state machine enforces the reason length).
        const t = transitionFaceToFace(cur.status as FaceToFaceState, {
          type: "requestWindowOverride",
          isMedicalDirector: true,
          reason,
        });
        const r = firstOrThrow(
          await tx
            .update(F2F)
            .set({
              status: t.to,
              windowOverride: true,
              windowOverrideReason: reason,
              windowOverrideBy: actorUserId || null,
              version: sql`${F2F.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(F2F.id, id), eq(F2F.version, ifVersion)))
            .returning({ id: F2F.id, status: F2F.status, version: F2F.version }),
          "f2f not found",
        );
        await runEffects(
          tx,
          {
            organizationId,
            aggregateKind: "face_to_face_encounter",
            aggregateId: id,
            admissionId: id,
          },
          t.effects,
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T04: level-of-care period (§2.3.5) ────────────────────────────────────────────────────
    async changeLoc(
      organizationId,
      admissionId,
      newLevel,
      facilityId = null,
      effectiveStart = undefined,
      reason = "",
    ): Promise<MutationResult> {
      if (!LEVELS_OF_CARE.includes(newLevel as LevelOfCare))
        throw new WardenXError("VALIDATION_ERROR", `unknown level of care '${newLevel}'`, 422);
      const level = newLevel as LevelOfCare;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [adm] = await tx
          .select({ status: ADM.status })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        // §2.3.5 requestAssign — the guards (admission active/on-hold, no overlap, GIP documentation,
        // IRC/GIP facility). IRC/GIP land in `assigning` until confirmLocBedAssignment (below) verifies a
        // real M37 bed; RHC/CHC go straight to `active`.
        const t = transitionLevelOfCare("pending", {
          type: "requestAssign",
          level,
          admissionActiveOrOnHold: adm.status === "active" || adm.status === "on_hold",
          facilityId,
          wouldOverlap: false,
          reason,
        });
        const to: LevelOfCareState = t.to;
        // Close the prior open LOC (the §2.3.5 end_level_of_care effect) BEFORE inserting the new one —
        // the partial unique `lcp_adm_open_idx` permits only one open period per admission.
        await tx
          .update(LOC)
          .set({
            endedAt: now(),
            status: "ended",
            version: sql`${LOC.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(LOC.admissionId, admissionId), sql`${LOC.endedAt} is null`));
        const loc = firstOrThrow(
          await tx
            .insert(LOC)
            .values({
              organizationId,
              admissionId,
              levelOfCare: level,
              status: to === "assigning" ? "assigning" : "active",
              facilityId,
              reason,
              effectiveAt: effectiveStart ? new Date(effectiveStart) : now(),
            })
            .returning({ id: LOC.id, status: LOC.status, version: LOC.version }),
          "loc insert returned no row",
        );
        // No outbox event while `assigning` — nothing downstream should treat an unconfirmed IPU request
        // as a real period of care yet; confirmLocBedAssignment publishes m6.loc.changed once it's real.
        if (to !== "assigning") {
          await outbox.publish(tx, {
            eventName: "m6.loc.changed",
            payload: { levelOfCarePeriodId: loc.id, level, state: to },
            organizationId,
            aggregateKind: "level_of_care_period",
            aggregateId: loc.id,
          });
        }
        return { id: loc.id, state: loc.status, version: Number(loc.version) };
      });
    },
    async patchLoc(organizationId, id, reason, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ version: LOC.version, status: LOC.status })
          .from(LOC)
          .where(eq(LOC.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        const r = firstOrThrow(
          await tx
            .update(LOC)
            .set({ reason, version: sql`${LOC.version} + 1`, updatedAt: now() })
            .where(and(eq(LOC.id, id), eq(LOC.version, ifVersion)))
            .returning({ id: LOC.id, status: LOC.status, version: LOC.version }),
          "loc not found",
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async confirmLocBedAssignment(organizationId, locPeriodId, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ status: LOC.status, version: LOC.version })
          .from(LOC)
          .where(eq(LOC.id, locPeriodId))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(locPeriodId);
        assertVersion(locPeriodId, Number(cur.version), ifVersion);
        if (!ipuBedAssignmentReader) {
          throw new WardenXError(
            "IPU_BED_ASSIGNMENT_READER_UNBOUND",
            "the M37 bed-assignment reader is not bound in this environment",
            503,
          );
        }
        const bed = await ipuBedAssignmentReader.activeBedAssignmentForLevelOfCarePeriod(
          organizationId,
          locPeriodId,
        );
        // The real §2.3.5 "bedId verified with M37" guard — never trusts a caller-supplied bed id.
        // ipuConfirmBedAssignment's only legal destination is "active" (§2.3.5 graph) — transitionLevelOfCare
        // still runs first so the ILLEGAL_TRANSITION/guard checks fire before any write.
        transitionLevelOfCare(cur.status as LevelOfCareState, {
          type: "ipuConfirmBedAssignment",
          bedVerified: bed !== null,
        });
        const r = firstOrThrow(
          await tx
            .update(LOC)
            .set({
              status: "active",
              ipuBedAssignmentId: bed?.bedAssignmentId ?? null,
              version: sql`${LOC.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(LOC.id, locPeriodId), eq(LOC.version, ifVersion)))
            .returning({
              id: LOC.id,
              status: LOC.status,
              version: LOC.version,
              levelOfCare: LOC.levelOfCare,
            }),
          "loc not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.loc.changed",
          payload: { levelOfCarePeriodId: r.id, level: r.levelOfCare, state: r.status },
          organizationId,
          aggregateKind: "level_of_care_period",
          aggregateId: r.id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },

    // ── M6L-T04: revocation / transfer / discharge (§2.3.1) ───────────────────────────────────────
    async createRevocation(
      organizationId,
      admissionId,
      input: RevocationInput,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const period = await latestPeriod(tx, admissionId);
        if (!period) throw new ResourceNotFoundError(admissionId);
        // §2.3.6 R-RV-01 — the pure command guard: the election period being revoked must actually be
        // ACTIVE (latestPeriod alone doesn't check status — a completed/pending period would otherwise
        // slip through and hit the `revocation_period_idx` unique constraint with a confusing 500) and
        // the effective date may not precede the signed date. Both dates are `input.revocationDate` (the
        // route contract carries one date, mirroring the spec's own §4.2.7 shape), which trivially
        // satisfies the second guard by construction — the ACTIVE check is the one this actually gates.
        // Only used for validation here: the cascade this returns (end period/LOC, audit, outbox) is
        // already applied by `dischargeAdmissionTx` below via `transitionAdmission`'s own equivalent
        // effects — running both would double-apply the UPDATEs and double-publish the outbox event.
        planRevocation({
          electionPeriodActive: period.status === "active",
          signedAt: input.revocationDate,
          effectiveAt: input.revocationDate,
        });
        // `signingPatientName` has no column — see RevocationInput's doc.
        const rev = firstOrThrow(
          await tx
            .insert(RE)
            .values({
              organizationId,
              admissionId,
              electionPeriodId: period.id,
              signerKind:
                input.signingRole === "legal_representative" ? "representative" : "patient",
              effectiveAt: input.revocationDate,
              signedAt: input.revocationDate,
              revocationReason: input.revocationReason,
              narrative: input.narrative,
            })
            .returning({ id: RE.id, version: RE.version }),
          "revocation insert returned no row",
        );
        // §2.3.1 — a revocation discharges the admission (end LOC + complete every benefit period).
        await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: "revocation",
          effectiveAt: input.revocationDate,
          forCauseCosigned: false,
        });
        await outbox.publish(tx, {
          eventName: "m6.revocation.created",
          payload: { revocationId: rev.id, admissionId },
          organizationId,
          aggregateKind: "revocation_event",
          aggregateId: rev.id,
        });
        return { id: rev.id, state: "created", version: Number(rev.version) };
      });
    },
    async transferOut(
      organizationId,
      admissionId,
      input: TransferOutInput,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const period = await latestPeriod(tx, admissionId);
        if (!period) throw new ResourceNotFoundError(admissionId);
        // §2.3.6 R-XFR-01 — only one transfer-out per benefit period (42 CFR 418.28). No DB constraint
        // enforces this (unlike revocation_event's `revocation_period_idx` unique index), so query the
        // real fact rather than assuming it can never happen (the admission-graph transition to
        // `discharged` blocks an obvious double-call today, but that's incidental, not a rule).
        const [priorTransferOut] = await tx
          .select({ id: TE.id })
          .from(TE)
          .where(
            and(
              eq(TE.admissionId, admissionId),
              eq(TE.periodSequenceAtTransfer, period.sequence),
              eq(TE.direction, "out"),
            ),
          )
          .limit(1);
        planTransferOut({ transferAlreadyDoneThisPeriod: !!priorTransferOut });
        const xfer = firstOrThrow(
          await tx
            .insert(TE)
            .values({
              organizationId,
              admissionId,
              direction: "out",
              effectiveAt: input.effectiveDate,
              periodSequenceAtTransfer: period.sequence,
              receivingOrSendingCcn: input.otherHospiceCcn ?? null,
              receivingOrSendingName: input.otherHospiceName,
              narrative: input.narrative,
            })
            .returning({ id: TE.id, version: TE.version }),
          "transfer insert returned no row",
        );
        // §2.3.1 — a transfer-out discharges the admission (the receiving hospice inherits the election).
        await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: "transfer",
          effectiveAt: input.effectiveDate,
          forCauseCosigned: false,
        });
        await outbox.publish(tx, {
          eventName: "m6.transfer.created",
          payload: { transferId: xfer.id, admissionId, direction: "out" },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        return { id: xfer.id, state: "created", version: Number(xfer.version) };
      });
    },
    async transferIn(
      organizationId,
      admissionId,
      input: TransferInInput,
      actorUserId,
    ): Promise<MutationResult & { currentElectionPeriodSequence: number }> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        if (!(await admissionExists(tx as DbClient, admissionId)))
          throw new ResourceNotFoundError(admissionId);
        // W-DC-03 / D9 — inherit the carried sequence as the ACTIVE period (no CTI required from us) and
        // open the next PENDING period (our CTI required). The sequence counter never restarts.
        const plan = planTransferIn(input);
        await tx.insert(EP).values({
          organizationId,
          admissionId,
          sequenceNumber: plan.inherited.sequence,
          periodKind: "ninety_day",
          status: plan.inherited.state,
        });
        const nextPeriod = firstOrThrow(
          await tx
            .insert(EP)
            .values({
              organizationId,
              admissionId,
              sequenceNumber: plan.next.sequence,
              periodKind: "ninety_day",
              status: plan.next.state,
            })
            .returning({ id: EP.id }),
          "election period insert returned no row",
        );
        // D9 — draft OUR CTI against the next period (the inherited period runs on the sending
        // hospice's certification; `signCtiHospiceMd` derives the no-attending-needed rule from this
        // period's own sequenceNumber, which is never 1 for a transfer-in, so no special-casing here).
        const cti = firstOrThrow(
          await tx
            .insert(CTI)
            .values({
              organizationId,
              electionPeriodId: nextPeriod.id,
              hospiceMdId: input.hospiceMedicalDirectorId,
              attendingMdId: input.attendingPhysicianId ?? null,
            })
            .returning({ id: CTI.id }),
          "cti insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.cti.drafted",
          payload: { ctiId: cti.id, electionPeriodId: nextPeriod.id, isRecert: true },
          organizationId,
          aggregateKind: "certification_of_terminal_illness",
          aggregateId: cti.id,
        });
        const xfer = firstOrThrow(
          await tx
            .insert(TE)
            .values({
              organizationId,
              admissionId,
              direction: "in",
              effectiveAt: input.effectiveDate,
              periodSequenceAtTransfer: plan.inherited.sequence,
              receivingOrSendingCcn: input.otherHospiceCcn ?? null,
              receivingOrSendingName: input.otherHospiceName,
              narrative: input.narrative,
            })
            .returning({ id: TE.id, version: TE.version }),
          "transfer insert returned no row",
        );
        await outbox.publish(tx, {
          eventName: "m6.transfer.created",
          payload: { transferId: xfer.id, admissionId, direction: "in" },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        await outbox.publish(tx, {
          eventName: "m6.election.period_started",
          payload: { admissionId, sequence: plan.inherited.sequence },
          organizationId,
          aggregateKind: "transfer_event",
          aggregateId: xfer.id,
        });
        return {
          id: xfer.id,
          state: "created",
          version: Number(xfer.version),
          currentElectionPeriodSequence: plan.inherited.sequence,
        };
      });
    },
    async discharge(
      organizationId,
      admissionId,
      input: DischargeInput,
      actorUserId,
    ): Promise<DischargeResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        // §6.3 — the per-reason narrative gates (for_cause needs a forCauseReason; D11 tightens
        // no_longer_terminal/other). The reason→permission key is enforced at the route preHandler.
        const issue = checkDischargeNarrative(input.reason, input.narrative, input.forCauseReason);
        if (issue) throw new AdmissionStateError(issue.code, issue.message);
        const requiresMedicalDirectorCosign = dischargeRequiresCosign(input.reason);
        const dbType = REASON_TO_DB_TYPE[input.reason];
        if (requiresMedicalDirectorCosign) {
          // W-DC-02 / D11 — filing a for-cause discharge does NOT discharge the admission; the row is
          // `pending_cosign` and the admission stays active until a medical director cosigns (route 40).
          if (!(await admissionExists(tx as DbClient, admissionId)))
            throw new ResourceNotFoundError(admissionId);
          const de = firstOrThrow(
            await tx
              .insert(DE)
              .values({
                organizationId,
                admissionId,
                dischargeType: dbType,
                status: "pending_cosign",
                effectiveAt: input.dischargeDate,
                narrative: input.narrative,
                forCauseReason: input.forCauseReason ?? null,
              })
              .returning({ id: DE.id, status: DE.status, version: DE.version }),
            "discharge insert returned no row",
          );
          await outbox.publish(tx, {
            eventName: "m6.discharge.created",
            payload: { dischargeId: de.id, admissionId },
            organizationId,
            aggregateKind: "discharge_event",
            aggregateId: de.id,
          });
          return {
            id: de.id,
            state: de.status,
            version: Number(de.version),
            requiresMedicalDirectorCosign,
            reason: input.reason,
          };
        }
        // Every other reason discharges immediately: death → bereavement (§2.3.1) + the M6 bereavement-
        // eligibility rule (emitted by the state machine); the rest → discharged.
        const res = await dischargeAdmissionTx(tx, organizationId, admissionId, {
          dischargeType: REASON_TO_SM_TYPE[input.reason],
          effectiveAt: input.dischargeDate,
          forCauseCosigned: false,
        });
        const de = firstOrThrow(
          await tx
            .insert(DE)
            .values({
              organizationId,
              admissionId,
              dischargeType: dbType,
              status: "completed",
              effectiveAt: input.dischargeDate,
              narrative: input.narrative,
              deathAt: input.reason === "death" ? new Date(input.dischargeDate) : null,
              bereavementEligible: res.state === "bereavement",
            })
            .returning({ id: DE.id, status: DE.status, version: DE.version }),
          "discharge insert returned no row",
        );
        return {
          id: de.id,
          state: de.status,
          version: Number(de.version),
          requiresMedicalDirectorCosign,
          reason: input.reason,
        };
      });
    },
    async cosignDischarge(organizationId, id, ifVersion, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({
            status: DE.status,
            version: DE.version,
            admissionId: DE.admissionId,
            effectiveAt: DE.effectiveAt,
          })
          .from(DE)
          .where(eq(DE.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status !== "pending_cosign")
          throw conflict(
            `discharge ${id} is not awaiting a medical-director cosign (state '${cur.status}')`,
          );
        // W-DC-02 — the cosign completes the discharge AND discharges the admission held active while
        // awaiting governance sign-off (D11).
        const outcome = resolveForCauseDischarge("cosign");
        const r = firstOrThrow(
          await tx
            .update(DE)
            .set({
              status: outcome.dischargeState,
              version: sql`${DE.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(DE.id, id), eq(DE.version, ifVersion)))
            .returning({ id: DE.id, status: DE.status, version: DE.version }),
          "discharge not found",
        );
        await dischargeAdmissionTx(tx, organizationId, cur.admissionId, {
          dischargeType: "for_cause",
          effectiveAt: cur.effectiveAt,
          forCauseCosigned: true,
        });
        await outbox.publish(tx, {
          eventName: "m6.discharge.cosigned",
          payload: { dischargeId: id, admissionId: cur.admissionId },
          organizationId,
          aggregateKind: "discharge_event",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async acknowledgeNor(organizationId, admissionId, input, actorUserId): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [adm] = await tx
          .select({ status: ADM.status, version: ADM.version, patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) throw new ResourceNotFoundError(admissionId);
        const [existing] = await tx
          .select({ id: NOR.id })
          .from(NOR)
          .where(eq(NOR.admissionId, admissionId))
          .limit(1);
        // §2.3.1 pending → notice_of_rights_acknowledged (guards `alreadyAcknowledged`).
        const t = transitionAdmission(adm.status as AdmissionState, {
          type: "acknowledgeNoticeOfRights",
          alreadyAcknowledged: !!existing,
        } satisfies AdmissionEvent);
        const acknowledgedAt = new Date();
        // TASK-034: the request's `deliveryMethod`/`acknowledgedByRole` used to be validated by the
        // route then discarded here — every acknowledgment silently recorded "patient, electronic
        // witnessed" regardless of what was submitted. `acknowledgedByRole`'s wire value
        // "legal_representative" doesn't match the DB's `election_signer_kind` enum ("representative"),
        // so it's translated, not passed through.
        const nor = firstOrThrow(
          await tx
            .insert(NOR)
            .values({
              organizationId,
              admissionId,
              patientId: adm.patientId,
              signerKind:
                input.acknowledgedByRole === "legal_representative" ? "representative" : "patient",
              acknowledgedAt: acknowledgedAt.toISOString().slice(0, 10),
              acknowledgmentMethod: input.deliveryMethod,
            })
            .returning({ id: NOR.id }),
          "NOR insert returned no row",
        );
        const r = firstOrThrow(
          await tx
            .update(ADM)
            .set({ status: t.to, version: sql`${ADM.version} + 1` })
            .where(eq(ADM.id, admissionId))
            .returning({ id: ADM.id, status: ADM.status, version: ADM.version }),
          "row not found",
        );
        await runEffects(
          tx,
          { organizationId, aggregateKind: "admission", aggregateId: admissionId, admissionId },
          t.effects,
          {
            "m6.nor.acknowledged": {
              norAcknowledgmentId: nor.id,
              acknowledgedAt: acknowledgedAt.toISOString(),
            },
          },
        );
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    // ── M6L-T05: compliance-window close / override ───────────────────────────────────────────────
    async closeComplianceWindow(organizationId, id, ifVersion): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [cur] = await tx
          .select({ status: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status === "closed") throw conflict(`compliance window ${id} is already closed`);
        const r = firstOrThrow(
          await tx
            .update(CW)
            .set({
              status: "closed",
              closedAt: now(),
              version: sql`${CW.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(CW.id, id), eq(CW.version, ifVersion)))
            .returning({ id: CW.id, status: CW.status, version: CW.version }),
          "compliance window not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.compliance.window.closed",
          payload: { complianceWindowId: id },
          organizationId,
          aggregateKind: "compliance_window",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
    async overrideComplianceWindow(
      organizationId,
      id,
      reason,
      ifVersion,
      actorUserId,
    ): Promise<MutationResult> {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const [cur] = await tx
          .select({ status: CW.status, version: CW.version })
          .from(CW)
          .where(eq(CW.id, id))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(id);
        assertVersion(id, Number(cur.version), ifVersion);
        if (cur.status === "closed") throw conflict(`compliance window ${id} is already closed`);
        // §2.2 override — closes the window early with the captured reason + the overriding staff member
        // (whose role the route's ABAC preHandler gates); the reason is the audit-bearing evidence.
        const r = firstOrThrow(
          await tx
            .update(CW)
            .set({
              status: "closed",
              closedAt: now(),
              overrideReason: reason,
              closedBy: actorUserId || null,
              version: sql`${CW.version} + 1`,
              updatedAt: now(),
            })
            .where(and(eq(CW.id, id), eq(CW.version, ifVersion)))
            .returning({ id: CW.id, status: CW.status, version: CW.version }),
          "compliance window not found",
        );
        await outbox.publish(tx, {
          eventName: "m6.compliance.window.overridden",
          payload: { complianceWindowId: id, reason },
          organizationId,
          aggregateKind: "compliance_window",
          aggregateId: id,
        });
        return { id: r.id, state: r.status, version: Number(r.version) };
      });
    },
  };
}

/**
 * The production, RLS-backed AdmissionAbacResolver — the §4.6 signer-identity write predicates
 * (F2F attest, discharge medical-director cosign, compliance override) load a resource's owner facts
 * through it. Every load is a single org-scoped read under `withOrgContext` (RLS backstops), returning
 * `null` when the row is absent/cross-tenant so the predicate fails closed.
 */
export function createDbAdmissionAbacResolver(db: DbClient): AdmissionAbacResolver {
  return {
    async loadReferral(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ locationId: REF.locationId, providerEntityId: REF.providerEntityId })
          .from(REF)
          .where(eq(REF.id, id))
          .limit(1);
        return r
          ? { locationId: r.locationId ?? null, providerEntityId: r.providerEntityId ?? null }
          : null;
      });
    },
    async loadAdmission(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ patientId: ADM.patientId, providerEntityId: ADM.providerEntityId })
          .from(ADM)
          .where(eq(ADM.id, id))
          .limit(1);
        return r ? { patientId: r.patientId, providerEntityId: r.providerEntityId ?? null } : null;
      });
    },
    async loadCti(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ hospiceMdId: CTI.hospiceMdId, attendingMdId: CTI.attendingMdId })
          .from(CTI)
          .where(eq(CTI.id, id))
          .limit(1);
        return r
          ? {
              hospiceMedicalDirectorId: r.hospiceMdId,
              attendingPhysicianId: r.attendingMdId ?? null,
            }
          : null;
      });
    },
    async loadF2f(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // The DB stores the performer as `performed_by_user_id`; the §4.6 predicate reads it as the
        // scheduled clinician (the person whose identity the attest gate matches).
        const [r] = await tx
          .select({ performedByUserId: F2F.performedByUserId })
          .from(F2F)
          .where(eq(F2F.id, id))
          .limit(1);
        return r ? { scheduledClinicianId: r.performedByUserId } : null;
      });
    },
    async loadComplianceWindow(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // compliance_window carries no patient/provider — join the admission it belongs to.
        const [r] = await tx
          .select({
            admissionId: CW.admissionId,
            patientId: ADM.patientId,
            providerEntityId: ADM.providerEntityId,
          })
          .from(CW)
          .innerJoin(ADM, eq(CW.admissionId, ADM.id))
          .where(eq(CW.id, id))
          .limit(1);
        return r
          ? {
              admissionId: r.admissionId,
              patientId: r.patientId,
              providerEntityId: r.providerEntityId ?? null,
            }
          : null;
      });
    },
  };
}
