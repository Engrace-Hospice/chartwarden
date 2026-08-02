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
import { NotFoundError } from "@wardenx/types";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  type AuthoringDisciplineScope,
  assertDisciplineScope,
  filterAnchoredToVisible,
  filterVisibleProblems,
  redactedSudProblemIds,
} from "./authoring/index";
import { CarePlanStateError } from "./lifecycle/errors";
import { decideRecordSignature, resolveRequiredSignerSet } from "./lifecycle/required-signer-set";
import {
  checkGoalReferencesProblem,
  checkInterventionFrequency,
  checkInterventionReferencesProblem,
  checkOptimisticConcurrency,
  checkPatientStatedGoalVerbatim,
} from "./lifecycle/validation";
import {
  CarePlanAlreadyExistsError,
  type CarePlanRouteService,
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

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** The §2.6 initial-review gate horizon (5 days) the bootstrap seeds the plan's `initial_due_at` with. */
const INITIAL_GATE_DAYS = 5;

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
    status: r.status,
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
    status: r.status,
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
    signedAt: iso(v.signedAt),
    version: Number(v.version),
  });

  /** Emit one `m7.*` event on the caller's tx (validated + persisted by the bound publisher; no-op default). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, { eventName, payload, organizationId: org, aggregateKind, aggregateId });
  }

  /** Resolve a tenant-scoped plan row (RLS-scoped) or raise the non-leaking 404. */
  async function loadPlan(tx: DbClient, planId: string): Promise<typeof CP.$inferSelect> {
    const [row] = await tx.select().from(CP).where(eq(CP.id, planId)).limit(1);
    if (!row) throw new NotFoundError("care_plan", planId);
    return row;
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
    async bootstrapCarePlan(org, patientId, admissionId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // One active plan per admission (the partial unique `care_plan_one_per_admission_uq` also guards).
        const [existing] = await t
          .select({ id: CP.id })
          .from(CP)
          .where(and(eq(CP.admissionId, admissionId), ne(CP.status, "discharged")))
          .limit(1);
        if (existing) throw new CarePlanAlreadyExistsError();
        const initialDueAt = new Date(Date.now() + INITIAL_GATE_DAYS * 86_400_000);
        const plan = firstOrThrow(
          await t
            .insert(CP)
            .values({ organizationId: org, patientId, admissionId, status: "draft", initialDueAt })
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

    // ── Version lifecycle (§2.2.2 draft → in_review → signed) ────────────────────────────────────────
    async createVersion(org, planId, kind, idgMeetingId) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadPlan(t, planId);
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
        const v = await loadVersion(t, planId, versionId);
        checkOptimisticConcurrency(ifVersion, Number(v.version));
        if (v.status !== "draft") {
          throw new CarePlanStateError(
            "ILLEGAL_TRANSITION",
            `version cannot finalize from '${v.status}'`,
          );
        }
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
            .set({ status: "in_review", requiredSignerSet, version: sql`${CPV.version} + 1` })
            .where(and(eq(CPV.id, versionId), eq(CPV.version, ifVersion)))
            .returning(),
          "version finalize matched no row (stale write)",
        );
        return versionDto(updated, await sigsFor(t, versionId));
      });
    },

    async signVersion(org, planId, versionId, ifVersion, signerRole, at) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const v = await loadVersion(t, planId, versionId);
        checkOptimisticConcurrency(ifVersion, Number(v.version));
        if (v.status !== "in_review") {
          throw new CarePlanStateError(
            "ILLEGAL_TRANSITION",
            `version cannot be signed from '${v.status}'`,
          );
        }
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
          signerRole,
          signatureMethod: "password_step_up",
          signedAt: new Date(at),
        });
        const updated = firstOrThrow(
          await t
            .update(CPV)
            .set({
              status: decision.quorumMet ? "signed" : "in_review",
              signedAt: decision.quorumMet ? new Date(at) : null,
              version: sql`${CPV.version} + 1`,
            })
            .where(eq(CPV.id, versionId))
            .returning(),
          "version sign matched no row",
        );
        if (decision.quorumMet) {
          // The last required signature activates the plan and pins the active version (§2.2.2).
          await t
            .update(CP)
            .set({
              status: "active",
              activeVersionId: versionId,
              version: sql`${CP.version} + 1`,
              updatedAt: new Date(),
              ...(v.kind === "initial" ? { initialSignedAt: new Date(at) } : {}),
            })
            .where(eq(CP.id, planId));
          await emit(t, org, "m7.care_plan.version_signed", "care_plan_version", versionId, {
            planId,
            versionId,
            kind: v.kind,
            snapshotRef: versionId,
          });
        }
        return versionDto(updated, await sigsFor(t, versionId));
      });
    },

    async returnVersionToDraft(org, planId, versionId, ifVersion) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
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
        const updated = firstOrThrow(
          await t
            .update(CPV)
            .set({ status: "draft", signedAt: null, version: sql`${CPV.version} + 1` })
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
