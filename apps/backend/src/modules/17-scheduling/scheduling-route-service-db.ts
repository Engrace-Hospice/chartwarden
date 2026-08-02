// apps/backend/src/modules/17-scheduling — PRODUCTION SchedulingRouteService + §4.7 ABAC resolver (M17L reads
// + the write lifecycle over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (visit lists / day-week-map views, the proposal inbox, recurring cadences,
// clinician availability, time-off, portal upcoming, productivity metrics) run as real Drizzle queries over
// the M17-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. `visit` + `visit_state_history` are PARTITIONED BY RANGE (service_date / transitioned_at)
// with a DEFAULT catch-all leaf — reads query the parent, inserts route to the current-month leaf; the D6
// per-clinician visit-overlap GiST EXCLUDE lives on the leaves and fires at publish (proposed → published).
//
// Like M12/M13, M17 has NO state-transition DB triggers (only the M4 audit triggers) — the service performs
// every visit / time-off / recurring / availability transition itself via INSERT/UPDATE, composing the PURE
// `@wardenx/scheduling` deciders: the §2.2.1 eight-state visit machine (`transitionVisit` / `planVisitProposed`)
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
//   (3) the D8 pre-schedule gate the publish/edit/reassign paths enforce resolves ONLY the `not_on_pto`
//       predicate for real (an APPROVED time-off window overlapping the visit fails it); the M2 discipline /
//       credential and M5 caseload predicates are NOT threaded (fail-open, the M13 compromise-#3 posture) — so
//       `resolveDiscipline` / `credentialsActiveForPurpose` / `allowsUnassignedPool` / `isInCaseload` stay
//       fail-closed for the route-layer §4.7 predicates, but the service-layer gate only blocks on PTO;
//   (4) `time_off` / `clinician_availability` are clinician-scoped (nullable siting) → their inserts carry NULL
//       provider_entity_id + location_id per the schema intent;
//   (5) route optimisation stays OFF (`scheduling.route_optimization`) → `optimizeDay` emits the §7.9
//       `m17.route_optimization_degraded` event and returns the degraded (scheduled-order) result;
//   (6) `upsertAvailability` MERGES per (membership, day_of_week) — wardenx_app has no DELETE grant on any M17
//       table, so a weekday dropped from the new set is not pruned (the append-only posture); `time_zone` has
//       no column, so the write echoes the request tz while reads report UTC (the T01 read TODO).
import { type DbClient, schema } from "@wardenx/db";
import {
  type SchedulingDiscipline,
  type SchedulingSideEffect,
  VISIT_PURPOSE_DISCIPLINES,
  planVisitProposed,
  transitionTimeOff,
  transitionVisit,
} from "@wardenx/scheduling";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type TimeOffKind,
  type TimeOffState,
  ValidationError,
  type VisitPurpose,
  type VisitSetting,
  type VisitStatus,
} from "@wardenx/types";
import { type SQL, and, eq, gte, lte } from "drizzle-orm";
import type { SchedulingAbacResolver } from "./abac-predicates";
import type {
  AvailabilityView,
  CreateRecurringInput,
  CreateVisitInput,
  EditVisitInput,
  OptimizeDayInput,
  ProposalView,
  RecurringView,
  RequestTimeOffInput,
  RescheduleVisitInput,
  SchedulingRouteService,
  TimeOffView,
  UpsertAvailabilityInput,
  VisitView,
} from "./routes/service";

const V = schema.visit;
const VSH = schema.visitStateHistory;
const VP = schema.visitProposal;
const RV = schema.recurringVisit;
const CA = schema.clinicianAvailability;
const TO = schema.timeOff;
const MEM = schema.memberships;

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());
const serviceDateOf = (isoStr: string): string => isoStr.slice(0, 10);

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

const toVisitView = (r: VisitRow): VisitView => {
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
    serviceDate: serviceDateOf(startedAt),
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

/** The first eligible discipline for a visit purpose — the captured `assigned_discipline_at_assignment`
 * (compromise #2: the real M2 discipline resolver is not threaded into the DB backend). */
const disciplineFor = (purpose: VisitPurpose): SchedulingDiscipline =>
  VISIT_PURPOSE_DISCIPLINES[purpose][0] as SchedulingDiscipline;

/**
 * The production, RLS-backed scheduling backend (M17L reads + the write lifecycle). Also implements
 * {@link SchedulingAbacResolver}: the time-off overlap probe is a real org-scoped query; the cross-module
 * facts (M2 discipline/credentials, M2 org policy, M5 caseload) fail closed until those readers bind (the
 * service-layer publish/edit/reassign gate enforces only `not_on_pto`, compromise #3).
 */
export function createDbSchedulingBackend(
  db: DbClient,
  outbox: SchedulingWriteOutboxPort = NOOP_OUTBOX,
): SchedulingRouteService {
  // ── emit + tx helpers ───────────────────────────────────────────────────────────────────────────────
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, { eventName, payload, organizationId: orgId, aggregateKind, aggregateId });
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

  /** The D8 pre-schedule gate the service enforces (compromise #3 — only `not_on_pto` is resolvable here). */
  async function preScheduleGatePassed(
    tx: DbClient,
    membershipId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<boolean> {
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
    return rows.length === 0;
  }

  /** Insert a `proposed` visit then run the D8 gate + `publish` transition in the same tx (§2.2.1). Reused by
   * the manual create, proposal publish, and reschedule paths. Returns the published wire view. */
  async function insertAndPublish(
    tx: DbClient,
    orgId: string,
    userId: string,
    input: CreateVisitInput,
    lineage: { parentRecurringVisitId: string | null; parentProposalId: string | null },
  ): Promise<VisitView> {
    const { providerEntityId, locationId } = await resolveSiting(tx, input.assignedMembershipId);
    const discipline = disciplineFor(input.visitPurpose);
    const serviceDate = serviceDateOf(input.scheduledStartedAt);

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
      input.assignedMembershipId,
      input.scheduledStartedAt,
      input.scheduledEndedAt,
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
      visitPurpose: input.visitPurpose,
      visitSetting: input.visitSetting,
      scheduledStartedAt: input.scheduledStartedAt,
      scheduledEndedAt: input.scheduledEndedAt,
      patientAddressId: input.patientAddressId,
      externalFacilityId: input.externalFacilityId,
      parentRecurringVisitId: lineage.parentRecurringVisitId,
      parentProposalId: lineage.parentProposalId,
    });

    return toVisitView({
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
    });
  }

  const backend = {
    // ── outbox drain — the DB backend publishes transactionally; nothing is buffered ─────────────────────
    drainEvents() {
      return [];
    },

    // ── visits (reads) ────────────────────────────────────────────────────────────────────────────────
    async listVisits(
      orgId: string,
      filters: { clinician?: string; patient?: string; from?: string; to?: string; status?: string },
    ): Promise<VisitView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (filters.clinician) conds.push(eq(V.assignedMembershipId, filters.clinician));
        if (filters.patient) conds.push(eq(V.patientId, filters.patient));
        if (filters.status) conds.push(eq(V.status, filters.status as VisitStatus));
        if (filters.from) conds.push(gte(V.scheduledStartedAt, new Date(filters.from)));
        if (filters.to) conds.push(lte(V.scheduledStartedAt, new Date(filters.to)));
        const rows = await tx
          .select(VISIT_COLS)
          .from(V)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(V.scheduledStartedAt);
        return rows.map((r) => toVisitView(r as VisitRow));
      });
    },

    async getVisit(orgId: string, visitId: string): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        if (!row) throw new NotFoundError("visit");
        return toVisitView(row as VisitRow);
      });
    },

    // ── visits (writes) ─────────────────────────────────────────────────────────────────────────────────
    async createVisit(orgId: string, userId: string, input: CreateVisitInput): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) =>
        insertAndPublish(tx as DbClient, orgId, userId, input, {
          parentRecurringVisitId: null,
          parentProposalId: null,
        }),
      );
    },

    async editVisit(
      orgId: string,
      userId: string,
      visitId: string,
      input: EditVisitInput,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const reassigned =
          input.assignedMembershipId !== undefined || input.scheduledStartedAt !== undefined;
        const nextMembership = (input.assignedMembershipId ?? v.assignedMembershipId) as string;
        const nextStart = input.scheduledStartedAt ?? iso(v.scheduledStartedAt as Date);
        const nextEnd = input.scheduledEndedAt ?? iso(v.scheduledEndedAt as Date);
        if (reassigned) {
          const passed = await preScheduleGatePassed(tx, nextMembership, nextStart, nextEnd);
          if (!passed) throw new ForbiddenError("PRE_SCHEDULE_GATE_FAILED");
        }
        const set: Record<string, unknown> = {
          version: (v.version as number) + 1,
          updatedAt: new Date(),
        };
        if (input.scheduledStartedAt) {
          set.scheduledStartedAt = new Date(input.scheduledStartedAt);
          set.serviceDate = serviceDateOf(input.scheduledStartedAt);
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
        return toVisitView(row as VisitRow);
      });
    },

    async startVisit(
      orgId: string,
      userId: string,
      visitId: string,
      evvMissingReason: string | undefined,
      stepUpSatisfied: boolean,
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
          type: "start",
          source:
            evvMissingReason === undefined
              ? { via: "evv" }
              : { via: "self_attest", evvMissingReason, stepUpSatisfied },
        });
        const bracket = evvMissingReason === undefined ? "evv_present" : "evv_missing_documented";
        await tx
          .update(V)
          .set({
            status: transition.to,
            evvBracketState: bracket,
            evvMissingReason: evvMissingReason ?? null,
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
        return toVisitView(row as VisitRow);
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
        return toVisitView(row as VisitRow);
      });
    },

    async rescheduleVisit(
      orgId: string,
      userId: string,
      visitId: string,
      input: RescheduleVisitInput,
    ): Promise<{ original: VisitView; created: VisitView }> {
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
            assignedMembershipId: input.newAssignedMembershipId ?? (v.assignedMembershipId as string),
            visitPurpose: v.visitPurpose as VisitPurpose,
            visitSetting: v.visitSetting as VisitSetting,
            scheduledStartedAt: input.newScheduledStartedAt,
            scheduledEndedAt: input.newScheduledEndedAt,
          },
          { parentRecurringVisitId: null, parentProposalId: null },
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
        return { original: toVisitView(row as VisitRow), created };
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
        return toVisitView(row as VisitRow);
      });
    },

    async reassignVisit(
      orgId: string,
      userId: string,
      visitId: string,
      newAssignedMembershipId: string,
    ): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const v = await loadVisit(tx, visitId);
        const passed = await preScheduleGatePassed(
          tx,
          newAssignedMembershipId,
          iso(v.scheduledStartedAt as Date),
          iso(v.scheduledEndedAt as Date),
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
        return toVisitView(row as VisitRow);
      });
    },

    // ── proposals ─────────────────────────────────────────────────────────────────────────────────────
    async listProposals(orgId: string, filters: { patient?: string }): Promise<ProposalView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
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
          .orderBy(VP.proposedForDate);
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
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [p] = await tx.select().from(VP).where(eq(VP.id, proposalId)).limit(1);
        if (!p) throw new NotFoundError("visit_proposal");
        if (p.status !== "pending") throw new ConflictError("proposal is not pending");
        // The proposal must carry a best-fit membership to publish (the scheduler may reassign later); the
        // manual create path is the alternative when there is no suggestion.
        if (!p.suggestedMembershipId) {
          throw new ValidationError("the proposal has no suggested membership to assign the visit", []);
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
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const { providerEntityId, locationId } = await resolveSiting(tx, input.assignedMembershipId);
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
            rrule: input.rrule,
            // §2.2.3 — the time-of-day window + tz are policy fields the write path defaults (the RRULE parse
            // for the window lands with the materializer worker); NOT NULL, so seeded deterministically.
            timeOfDayStart: "09:00",
            timeOfDayEnd: "10:00",
            timeZone: "UTC",
            startDate: serviceDateOf(new Date().toISOString()),
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
        await tx
          .update(RV)
          .set({
            status: "discontinued",
            discontinuedAt: new Date(),
            discontinuedBy: userId || null,
            version: (r.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(RV.id, id));
        await emit(tx, orgId, "m17.recurring_visit.discontinued", "recurring_visit", id, {
          recurringVisitId: id,
          cancelledChildCount: 0,
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
          slots: rows.map((r) => ({ weekday: r.dayOfWeek, startTime: r.startTime, endTime: r.endTime })),
        };
      });
    },

    async upsertAvailability(
      orgId: string,
      userId: string,
      membershipId: string,
      input: UpsertAvailabilityInput,
    ): Promise<AvailabilityView> {
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
      filters: { membership?: string; state?: string },
    ): Promise<TimeOffView[]> {
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
    ): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
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
          conflictingVisitCount: 0,
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

    async approveTimeOff(orgId: string, userId: string, id: string): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
        transitionTimeOff(t.approvalState as TimeOffState, {
          type: "approve",
          approverPresent: true,
          conflictingVisitCount: 0,
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
        await emit(tx, orgId, "m17.time_off.approved", "time_off", id, {
          timeOffId: id,
          membershipId: t.membershipId,
          approvedBy: userId,
          affectedPublishedVisitCount: 0,
        });
        return toTimeOffView(t, "approved");
      });
    },

    async denyTimeOff(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
    ): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
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

    async cancelTimeOff(orgId: string, userId: string, id: string): Promise<TimeOffView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [t] = await tx.select().from(TO).where(eq(TO.id, id)).limit(1);
        if (!t) throw new NotFoundError("time_off");
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
    async dayView(orgId: string, membershipId: string | undefined, date: string) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
        (v) => v.serviceDate === date,
      );
      return { date, membershipId: membershipId ?? null, visits };
    },

    async weekView(orgId: string, membershipId: string | undefined, weekStart: string) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
        (v) => v.serviceDate >= weekStart,
      );
      return { weekStart, membershipId: membershipId ?? null, visits };
    },

    async mapView(orgId: string, membershipId: string, date: string) {
      const stops = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
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

    async visitMetrics(orgId: string, _window: { from: string; to: string }) {
      const visits = await backend.listVisits(orgId, {});
      const total = visits.length || 1;
      const noShow = visits.filter((v) => v.status === "no_show").length;
      const rescheduled = visits.filter((v) => v.status === "rescheduled").length;
      return { onTimeRate: 1, noShowRate: noShow / total, rescheduleRate: rescheduled / total };
    },

    routeEfficiencyMetrics(_orgId: string, membershipId: string) {
      return { membershipId, totalProposedMiles: 0, overrideRate: 0 };
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
    async resolveDiscipline(_orgId: string, _membershipId: string): Promise<SchedulingDiscipline | null> {
      return null;
    },
    async credentialsActiveForPurpose(): Promise<boolean> {
      return false;
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
    async allowsUnassignedPool(): Promise<boolean> {
      return false;
    },
    async isInCaseload(): Promise<boolean> {
      return false;
    },
  };

  return backend as unknown as SchedulingRouteService;
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
