// apps/backend/src/modules/17-scheduling — PRODUCTION SchedulingRouteService + §4.7 ABAC resolver (M17L reads
// + the write lifecycle over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (visit lists / day-week-map views, the proposal inbox, recurring cadences,
// clinician availability, time-off, portal upcoming, productivity metrics) run as real Drizzle queries over
// the M17-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `chartwarden_app` role. `visit` + `visit_state_history` are PARTITIONED BY RANGE (service_date / transitioned_at)
// with a DEFAULT catch-all leaf — reads query the parent, inserts route to the current-month leaf; the D6
// per-clinician visit-overlap GiST EXCLUDE lives on the leaves and fires at publish (proposed → published).
//
// Like M12/M13, M17 has NO state-transition DB triggers (only the M4 audit triggers) — the service performs
// every visit / time-off / recurring / availability transition itself via INSERT/UPDATE, composing the PURE
// `@chartwarden/scheduling` deciders: the §2.2.1 eight-state visit machine (`transitionVisit` / `planVisitProposed`)
// and the §2.2.6 time_off machine (`transitionTimeOff`). Each machine returns a declarative side-effect list
// (`write_state_history` / `outbox` / `set_*` / `capture_reason` / `bump_version` / `audit` / `alert`); the
// service EXECUTES it inside the mutation's `withOrgContext` tx — writing the `visit_state_history` append and
// publishing the strict `m17.*` catalog payload on the bound transactional outbox (the publisher Value.Checks
// each emit and rolls back on mismatch, so the payloads here are the exact events-by-m17.ts shapes). Column
// writes (status, version, evv-bracket, captured reasons, cancel/reschedule lineage) are applied directly on
// the UPDATE, mirroring the in-mem service (which lets effects drive only the events + history).
//
// Documented compromises (the M8–M14 convention; the interface threads no seams into the DB backend):
//   (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL actor; the acting
//       membership is the passed `userId` (stored as `actor_membership_id` on `visit_state_history` and as the
//       `*_by` field on the aggregate / outbox payload where a column exists);
//   (2) the `visit` / `recurring_visit` siting (provider_entity_id + location_id, both NOT NULL) is resolved
//       from the assigned membership's `default_provider_entity_id` + `default_location_ids[0]` (M1 §3.7);
//       `assigned_discipline_at_assignment` is captured as the first eligible discipline for the visit purpose
//       (`VISIT_PURPOSE_DISCIPLINES[purpose][0]`) — the real M2 discipline resolver is not threaded here;
//   (3) GAP-030/GAP-031: both the ROUTE-LAYER §4.7 ABAC predicates on `POST /visits` (the
//       `SchedulingAbacResolver` methods below, GAP-030) AND the SERVICE-LAYER `preScheduleGatePassed`
//       gate (reassign/edit/publish/reschedule, GAP-031) now resolve real data for `discipline_matches_
//       visit` (M3 membership_role→role, the GAP-021 precedent), `not_on_pto`, and `within_caseload_or_
//       unassigned_pool` (the M17 `allow_unassigned_pool_assignment` org setting + the M5 CaseloadProvider
//       seam) — via the SAME `resolveDisciplinesTx`/`allowsUnassignedPoolTx` tx-scoped helpers plus the
//       SAME no-tx-open `inCaseload`/`credentialActive` seam calls, so the two layers can't drift. `clinician_credentials_active` stays fail-closed and
//       deliberately unattached/unchecked in BOTH layers: no clinical-credential data model exists
//       anywhere in the platform yet (GAP-093);
//   (4) `time_off` / `clinician_availability` are clinician-scoped (nullable siting) → their inserts carry NULL
//       provider_entity_id + location_id per the schema intent;
//   (5) route optimisation stays OFF (`scheduling.route_optimization`) → `optimizeDay` emits the §7.9
//       `m17.route_optimization_degraded` event and returns the degraded (scheduled-order) result;
//   (6) `upsertAvailability` MERGES per (membership, day_of_week) — chartwarden_app has no DELETE grant on any M17
//       table, so a weekday dropped from the new set is not pruned (the append-only posture); `time_zone` has
//       no column, so the write echoes the request tz while reads report UTC (the T01 read TODO).
import {
  type DbClient,
  organizationSettingsReader,
  organizationTimezone,
  schema,
} from "@chartwarden/db";
import {
  MATERIALIZE_HORIZON_DAYS,
  PROPOSE_HORIZON_DAYS,
  type SchedulingDiscipline,
  type SchedulingSideEffect,
  SchedulingStateError,
  VISIT_PURPOSE_DISCIPLINES,
  materializeRecurrence,
  planFrequencyProposals,
  planVisitProposed,
  transitionTimeOff,
  transitionVisit,
} from "@chartwarden/scheduling";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ConflictError,
  type EncounterType,
  ForbiddenError,
  type InterventionDiscipline,
  NotFoundError,
  type TimeOffKind,
  type TimeOffState,
  ValidationError,
  type VisitPurpose,
  type VisitSetting,
  type VisitStatus,
} from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { type SQL, and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import type { SchedulingAbacResolver } from "./abac-predicates";
import {
  countPublishedVisitsInWindow,
  emitDueCaregiverReminders,
  flagReassignmentsForTimeOff,
  sweepApprovedTimeOffReassignments,
} from "./reassignment-scan";
import {
  assertRecurringPolicyValid,
  ruleForPolicy,
  toRecurringPolicyColumns,
} from "./recurring-policy";
import { assertAssignedClinician } from "./routes/assigned-clinician";
import {
  type CallerAuthority,
  assertMayCancelTimeOff,
  assertMayDecideTimeOff,
  assertMayEditAvailability,
  assertMayRequestTimeOff,
  resolveTimeOffListScope,
} from "./routes/own-vs-any";
import {
  type AvailabilityView,
  type CreateRecurringInput,
  type CreateVisitInput,
  type EditVisitInput,
  type EligibleClinicianView,
  type OptimizeDayInput,
  type ProposalView,
  type RecurringView,
  type RequestTimeOffInput,
  type RescheduleVisitInput,
  type SchedulingRouteService,
  type SchedulingStaffView,
  type TimeOffView,
  type UpsertAvailabilityInput,
  VISIT_LIST_LIMIT,
  type VisitReadScope,
  type VisitView,
} from "./routes/service";
import { type CredentialRecord, createDrizzleCredentialStore } from "./seams/index";
import {
  type CreateOnCallRotationInput,
  createDrizzleOnCallRotationStore,
} from "./seams/oncall-rotation-store";
import { orgContextFor } from "./system-actor";
import { computeVisitMetrics } from "./visit-metrics";

/** Safety cap on the internal (unscoped) visit read that metrics / portal / optimiser compose over. */
const UNSCOPED_LIMIT = 50_000;
/** `stale-visit-sweep` bounds: batch size per run, and the re-nag window before a still-stuck visit is flagged again. */
const STALE_VISIT_SCAN_LIMIT = 500;
const STALE_VISIT_RENAG_HOURS = 168;

const V = schema.visit;
const VSH = schema.visitStateHistory;
const VP = schema.visitProposal;
const RV = schema.recurringVisit;
const CA = schema.clinicianAvailability;
const TO = schema.timeOff;
const MEM = schema.memberships;
const MEM_ROLE = schema.membershipRoles;
const ROLE = schema.roles;
const ORG = schema.organizations;
const USER = schema.users;

/** Every discipline any visit purpose accepts (GAP-030) — the full `SchedulingDiscipline` vocab,
 *  derived from the policy map rather than duplicated as a literal list. */
const ALL_SCHEDULING_DISCIPLINES = new Set<string>(Object.values(VISIT_PURPOSE_DISCIPLINES).flat());

/** The two D8 gate facts that come from CROSS-MODULE seams, resolved with no transaction open (the seams
 *  each take their own pooled connection) and then handed to the gate running inside the write tx. */
interface PreScheduleSeamFacts {
  /** M17's own `CredentialReader`: an ACTIVE credential for one of the qualifying disciplines. */
  readonly credentialsActive: boolean;
  /** M5's `CaseloadProvider`: the patient is in this membership's caseload. */
  readonly inCaseload: boolean;
}

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());
// PARAM-004: was `isoStr.slice(0, 10)` — a UTC-instant slice reads the WRONG calendar day for a
// large fraction of every US business day (an evening visit's scheduledStartedAt, e.g. 8pm
// Pacific, is already tomorrow in UTC). `timezone` is the org's `org_timezone` setting, resolved
// ONCE per method via `organizationTimezone` and reused across every derivation in that call.
const serviceDateOf = (isoStr: string, timezone: string): string =>
  localDateInTimeZone(new Date(isoStr), timezone);

// ── row → view projections ──────────────────────────────────────────────────────────────────────────────
type VisitRow = {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  visitSetting: string;
  scheduledStartedAt: Date;
  scheduledEndedAt: Date;
  status: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  rescheduledIntoVisitId: string | null;
};

const toVisitView = (r: VisitRow, timezone: string): VisitView => {
  const startedAt = iso(r.scheduledStartedAt);
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    assignedMembershipId: r.assignedMembershipId,
    visitPurpose: r.visitPurpose as VisitPurpose,
    visitSetting: r.visitSetting as VisitSetting,
    scheduledStartedAt: startedAt,
    scheduledEndedAt: iso(r.scheduledEndedAt),
    serviceDate: serviceDateOf(startedAt, timezone),
    status: r.status as VisitStatus,
    patientAddressId: r.patientAddressId,
    externalFacilityId: r.externalFacilityId,
    rescheduledIntoVisitId: r.rescheduledIntoVisitId,
  };
};

const VISIT_COLS = {
  id: V.id,
  organizationId: V.organizationId,
  patientId: V.patientId,
  admissionId: V.admissionId,
  assignedMembershipId: V.assignedMembershipId,
  visitPurpose: V.visitPurpose,
  visitSetting: V.visitSetting,
  scheduledStartedAt: V.scheduledStartedAt,
  scheduledEndedAt: V.scheduledEndedAt,
  status: V.status,
  patientAddressId: V.patientAddressId,
  externalFacilityId: V.externalFacilityId,
  rescheduledIntoVisitId: V.rescheduledIntoVisitId,
} as const;

/** The write-path load: everything a transition needs (siting for the history row + the machine facts). */
const VISIT_WRITE_COLS = {
  ...VISIT_COLS,
  providerEntityId: V.providerEntityId,
  locationId: V.locationId,
  version: V.version,
} as const;

/** The transactional-outbox port (§4.4): the bound publisher validates every emit against the boot catalog
 * and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit without
 * a dispatcher. Mirrors M7–M14. */
export interface SchedulingWriteOutboxPort {
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
const NOOP_OUTBOX: SchedulingWriteOutboxPort = { async publish() {} };

export interface SchedulingAutomationService {
  materializeRecurringVisitsForOrg(
    orgId: string,
    userId: string,
    options?: { now?: Date; horizonDays?: number },
  ): Promise<{ policiesScanned: number; visitsCreated: number; occurrencesSkipped: number }>;
  generateCarePlanVisitProposals(
    orgId: string,
    userId: string,
    input: {
      planId: string;
      versionId: string;
      patientId: string;
      admissionId: string;
      now?: Date;
    },
  ): Promise<{ proposalsCreated: number; proposalsSkipped: number }>;
  handleAdmissionHold(
    orgId: string,
    userId: string,
    input: { admissionId: string; heldAt: string; reason: string },
  ): Promise<{ cancelledVisits: number }>;
  handleAdmissionResume(
    orgId: string,
    userId: string,
    input: { admissionId: string; resumedAt: string },
  ): Promise<{ recreatedVisits: 0 }>;
  handleAdmissionDischarge(
    orgId: string,
    userId: string,
    input: { admissionId: string; dischargeDate: string; reason: string },
  ): Promise<{ cancelledVisits: number }>;
  scanVisitAttentionForOrg(
    orgId: string,
    userId: string,
    options?: { now?: Date },
  ): Promise<{ staleVisits: number; possibleMissedVisits: number }>;
  /** §4.8 `reassignment-scan` backstop: flag published visits inside every approved PTO window (idempotent). */
  scanTimeOffReassignmentsForOrg(
    orgId: string,
    userId: string,
    options?: { now?: Date },
  ): Promise<{ timeOffsScanned: number; visitsFlagged: number }>;
  /** §4.8 `caregiver-reminder`: emit `m17.caregiver_reminder_due` for opted-in visits ≤24h out (idempotent). */
  emitCaregiverRemindersForOrg(
    orgId: string,
    userId: string,
    options?: { now?: Date },
  ): Promise<{ remindersEmitted: number }>;
}

/** The first eligible discipline for a visit purpose — the captured `assigned_discipline_at_assignment`
 * (compromise #2: the real M2 discipline resolver is not threaded into the DB backend). */
const disciplineFor = (purpose: VisitPurpose): SchedulingDiscipline =>
  VISIT_PURPOSE_DISCIPLINES[purpose][0] as SchedulingDiscipline;

const encounterTypeFor = (purpose: VisitPurpose): EncounterType => {
  switch (purpose) {
    case "f2f":
      return "face_to_face";
    case "recert":
      return "recert_visit";
    case "aide_poc":
      return "chha_visit";
    case "msw_assessment":
    case "msw_followup":
    case "chaplain_assessment":
    case "chaplain_visit":
    case "volunteer_visit":
    case "admission_visit":
      return purpose;
    default:
      return "routine_visit";
  }
};

/**
 * The production, RLS-backed scheduling backend (M17L reads + the write lifecycle). Also implements
 * {@link SchedulingAbacResolver}: the time-off overlap probe is a real org-scoped query; the cross-module
 * facts (M2 discipline/credentials, M2 org policy, M5 caseload) fail closed until those readers bind (the
 * service-layer publish/edit/reassign gate enforces only `not_on_pto`, compromise #3).
 */
export function createDbSchedulingBackend(
  db: DbClient,
  outbox: SchedulingWriteOutboxPort = NOOP_OUTBOX,
): SchedulingRouteService & SchedulingAutomationService {
  // GAP-093 — the same Drizzle store `registerCredentialSeam` binds to the boot-registered
  // `CredentialReader` seam, constructed here directly (no self-referential `getSeam` round-trip)
  // for M17's OWN grant/revoke/list routes — this module owns `membership_credential`.
  const credentialStore = createDrizzleCredentialStore(db);
  // GAP-029 — M17's own on-call rotation table.
  const onCallRotationStore = createDrizzleOnCallRotationStore(db);

  // ── emit + tx helpers ───────────────────────────────────────────────────────────────────────────────
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: orgId,
      aggregateKind,
      aggregateId,
    });
  }

  /** Resolve a visit/recurring row's siting from the assigned membership (compromise #2). */
  async function resolveSiting(
    tx: DbClient,
    membershipId: string,
  ): Promise<{ providerEntityId: string; locationId: string }> {
    const [m] = await tx
      .select({ pe: MEM.defaultProviderEntityId, locs: MEM.defaultLocationIds })
      .from(MEM)
      .where(eq(MEM.id, membershipId))
      .limit(1);
    if (!m) throw new NotFoundError("membership");
    const locs = Array.isArray(m.locs) ? (m.locs as string[]) : [];
    if (!m.pe || locs.length === 0) {
      throw new ValidationError(
        "the assigned membership has no default provider entity / location to site the visit",
        [],
      );
    }
    return { providerEntityId: m.pe, locationId: locs[0] as string };
  }

  /** Load a write-path visit row (RLS-scoped) or the non-leaking 404. */
  async function loadVisit(tx: DbClient, visitId: string): Promise<Record<string, unknown>> {
    const [row] = await tx.select(VISIT_WRITE_COLS).from(V).where(eq(V.id, visitId)).limit(1);
    if (!row) throw new NotFoundError("visit");
    return row as Record<string, unknown>;
  }

  /** Append the §2.2.2 `visit_state_history` rows a transition's effects declare (one per write_state_history). */
  async function appendHistory(
    tx: DbClient,
    orgId: string,
    v: { id: string; providerEntityId: string; locationId: string },
    effects: ReadonlyArray<SchedulingSideEffect>,
    userId: string,
  ): Promise<void> {
    for (const e of effects) {
      if (e.kind !== "write_state_history") continue;
      const genesis = e.from === e.to; // the `proposed → proposed` factory insert carries a NULL from_state
      await tx.insert(VSH).values({
        organizationId: orgId,
        providerEntityId: v.providerEntityId,
        locationId: v.locationId,
        visitId: v.id,
        fromState: genesis ? null : (e.from as VisitStatus),
        toState: e.to as VisitStatus,
        actorMembershipId: e.systemDriven || !userId ? null : userId,
        systemSource: e.systemDriven ? "system" : null,
        reason: e.reason,
      });
    }
  }

  // ── §4.7 fact resolvers, tx-scoped (GAP-030/GAP-031) ────────────────────────────────────────────────────
  // Shared by `preScheduleGatePassed` (runs directly against the caller's already-open `tx` — the M11
  // "read within tx" precedent: a fact this gate needs must never be resolved via a SEPARATE
  // `withOrgContext`/transaction, or it risks missing a write made earlier in the SAME enclosing tx) and
  // the `backend.resolveDiscipline`/`allowsUnassignedPool` ABAC-resolver methods below (which wrap these
  // in their OWN `withOrgContext` for the route-layer predicates, called standalone outside any tx).
  // Returns EVERY scheduling discipline the membership holds, not just one. This used to be a
  // `roleRows.find(...)` over an UNORDERED query, which is wrong twice for a multi-discipline
  // membership: the row Postgres happened to return first decided both whether the D8 gate passed
  // and which credential kind was then looked for, so a clinician holding e.g. `msw` + `rn` was
  // non-deterministically 403'd on an `admission_visit` they genuinely qualify for. "Does this
  // clinician hold A discipline that fits this visit?" is a set-intersection question; answering it
  // with one arbitrary element cannot be made correct by ordering, only by keeping the set.
  // Sorted so the value is stable for logging/debugging regardless of row order.
  async function resolveDisciplinesTx(
    tx: DbClient,
    orgId: string,
    membershipId: string,
  ): Promise<SchedulingDiscipline[]> {
    const roleRows = await tx
      .select({ key: ROLE.key })
      .from(MEM_ROLE)
      .innerJoin(ROLE, eq(MEM_ROLE.roleId, ROLE.id))
      .where(
        and(
          eq(MEM_ROLE.organizationId, orgId),
          eq(MEM_ROLE.membershipId, membershipId),
          or(isNull(MEM_ROLE.expiresAt), gt(MEM_ROLE.expiresAt, new Date())),
        ),
      );
    return [
      ...new Set(
        roleRows
          .map((r) => r.key)
          .filter((k): k is SchedulingDiscipline => ALL_SCHEDULING_DISCIPLINES.has(k)),
      ),
    ].sort();
  }

  async function allowsUnassignedPoolTx(tx: DbClient, orgId: string): Promise<boolean> {
    const [org] = await tx
      .select({ settings: ORG.settings })
      .from(ORG)
      .where(eq(ORG.id, orgId))
      .limit(1);
    return (
      organizationSettingsReader.get<boolean>(
        (org?.settings as Record<string, unknown> | undefined) ?? null,
        "allow_unassigned_pool_assignment",
      ) ?? false
    );
  }

  // ── the SEAM-backed halves of the D8 gate, deliberately split from their tx-scoped prerequisites ──────
  //
  // `CaseloadProvider` and `CredentialReader` are both backed in production by stores that open their OWN
  // `withOrgContext` — i.e. their own `db.transaction()` — on this same pooled handle. Calling either from
  // INSIDE an M17 transaction therefore held two pool connections for one request: the caller's, plus the
  // one the seam needs to make progress. With `max: 10` and no `connectionTimeoutMillis`, ten concurrent
  // visit writes hold all ten connections and each waits forever for an eleventh. That is the same defect
  // proven against M36's `syncCareTeamChannel` (a max:1 pool reproduces it in one call), and the comment
  // that used to sit here called it "an unavoidable nested transaction … proven live-tested" — live tests
  // prove the QUERY, never the pool arithmetic.
  //
  // So: the tx-scoped prerequisite reads keep taking a `tx`, and the seam calls take none and must be
  // invoked with NO transaction open. `resolvePreScheduleSeamFacts` below is the one place that sequences
  // them for the service-layer gate.

  /** tx-scoped: the membership's user id (the seam speaks user ids, M17 speaks membership ids). */
  async function membershipUserIdTx(
    tx: DbClient,
    orgId: string,
    membershipId: string,
  ): Promise<string | null> {
    const [mem] = await tx
      .select({ userId: MEM.userId })
      .from(MEM)
      .where(and(eq(MEM.organizationId, orgId), eq(MEM.id, membershipId)))
      .limit(1);
    return mem?.userId ?? null; // no such membership on this tenant → fail closed at the caller
  }

  /** NO transaction may be open when this is called — see the block comment above. */
  async function inCaseload(
    orgId: string,
    userId: string | null,
    patientId: string,
  ): Promise<boolean> {
    if (userId === null) return false;
    return getSeam("CaseloadProvider").isInCaseload({ organizationId: orgId, userId, patientId });
  }

  // GAP-093 — the real `clinician_credentials_active` check: does `membershipId` hold an ACTIVE
  // credential for the discipline it's actually being scheduled under (the SAME `discipline` value
  // `resolveDisciplineTx` resolved)? Orthogonal to `discipline_matches_visit` (an M3 RBAC role grant)
  // — a clinician can hold the "rn" ROLE while their nursing LICENSE has lapsed or been suspended.
  // Reads through `getSeam("CredentialReader")` (M17's OWN boot-registered seam) rather than the
  // Drizzle store directly: the seam is the one path every consumer (this gate, and eventually M23/
  // M31) shares, so a future change to what "active" means has one home. That seam opens its own
  // `withOrgContext`, hence the no-transaction-open contract below.
  /** NO transaction may be open when this is called — see the block comment above `membershipUserIdTx`. */
  async function credentialActive(
    orgId: string,
    membershipId: string,
    disciplines: readonly SchedulingDiscipline[],
    asOfDate: string,
  ): Promise<boolean> {
    if (disciplines.length === 0) return false; // no qualifying discipline → nothing to credential
    const creds = await getSeam("CredentialReader").activeCredentialsAsOf({
      organizationId: orgId,
      membershipId,
      asOf: asOfDate,
    });
    return creds.some((c) => disciplines.includes(c.kind as SchedulingDiscipline));
  }

  /**
   * Resolve the two SEAM-backed halves of the D8 gate with no transaction open.
   *
   * Every write path calls this BEFORE opening its `withOrgContext`, then hands the verdicts to
   * {@link preScheduleGatePassed}, which still resolves everything else (disciplines, PTO, unassigned-pool
   * policy) inside the write tx where the M11 "read within tx" rule applies.
   *
   * Splitting the gate this way is safe because neither fact is written by an M17 transaction:
   * `patient_assignment` belongs to M5 and `membership_credential` is only ever written by M17's own
   * grant/revoke routes, never mid-visit-write. So there is no same-tx write these reads could miss —
   * which was already true of the nested version, since a separate connection saw a separate snapshot
   * anyway. The nesting never bought atomicity; it only bought a second connection.
   */
  /**
   * The gate target for a write keyed on an EXISTING visit (edit / reschedule / reassign), read in its own
   * short transaction so {@link resolvePreScheduleSeamFacts} can then run with none open. `overrides` are
   * the caller's proposed changes, each falling back to the stored row.
   *
   * The write transaction re-loads the visit and re-runs every non-seam check against it, so this read is
   * only ever used to decide WHICH membership/patient/date to ask the seams about. A concurrent change
   * between the two reads can therefore only produce a seam verdict for a slightly stale target — the same
   * exposure the nested version had, since its seam call ran on a separate connection and snapshot too.
   */
  async function preScheduleTargetOfVisit(
    tx: DbClient,
    visitId: string,
    overrides: {
      membershipId?: string;
      visitPurpose?: VisitPurpose;
      startsAt?: string;
      endsAt?: string;
    },
  ): Promise<{
    membershipId: string;
    visitPurpose: VisitPurpose;
    patientId: string;
    startsAt: string;
  }> {
    const v = await loadVisit(tx, visitId);
    return {
      membershipId: (overrides.membershipId ?? v.assignedMembershipId) as string,
      visitPurpose: (overrides.visitPurpose ?? v.visitPurpose) as VisitPurpose,
      patientId: v.patientId as string,
      startsAt: overrides.startsAt ?? iso(v.scheduledStartedAt as Date),
    };
  }

  async function resolvePreScheduleSeamFacts(
    orgId: string,
    membershipId: string,
    visitPurpose: VisitPurpose,
    patientId: string,
    startsAt: string,
  ): Promise<PreScheduleSeamFacts> {
    const { qualifying, serviceDate, userId } = await withOrgContext(
      db,
      { organizationId: orgId, userId: "" },
      async (txRaw) => {
        const tx = txRaw as DbClient;
        const held = await resolveDisciplinesTx(tx, orgId, membershipId);
        return {
          qualifying: held.filter((d) => VISIT_PURPOSE_DISCIPLINES[visitPurpose].includes(d)),
          serviceDate: serviceDateOf(startsAt, await organizationTimezone(tx, orgId)),
          userId: await membershipUserIdTx(tx, orgId, membershipId),
        };
      },
    );
    // Transaction closed. Both seams may now take their own connection without contending for ours.
    const [credentialsActive, inCaseloadNow] = await Promise.all([
      credentialActive(orgId, membershipId, qualifying, serviceDate),
      inCaseload(orgId, userId, patientId),
    ]);
    return { credentialsActive, inCaseload: inCaseloadNow };
  }

  /** The D8 pre-schedule gate the service enforces (GAP-031/GAP-093). Checks the same facts GAP-030
   *  wired into the route-layer ABAC predicates — `clinician_credentials_active`,
   *  `discipline_matches_visit`, `not_on_pto`, `within_caseload_or_unassigned_pool` — against real
   *  data, reused from the SAME tx-scoped resolvers above so the two layers can never drift. */
  async function preScheduleGatePassed(
    tx: DbClient,
    orgId: string,
    membershipId: string,
    visitPurpose: VisitPurpose,
    patientId: string,
    startsAt: string,
    endsAt: string,
    seamFacts: PreScheduleSeamFacts,
  ): Promise<boolean> {
    // The clinician qualifies if ANY discipline they hold is accepted for this visit purpose, and the
    // credential check then runs against that same qualifying set — a membership holding `msw` + `rn`
    // passes an `admission_visit` on its `rn` role and `rn` licence, whichever order the rows arrive in.
    const qualifying = (await resolveDisciplinesTx(tx, orgId, membershipId)).filter((d) =>
      VISIT_PURPOSE_DISCIPLINES[visitPurpose].includes(d),
    );
    if (qualifying.length === 0) return false;

    // Seam-backed, resolved by `resolvePreScheduleSeamFacts` before this transaction opened.
    if (!seamFacts.credentialsActive) return false;

    const overlapRows = await tx
      .select({ id: TO.id })
      .from(TO)
      .where(
        and(
          eq(TO.membershipId, membershipId),
          eq(TO.approvalState, "approved" as TimeOffState),
          lte(TO.startsAt, new Date(endsAt)),
          gte(TO.endsAt, new Date(startsAt)),
        ),
      )
      .limit(1);
    if (overlapRows.length > 0) return false; // an approved PTO row overlaps the window

    if (await allowsUnassignedPoolTx(tx, orgId)) return true; // org opened the unassigned pool
    return seamFacts.inCaseload;
  }

  /** Insert a `proposed` visit then run the D8 gate + `publish` transition in the same tx (§2.2.1). Reused by
   * the manual create, proposal publish, and reschedule paths. Returns the published wire view. */
  async function insertAndPublish(
    tx: DbClient,
    orgId: string,
    userId: string,
    input: CreateVisitInput,
    lineage: { parentRecurringVisitId: string | null; parentProposalId: string | null },
    seamFacts: PreScheduleSeamFacts,
  ): Promise<VisitView> {
    const { providerEntityId, locationId } = await resolveSiting(tx, input.assignedMembershipId);
    const discipline = disciplineFor(input.visitPurpose);
    const timezone = await organizationTimezone(tx, orgId);
    const serviceDate = serviceDateOf(input.scheduledStartedAt, timezone);

    const [inserted] = await tx
      .insert(V)
      .values({
        organizationId: orgId,
        providerEntityId,
        locationId,
        patientId: input.patientId,
        admissionId: input.admissionId,
        patientAddressId: input.patientAddressId,
        externalFacilityId: input.externalFacilityId,
        assignedMembershipId: input.assignedMembershipId,
        assignedDisciplineAtAssignment: discipline,
        visitPurpose: input.visitPurpose,
        visitSetting: input.visitSetting,
        scheduledStartedAt: new Date(input.scheduledStartedAt),
        scheduledEndedAt: new Date(input.scheduledEndedAt),
        serviceDate,
        parentRecurringVisitId: lineage.parentRecurringVisitId,
        parentProposalId: lineage.parentProposalId,
        status: "proposed",
      })
      .returning({ id: V.id });
    if (!inserted) throw new Error("visit insert returned no row");
    const visitId = inserted.id;
    const sited = { id: visitId, providerEntityId, locationId };

    // §2.2.1 genesis — the `proposed` factory (history + audit + m17.visit.proposed).
    const genesis = planVisitProposed();
    await appendHistory(tx, orgId, sited, genesis, userId);
    await emit(tx, orgId, "m17.visit.proposed", "visit", visitId, {
      proposalId: lineage.parentProposalId ?? visitId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      source: lineage.parentProposalId ? "proposal_publish" : "manual_create",
      proposedForDate: serviceDate,
      proposedVisitPurpose: input.visitPurpose,
      proposedDiscipline: discipline,
    });

    // §2.2.1 publish — the D8 gate verdict feeds the machine (proposed → published), which fires the
    // caseload-contribution + visit-seeding stream. The D6 overlap EXCLUDE backstops this on the leaf.
    const gatePassed = await preScheduleGatePassed(
      tx,
      orgId,
      input.assignedMembershipId,
      input.visitPurpose,
      input.patientId,
      input.scheduledStartedAt,
      input.scheduledEndedAt,
      seamFacts,
    );
    const published = transitionVisit("proposed", { type: "publish", gatePassed });
    await tx
      .update(V)
      .set({ status: published.to, version: 1, updatedAt: new Date() })
      .where(eq(V.id, visitId));
    await appendHistory(tx, orgId, sited, published.effects, userId);
    await emit(tx, orgId, "m17.visit.assigned", "visit", visitId, {
      visitId,
      assignedMembershipId: input.assignedMembershipId,
      patientId: input.patientId,
      scheduledStartedAt: input.scheduledStartedAt,
      scheduledEndedAt: input.scheduledEndedAt,
    });
    await emit(tx, orgId, "m17.visit.published", "visit", visitId, {
      visitId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      assignedMembershipId: input.assignedMembershipId,
      assignedDiscipline: discipline,
      encounterType: encounterTypeFor(input.visitPurpose),
      serviceDate,
      organizationId: orgId,
      providerEntityId,
      locationId,
      visitPurpose: input.visitPurpose,
      visitSetting: input.visitSetting,
      scheduledStartedAt: input.scheduledStartedAt,
      scheduledEndedAt: input.scheduledEndedAt,
      patientAddressId: input.patientAddressId,
      externalFacilityId: input.externalFacilityId,
      parentRecurringVisitId: lineage.parentRecurringVisitId,
      parentProposalId: lineage.parentProposalId,
    });

    return toVisitView(
      {
        id: visitId,
        organizationId: orgId,
        patientId: input.patientId,
        admissionId: input.admissionId,
        assignedMembershipId: input.assignedMembershipId,
        visitPurpose: input.visitPurpose,
        visitSetting: input.visitSetting,
        scheduledStartedAt: new Date(input.scheduledStartedAt),
        scheduledEndedAt: new Date(input.scheduledEndedAt),
        status: published.to,
        patientAddressId: input.patientAddressId,
        externalFacilityId: input.externalFacilityId,
        rescheduledIntoVisitId: null,
      },
      timezone,
    );
  }

  async function publishedChildExists(
    orgId: string,
    parentRecurringVisitId: string,
    serviceDate: string,
  ): Promise<boolean> {
    return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
      const [existing] = await tx
        .select({ id: V.id })
        .from(V)
        .where(
          and(
            eq(V.organizationId, orgId),
            eq(V.parentRecurringVisitId, parentRecurringVisitId),
            eq(V.serviceDate, serviceDate),
          ),
        )
        .limit(1);
      return existing !== undefined;
    });
  }

  async function cancelFuturePublishedVisitsForAdmission(
    orgId: string,
    userId: string,
    admissionId: string,
    cutoff: Date,
    reason: string,
  ): Promise<number> {
    return withOrgContext(db, orgContextFor(orgId, userId), async (txRaw) => {
      const tx = txRaw as DbClient;
      const rows = await tx
        .select(VISIT_WRITE_COLS)
        .from(V)
        .where(
          and(
            eq(V.organizationId, orgId),
            eq(V.admissionId, admissionId),
            eq(V.status, "published"),
            gte(V.scheduledStartedAt, cutoff),
          ),
        );
      let cancelled = 0;
      for (const v of rows) {
        const transition = transitionVisit(v.status as VisitStatus, {
          type: "cancel",
          reason,
          cancelledByPresent: true,
        });
        await tx
          .update(V)
          .set({
            status: transition.to,
            cancelledByMembershipId: userId || null,
            cancelledAt: new Date(),
            cancellationReason: reason,
            cancellationReasonCode: "admission_lifecycle",
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, v.id));
        await appendHistory(
          tx,
          orgId,
          {
            id: v.id,
            providerEntityId: v.providerEntityId as string,
            locationId: v.locationId as string,
          },
          transition.effects,
          userId,
        );
        await emit(tx, orgId, "m17.visit.unassigned", "visit", v.id, {
          visitId: v.id,
          formerAssignedMembershipId: v.assignedMembershipId as string,
          patientId: v.patientId as string,
        });
        await emit(tx, orgId, "m17.visit.cancelled", "visit", v.id, {
          visitId: v.id,
          cancelledBy: userId,
          reason,
          reasonCode: "admission_lifecycle",
        });
        cancelled += 1;
      }
      return cancelled;
    });
  }

  const proposalDisciplines: readonly InterventionDiscipline[] = [
    "rn",
    "lpn",
    "chha",
    "msw",
    "chaplain",
    "md_np",
    "pt",
    "ot",
    "st",
    "volunteer",
    "music_therapy",
    "dietitian",
    "bereavement",
  ];

  function purposeForInterventionDiscipline(discipline: InterventionDiscipline): VisitPurpose {
    switch (discipline) {
      case "chha":
        return "aide_poc";
      case "msw":
        return "msw_followup";
      case "chaplain":
        return "chaplain_visit";
      case "volunteer":
        return "volunteer_visit";
      case "md_np":
        return "recert";
      default:
        return "routine_visit";
    }
  }

  const backend = {
    // ── outbox drain — the DB backend publishes transactionally; nothing is buffered ─────────────────────
    drainEvents() {
      return [];
    },

    // PARAM-004 follow-up — lets the route layer resolve `orgId`'s configured timezone BEFORE the D8
    // pre-schedule ABAC gate runs (`requireAbac`'s `getTarget` is synchronous, so it cannot do this DB
    // read itself; the route stashes the result on `request.context.attributes` in an earlier preHandler).
    async orgTimezone(orgId: string): Promise<string> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        organizationTimezone(tx, orgId),
      );
    },

    // ── visits (reads) ────────────────────────────────────────────────────────────────────────────────
    async listVisits(
      orgId: string,
      filters: {
        clinician?: string;
        patient?: string;
        from?: string;
        to?: string;
        status?: string;
      },
      scope?: VisitReadScope,
    ): Promise<VisitView[]> {
      // GAP-053 — narrow to the caller's caseload (plus own assignments) in SQL; an empty scope reads nothing.
      const patientIds = scope?.patientIds ?? null;
      const assignee = scope?.assignedMembershipId;
      if (scope && patientIds !== null && patientIds.length === 0 && !assignee) return [];
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (scope && patientIds !== null) {
          const ownership = [
            ...(patientIds.length ? [inArray(V.patientId, [...patientIds])] : []),
            ...(assignee ? [eq(V.assignedMembershipId, assignee)] : []),
          ];
          conds.push(or(...ownership) as SQL);
        }
        if (filters.clinician) conds.push(eq(V.assignedMembershipId, filters.clinician));
        if (filters.patient) conds.push(eq(V.patientId, filters.patient));
        if (filters.status) conds.push(eq(V.status, filters.status as VisitStatus));
        if (filters.from) conds.push(gte(V.scheduledStartedAt, new Date(filters.from)));
        if (filters.to) conds.push(lte(V.scheduledStartedAt, new Date(filters.to)));
        const rows = await tx
          .select(VISIT_COLS)
          .from(V)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(V.scheduledStartedAt)
          .limit(scope ? VISIT_LIST_LIMIT : UNSCOPED_LIMIT);
        const timezone = await organizationTimezone(tx, orgId);
        return rows.map((r) => toVisitView(r as VisitRow, timezone));
      });
    },

    async getVisit(orgId: string, visitId: string): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        if (!row) throw new NotFoundError("visit");
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    // ── visits (writes) ─────────────────────────────────────────────────────────────────────────────────
    async createVisit(orgId: string, userId: string, input: CreateVisitInput): Promise<VisitView> {
      // Seam facts first, with no transaction open (see `resolvePreScheduleSeamFacts`).
      const seamFacts = await resolvePreScheduleSeamFacts(
        orgId,
        input.assignedMembershipId,
        input.visitPurpose,
        input.patientId,
        input.scheduledStartedAt,
      );
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) =>
        insertAndPublish(
          tx as DbClient,
          orgId,
          userId,
          input,
          { parentRecurringVisitId: null, parentProposalId: null },
          seamFacts,
        ),
      );
    },

    async editVisit(
      orgId: string,
      userId: string,
      visitId: string,
      input: EditVisitInput,
    ): Promise<VisitView> {
      if (input.scheduledStartedAt !== undefined || input.scheduledEndedAt !== undefined) {
        throw new ValidationError(
          "scheduled start/end changes must use POST /api/v1/visits/:visitId/reschedule",
          [],
        );
      }
      // The gate's seam facts are keyed on the visit's own patient/purpose/times, so the row has to be
      // read before they can be resolved — and they must be resolved with NO transaction open. Hence a
      // short read tx here, then the seams, then the write tx below, which re-loads the visit
      // authoritatively and re-runs every non-seam check against it.
      const pre = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) =>
        preScheduleTargetOfVisit(txRaw as DbClient, visitId, {
          membershipId: input.assignedMembershipId,
          visitPurpose: input.visitPurpose,
          startsAt: input.scheduledStartedAt,
          endsAt: input.scheduledEndedAt,
        }),
      );
      const seamFacts = await resolvePreScheduleSeamFacts(
        orgId,
        pre.membershipId,
        pre.visitPurpose,
        pre.patientId,
        pre.startsAt,
      );
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const timezone = await organizationTimezone(tx, orgId);
        const reassigned =
          input.assignedMembershipId !== undefined || input.scheduledStartedAt !== undefined;
        const nextMembership = (input.assignedMembershipId ?? v.assignedMembershipId) as string;
        const nextStart = input.scheduledStartedAt ?? iso(v.scheduledStartedAt as Date);
        const nextEnd = input.scheduledEndedAt ?? iso(v.scheduledEndedAt as Date);
        if (reassigned) {
          const nextPurpose = (input.visitPurpose ?? v.visitPurpose) as VisitPurpose;
          const passed = await preScheduleGatePassed(
            tx,
            orgId,
            nextMembership,
            nextPurpose,
            v.patientId as string,
            nextStart,
            nextEnd,
            seamFacts,
          );
          if (!passed) throw new ForbiddenError("PRE_SCHEDULE_GATE_FAILED");
        }
        const set: Record<string, unknown> = {
          version: (v.version as number) + 1,
          updatedAt: new Date(),
        };
        if (input.scheduledStartedAt) {
          set.scheduledStartedAt = new Date(input.scheduledStartedAt);
          set.serviceDate = serviceDateOf(input.scheduledStartedAt, timezone);
        }
        if (input.scheduledEndedAt) set.scheduledEndedAt = new Date(input.scheduledEndedAt);
        if (input.assignedMembershipId) {
          set.assignedMembershipId = input.assignedMembershipId;
          set.assignedDisciplineAtAssignment = disciplineFor(
            (input.visitPurpose ?? v.visitPurpose) as VisitPurpose,
          );
        }
        if (input.visitPurpose) set.visitPurpose = input.visitPurpose;
        if (input.visitSetting) set.visitSetting = input.visitSetting;
        await tx.update(V).set(set).where(eq(V.id, visitId));
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, timezone);
      });
    },

    async startVisit(
      orgId: string,
      userId: string,
      visitId: string,
      evvMissingReason: string,
      stepUpSatisfied: boolean,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        assertAssignedClinician(v.assignedMembershipId as string, userId);
        const sited = {
          id: visitId,
          providerEntityId: v.providerEntityId as string,
          locationId: v.locationId as string,
        };
        const transition = transitionVisit(v.status as VisitStatus, {
          type: "start",
          // GAP-050 — the HTTP route is ALWAYS the self-attest path; `via:'evv'` belongs to the M18 consumers.
          source: { via: "self_attest", evvMissingReason, stepUpSatisfied },
        });
        const bracket = "evv_missing_documented";
        await tx
          .update(V)
          .set({
            status: transition.to,
            evvBracketState: bracket,
            evvMissingReason,
            actualStartedAt: new Date(),
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await appendHistory(tx, orgId, sited, transition.effects, userId);
        await emit(tx, orgId, "m17.visit.started", "visit", visitId, {
          visitId,
          startedAt: new Date().toISOString(),
          evvBracketState: bracket,
        });
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    async arriveVisit(
      orgId: string,
      userId: string,
      visitId: string,
      evvMissingReason: string,
      stepUpSatisfied: boolean,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        assertAssignedClinician(v.assignedMembershipId as string, userId);
        const sited = {
          id: visitId,
          providerEntityId: v.providerEntityId as string,
          locationId: v.locationId as string,
        };
        const transition = transitionVisit(v.status as VisitStatus, {
          type: "arrive",
          // GAP-050 — the HTTP route is ALWAYS the self-attest path; `via:'evv'` belongs to the M18 consumers.
          source: { via: "self_attest", evvMissingReason, stepUpSatisfied },
        });
        const bracket = "evv_missing_documented";
        await tx
          .update(V)
          .set({
            status: transition.to,
            evvBracketState: bracket,
            evvMissingReason,
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await appendHistory(tx, orgId, sited, transition.effects, userId);
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    async cancelVisit(
      orgId: string,
      userId: string,
      visitId: string,
      reason: string,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const sited = {
          id: visitId,
          providerEntityId: v.providerEntityId as string,
          locationId: v.locationId as string,
        };
        const transition = transitionVisit(v.status as VisitStatus, {
          type: "cancel",
          reason,
          cancelledByPresent: true,
        });
        await tx
          .update(V)
          .set({
            status: transition.to,
            cancelledByMembershipId: userId || null,
            cancelledAt: new Date(),
            cancellationReason: reason,
            cancellationReasonCode: "operational",
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await appendHistory(tx, orgId, sited, transition.effects, userId);
        await emit(tx, orgId, "m17.visit.unassigned", "visit", visitId, {
          visitId,
          formerAssignedMembershipId: v.assignedMembershipId as string,
          patientId: v.patientId as string,
        });
        await emit(tx, orgId, "m17.visit.cancelled", "visit", visitId, {
          visitId,
          cancelledBy: userId,
          reason,
          reasonCode: "operational",
        });
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    async rescheduleVisit(
      orgId: string,
      userId: string,
      visitId: string,
      input: RescheduleVisitInput,
    ): Promise<{ original: VisitView; created: VisitView }> {
      // The REPLACEMENT visit is what the gate judges: the original's patient/purpose, but the caller's
      // new membership and start. Resolved before the write tx opens (see `resolvePreScheduleSeamFacts`).
      const pre = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) =>
        preScheduleTargetOfVisit(txRaw as DbClient, visitId, {
          membershipId: input.newAssignedMembershipId,
          startsAt: input.newScheduledStartedAt,
        }),
      );
      const seamFacts = await resolvePreScheduleSeamFacts(
        orgId,
        pre.membershipId,
        pre.visitPurpose,
        pre.patientId,
        pre.startsAt,
      );
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const sited = {
          id: visitId,
          providerEntityId: v.providerEntityId as string,
          locationId: v.locationId as string,
        };
        const transition = transitionVisit(v.status as VisitStatus, {
          type: "reschedule",
          reason: input.reason,
        });
        // The new visit is inserted + published in the SAME tx (its own genesis + publish stream).
        const created = await insertAndPublish(
          tx,
          orgId,
          userId,
          {
            patientId: v.patientId as string,
            admissionId: v.admissionId as string,
            patientAddressId: v.patientAddressId as string | null,
            externalFacilityId: v.externalFacilityId as string | null,
            assignedMembershipId:
              input.newAssignedMembershipId ?? (v.assignedMembershipId as string),
            visitPurpose: v.visitPurpose as VisitPurpose,
            visitSetting: v.visitSetting as VisitSetting,
            scheduledStartedAt: input.newScheduledStartedAt,
            scheduledEndedAt: input.newScheduledEndedAt,
          },
          { parentRecurringVisitId: null, parentProposalId: null },
          seamFacts,
        );
        await tx
          .update(V)
          .set({
            status: transition.to,
            rescheduledIntoVisitId: created.id,
            rescheduleReason: input.reason,
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await appendHistory(tx, orgId, sited, transition.effects, userId);
        await emit(tx, orgId, "m17.visit.unassigned", "visit", visitId, {
          visitId,
          formerAssignedMembershipId: v.assignedMembershipId as string,
          patientId: v.patientId as string,
        });
        await emit(tx, orgId, "m17.visit.rescheduled", "visit", visitId, {
          visitId,
          rescheduledIntoVisitId: created.id,
          oldStartedAt: iso(v.scheduledStartedAt as Date),
          newStartedAt: input.newScheduledStartedAt,
          reason: input.reason,
        });
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return {
          original: toVisitView(row as VisitRow, await organizationTimezone(tx, orgId)),
          created,
        };
      });
    },

    async noShowVisit(
      orgId: string,
      userId: string,
      visitId: string,
      reason: string,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const sited = {
          id: visitId,
          providerEntityId: v.providerEntityId as string,
          locationId: v.locationId as string,
        };
        const transition = transitionVisit(v.status as VisitStatus, { type: "no_show", reason });
        await tx
          .update(V)
          .set({
            status: transition.to,
            noShowDetectedAt: new Date(),
            noShowReason: reason,
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await appendHistory(tx, orgId, sited, transition.effects, userId);
        await emit(tx, orgId, "m17.visit.unassigned", "visit", visitId, {
          visitId,
          formerAssignedMembershipId: v.assignedMembershipId as string,
          patientId: v.patientId as string,
        });
        await emit(tx, orgId, "m17.visit.no_show_detected", "visit", visitId, {
          visitId,
          patientId: v.patientId as string,
          clinicianMembershipId: v.assignedMembershipId as string,
          scheduledStartedAt: iso(v.scheduledStartedAt as Date),
          reason: reason ?? "",
        });
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    async reassignVisit(
      orgId: string,
      userId: string,
      visitId: string,
      newAssignedMembershipId: string,
    ): Promise<VisitView> {
      const pre = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) =>
        preScheduleTargetOfVisit(txRaw as DbClient, visitId, {
          membershipId: newAssignedMembershipId,
        }),
      );
      const seamFacts = await resolvePreScheduleSeamFacts(
        orgId,
        pre.membershipId,
        pre.visitPurpose,
        pre.patientId,
        pre.startsAt,
      );
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const passed = await preScheduleGatePassed(
          tx,
          orgId,
          newAssignedMembershipId,
          v.visitPurpose as VisitPurpose,
          v.patientId as string,
          iso(v.scheduledStartedAt as Date),
          iso(v.scheduledEndedAt as Date),
          seamFacts,
        );
        if (!passed) throw new ForbiddenError("PRE_SCHEDULE_GATE_FAILED");
        await tx
          .update(V)
          .set({
            assignedMembershipId: newAssignedMembershipId,
            assignedDisciplineAtAssignment: disciplineFor(v.visitPurpose as VisitPurpose),
            version: (v.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(V.id, visitId));
        await emit(tx, orgId, "m17.visit.assigned", "visit", visitId, {
          visitId,
          assignedMembershipId: newAssignedMembershipId,
          patientId: v.patientId as string,
          scheduledStartedAt: iso(v.scheduledStartedAt as Date),
          scheduledEndedAt: iso(v.scheduledEndedAt as Date),
        });
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        return toVisitView(row as VisitRow, await organizationTimezone(tx, orgId));
      });
    },

    // ── proposals ─────────────────────────────────────────────────────────────────────────────────────
    async listProposals(
      orgId: string,
      filters: { patient?: string },
      scope?: VisitReadScope,
    ): Promise<ProposalView[]> {
      const patientIds = scope?.patientIds ?? null;
      if (patientIds !== null && patientIds.length === 0) return [];
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (patientIds !== null) conds.push(inArray(VP.patientId, [...patientIds]));
        if (filters.patient) conds.push(eq(VP.patientId, filters.patient));
        const rows = await tx
          .select({
            id: VP.id,
            patientId: VP.patientId,
            admissionId: VP.admissionId,
            proposedVisitPurpose: VP.proposedVisitPurpose,
            proposedForDate: VP.proposedForDate,
            status: VP.status,
          })
          .from(VP)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(VP.proposedForDate)
          .limit(VISIT_LIST_LIMIT);
        return rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          admissionId: r.admissionId,
          proposedVisitPurpose: r.proposedVisitPurpose as VisitPurpose,
          proposedForDate: r.proposedForDate,
          status: r.status as ProposalView["status"],
        }));
      });
    },

    async publishProposal(orgId: string, userId: string, proposalId: string): Promise<VisitView> {
      // Same two-phase shape as the visit-keyed writes: read the proposal, resolve the seam facts with
      // no tx open, then do the whole publish in the write tx (which re-reads and re-validates `p`).
      const pre = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const [row] = await (txRaw as DbClient)
          .select()
          .from(VP)
          .where(eq(VP.id, proposalId))
          .limit(1);
        return row;
      });
      if (!pre) throw new NotFoundError("visit_proposal");
      const seamFacts = pre.suggestedMembershipId
        ? await resolvePreScheduleSeamFacts(
            orgId,
            pre.suggestedMembershipId,
            pre.proposedVisitPurpose as VisitPurpose,
            pre.patientId,
            `${pre.proposedForDate}T13:00:00.000Z`,
          )
        : { credentialsActive: false, inCaseload: false };
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [p] = await tx.select().from(VP).where(eq(VP.id, proposalId)).limit(1);
        if (!p) throw new NotFoundError("visit_proposal");
        if (p.status !== "pending") throw new ConflictError("proposal is not pending");
        // The proposal must carry a best-fit membership to publish (the scheduler may reassign later); the
        // manual create path is the alternative when there is no suggestion.
        if (!p.suggestedMembershipId) {
          throw new ValidationError(
            "the proposal has no suggested membership to assign the visit",
            [],
          );
        }
        const startedAt = `${p.proposedForDate}T13:00:00.000Z`;
        const visit = await insertAndPublish(
          tx,
          orgId,
          userId,
          {
            patientId: p.patientId,
            admissionId: p.admissionId,
            patientAddressId: null,
            externalFacilityId: null,
            assignedMembershipId: p.suggestedMembershipId,
            visitPurpose: p.proposedVisitPurpose as VisitPurpose,
            visitSetting: "patient_home",
            scheduledStartedAt: startedAt,
            scheduledEndedAt: `${p.proposedForDate}T14:00:00.000Z`,
          },
          { parentRecurringVisitId: null, parentProposalId: proposalId },
          seamFacts,
        );
        await tx
          .update(VP)
          .set({
            status: "published",
            publishedAsVisitId: visit.id,
            version: (p.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(VP.id, proposalId));
        return visit;
      });
    },

    async dismissProposal(
      orgId: string,
      userId: string,
      proposalId: string,
      reason: string,
    ): Promise<ProposalView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [p] = await tx.select().from(VP).where(eq(VP.id, proposalId)).limit(1);
        if (!p) throw new NotFoundError("visit_proposal");
        await tx
          .update(VP)
          .set({
            status: "dismissed",
            dismissedBy: userId || null,
            dismissalReason: reason,
            version: (p.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(VP.id, proposalId));
        return {
          id: p.id,
          patientId: p.patientId,
          admissionId: p.admissionId,
          proposedVisitPurpose: p.proposedVisitPurpose as VisitPurpose,
          proposedForDate: p.proposedForDate,
          status: "dismissed",
        };
      });
    },

    // ── recurring visits ──────────────────────────────────────────────────────────────────────────────
    async listRecurring(orgId: string, patientId: string): Promise<RecurringView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            id: RV.id,
            patientId: RV.patientId,
            assignedMembershipId: RV.assignedMembershipId,
            visitPurpose: RV.visitPurpose,
            rrule: RV.rrule,
            status: RV.status,
          })
          .from(RV)
          .where(eq(RV.patientId, patientId));
        return rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          assignedMembershipId: r.assignedMembershipId,
          visitPurpose: r.visitPurpose as VisitPurpose,
          rrule: r.rrule,
          status: r.status as RecurringView["status"],
        }));
      });
    },

    async createRecurring(
      orgId: string,
      userId: string,
      input: CreateRecurringInput,
    ): Promise<RecurringView> {
      assertRecurringPolicyValid(input);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const { providerEntityId, locationId } = await resolveSiting(
          tx,
          input.assignedMembershipId,
        );
        const [inserted] = await tx
          .insert(RV)
          .values({
            organizationId: orgId,
            providerEntityId,
            locationId,
            patientId: input.patientId,
            admissionId: input.admissionId,
            assignedMembershipId: input.assignedMembershipId,
            visitPurpose: input.visitPurpose,
            visitSetting: input.visitSetting,
            ...toRecurringPolicyColumns(input),
            status: "active",
          })
          .returning({ id: RV.id });
        if (!inserted) throw new Error("recurring_visit insert returned no row");
        return {
          id: inserted.id,
          patientId: input.patientId,
          assignedMembershipId: input.assignedMembershipId,
          visitPurpose: input.visitPurpose,
          rrule: input.rrule,
          status: "active",
        };
      });
    },

    async discontinueRecurring(orgId: string, userId: string, id: string): Promise<RecurringView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [r] = await tx.select().from(RV).where(eq(RV.id, id)).limit(1);
        if (!r) throw new NotFoundError("recurring_visit");
        if (r.status !== "active") throw new ConflictError("recurring policy is not active");
        const now = new Date();
        const children = await tx
          .select(VISIT_WRITE_COLS)
          .from(V)
          .where(
            and(
              eq(V.organizationId, orgId),
              eq(V.parentRecurringVisitId, id),
              eq(V.status, "published"),
              gt(V.scheduledStartedAt, now),
            ),
          );
        let cancelledChildCount = 0;
        const reason = "Recurring policy discontinued by scheduler.";
        for (const child of children) {
          const transition = transitionVisit(child.status as VisitStatus, {
            type: "cancel",
            reason,
            cancelledByPresent: true,
          });
          await tx
            .update(V)
            .set({
              status: transition.to,
              cancelledByMembershipId: userId || null,
              cancelledAt: now,
              cancellationReason: reason,
              cancellationReasonCode: "recurrence_discontinued",
              version: (child.version as number) + 1,
              updatedAt: now,
            })
            .where(eq(V.id, child.id));
          await appendHistory(
            tx,
            orgId,
            {
              id: child.id,
              providerEntityId: child.providerEntityId as string,
              locationId: child.locationId as string,
            },
            transition.effects,
            userId,
          );
          await emit(tx, orgId, "m17.visit.unassigned", "visit", child.id, {
            visitId: child.id,
            formerAssignedMembershipId: child.assignedMembershipId as string,
            patientId: child.patientId as string,
          });
          await emit(tx, orgId, "m17.visit.cancelled", "visit", child.id, {
            visitId: child.id,
            cancelledBy: userId,
            reason,
            reasonCode: "recurrence_discontinued",
          });
          cancelledChildCount += 1;
        }
        await tx
          .update(RV)
          .set({
            status: "discontinued",
            discontinuedAt: now,
            discontinuedBy: userId || null,
            version: (r.version as number) + 1,
            updatedAt: now,
          })
          .where(eq(RV.id, id));
        await emit(tx, orgId, "m17.recurring_visit.discontinued", "recurring_visit", id, {
          recurringVisitId: id,
          cancelledChildCount,
          discontinuedBy: userId,
        });
        return {
          id: r.id,
          patientId: r.patientId,
          assignedMembershipId: r.assignedMembershipId,
          visitPurpose: r.visitPurpose as VisitPurpose,
          rrule: r.rrule,
          status: "discontinued",
        };
      });
    },

    async materializeRecurringVisitsForOrg(
      orgId: string,
      userId: string,
      options: { now?: Date; horizonDays?: number } = {},
    ) {
      const now = options.now ?? new Date();
      const policies = await withOrgContext(db, orgContextFor(orgId, userId), async (tx) =>
        tx
          .select()
          .from(RV)
          .where(and(eq(RV.organizationId, orgId), eq(RV.status, "active"))),
      );
      let visitsCreated = 0;
      let occurrencesSkipped = 0;
      for (const policy of policies) {
        const windowStart = localDateInTimeZone(now, policy.timeZone);
        const occurrences = materializeRecurrence(
          {
            rule: ruleForPolicy(policy),
            startDate: policy.startDate,
            endDate: policy.endDate,
            timeOfDayStart: policy.timeOfDayStart,
            timeOfDayEnd: policy.timeOfDayEnd,
            timeZone: policy.timeZone,
          },
          windowStart,
          options.horizonDays ?? MATERIALIZE_HORIZON_DAYS,
        );
        for (const occurrence of occurrences) {
          if (await publishedChildExists(orgId, policy.id, occurrence.serviceDate)) {
            occurrencesSkipped += 1;
            continue;
          }
          const seamFacts = await resolvePreScheduleSeamFacts(
            orgId,
            policy.assignedMembershipId,
            policy.visitPurpose as VisitPurpose,
            policy.patientId,
            occurrence.scheduledStartedAt,
          );
          await withOrgContext(db, orgContextFor(orgId, userId), async (tx) => {
            await insertAndPublish(
              tx as DbClient,
              orgId,
              userId,
              {
                patientId: policy.patientId,
                admissionId: policy.admissionId,
                patientAddressId: policy.patientAddressId,
                externalFacilityId: policy.externalFacilityId,
                assignedMembershipId: policy.assignedMembershipId,
                visitPurpose: policy.visitPurpose as VisitPurpose,
                visitSetting: policy.visitSetting as VisitSetting,
                scheduledStartedAt: occurrence.scheduledStartedAt,
                scheduledEndedAt: occurrence.scheduledEndedAt,
              },
              { parentRecurringVisitId: policy.id, parentProposalId: null },
              seamFacts,
            );
          });
          visitsCreated += 1;
        }
      }
      return { policiesScanned: policies.length, visitsCreated, occurrencesSkipped };
    },

    async generateCarePlanVisitProposals(
      orgId: string,
      userId: string,
      input: {
        planId: string;
        versionId: string;
        patientId: string;
        admissionId: string;
        now?: Date;
      },
    ) {
      const now = input.now ?? new Date();
      // M6 owns `admission` — read its siting through M6's published AdmissionStatusReader seam (org-explicit,
      // self-scoped under RLS), never M6's schema (scripts/check-table-ownership.ts).
      const admission = await getSeam("AdmissionStatusReader").getAdmissionSiting(
        orgId,
        input.admissionId,
      );
      if (!admission?.providerEntityId || !admission.locationId) {
        throw new ValidationError("admission is not sited for care-plan visit proposals", []);
      }
      const admissionSiting = {
        providerEntityId: admission.providerEntityId,
        locationId: admission.locationId,
      };
      let created = 0;
      let skipped = 0;
      await runWithRequestContext({ organizationId: orgId, userId }, async () => {
        const reader = getSeam("CarePlanReader");
        for (const discipline of proposalDisciplines) {
          const elements = await reader.relevantElementsForEncounter(
            input.patientId,
            "routine_visit",
            discipline,
          );
          if (!elements || elements.planId !== input.planId) continue;
          for (const intervention of elements.interventions) {
            let planned: ReturnType<typeof planFrequencyProposals>;
            try {
              planned = planFrequencyProposals({
                organizationId: orgId,
                providerEntityId: admissionSiting.providerEntityId,
                locationId: admissionSiting.locationId,
                patientId: input.patientId,
                admissionId: input.admissionId,
                interventionId: intervention.interventionId,
                frequency: intervention.frequencyText,
                proposedVisitPurpose: purposeForInterventionDiscipline(discipline),
                proposedDiscipline: discipline,
                proposedDurationMinutes: 60,
                anchorDate: localDateInTimeZone(
                  admission.activatedAt
                    ? new Date(admission.activatedAt)
                    : admission.admissionAt
                      ? new Date(admission.admissionAt)
                      : now,
                  "UTC",
                ),
                windowStart: localDateInTimeZone(now, "UTC"),
                horizonDays: PROPOSE_HORIZON_DAYS,
              });
            } catch (err) {
              if (err instanceof SchedulingStateError && err.code === "FREQUENCY_UNPARSEABLE") {
                skipped += 1;
                continue;
              }
              throw err;
            }
            for (const p of planned) {
              const inserted = await withOrgContext(db, orgContextFor(orgId, userId), async (tx) =>
                tx
                  .insert(VP)
                  .values({
                    organizationId: orgId,
                    providerEntityId: p.providerEntityId,
                    locationId: p.locationId,
                    patientId: p.patientId,
                    admissionId: p.admissionId,
                    source: p.source,
                    sourcePayload: {
                      ...p.sourcePayload,
                      planId: input.planId,
                      versionId: input.versionId,
                    },
                    sourceIdempotencyKey: `${input.planId}:${input.versionId}:${p.sourceIdempotencyKey}`,
                    proposedForDate: p.proposedForDate,
                    proposedVisitPurpose: p.proposedVisitPurpose,
                    proposedDiscipline: p.proposedDiscipline,
                    proposedDurationMinutes: p.proposedDurationMinutes,
                    suggestedMembershipId: p.suggestedMembershipId,
                    status: "pending",
                  })
                  .onConflictDoNothing({
                    target: [VP.organizationId, VP.source, VP.sourceIdempotencyKey],
                  })
                  .returning({ id: VP.id, proposedForDate: VP.proposedForDate }),
              );
              const proposal = inserted[0];
              if (!proposal) {
                skipped += 1;
                continue;
              }
              await withOrgContext(db, orgContextFor(orgId, userId), async (tx) =>
                emit(tx, orgId, "m17.visit.proposed", "visit_proposal", proposal.id, {
                  proposalId: proposal.id,
                  patientId: input.patientId,
                  admissionId: input.admissionId,
                  source: "frequency_driven_m7",
                  proposedForDate: proposal.proposedForDate,
                  proposedVisitPurpose: p.proposedVisitPurpose,
                  proposedDiscipline: p.proposedDiscipline,
                }),
              );
              created += 1;
            }
          }
        }
      });
      return { proposalsCreated: created, proposalsSkipped: skipped };
    },

    async handleAdmissionHold(
      orgId: string,
      userId: string,
      input: { admissionId: string; heldAt: string; reason: string },
    ) {
      const reason = `Admission placed on hold: ${input.reason}`;
      const cancelledVisits = await cancelFuturePublishedVisitsForAdmission(
        orgId,
        userId,
        input.admissionId,
        new Date(input.heldAt),
        reason,
      );
      return { cancelledVisits };
    },

    async handleAdmissionResume() {
      return { recreatedVisits: 0 as const };
    },

    async handleAdmissionDischarge(
      orgId: string,
      userId: string,
      input: { admissionId: string; dischargeDate: string; reason: string },
    ) {
      const reason = `Admission discharged: ${input.reason}`;
      const cancelledVisits = await cancelFuturePublishedVisitsForAdmission(
        orgId,
        userId,
        input.admissionId,
        new Date(`${input.dischargeDate}T00:00:00.000Z`),
        reason,
      );
      return { cancelledVisits };
    },

    async scanVisitAttentionForOrg(orgId: string, userId: string, options: { now?: Date } = {}) {
      const now = options.now ?? new Date();
      return withOrgContext(db, orgContextFor(orgId, userId), async (txRaw) => {
        const tx = txRaw as DbClient;
        const staleCutoff = new Date(now.getTime() - 48 * 3_600_000);
        const possibleMissedCutoff = new Date(now.getTime() - 2 * 3_600_000);
        const renagCutoff = new Date(now.getTime() - STALE_VISIT_RENAG_HOURS * 3_600_000);
        // Idempotent per stale episode (mig 0360): flag a visit only for a new `actual_started_at` or after
        // the re-nag window, so the 15-minute sweep does not re-emit for the same stuck visit.
        const stale = await tx
          .select({ id: V.id, serviceDate: V.serviceDate, actualStartedAt: V.actualStartedAt })
          .from(V)
          .where(
            and(
              eq(V.organizationId, orgId),
              eq(V.status, "in_visit"),
              lt(V.actualStartedAt, staleCutoff),
              or(
                sql`${V.staleFlaggedStartedAt} IS DISTINCT FROM ${V.actualStartedAt}`,
                lt(V.staleFlaggedAt, renagCutoff),
              ),
            ),
          )
          .limit(STALE_VISIT_SCAN_LIMIT);
        for (const v of stale) {
          await emit(tx, orgId, "m17.stale_visit_detected", "visit", v.id, {
            visitId: v.id,
            stuckInState: "in_visit",
            hoursStuck: Math.floor(
              (now.getTime() - (v.actualStartedAt?.getTime() ?? now.getTime())) / 3_600_000,
            ),
          });
          await tx
            .update(V)
            .set({ staleFlaggedStartedAt: v.actualStartedAt, staleFlaggedAt: now })
            .where(and(eq(V.id, v.id), eq(V.serviceDate, v.serviceDate)));
        }
        const possibleMissed = await tx
          .select({ id: V.id })
          .from(V)
          .where(
            and(
              eq(V.organizationId, orgId),
              eq(V.status, "published"),
              lt(V.scheduledEndedAt, possibleMissedCutoff),
            ),
          );
        return { staleVisits: stale.length, possibleMissedVisits: possibleMissed.length };
      });
    },

    async scanTimeOffReassignmentsForOrg(
      orgId: string,
      userId: string,
      options: { now?: Date } = {},
    ) {
      const now = options.now ?? new Date();
      return withOrgContext(db, orgContextFor(orgId, userId), (tx) =>
        sweepApprovedTimeOffReassignments(tx as DbClient, orgId, emit, now),
      );
    },

    async emitCaregiverRemindersForOrg(
      orgId: string,
      userId: string,
      options: { now?: Date } = {},
    ) {
      const now = options.now ?? new Date();
      return withOrgContext(db, orgContextFor(orgId, userId), async (tx) => ({
        remindersEmitted: await emitDueCaregiverReminders(tx as DbClient, orgId, emit, now),
      }));
    },

    // ── availability ──────────────────────────────────────────────────────────────────────────────────
    async getAvailability(orgId: string, membershipId: string): Promise<AvailabilityView | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ dayOfWeek: CA.dayOfWeek, startTime: CA.startTime, endTime: CA.endTime })
          .from(CA)
          .where(eq(CA.membershipId, membershipId))
          .orderBy(CA.dayOfWeek);
        if (rows.length === 0) return null;
        return {
          membershipId,
          // `clinician_availability` carries no time_zone column; reads report UTC (the write path echoes the
          // request tz). Persisting tz lands with the availability-editor screen.
          timeZone: "UTC",
          slots: rows.map((r) => ({
            weekday: r.dayOfWeek,
            startTime: r.startTime,
            endTime: r.endTime,
          })),
        };
      });
    },

    async upsertAvailability(
      orgId: string,
      userId: string,
      membershipId: string,
      input: UpsertAvailabilityInput,
      authority: CallerAuthority,
    ): Promise<AvailabilityView> {
      assertMayEditAvailability(userId, membershipId, authority);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        // Merge per (membership, day_of_week): UPDATE the existing row, else INSERT. No DELETE grant → a
        // weekday dropped from the new set is not pruned (compromise #6).
        const existing = await tx
          .select({ id: CA.id, dayOfWeek: CA.dayOfWeek })
          .from(CA)
          .where(eq(CA.membershipId, membershipId));
        const byDay = new Map(existing.map((e) => [e.dayOfWeek, e.id]));
        for (const slot of input.slots) {
          const hit = byDay.get(slot.weekday);
          if (hit) {
            await tx
              .update(CA)
              .set({ startTime: slot.startTime, endTime: slot.endTime, updatedAt: new Date() })
              .where(eq(CA.id, hit));
          } else {
            await tx.insert(CA).values({
              organizationId: orgId,
              membershipId,
              dayOfWeek: slot.weekday,
              startTime: slot.startTime,
              endTime: slot.endTime,
            });
          }
        }
        return { membershipId, timeZone: input.timeZone, slots: input.slots };
      });
    },

    // ── time off ──────────────────────────────────────────────────────────────────────────────────────
    async listTimeOff(
      orgId: string,
      userId: string,
      filtersIn: { membership?: string; state?: string },
      authority: CallerAuthority,
    ): Promise<TimeOffView[]> {
      const filters = {
        ...filtersIn,
        membership: resolveTimeOffListScope(userId, filtersIn.membership, authority),
      };
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (filters.membership) conds.push(eq(TO.membershipId, filters.membership));
        if (filters.state) conds.push(eq(TO.approvalState, filters.state as TimeOffState));
        const rows = await tx
          .select({
            id: TO.id,
            membershipId: TO.membershipId,
            kind: TO.kind,
            startsAt: TO.startsAt,
            endsAt: TO.endsAt,
            state: TO.approvalState,
          })
          .from(TO)
          .where(conds.length ? and(...conds) : undefined);
        return rows.map((r) => ({
          id: r.id,
          membershipId: r.membershipId,
          kind: r.kind as TimeOffKind,
          startsAt: iso(r.startsAt),
          endsAt: iso(r.endsAt),
          state: r.state as TimeOffState,
        }));
      });
    },

    async requestTimeOff(
      orgId: string,
      userId: string,
      input: RequestTimeOffInput,
      authority: CallerAuthority,
    ): Promise<TimeOffView> {
      assertMayRequestTimeOff(userId, input.membershipId, authority);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const conflictingVisitCount = await countPublishedVisitsInWindow(
          tx,
          orgId,
          {
            membershipId: input.membershipId,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
          },
          new Date(),
        );
        const [inserted] = await tx
          .insert(TO)
          .values({
            organizationId: orgId,
            membershipId: input.membershipId,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            kind: input.kind,
            approvalState: "requested",
          })
          .returning({ id: TO.id });
        if (!inserted) throw new Error("time_off insert returned no row");
        await emit(tx, orgId, "m17.time_off.requested", "time_off", inserted.id, {
          timeOffId: inserted.id,
          membershipId: input.membershipId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          kind: input.kind,
          conflictingVisitCount,
        });
        return {
          id: inserted.id,
          membershipId: input.membershipId,
          kind: input.kind,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          state: "requested",
        };
      });
    },

    async approveTimeOff(
      orgId: string,
      userId: string,
      id: string,
      authority: CallerAuthority,
    ): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
        assertMayDecideTimeOff(userId, t.membershipId, authority);
        const now = new Date();
        const pto = { id, membershipId: t.membershipId, startsAt: t.startsAt, endsAt: t.endsAt };
        const affectedPublishedVisitCount = await countPublishedVisitsInWindow(tx, orgId, pto, now);
        const transition = transitionTimeOff(t.approvalState as TimeOffState, {
          type: "approve",
          approverPresent: true,
          conflictingVisitCount: affectedPublishedVisitCount,
        });
        await tx
          .update(TO)
          .set({
            approvalState: "approved",
            approvedByMembershipId: userId || null,
            approvedAt: new Date(),
            version: (t.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(TO.id, id));
        // §2.4 `trigger_reassignment_scan` — the machine's effect, interpreted here in the approving tx
        // (bounded; the cron backstop picks up any remainder and later-published visits).
        if (transition.effects.some((e) => e.kind === "trigger_reassignment_scan")) {
          await flagReassignmentsForTimeOff(tx, orgId, emit, pto, now);
        }
        await emit(tx, orgId, "m17.time_off.approved", "time_off", id, {
          timeOffId: id,
          membershipId: t.membershipId,
          approvedBy: userId,
          affectedPublishedVisitCount,
        });
        return toTimeOffView(t, "approved");
      });
    },

    async denyTimeOff(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
      authority: CallerAuthority,
    ): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
        assertMayDecideTimeOff(userId, t.membershipId, authority);
        transitionTimeOff(t.approvalState as TimeOffState, { type: "deny", reason });
        await tx
          .update(TO)
          .set({
            approvalState: "denied",
            deniedByMembershipId: userId || null,
            deniedAt: new Date(),
            denialReason: reason,
            version: (t.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(TO.id, id));
        await emit(tx, orgId, "m17.time_off.denied", "time_off", id, {
          timeOffId: id,
          deniedBy: userId,
          reason,
        });
        return toTimeOffView(t, "denied");
      });
    },

    async cancelTimeOff(
      orgId: string,
      userId: string,
      id: string,
      authority: CallerAuthority,
    ): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
        assertMayCancelTimeOff(userId, t.membershipId, authority);
        transitionTimeOff(t.approvalState as TimeOffState, {
          type: "cancel",
          windowStarted: new Date(t.startsAt) <= new Date(),
        });
        await tx
          .update(TO)
          .set({
            approvalState: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: userId || null,
            version: (t.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(TO.id, id));
        return toTimeOffView(t, "cancelled");
      });
    },

    // ── derived views (compose over the real visit read) ─────────────────────────────────────────────────
    async dayView(
      orgId: string,
      membershipId: string | undefined,
      date: string,
      scope?: VisitReadScope,
    ) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId }, scope)).filter(
        (v) => v.serviceDate === date,
      );
      return { date, membershipId: membershipId ?? null, visits };
    },

    async weekView(
      orgId: string,
      membershipId: string | undefined,
      weekStart: string,
      scope?: VisitReadScope,
    ) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId }, scope)).filter(
        (v) => v.serviceDate >= weekStart,
      );
      return { weekStart, membershipId: membershipId ?? null, visits };
    },

    async mapView(orgId: string, membershipId: string, date: string, scope?: VisitReadScope) {
      const stops = (await backend.listVisits(orgId, { clinician: membershipId }, scope)).filter(
        (v) => v.serviceDate === date,
      );
      return { membershipId, date, stops };
    },

    async portalUpcoming(orgId: string, patientId: string, withinHours: number) {
      const cutoff = new Date(Date.now() + withinHours * 3_600_000).toISOString();
      const visits = await backend.listVisits(orgId, { patient: patientId, status: "published" });
      return visits
        .filter((v) => v.scheduledStartedAt <= cutoff)
        .map((v) => ({
          visitId: v.id,
          scheduledStartedAt: v.scheduledStartedAt,
          scheduledEndedAt: v.scheduledEndedAt,
          visitPurposeLabel: "Scheduled visit", // §4.3 — lay-language, never the raw enum; notes scrubbed
          visitSetting: v.visitSetting,
        }));
    },

    async visitMetrics(orgId: string, window: { from: string; to: string }) {
      // GAP-131 — real rates over the requested window (was a hard-coded on-time rate of 1 and an ignored window).
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) =>
        (txRaw as DbClient)
          .select({
            scheduledStartedAt: V.scheduledStartedAt,
            actualStartedAt: V.actualStartedAt,
            status: V.status,
          })
          .from(V)
          .where(
            and(
              eq(V.organizationId, orgId),
              gte(V.scheduledStartedAt, new Date(window.from)),
              lt(V.scheduledStartedAt, new Date(window.to)),
            ),
          ),
      );
      return computeVisitMetrics(
        rows.map((r) => ({
          scheduledStartedAt: iso(r.scheduledStartedAt),
          actualStartedAt: r.actualStartedAt ? iso(r.actualStartedAt) : null,
          status: r.status as string,
        })),
        window,
      );
    },

    routeEfficiencyMetrics(_orgId: string, _membershipId: string) {
      // GAP-131 — route optimisation is OFF (Phase 1), so there is no proposed-mileage or override data to
      // aggregate. A fabricated zero would read as a real measurement; refuse instead.
      throw new ChartWardenError(
        "NOT_IMPLEMENTED",
        "route-efficiency metrics are unavailable until route optimisation is enabled",
        501,
      );
    },

    /** §7.9 — route optimisation is OFF (Phase 1); emit the degraded event, return the degraded result. */
    async optimizeDay(orgId: string, _userId: string, input: OptimizeDayInput) {
      const stops = await backend.dayView(orgId, input.membershipId, input.serviceDate);
      await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) =>
        emit(tx, orgId, "m17.route_optimization_degraded", "route", input.membershipId, {
          membershipId: input.membershipId,
          serviceDate: input.serviceDate,
          reason: "optimization_disabled",
        }),
      );
      return {
        membershipId: input.membershipId,
        serviceDate: input.serviceDate,
        degraded: true,
        reason: "optimization_disabled",
        segmentCount: Math.max(0, stops.visits.length - 1),
      };
    },

    // ── SchedulingAbacResolver (§4.7) — cross-module facts fail closed (compromise #3) ───────────────────
    // GAP-030 — resolveDiscipline / allowsUnassignedPool / isInCaseload now read real data (the M30
    // loadMemberRoleKeys / GAP-021 precedent + the M5 CaseloadProvider seam).
    // GAP-093 — credentialsActiveForPurpose now reads real data too (the new M17 CredentialReader seam
    // over `membership_credential`), reusing the SAME `credentialActive`/`resolveDisciplinesTx`
    // resolvers `preScheduleGatePassed` uses so the two layers can't drift (the GAP-031 pattern).
    // Both seam-backed predicates CLOSE their transaction before calling the seam (code review
    // 2026-08-14) — the seam takes its own pooled connection, and holding ours while it does is the
    // M36 `syncCareTeamChannel` deadlock.
    // GAP-031 — these now delegate to the SAME resolvers `preScheduleGatePassed` uses (defined
    // above, near `appendHistory`), each wrapped in its own `withOrgContext` since these are called
    // standalone from the route-layer ABAC predicates (`abac-predicates.ts`), never nested inside an
    // existing tx — that's the opposite call shape from the service-layer gate, hence the two wrappers.
    async resolveDisciplines(orgId: string, membershipId: string): Promise<SchedulingDiscipline[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        resolveDisciplinesTx(tx, orgId, membershipId),
      );
    },
    async credentialsActiveForPurpose(
      orgId: string,
      membershipId: string,
      visitPurpose: VisitPurpose,
      serviceDate: string,
    ): Promise<boolean> {
      // The seam call is deliberately OUTSIDE the transaction: `CredentialReader`'s store opens its own
      // `withOrgContext` on this same pooled handle, so calling it from in here held two connections at
      // once. See `credentialActive`'s note — this is the M36 `syncCareTeamChannel` deadlock shape.
      const qualifying = await withOrgContext(
        db,
        { organizationId: orgId, userId: "" },
        async (tx) =>
          (await resolveDisciplinesTx(tx, orgId, membershipId)).filter((d) =>
            VISIT_PURPOSE_DISCIPLINES[visitPurpose].includes(d),
          ),
      );
      return credentialActive(orgId, membershipId, qualifying, serviceDate);
    },
    async hasApprovedTimeOffOverlap(
      orgId: string,
      membershipId: string,
      startsAt: string,
      endsAt: string,
    ): Promise<boolean> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ id: TO.id })
          .from(TO)
          .where(
            and(
              eq(TO.membershipId, membershipId),
              eq(TO.approvalState, "approved" as TimeOffState),
              lte(TO.startsAt, new Date(endsAt)),
              gte(TO.endsAt, new Date(startsAt)),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
    async allowsUnassignedPool(orgId: string): Promise<boolean> {
      // `organization` carries RLS (`id = current_setting('app.org_id')::uuid`) — unlike
      // `organizationTimezone()` (safe only because `resolveOrgTimezone` always runs FIRST in the
      // preHandler chain, before any withOrgContext call sets `app.org_id`), this predicate runs
      // AFTER resolveDiscipline/hasApprovedTimeOffOverlap, so a bare (unwrapped) read here inherits
      // whatever the session GUC was left as and 500s (`''::uuid` cast failure) instead of denying.
      return withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        allowsUnassignedPoolTx(tx, orgId),
      );
    },
    async isInCaseload(orgId: string, membershipId: string, patientId: string): Promise<boolean> {
      // Same split as `credentialsActiveForPurpose`: resolve the membership's user id inside the tx,
      // then close it before asking M5's seam (which opens its own).
      const userId = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        membershipUserIdTx(tx, orgId, membershipId),
      );
      return inCaseload(orgId, userId, patientId);
    },

    /** UI projection of the create gate. It deliberately calls the same seam helpers as the write
     * paths; this is a convenience/read model, never an authorization bypass. */
    async eligibleClinicians(
      orgId: string,
      input: {
        patientId: string;
        visitPurpose: VisitPurpose;
        scheduledStartedAt: string;
        scheduledEndedAt: string;
      },
    ): Promise<EligibleClinicianView[]> {
      const candidates = await withOrgContext(
        db,
        { organizationId: orgId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          return tx
            .select({ membershipId: MEM.id, displayName: USER.name })
            .from(MEM)
            .innerJoin(USER, eq(USER.id, MEM.userId))
            .where(and(eq(MEM.organizationId, orgId), eq(MEM.status, "active")));
        },
      );
      return Promise.all(
        candidates.map(async (candidate) => {
          const facts = await resolvePreScheduleSeamFacts(
            orgId,
            candidate.membershipId,
            input.visitPurpose,
            input.patientId,
            input.scheduledStartedAt,
          );
          const { disciplines, pto, pool } = await withOrgContext(
            db,
            { organizationId: orgId, userId: "" },
            async (txRaw) => {
              const tx = txRaw as DbClient;
              const disciplines = await resolveDisciplinesTx(tx, orgId, candidate.membershipId);
              const [pto] = await tx
                .select({ id: TO.id })
                .from(TO)
                .where(
                  and(
                    eq(TO.membershipId, candidate.membershipId),
                    eq(TO.approvalState, "approved" as TimeOffState),
                    lte(TO.startsAt, new Date(input.scheduledEndedAt)),
                    gte(TO.endsAt, new Date(input.scheduledStartedAt)),
                  ),
                )
                .limit(1);
              return {
                disciplines,
                pto: Boolean(pto),
                pool: await allowsUnassignedPoolTx(tx, orgId),
              };
            },
          );
          const qualifying = disciplines.filter((discipline) =>
            VISIT_PURPOSE_DISCIPLINES[input.visitPurpose].includes(discipline),
          );
          const reasonCodes: string[] = [];
          if (!qualifying.length) reasonCodes.push("CLINICIAN_DISCIPLINE_NOT_ALLOWED");
          else if (!facts.credentialsActive) reasonCodes.push("CLINICIAN_CREDENTIAL_MISSING");
          if (pto) reasonCodes.push("CLINICIAN_ON_PTO");
          if (!pool && !facts.inCaseload) reasonCodes.push("CLINICIAN_NOT_IN_CASELOAD");
          return {
            membershipId: candidate.membershipId,
            displayName: candidate.displayName ?? "Clinician",
            disciplines,
            eligible: reasonCodes.length === 0,
            reasonCodes,
          };
        }),
      );
    },

    /** Scheduling-safe staff directory.  It intentionally exposes only the
     * values needed to render an assigned clinician; membership management
     * permissions are neither required nor implied by this projection. */
    async schedulingStaff(orgId: string): Promise<SchedulingStaffView[]> {
      const candidates = await withOrgContext(
        db,
        { organizationId: orgId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          return tx
            .select({
              membershipId: MEM.id,
              displayName: USER.name,
              roleKey: ROLE.key,
            })
            .from(MEM)
            .innerJoin(USER, eq(USER.id, MEM.userId))
            .leftJoin(
              MEM_ROLE,
              and(
                eq(MEM_ROLE.organizationId, orgId),
                eq(MEM_ROLE.membershipId, MEM.id),
                or(isNull(MEM_ROLE.expiresAt), gt(MEM_ROLE.expiresAt, new Date())),
              ),
            )
            .leftJoin(ROLE, eq(MEM_ROLE.roleId, ROLE.id))
            .where(and(eq(MEM.organizationId, orgId), eq(MEM.status, "active")));
        },
      );
      const byMembership = new Map<string, SchedulingStaffView>();
      for (const candidate of candidates) {
        const discipline = ALL_SCHEDULING_DISCIPLINES.has(candidate.roleKey ?? "")
          ? (candidate.roleKey as SchedulingDiscipline)
          : null;
        const current = byMembership.get(candidate.membershipId);
        if (!current || (current.discipline === null && discipline !== null)) {
          byMembership.set(candidate.membershipId, {
            membershipId: candidate.membershipId,
            displayName: candidate.displayName ?? "Clinician",
            discipline,
          });
        }
      }
      return [...byMembership.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    // ── GAP-093 — membership_credential grant/revoke/list (the management surface a real D8 gate
    // needs, or `clinician_credentials_active` would deny every caller forever for lack of any way to
    // ever satisfy it — the same regression GAP-030 fixed, one layer down) ─────────────────────────────
    async listCredentials(
      orgId: string,
      membershipId: string,
    ): Promise<readonly CredentialRecord[]> {
      return credentialStore.listForMembership(orgId, membershipId);
    },
    // ── GAP-029 — on-call rotation management (the source behind tonightsOnCallRoster) ──────────────────
    async listOnCallRotation(orgId: string, options: { includeCancelled?: boolean } = {}) {
      return onCallRotationStore.list(orgId, options);
    },
    async createOnCallRotationEntry(
      orgId: string,
      actorMembershipId: string,
      input: CreateOnCallRotationInput,
    ) {
      return onCallRotationStore.create(orgId, actorMembershipId, input);
    },
    async cancelOnCallRotationEntry(orgId: string, actorMembershipId: string, entryId: string) {
      return onCallRotationStore.cancel(orgId, actorMembershipId, entryId);
    },
    async grantCredential(
      orgId: string,
      grantedByMembershipId: string,
      input: {
        membershipId: string;
        credentialType: CredentialRecord["credentialType"];
        effectiveAt: string;
        expiresAt?: string | null;
        issuingBody?: string | null;
      },
    ): Promise<CredentialRecord> {
      return credentialStore.grant(orgId, { ...input, grantedByMembershipId });
    },
    async revokeCredential(
      orgId: string,
      revokedByMembershipId: string,
      credentialId: string,
      revokedReason: string,
    ): Promise<void> {
      return credentialStore.revoke(orgId, { credentialId, revokedReason, revokedByMembershipId });
    },
  };

  return backend as unknown as SchedulingRouteService & SchedulingAutomationService;
}

/** Project a stored time_off row + its new state into the wire view. */
function toTimeOffView(t: typeof schema.timeOff.$inferSelect, state: TimeOffState): TimeOffView {
  return {
    id: t.id,
    membershipId: t.membershipId,
    kind: t.kind as TimeOffKind,
    startsAt: iso(t.startsAt),
    endsAt: iso(t.endsAt),
    state,
  };
}
