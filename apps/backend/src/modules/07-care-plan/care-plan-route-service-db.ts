import { randomUUID } from "node:crypto";
// apps/backend/src/modules/07-care-plan — PRODUCTION CarePlanRouteService (M7L-T01 reads, T02 writes).
//
// The screen-driving READS (the patient's care plan aggregate, the §7.5 summary card, the version
// ledger + a single version) run as real Drizzle queries over the M7-owned tables inside
// `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role.
// The §7.6 SUD confidentiality filter is applied per-caller via the same pure redaction helpers the
// in-memory slice uses (`filterVisibleProblems` / `filterAnchoredToVisible` / `redactedSudProblemIds`),
// and it fails closed — no `viewer` ⇒ the internal/system read path (full set), a `viewer` with
// `sudDisclosureAllowed=false` ⇒ SUD problems (and their dependent goals/interventions) are omitted.
//
// The WRITE lifecycle is now real (M7L-T02): bootstrap opens the plan + its initial draft version;
// version draft/finalize/sign/return-to-draft drive the §2.2.2 machine with the §2.3/D5 quorum core
// (`resolveRequiredSignerSet` / `decideRecordSignature`) and §7.7 optimistic concurrency on the new
// `care_plan_version.version`; problem/goal/intervention authoring runs the pure §2.3 validators and
// locks on each element's own `version`. Every mutation emits the matching `m7.*` event on the
// transactional outbox (the caller's tx) — no route is left at 501. Because the CarePlanRouteService
// interface does not thread the acting user, writes envelope `withOrgContext` with `userId:""` (the
// read convention): the M4 write-audit trigger still fires — the audit row records a NULL actor (a
// follow-up threads the membership when the interface carries it).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type CarePlanSignerRole,
  type GoalSource,
  type InterventionDiscipline,
  NotFoundError,
  type ProblemKind,
  type RequiredSignerSet,
} from "@wardenx/types";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  type AuthoringDisciplineScope,
  assertDisciplineScope,
  filterAnchoredToVisible,
  filterVisibleProblems,
  redactedSudProblemIds,
} from "./authoring/index";
import { CarePlanStateError } from "./lifecycle/errors";
import { computeNextReviewDueAt, warningOpensAt } from "./lifecycle/gate-clock";
import { decideRecordSignature, resolveRequiredSignerSet } from "./lifecycle/required-signer-set";
import {
  checkGoalReferencesProblem,
  checkInterventionFrequency,
  checkInterventionReferencesProblem,
  checkOptimisticConcurrency,
  checkPatientStatedGoalVerbatim,
} from "./lifecycle/validation";
import {
  type CarePlanAbacResolver,
  CarePlanAlreadyExistsError,
  type CarePlanRouteService,
  type CarePlanSignActor,
  type CarePlanViewer,
  type CreateGoalInput,
  type CreateInterventionInput,
  type CreateProblemInput,
  type ElementResult,
  type PatchGoalInput,
  type PatchInterventionInput,
  type PatchProblemInput,
} from "./routes/service";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;
const SIG = schema.carePlanSignatures;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;
const IDG_APP = schema.carePlanIdgDecisionApplications;
const IDG_CHANGE = schema.carePlanIdgProposedChanges;

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** The §2.6 initial-review gate horizon (5 days) the bootstrap seeds the plan's `initial_due_at` with. */
const INITIAL_GATE_DAYS = 5;

const SNAPSHOT_SCHEMA_VERSION = "2026-08-m7-v1";

/**
 * The transactional-outbox port (§2.4): the composition root binds M1's catalog-validating publisher
 * pinned to caller-module `m7`; `publish` writes the `outbox_event` row on the CALLER'S tx (transactional
 * outbox). The default is a no-op so the slice/tests commit without a dispatcher — the plan/version/
 * element state is the load-bearing effect; downstream consumers ride the outbox once it is wired at the
 * mount.
 */
export interface CarePlanWriteOutboxPort {
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
const NOOP_OUTBOX: CarePlanWriteOutboxPort = { async publish() {} };

/** First row of a `RETURNING`/`SELECT` under `noUncheckedIndexedAccess`, or a 500 (unreachable after a write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new CarePlanStateError("ILLEGAL_TRANSITION", msg);
  return r;
}

/**
 * The production, RLS-backed CarePlanRouteService. Reads and writes run under `withOrgContext`; every
 * write drives the pure lifecycle core and emits its `m7.*` event. Org is bound from the request context
 * by the caller and passed as `org` — never the body.
 */
export function createDbCarePlanRouteService(
  db: DbClient,
  outbox: CarePlanWriteOutboxPort = NOOP_OUTBOX,
): CarePlanRouteService {
  /** Project a `problem` row to the in-memory ProblemRecord DTO shape (§7.6 filter keys off `sudRelated`/`id`). */
  const problemDto = (r: typeof PROB.$inferSelect) => ({
    id: r.id,
    organizationId: r.organizationId,
    planId: r.carePlanId,
    icd10Code: r.icd10Code ?? null,
    snomedCode: r.snomedCode ?? null,
    description: r.description,
    kind: r.kind,
    source: r.source,
    sudRelated: r.sudRelated,
    status: r.status,
    onsetAt: iso(r.onsetAt),
    resolvedAt: iso(r.resolvedAt),
    resolutionNote: r.resolutionNote ?? null,
    version: Number(r.version),
  });
  const goalDto = (r: typeof GOAL.$inferSelect) => ({
    id: r.id,
    organizationId: r.organizationId,
    planId: r.carePlanId,
    problemId: r.problemId,
    originalText: r.originalText,
    revisedText: r.revisedText ?? null,
    source: r.source,
    actingConsentId: r.actingConsentId ?? null,
    measurableOutcome: r.measurableOutcome ?? null,
    targetAt: iso(r.targetAt),
    status: r.status,
    statusNote: r.statusNote ?? null,
    version: Number(r.version),
  });
  const interventionDto = (r: typeof INTV.$inferSelect) => ({
    id: r.id,
    organizationId: r.organizationId,
    planId: r.carePlanId,
    problemId: r.problemId,
    goalRefs: (r.goalRefs as string[]) ?? [],
    scopeText: r.scopeText,
    frequencyText: r.frequencyText,
    frequencyValue: r.frequencyValue,
    discipline: r.discipline,
    responsibleRole: r.responsibleRole ?? null,
    linkedOrderId: r.linkedOrderId ?? null,
    status: r.status,
    discontinueReason: r.discontinueReason ?? null,
    version: Number(r.version),
  });
  const versionDto = (
    v: typeof CPV.$inferSelect,
    sigs: { signerRole: string; signedAt: string | null }[],
  ) => ({
    id: v.id,
    planId: v.carePlanId,
    sequence: v.sequence,
    kind: v.kind,
    status: v.status,
    idgMeetingId: v.idgMeetingId ?? null,
    requiredSignerSet: v.requiredSignerSet,
    signatures: sigs,
    draftedAt: iso(v.draftedAt),
    signedAt: iso(v.signedAt),
    supersededAt: iso(v.supersededAt),
    stateSnapshot: v.stateSnapshot ?? null,
    patientUnderstandingText: v.patientUnderstandingText ?? null,
    version: Number(v.version),
  });

  const terminalProblemBlocker = {
    code: "TERMINAL_PROBLEM_REQUIRED",
    message: "at least one active terminal problem is required",
  } as const;

  const openVersionBlocker = {
    code: "OPEN_VERSION_REQUIRED",
    message: "no draft or in-review version is open",
  } as const;
  const idgProposalBlocker = {
    code: "IDG_PROPOSAL_REQUIRED",
    message: "Record an IDG decision with a proposed Care Plan change before sending this review for signature.",
  } as const;

  /** Emit one `m7.*` event on the caller's tx (validated + persisted by the bound publisher; no-op default). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** Resolve a tenant-scoped plan row (RLS-scoped) or raise the non-leaking 404. */
  async function loadPlan(tx: DbClient, planId: string): Promise<typeof CP.$inferSelect> {
    const [row] = await tx.select().from(CP).where(eq(CP.id, planId)).limit(1);
    if (!row) throw new NotFoundError("care_plan", planId);
    return row;
  }

  function ensurePlanWritable(plan: typeof CP.$inferSelect): void {
    if (plan.status === "discharged") {
      throw new CarePlanStateError("CARE_PLAN_CLOSED", "discharged care plans cannot be mutated");
    }
  }

  async function activeTerminalProblemCount(tx: DbClient, planId: string): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(PROB)
      .where(
        and(eq(PROB.carePlanId, planId), eq(PROB.kind, "terminal"), eq(PROB.status, "active")),
      );
    return Number(row?.count ?? 0);
  }

  async function requireReadyToFinalize(tx: DbClient, v: typeof CPV.$inferSelect): Promise<void> {
    if (v.kind === "initial" && (await activeTerminalProblemCount(tx, v.carePlanId)) < 1) {
      throw new CarePlanStateError("CARE_PLAN_NOT_READY", "care plan is not ready to finalize", [
        terminalProblemBlocker,
      ]);
    }
  }

  async function requireReadyToSign(tx: DbClient, v: typeof CPV.$inferSelect): Promise<void> {
    if (v.kind === "initial" && (await activeTerminalProblemCount(tx, v.carePlanId)) < 1) {
      throw new CarePlanStateError("CARE_PLAN_NOT_READY", "care plan is not ready to sign", [
        terminalProblemBlocker,
      ]);
    }
  }

  async function ensureNoOtherOpenVersion(
    tx: DbClient,
    planId: string,
    exceptVersionId?: string,
  ): Promise<void> {
    const predicates = [
      eq(CPV.carePlanId, planId),
      inArray(CPV.status, ["draft", "in_review"] as const),
    ];
    if (exceptVersionId) predicates.push(ne(CPV.id, exceptVersionId));
    const [row] = await tx
      .select({ id: CPV.id })
      .from(CPV)
      .where(and(...predicates))
      .limit(1);
    if (row) {
      throw new CarePlanStateError(
        "OPEN_VERSION_EXISTS",
        "a care plan may have only one draft or in-review version",
      );
    }
  }

  function missingSignerSlots(
    set: RequiredSignerSet,
    signedRoles: ReadonlyArray<CarePlanSignerRole>,
  ): RequiredSignerSet {
    const remaining = [...signedRoles];
    const missing: { role: string; count: number }[] = [];
    for (const slot of set) {
      let need = slot.count;
      for (let i = remaining.length - 1; i >= 0 && need > 0; i--) {
        if (slot.role.split("|").includes(remaining[i]!)) {
          remaining.splice(i, 1);
          need--;
        }
      }
      if (need > 0) missing.push({ role: slot.role, count: need });
    }
    return missing;
  }

  async function captureStateSnapshot(tx: DbClient, planId: string) {
    const [probRows, goalRows, intvRows] = await Promise.all([
      tx.select().from(PROB).where(eq(PROB.carePlanId, planId)).orderBy(asc(PROB.id)),
      tx.select().from(GOAL).where(eq(GOAL.carePlanId, planId)).orderBy(asc(GOAL.id)),
      tx.select().from(INTV).where(eq(INTV.carePlanId, planId)).orderBy(asc(INTV.id)),
    ]);
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      problems: probRows.map((p) => ({
        id: p.id,
        icd10Code: p.icd10Code ?? null,
        snomedCode: p.snomedCode ?? null,
        description: p.description,
        kind: p.kind,
        source: p.source,
        sudRelated: p.sudRelated,
        status: p.status,
        onsetAt: iso(p.onsetAt),
        resolvedAt: iso(p.resolvedAt),
        resolutionNote: p.resolutionNote ?? null,
        version: Number(p.version),
      })),
      goals: goalRows.map((g) => ({
        id: g.id,
        problemId: g.problemId,
        originalText: g.originalText,
        revisedText: g.revisedText ?? null,
        source: g.source,
        actingConsentId: g.actingConsentId ?? null,
        measurableOutcome: g.measurableOutcome ?? null,
        targetAt: iso(g.targetAt),
        status: g.status,
        statusNote: g.statusNote ?? null,
        version: Number(g.version),
      })),
      interventions: intvRows.map((i) => ({
        id: i.id,
        problemId: i.problemId,
        goalRefs: (i.goalRefs as string[]) ?? [],
        scopeText: i.scopeText,
        frequencyText: i.frequencyText,
        frequencyValue: i.frequencyValue,
        discipline: i.discipline,
        responsibleRole: i.responsibleRole ?? null,
        linkedOrderId: i.linkedOrderId ?? null,
        status: i.status,
        discontinueReason: i.discontinueReason ?? null,
        version: Number(i.version),
      })),
    };
  }

  type ClinicalSnapshot = Awaited<ReturnType<typeof captureStateSnapshot>>;
  type IdgChangeRow = typeof IDG_CHANGE.$inferSelect;

  function recordOf(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CarePlanStateError("IDG_PROPOSAL_INVALID", `${label} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  function stringOf(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new CarePlanStateError("IDG_PROPOSAL_INVALID", `${key} must be a non-empty string`);
    }
    return value;
  }

  /**
   * Structural equality for the IDG baseline check. `baseline_snapshot` is persisted as `jsonb`, which
   * does NOT preserve object key order (Postgres stores keys by length, then bytewise), so comparing
   * `JSON.stringify` of the round-tripped baseline against a freshly captured snapshot reported every
   * untouched plan as "changed" (IDG_PROPOSAL_CONFLICT on every finalize/publish). Canonicalise object
   * keys before comparing; array order stays significant (the snapshot sorts every list by id).
   */
  function canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, canonicalJson(obj[k])]),
      );
    }
    return value;
  }

  function jsonEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
  }

  async function loadIdgProposalBundle(tx: DbClient, versionId: string) {
    const applications = await tx
      .select()
      .from(IDG_APP)
      .where(eq(IDG_APP.carePlanVersionId, versionId))
      .orderBy(asc(IDG_APP.proposedAt));
    const changes = applications.length
      ? await tx
          .select()
          .from(IDG_CHANGE)
          .where(
            inArray(
              IDG_CHANGE.applicationId,
              applications.map((a) => a.id),
            ),
          )
          .orderBy(asc(IDG_CHANGE.idgDecisionId), asc(IDG_CHANGE.ordinal))
      : [];
    return { applications, changes };
  }

  function mutateCandidateSnapshot(
    snapshot: ClinicalSnapshot,
    changes: readonly IdgChangeRow[],
  ): void {
    for (const change of changes) {
      const proposed = recordOf(change.proposed, "IDG proposed change");
      switch (change.operation) {
        case "problem_add":
          snapshot.problems.push({
            id: stringOf(proposed, "id"),
            icd10Code: (proposed.icd10Code as string | null | undefined) ?? null,
            snomedCode: (proposed.snomedCode as string | null | undefined) ?? null,
            description: stringOf(proposed, "description"),
            kind: stringOf(proposed, "kind") as ProblemKind,
            source: "clinical",
            sudRelated: proposed.sudRelated === true,
            status: "active",
            onsetAt: null,
            resolvedAt: null,
            resolutionNote: null,
            version: 1,
          });
          break;
        case "problem_update": {
          const target = snapshot.problems.find((p) => p.id === change.targetEntityId);
          if (!target) throw new CarePlanStateError("IDG_PROPOSAL_CONFLICT", "problem is missing");
          Object.assign(target, proposed);
          target.version += 1;
          break;
        }
        case "goal_add":
          snapshot.goals.push({
            id: stringOf(proposed, "id"),
            problemId: stringOf(proposed, "problemId"),
            originalText: stringOf(proposed, "originalText"),
            revisedText: (proposed.revisedText as string | null | undefined) ?? null,
            source: stringOf(proposed, "source") as GoalSource,
            actingConsentId: null,
            measurableOutcome: stringOf(proposed, "measurableOutcome"),
            targetAt: null,
            status: "not_started",
            statusNote: null,
            version: 1,
          });
          break;
        case "goal_update": {
          const target = snapshot.goals.find((g) => g.id === change.targetEntityId);
          if (!target) throw new CarePlanStateError("IDG_PROPOSAL_CONFLICT", "goal is missing");
          Object.assign(target, proposed);
          target.version += 1;
          break;
        }
        case "intervention_add":
          snapshot.interventions.push({
            id: stringOf(proposed, "id"),
            problemId: stringOf(proposed, "problemId"),
            goalRefs: Array.isArray(proposed.goalRefs) ? (proposed.goalRefs as string[]) : [],
            scopeText: stringOf(proposed, "scopeText"),
            frequencyText: stringOf(proposed, "frequencyText"),
            frequencyValue: stringOf(proposed, "frequencyValue"),
            discipline: stringOf(proposed, "discipline") as InterventionDiscipline,
            responsibleRole: null,
            linkedOrderId: null,
            status: "active",
            discontinueReason: null,
            version: 1,
          });
          break;
        case "intervention_discontinue": {
          const target = snapshot.interventions.find((i) => i.id === change.targetEntityId);
          if (!target) {
            throw new CarePlanStateError("IDG_PROPOSAL_CONFLICT", "intervention is missing");
          }
          Object.assign(target, proposed);
          target.version += 1;
          break;
        }
        default:
          throw new CarePlanStateError(
            "IDG_PROPOSAL_INVALID",
            `unsupported IDG mutation '${change.operation}'`,
          );
      }
    }
    snapshot.problems.sort((a, b) => a.id.localeCompare(b.id));
    snapshot.goals.sort((a, b) => a.id.localeCompare(b.id));
    snapshot.interventions.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function captureIdgCandidateSnapshot(
    tx: DbClient,
    planId: string,
    versionId: string,
  ): Promise<ClinicalSnapshot> {
    const current = await captureStateSnapshot(tx, planId);
    const { applications, changes } = await loadIdgProposalBundle(tx, versionId);
    if (applications.length === 0 || changes.length === 0) {
      throw new CarePlanStateError(
        "IDG_PROPOSAL_REQUIRED",
        "idg_review versions require proposed changes before finalize",
      );
    }
    for (const app of applications) {
      if (app.status !== "proposed") {
        throw new CarePlanStateError(
          "IDG_PROPOSAL_CONFLICT",
          `IDG proposal cannot finalize from '${app.status}'`,
        );
      }
      if (!app.baselineSnapshot || !jsonEqual(app.baselineSnapshot, current)) {
        await tx
          .update(IDG_APP)
          .set({ status: "conflict", conflictReason: "baseline_changed" })
          .where(eq(IDG_APP.id, app.id));
        throw new CarePlanStateError(
          "IDG_PROPOSAL_CONFLICT",
          "care plan changed after the IDG proposal was created",
        );
      }
    }
    mutateCandidateSnapshot(current, changes);
    return current;
  }

  async function applyIdgProposalChanges(
    tx: DbClient,
    input: {
      readonly org: string;
      readonly plan: typeof CP.$inferSelect;
      readonly version: typeof CPV.$inferSelect;
      readonly at: Date;
    },
  ): Promise<{ applicationCount: number; changeCount: number }> {
    const current = await captureStateSnapshot(tx, input.plan.id);
    const { applications, changes } = await loadIdgProposalBundle(tx, input.version.id);
    if (applications.length === 0 || changes.length === 0) {
      throw new CarePlanStateError("IDG_PROPOSAL_REQUIRED", "idg_review has no proposed changes");
    }
    for (const app of applications) {
      if (app.status === "applied") continue;
      if (app.status !== "in_review") {
        throw new CarePlanStateError(
          "IDG_PROPOSAL_CONFLICT",
          `IDG proposal cannot publish from '${app.status}'`,
        );
      }
      if (!app.baselineSnapshot || !jsonEqual(app.baselineSnapshot, current)) {
        await tx
          .update(IDG_APP)
          .set({ status: "conflict", conflictReason: "baseline_changed" })
          .where(eq(IDG_APP.id, app.id));
        throw new CarePlanStateError(
          "IDG_PROPOSAL_CONFLICT",
          "care plan changed after the IDG proposal entered review",
        );
      }
    }

    for (const change of changes.filter((c) => c.status !== "applied")) {
      const proposed = recordOf(change.proposed, "IDG proposed change");
      const common = {
        organizationId: input.org,
        providerEntityId: input.plan.providerEntityId,
        locationId: input.plan.locationId,
        carePlanId: input.plan.id,
      };
      switch (change.operation) {
        case "problem_add":
          await tx.insert(PROB).values({
            ...common,
            id: stringOf(proposed, "id"),
            icd10Code: (proposed.icd10Code as string | null | undefined) ?? null,
            snomedCode: (proposed.snomedCode as string | null | undefined) ?? null,
            description: stringOf(proposed, "description"),
            kind: stringOf(proposed, "kind") as typeof PROB.$inferInsert.kind,
            source: "clinical",
            sudRelated: proposed.sudRelated === true,
            status: "active",
          });
          break;
        case "problem_update":
          await tx
            .update(PROB)
            .set({ ...proposed, updatedAt: input.at, version: sql`${PROB.version} + 1` })
            .where(and(eq(PROB.carePlanId, input.plan.id), eq(PROB.id, change.targetEntityId!)));
          break;
        case "goal_add":
          await tx.insert(GOAL).values({
            ...common,
            id: stringOf(proposed, "id"),
            problemId: stringOf(proposed, "problemId"),
            originalText: stringOf(proposed, "originalText"),
            revisedText: (proposed.revisedText as string | null | undefined) ?? null,
            source: stringOf(proposed, "source") as typeof GOAL.$inferInsert.source,
            measurableOutcome: stringOf(proposed, "measurableOutcome"),
          });
          break;
        case "goal_update":
          await tx
            .update(GOAL)
            .set({ ...proposed, updatedAt: input.at, version: sql`${GOAL.version} + 1` })
            .where(and(eq(GOAL.carePlanId, input.plan.id), eq(GOAL.id, change.targetEntityId!)));
          break;
        case "intervention_add":
          await tx.insert(INTV).values({
            ...common,
            id: stringOf(proposed, "id"),
            problemId: stringOf(proposed, "problemId"),
            goalRefs: Array.isArray(proposed.goalRefs) ? proposed.goalRefs : [],
            scopeText: stringOf(proposed, "scopeText"),
            frequencyText: stringOf(proposed, "frequencyText"),
            frequencyValue: stringOf(proposed, "frequencyValue"),
            discipline: stringOf(proposed, "discipline") as typeof INTV.$inferInsert.discipline,
          });
          break;
        case "intervention_discontinue":
          await tx
            .update(INTV)
            .set({ ...proposed, updatedAt: input.at, version: sql`${INTV.version} + 1` })
            .where(and(eq(INTV.carePlanId, input.plan.id), eq(INTV.id, change.targetEntityId!)));
          break;
      }
      await tx
        .update(IDG_CHANGE)
        .set({ status: "applied", appliedAt: input.at })
        .where(eq(IDG_CHANGE.id, change.id));
    }

    const after = await captureStateSnapshot(tx, input.plan.id);
    if (!jsonEqual(after, input.version.stateSnapshot)) {
      throw new CarePlanStateError(
        "IDG_PROPOSAL_CONFLICT",
        "applied IDG proposal does not match the signed candidate snapshot",
      );
    }
    await tx
      .update(IDG_APP)
      .set({ status: "applied", appliedAt: input.at })
      .where(eq(IDG_APP.carePlanVersionId, input.version.id));
    return { applicationCount: applications.length, changeCount: changes.length };
  }

  async function loadVersion(
    tx: DbClient,
    planId: string,
    versionId: string,
  ): Promise<typeof CPV.$inferSelect> {
    const [row] = await tx
      .select()
      .from(CPV)
      .where(and(eq(CPV.id, versionId), eq(CPV.carePlanId, planId)))
      .limit(1);
    if (!row) throw new NotFoundError("care_plan_version", versionId);
    return row;
  }
  async function loadProblem(
    tx: DbClient,
    planId: string,
    problemId: string,
  ): Promise<typeof PROB.$inferSelect> {
    const [row] = await tx
      .select()
      .from(PROB)
      .where(and(eq(PROB.id, problemId), eq(PROB.carePlanId, planId)))
      .limit(1);
    if (!row) throw new NotFoundError("problem", problemId);
    return row;
  }
  async function loadGoal(
    tx: DbClient,
    planId: string,
    goalId: string,
  ): Promise<typeof GOAL.$inferSelect> {
    const [row] = await tx
      .select()
      .from(GOAL)
      .where(and(eq(GOAL.id, goalId), eq(GOAL.carePlanId, planId)))
      .limit(1);
    if (!row) throw new NotFoundError("goal", goalId);
    return row;
  }
  async function loadIntervention(
    tx: DbClient,
    planId: string,
    interventionId: string,
  ): Promise<typeof INTV.$inferSelect> {
    const [row] = await tx
      .select()
      .from(INTV)
      .where(and(eq(INTV.id, interventionId), eq(INTV.carePlanId, planId)))
      .limit(1);
    if (!row) throw new NotFoundError("intervention", interventionId);
    return row;
  }

  /** A version's LIVE signatures (signer roles + signed-at), ordered by signing time (invalidated excluded). */
  async function sigsFor(tx: DbClient, versionId: string) {
    const rows = await tx
      .select({ signerRole: SIG.signerRole, signedAt: SIG.signedAt })
      .from(SIG)
      .where(and(eq(SIG.carePlanVersionId, versionId), sql`${SIG.invalidatedAt} is null`))
      .orderBy(asc(SIG.signedAt));
    return rows.map((s) => ({ signerRole: s.signerRole, signedAt: iso(s.signedAt) }));
  }

  /** Load every version of a plan (seq asc) with its signatures, projected to the version DTO. */
  async function versionsForPlan(tx: DbClient, planId: string) {
    const rows = await tx
      .select()
      .from(CPV)
      .where(eq(CPV.carePlanId, planId))
      .orderBy(asc(CPV.sequence));
    const ids = rows.map((r) => r.id);
    const sigRows = ids.length
      ? await tx
          .select({
            versionId: SIG.carePlanVersionId,
            signerRole: SIG.signerRole,
            signedAt: SIG.signedAt,
          })
          .from(SIG)
          .where(and(inArray(SIG.carePlanVersionId, ids), sql`${SIG.invalidatedAt} is null`))
      : [];
    const byVersion = new Map<string, { signerRole: string; signedAt: string | null }[]>();
    for (const s of sigRows) {
      const list = byVersion.get(s.versionId) ?? [];
      list.push({ signerRole: s.signerRole, signedAt: iso(s.signedAt) });
      byVersion.set(s.versionId, list);
    }
    return rows.map((v) => versionDto(v, byVersion.get(v.id) ?? []));
  }

  return {
    // ── Bootstrap (§2.2.1) ──────────────────────────────────────────────────────────────────────────
    async bootstrapCarePlan(org, patientId, admissionId, admissionActivatedAt) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // One active plan per admission (the partial unique `care_plan_one_per_admission_uq` also guards).
        const [existing] = await t
          .select({ id: CP.id })
          .from(CP)
          .where(and(eq(CP.admissionId, admissionId), ne(CP.status, "discharged")))
          .limit(1);
        if (existing) throw new CarePlanAlreadyExistsError();
        // TASK-040D (mig 0161) — `admissionActivatedAt` is the SAME instant `initialDueAt` is already
        // derived from (the bootstrap route runs at `m6.admission.activated`); stamping it here just
        // makes that instant queryable/echoable (§7.1 payload) rather than computing initialDueAt twice.
        const now = admissionActivatedAt ? new Date(admissionActivatedAt) : new Date();
        const initialDueAt = new Date(now.getTime() + INITIAL_GATE_DAYS * 86_400_000);
        const plan = firstOrThrow(
          await t
            .insert(CP)
            .values({
              organizationId: org,
              patientId,
              admissionId,
              status: "draft",
              initialDueAt,
              admissionActivatedAt: now,
            })
            .returning(),
          "care_plan insert returned no row",
        );
        const version = firstOrThrow(
          await t
            .insert(CPV)
            .values({
              organizationId: org,
              carePlanId: plan.id,
              sequence: 1,
              kind: "initial",
              status: "draft",
              requiredSignerSet: resolveRequiredSignerSet("initial"),
            })
            .returning(),
          "care_plan_version insert returned no row",
        );
        await emit(t, org, "m7.care_plan.created", "care_plan", plan.id, {
          planId: plan.id,
          patientId,
          admissionId,
        });
        await emit(t, org, "m7.care_plan.version_drafted", "care_plan_version", version.id, {
          planId: plan.id,
          versionId: version.id,
          kind: "initial",
          sequence: 1,
        });
        return {
          id: plan.id,
          patientId,
          status: "draft",
          initialVersionId: version.id,
          version: Number(plan.version),
        };
      });
    },

    async closeCarePlanForAdmission(org, admissionId, reason, dischargedAt) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [plan] = await t
          .select()
          .from(CP)
          .where(and(eq(CP.admissionId, admissionId), ne(CP.status, "discharged")))
          .limit(1);
        if (!plan) return { closed: false, admissionId, reason, dischargedAt };
        const closed = firstOrThrow(
          await t
            .update(CP)
            .set({
              status: "discharged",
              version: sql`${CP.version} + 1`,
              updatedAt: new Date(dischargedAt),
            })
            .where(and(eq(CP.id, plan.id), ne(CP.status, "discharged")))
            .returning(),
          "care_plan discharge matched no row",
        );
        await emit(t, org, "m7.care_plan.discharged", "care_plan", closed.id, {
          planId: closed.id,
          patientId: closed.patientId,
          reason,
        });
        return {
          closed: true,
          id: closed.id,
          admissionId,
          reason,
          dischargedAt,
          version: Number(closed.version),
        };
      });
    },

    // ── Care-plan aggregate read (§7.6 SUD-filtered) ────────────────────────────────────────────────
    async getCarePlanForPatient(org, patientId, viewer?: CarePlanViewer) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [row] = await t
          .select()
          .from(CP)
          .where(eq(CP.patientId, patientId))
          .orderBy(asc(CP.createdAt))
          .limit(1);
        if (!row) return null;
        const [planVersions, probRows, goalRows, intvRows] = await Promise.all([
          versionsForPlan(t, row.id),
          t.select().from(PROB).where(eq(PROB.carePlanId, row.id)),
          t.select().from(GOAL).where(eq(GOAL.carePlanId, row.id)),
          t.select().from(INTV).where(eq(INTV.carePlanId, row.id)),
        ]);
        const allowSud = viewer?.sudDisclosureAllowed ?? true;
        const planProblems = probRows.map(problemDto);
        const hiddenIds = redactedSudProblemIds(planProblems, allowSud);
        return {
          id: row.id,
          patientId: row.patientId,
          admissionId: row.admissionId,
          status: row.status,
          activeVersionId: row.activeVersionId ?? null,
          version: Number(row.version),
          versions: planVersions,
          problems: filterVisibleProblems(planProblems, allowSud),
          goals: filterAnchoredToVisible(goalRows.map(goalDto), hiddenIds),
          interventions: filterAnchoredToVisible(intvRows.map(interventionDto), hiddenIds),
          redacted: hiddenIds.length > 0,
        };
      });
    },

    // ── §7.5 summary card read (§7.6 SUD-filtered) ──────────────────────────────────────────────────
    async getSummary(org, planId, viewer?: CarePlanViewer) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [p] = await t.select().from(CP).where(eq(CP.id, planId)).limit(1);
        if (!p) throw new NotFoundError("care_plan", planId); // RLS-hidden rows look identical (non-leaking 404)
        const [probRows, goalRows, intvRows] = await Promise.all([
          t.select().from(PROB).where(eq(PROB.carePlanId, p.id)),
          t.select().from(GOAL).where(eq(GOAL.carePlanId, p.id)),
          t.select().from(INTV).where(eq(INTV.carePlanId, p.id)),
        ]);
        const allowSud = viewer?.sudDisclosureAllowed ?? true;
        const planProblems = probRows.map(problemDto);
        const hiddenIds = redactedSudProblemIds(planProblems, allowSud);
        const visibleProblems = filterVisibleProblems(planProblems, allowSud);
        const activeProblems = visibleProblems
          .filter((x) => x.status === "active")
          .map((x) => ({ description: x.description, kind: x.kind }));
        const patientStatedGoals = filterAnchoredToVisible(
          goalRows.map(goalDto).filter((g) => g.source !== "clinical"),
          hiddenIds,
        ).map((g) => ({ text: g.originalText, measurableOutcome: g.measurableOutcome }));
        const activeInterventions = filterAnchoredToVisible(
          intvRows.map(interventionDto).filter((i) => i.status === "active"),
          hiddenIds,
        ).map((i) => ({
          layText: i.scopeText,
          discipline: i.discipline,
          frequencyText: i.frequencyText,
        }));
        return {
          planId: p.id,
          versionId: p.activeVersionId ?? null,
          activeProblems,
          patientStatedGoals,
          activeInterventions,
          redacted: hiddenIds.length > 0,
        };
      });
    },

    // ── Version ledger reads ────────────────────────────────────────────────────────────────────────
    async listVersions(org, planId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [p] = await t.select({ id: CP.id }).from(CP).where(eq(CP.id, planId)).limit(1);
        if (!p) throw new NotFoundError("care_plan", planId);
        const items = await versionsForPlan(t, planId);
        return { items, nextCursor: null };
      });
    },
    async getVersion(org, planId, versionId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [p] = await t.select({ id: CP.id }).from(CP).where(eq(CP.id, planId)).limit(1);
        if (!p) throw new NotFoundError("care_plan", planId);
        const v = await loadVersion(t, planId, versionId);
        return versionDto(v, await sigsFor(t, v.id));
      });
    },

    async getReadiness(org, planId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadPlan(t, planId);
        const [open] = await t
          .select()
          .from(CPV)
          .where(and(eq(CPV.carePlanId, planId), inArray(CPV.status, ["draft", "in_review"])))
          .orderBy(asc(CPV.sequence))
          .limit(1);
        if (!open) {
          return {
            planId,
            openVersionId: null,
            canFinalize: false,
            canSign: false,
            blockers: [openVersionBlocker],
            signatures: { required: [], collected: [], missing: [] },
          };
        }
        const blockers = [] as Array<typeof terminalProblemBlocker | typeof idgProposalBlocker>;
        if (open.kind === "initial" && (await activeTerminalProblemCount(t, planId)) < 1) {
          blockers.push(terminalProblemBlocker);
        }
        if (open.kind === "idg_review") {
          const { applications, changes } = await loadIdgProposalBundle(t, open.id);
          if (applications.length === 0 || changes.length === 0) blockers.push(idgProposalBlocker);
        }
        const collected = await sigsFor(t, open.id);
        const missing = missingSignerSlots(
          open.requiredSignerSet as RequiredSignerSet,
          collected.map((s) => s.signerRole as CarePlanSignerRole),
        );
        return {
          planId,
          openVersionId: open.id,
          openVersionStatus: open.status,
          canFinalize: open.status === "draft" && blockers.length === 0,
          canSign: open.status === "in_review" && blockers.length === 0 && missing.length > 0,
          blockers,
          signatures: {
            required: open.requiredSignerSet,
            collected,
            missing,
          },
        };
      });
    },

    async getProposedChanges(org, planId, versionId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadPlan(t, planId);
        const version = await loadVersion(t, planId, versionId);
        const { applications, changes } = await loadIdgProposalBundle(t, versionId);
        return {
          versionId,
          kind: version.kind,
          meetingId: version.idgMeetingId ?? applications[0]?.idgMeetingId ?? null,
          status: version.status,
          proposals: applications.map((a) => ({
            id: a.id,
            decisionId: a.idgDecisionId,
            meetingId: a.idgMeetingId,
            sourceOutboxEventId: a.sourceOutboxEventId,
            status: a.status,
            proposedAt: iso(a.proposedAt),
            inReviewAt: iso(a.inReviewAt),
            appliedAt: iso(a.appliedAt),
            conflictReason: a.conflictReason ?? null,
          })),
          changes: changes.map((c) => ({
            id: c.id,
            proposalId: c.applicationId,
            decisionId: c.idgDecisionId,
            entityType: c.entityType,
            operation: c.operation,
            targetId: c.targetEntityId ?? null,
            before: c.before ?? null,
            proposed: c.proposed,
            status: c.status,
          })),
        };
      });
    },

    async getReviewStatus(org, planId, nowIso) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        const [open] = await t
          .select({ id: CPV.id, status: CPV.status })
          .from(CPV)
          .where(
            and(
              eq(CPV.carePlanId, planId),
              eq(CPV.kind, "idg_review"),
              inArray(CPV.status, ["draft", "in_review"]),
            ),
          )
          .limit(1);
        const now = new Date(nowIso ?? new Date().toISOString());
        const dueAt = plan.nextReviewDueAt;
        let status: "not_due" | "due" | "overdue" | "review_in_progress" = "not_due";
        let overdueByDays = 0;
        if (open) {
          status = "review_in_progress";
        } else if (dueAt) {
          // D3 — "due" opens at the START of org-local day 13 (the same instant the review_due cron
          // alert uses), not `dueAt − 48h`, which lands on the last millisecond of day 13.
          const leadAt = new Date(warningOpensAt(dueAt.toISOString()));
          if (now.getTime() > dueAt.getTime()) {
            status = "overdue";
            overdueByDays = Math.floor((now.getTime() - dueAt.getTime()) / 86_400_000);
          } else if (now.getTime() >= leadAt.getTime()) {
            status = "due";
          }
        }
        return {
          planId,
          nextReviewDueAt: iso(dueAt),
          status,
          overdueByDays,
          openReviewVersionId: open?.id ?? null,
          openReviewVersionStatus: open?.status ?? null,
          canStartReview: !open && plan.status !== "discharged",
        };
      });
    },

    // ── Version lifecycle (§2.2.2 draft → in_review → signed) ────────────────────────────────────────
    async createVersion(org, planId, kind, idgMeetingId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        await ensureNoOtherOpenVersion(t, planId);
        const [{ maxSeq } = { maxSeq: 0 }] = await t
          .select({ maxSeq: sql<number>`coalesce(max(${CPV.sequence}), 0)::int` })
          .from(CPV)
          .where(eq(CPV.carePlanId, planId));
        const v = firstOrThrow(
          await t
            .insert(CPV)
            .values({
              organizationId: org,
              carePlanId: planId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              sequence: Number(maxSeq) + 1,
              kind,
              status: "draft",
              idgMeetingId: idgMeetingId ?? null,
              requiredSignerSet: resolveRequiredSignerSet(kind),
            })
            .returning(),
          "care_plan_version insert returned no row",
        );
        await emit(t, org, "m7.care_plan.version_drafted", "care_plan_version", v.id, {
          planId,
          versionId: v.id,
          kind,
          sequence: v.sequence,
        });
        return versionDto(v, []);
      });
    },

    async finalizeVersion(org, planId, versionId, ifVersion, set) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        const v = await loadVersion(t, planId, versionId);
        checkOptimisticConcurrency(ifVersion, Number(v.version));
        if (v.status !== "draft") {
          throw new CarePlanStateError(
            "ILLEGAL_TRANSITION",
            `version cannot finalize from '${v.status}'`,
          );
        }
        await ensureNoOtherOpenVersion(t, planId, versionId);
        await requireReadyToFinalize(t, v);
        let requiredSignerSet = v.requiredSignerSet;
        if (set) {
          // A tenant may TIGHTEN the floor (add slots) but never loosen below it (§11 D5).
          const floor = resolveRequiredSignerSet(v.kind);
          if (set.length < floor.length) {
            throw new CarePlanStateError(
              "REQUIRED_SIGNER_SET_UNMET",
              "the Required Signer Set may not loosen the floor quorum",
            );
          }
          requiredSignerSet = set;
        }
        const updated = firstOrThrow(
          await t
            .update(CPV)
            .set({
              status: "in_review",
              requiredSignerSet,
              stateSnapshot:
                v.kind === "idg_review"
                  ? await captureIdgCandidateSnapshot(t, planId, versionId)
                  : await captureStateSnapshot(t, planId),
              version: sql`${CPV.version} + 1`,
            })
            .where(and(eq(CPV.id, versionId), eq(CPV.version, ifVersion)))
            .returning(),
          "version finalize matched no row (stale write)",
        );
        if (v.kind === "idg_review") {
          await t
            .update(IDG_APP)
            .set({ status: "in_review", inReviewAt: new Date() })
            .where(and(eq(IDG_APP.carePlanVersionId, versionId), eq(IDG_APP.status, "proposed")));
        }
        return versionDto(updated, await sigsFor(t, versionId));
      });
    },

    async signVersion(
      org,
      planId,
      versionId,
      ifVersion,
      signerRole,
      at,
      actor?: CarePlanSignActor,
      patientUnderstandingText?: string | null,
    ) {
      return withOrgContext(
        db,
        { organizationId: org, userId: actor?.userId ?? "" },
        async (tx) => {
          const t = tx as unknown as DbClient;
          const plan = await loadPlan(t, planId);
          ensurePlanWritable(plan);
          const v = await loadVersion(t, planId, versionId);
          checkOptimisticConcurrency(ifVersion, Number(v.version));
          if (v.status !== "in_review") {
            throw new CarePlanStateError(
              "ILLEGAL_TRANSITION",
              `version cannot be signed from '${v.status}'`,
            );
          }
          await requireReadyToSign(t, v);
          const existing = await sigsFor(t, versionId);
          const decision = decideRecordSignature(
            v.requiredSignerSet as Parameters<typeof decideRecordSignature>[0],
            existing.map((s) => s.signerRole) as Parameters<typeof decideRecordSignature>[1],
            signerRole,
          );
          await t.insert(SIG).values({
            organizationId: org,
            carePlanVersionId: versionId,
            providerEntityId: v.providerEntityId,
            locationId: v.locationId,
            membershipId: actor?.membershipId ?? null,
            signerRole,
            signatureMethod: "password_step_up",
            signedAt: new Date(at),
          });
          let idgApplied: { applicationCount: number; changeCount: number } | null = null;
          if (decision.quorumMet && v.kind === "idg_review") {
            idgApplied = await applyIdgProposalChanges(t, {
              org,
              plan,
              version: v,
              at: new Date(at),
            });
          }
          const updated = firstOrThrow(
            await t
              .update(CPV)
              .set({
                status: decision.quorumMet ? "signed" : "in_review",
                signedAt: decision.quorumMet ? new Date(at) : null,
                patientUnderstandingText:
                  patientUnderstandingText === undefined ? undefined : patientUnderstandingText,
                version: sql`${CPV.version} + 1`,
              })
              .where(eq(CPV.id, versionId))
              .returning(),
            "version sign matched no row",
          );
          if (decision.quorumMet) {
            if (plan.activeVersionId && plan.activeVersionId !== versionId) {
              await t
                .update(CPV)
                .set({
                  status: "superseded",
                  supersededAt: new Date(at),
                  version: sql`${CPV.version} + 1`,
                })
                .where(and(eq(CPV.id, plan.activeVersionId), eq(CPV.status, "signed")));
            }
            // The last required signature activates the plan and pins the active version (§2.2.2).
            // TASK-040D (mig 0161) — gate-clock.ts's own doc comment says computeNextReviewDueAt is
            // "called on every version_signed (initial and each IDG review) so the review clock re-arms
            // from the most recent signature", but nothing ever called it — nextReviewDueAt stayed NULL
            // forever, silently no-opping the §7.2 review-gate cron scan regardless of whether it runs.
            // Recomputing it here on EVERY sign (not just review) + resetting the two emission markers is
            // what makes planReviewGateScan (jobs/index.ts) do anything once TASK-040D's worker is live.
            await t
              .update(CP)
              .set({
                status: "active",
                activeVersionId: versionId,
                version: sql`${CP.version} + 1`,
                updatedAt: new Date(),
                nextReviewDueAt: new Date(computeNextReviewDueAt(at)),
                reviewDueEmitted: false,
                reviewOverdueEmitted: false,
                ...(v.kind === "initial" ? { initialSignedAt: new Date(at) } : {}),
              })
              .where(eq(CP.id, planId));
            await emit(t, org, "m7.care_plan.version_signed", "care_plan_version", versionId, {
              planId,
              versionId,
              patientId: plan.patientId,
              admissionId: plan.admissionId,
              kind: v.kind,
              snapshotRef: versionId,
            });
            if (idgApplied) {
              await emit(
                t,
                org,
                "m7.care_plan.idg_proposal_applied",
                "care_plan_version",
                versionId,
                {
                  planId,
                  versionId,
                  appliedProposalCount: idgApplied.applicationCount,
                  appliedChangeCount: idgApplied.changeCount,
                },
              );
            }
          }
          return versionDto(updated, await sigsFor(t, versionId));
        },
      );
    },

    async returnVersionToDraft(org, planId, versionId, ifVersion) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        const v = await loadVersion(t, planId, versionId);
        checkOptimisticConcurrency(ifVersion, Number(v.version));
        if (v.status !== "in_review") {
          throw new CarePlanStateError(
            "ILLEGAL_TRANSITION",
            `version cannot return to draft from '${v.status}'`,
          );
        }
        // D8: clear the collected signatures for re-authoring — INVALIDATE (never delete; care-plan tables
        // are append-only for wardenx_app), so the audit trail survives and the roles can re-sign.
        await t
          .update(SIG)
          .set({ invalidatedAt: new Date() })
          .where(and(eq(SIG.carePlanVersionId, versionId), sql`${SIG.invalidatedAt} is null`));
        if (v.kind === "idg_review") {
          await t
            .update(IDG_APP)
            .set({ status: "proposed", inReviewAt: null })
            .where(and(eq(IDG_APP.carePlanVersionId, versionId), eq(IDG_APP.status, "in_review")));
          await t
            .update(IDG_CHANGE)
            .set({ status: "proposed", appliedAt: null })
            .where(
              and(eq(IDG_CHANGE.carePlanVersionId, versionId), eq(IDG_CHANGE.status, "proposed")),
            );
        }
        const updated = firstOrThrow(
          await t
            .update(CPV)
            .set({
              status: "draft",
              signedAt: null,
              stateSnapshot: null,
              version: sql`${CPV.version} + 1`,
            })
            .where(and(eq(CPV.id, versionId), eq(CPV.version, ifVersion)))
            .returning(),
          "version return-to-draft matched no row (stale write)",
        );
        return versionDto(updated, []);
      });
    },

    // ── Problems (§2.2.3) ────────────────────────────────────────────────────────────────────────────
    async addProblem(org, planId, body: CreateProblemInput): Promise<ElementResult> {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        const p = firstOrThrow(
          await t
            .insert(PROB)
            .values({
              organizationId: org,
              carePlanId: planId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              icd10Code: body.icd10Code ?? null,
              snomedCode: body.snomedCode ?? null,
              description: body.description,
              kind: body.kind,
              source: body.source,
              sudRelated: body.sudRelated ?? false,
              status: "active",
            })
            .returning(),
          "problem insert returned no row",
        );
        await emit(t, org, "m7.problem.added", "problem", p.id, {
          planId,
          problemId: p.id,
          status: p.status,
        });
        return { id: p.id, status: p.status, version: Number(p.version) };
      });
    },

    async patchProblem(org, planId, problemId, ifVersion, body: PatchProblemInput) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        ensurePlanWritable(await loadPlan(t, planId));
        const row = await loadProblem(t, planId, problemId);
        checkOptimisticConcurrency(ifVersion, Number(row.version));
        const updated = firstOrThrow(
          await t
            .update(PROB)
            .set({
              description: body.description,
              kind: body.kind,
              icd10Code: body.icd10Code,
              snomedCode: body.snomedCode,
              version: sql`${PROB.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(PROB.id, problemId), eq(PROB.version, ifVersion)))
            .returning(),
          "problem patch matched no row (stale write)",
        );
        await emit(t, org, "m7.problem.updated", "problem", updated.id, {
          planId,
          problemId: updated.id,
          status: updated.status,
        });
        return { id: updated.id, status: updated.status, version: Number(updated.version) };
      });
    },

    async resolveProblem(org, planId, problemId, ifVersion, note) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        ensurePlanWritable(await loadPlan(t, planId));
        const row = await loadProblem(t, planId, problemId);
        checkOptimisticConcurrency(ifVersion, Number(row.version));
        const updated = firstOrThrow(
          await t
            .update(PROB)
            .set({
              status: "resolved",
              resolutionNote: note,
              resolvedAt: new Date(),
              version: sql`${PROB.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(PROB.id, problemId), eq(PROB.version, ifVersion)))
            .returning(),
          "problem resolve matched no row (stale write)",
        );
        await emit(t, org, "m7.problem.resolved", "problem", updated.id, {
          planId,
          problemId: updated.id,
          status: updated.status,
        });
        return { id: updated.id, status: updated.status, version: Number(updated.version) };
      });
    },

    // ── Goals (§2.2.3 / §7.3 verbatim / D6) ──────────────────────────────────────────────────────────
    async addGoal(org, planId, body: CreateGoalInput, dpoaConsentActive) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        checkGoalReferencesProblem(body.problemId);
        checkPatientStatedGoalVerbatim({
          source: body.source,
          originalText: body.originalText,
          isUpdate: false,
          mutatingOriginalText: false,
        });
        if (body.source === "agent_stated" && !dpoaConsentActive) {
          throw new CarePlanStateError(
            "DPOA_CONSENT_REQUIRED",
            "an agent-stated goal requires an active dpoa_healthcare consent",
          );
        }
        const g = firstOrThrow(
          await t
            .insert(GOAL)
            .values({
              organizationId: org,
              carePlanId: planId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              problemId: body.problemId,
              originalText: body.originalText,
              source: body.source,
              actingConsentId: body.actingConsentId ?? null,
              measurableOutcome: body.measurableOutcome ?? null,
              status: "not_started",
            })
            .returning(),
          "goal insert returned no row",
        );
        await emit(t, org, "m7.goal.added", "goal", g.id, {
          planId,
          goalId: g.id,
          status: g.status,
          source: g.source,
        });
        return { id: g.id, status: g.status, version: Number(g.version) };
      });
    },

    async patchGoal(org, planId, goalId, ifVersion, body: PatchGoalInput) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        ensurePlanWritable(await loadPlan(t, planId));
        const row = await loadGoal(t, planId, goalId);
        checkOptimisticConcurrency(ifVersion, Number(row.version));
        // A verbatim-source goal's original_text is immutable; PATCH never carries it (schema omits it),
        // but enforce the rule defensively (D6 — the DB trigger is the backstop).
        checkPatientStatedGoalVerbatim({
          source: row.source,
          originalText: row.originalText,
          isUpdate: true,
          mutatingOriginalText: false,
        });
        const updated = firstOrThrow(
          await t
            .update(GOAL)
            .set({
              revisedText: body.revisedText,
              measurableOutcome: body.measurableOutcome,
              status: body.status,
              version: sql`${GOAL.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(GOAL.id, goalId), eq(GOAL.version, ifVersion)))
            .returning(),
          "goal patch matched no row (stale write)",
        );
        // Fire the precise lifecycle event when the status advanced to a terminal state, else `updated`.
        const eventName =
          updated.status === "met"
            ? "m7.goal.met"
            : updated.status === "discontinued"
              ? "m7.goal.discontinued"
              : "m7.goal.updated";
        await emit(t, org, eventName, "goal", updated.id, {
          planId,
          goalId: updated.id,
          status: updated.status,
          source: updated.source,
        });
        return { id: updated.id, status: updated.status, version: Number(updated.version) };
      });
    },

    // ── Interventions (§2.2.3 / §7.4 discipline scope) ───────────────────────────────────────────────
    async addIntervention(
      org,
      planId,
      body: CreateInterventionInput,
      authoring?: AuthoringDisciplineScope,
    ) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        // §7.4 discipline_scope: an actor may author only their own discipline (IDG Coordinator excepted).
        if (authoring) assertDisciplineScope(authoring, body.discipline);
        checkInterventionReferencesProblem(body.problemId);
        checkInterventionFrequency(body.frequencyValue);
        const i = firstOrThrow(
          await t
            .insert(INTV)
            .values({
              organizationId: org,
              carePlanId: planId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              problemId: body.problemId,
              goalRefs: [...(body.goalRefs ?? [])],
              scopeText: body.scopeText,
              frequencyText: body.frequencyText,
              frequencyValue: body.frequencyValue,
              discipline: body.discipline,
              responsibleRole: body.responsibleRole ?? null,
              status: "active",
            })
            .returning(),
          "intervention insert returned no row",
        );
        await emit(t, org, "m7.intervention.added", "intervention", i.id, {
          planId,
          interventionId: i.id,
          status: i.status,
          discipline: i.discipline,
        });
        return { id: i.id, status: i.status, version: Number(i.version) };
      });
    },

    async patchIntervention(org, planId, interventionId, ifVersion, body: PatchInterventionInput) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        ensurePlanWritable(await loadPlan(t, planId));
        const row = await loadIntervention(t, planId, interventionId);
        checkOptimisticConcurrency(ifVersion, Number(row.version));
        if (body.frequencyValue !== undefined) checkInterventionFrequency(body.frequencyValue);
        const updated = firstOrThrow(
          await t
            .update(INTV)
            .set({
              scopeText: body.scopeText,
              frequencyText: body.frequencyText,
              frequencyValue: body.frequencyValue,
              responsibleRole: body.responsibleRole,
              version: sql`${INTV.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(INTV.id, interventionId), eq(INTV.version, ifVersion)))
            .returning(),
          "intervention patch matched no row (stale write)",
        );
        await emit(t, org, "m7.intervention.updated", "intervention", updated.id, {
          planId,
          interventionId: updated.id,
          status: updated.status,
          discipline: updated.discipline,
        });
        return { id: updated.id, status: updated.status, version: Number(updated.version) };
      });
    },

    async discontinueIntervention(org, planId, interventionId, ifVersion, _reason) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        ensurePlanWritable(await loadPlan(t, planId));
        const row = await loadIntervention(t, planId, interventionId);
        checkOptimisticConcurrency(ifVersion, Number(row.version));
        const updated = firstOrThrow(
          await t
            .update(INTV)
            .set({
              status: "discontinued",
              discontinueReason: _reason,
              version: sql`${INTV.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(INTV.id, interventionId), eq(INTV.version, ifVersion)))
            .returning(),
          "intervention discontinue matched no row (stale write)",
        );
        await emit(t, org, "m7.intervention.discontinued", "intervention", updated.id, {
          planId,
          interventionId: updated.id,
          status: updated.status,
          discipline: updated.discipline,
        });
        return { id: updated.id, status: updated.status, version: Number(updated.version) };
      });
    },
  };
}

/**
 * The production, RLS-backed {@link CarePlanAbacResolver} — the §6 owner-fact loaders M7's ABAC predicates
 * (`caseload_or_scope` plan-arm, `dpoa_active`, `sud_disclosure_allowed`, `signer_role_match`) resolve a
 * plan/problem/version's org-scoped facts through. Each load runs under `withOrgContext` (RLS scopes every
 * statement by `app.org_id` as the unprivileged `wardenx_app` role) and FAILS CLOSED — a missing or
 * cross-tenant id returns `null`, so the predicate denies rather than leaking existence. Mirrors the in-memory
 * `createInMemoryDocumentBackend`-style resolver in `routes/service.ts` (a non-problem `problemId`, e.g. a
 * goal/intervention element id, resolves to `null` — the same fail-closed posture the slice takes).
 */
export function createDbCarePlanAbacResolver(db: DbClient): CarePlanAbacResolver {
  const withOrg = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));

  return {
    async loadPlan(organizationId, planId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ patientId: CP.patientId })
          .from(CP)
          .where(eq(CP.id, planId))
          .limit(1);
        return row ? { planId, patientId: row.patientId } : null;
      });
    },
    async loadProblem(organizationId, problemId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ carePlanId: PROB.carePlanId, sudRelated: PROB.sudRelated })
          .from(PROB)
          .where(eq(PROB.id, problemId))
          .limit(1);
        if (!row) return null;
        const [plan] = await tx
          .select({ patientId: CP.patientId })
          .from(CP)
          .where(eq(CP.id, row.carePlanId))
          .limit(1);
        if (!plan) return null;
        return { planId: row.carePlanId, patientId: plan.patientId, sudRelated: row.sudRelated };
      });
    },
    async loadVersion(organizationId, versionId) {
      return withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select({ carePlanId: CPV.carePlanId, requiredSignerSet: CPV.requiredSignerSet })
          .from(CPV)
          .where(eq(CPV.id, versionId))
          .limit(1);
        return row
          ? {
              planId: row.carePlanId,
              requiredSignerSet: row.requiredSignerSet as RequiredSignerSet,
            }
          : null;
      });
    },
  };
}
