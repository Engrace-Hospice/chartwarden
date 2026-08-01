// apps/backend/src/modules/07-care-plan — PRODUCTION CarePlanRouteService, READ-first (M7L-T01).
//
// The screen-driving READS (the patient's care plan aggregate, the §7.5 summary card, the version
// ledger + a single version) run as real Drizzle queries over the M7-owned tables inside
// `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged `wardenx_app` role.
// The §7.6 SUD confidentiality filter is applied per-caller via the same pure redaction helpers the
// in-memory slice uses (`filterVisibleProblems` / `filterAnchoredToVisible` / `redactedSudProblemIds`),
// and it fails closed — no `viewer` ⇒ the internal/system read path (full set), a `viewer` with
// `sudDisclosureAllowed=false` ⇒ SUD problems (and their dependent goals/interventions) are omitted.
// The full WRITE lifecycle (bootstrap → version draft/finalize/sign/return → problem/goal/intervention
// authoring, with §7.7 optimistic concurrency + the `m7.*` outbox) is the M7L-T02+ follow-up; every
// write here fail-closes 501 (`NOT_IMPLEMENTED`). The in-memory `createInMemoryCarePlanBackend`
// (`routes/service.ts`) stays the behavioral reference and DTO source-of-truth for those writes.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  filterAnchoredToVisible,
  filterVisibleProblems,
  redactedSudProblemIds,
} from "./authoring/index";
import type { CarePlanRouteService, CarePlanViewer } from "./routes/service";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;
const SIG = schema.carePlanSignatures;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** A never-returning stub for the write lifecycle still owed by M7L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "care-plan writes arrive in M7L-T02+ (the Drizzle write lifecycle)",
    501,
  );
};

/**
 * The production, RLS-backed CarePlanRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `org` — never the body.
 */
export function createDbCarePlanRouteService(db: DbClient): CarePlanRouteService {
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
  // NOTE (shape approximation): `care_plan` and `care_plan_version` carry no optimistic-concurrency
  // `version` column (unlike problem/goal/intervention which do). The in-memory DTO exposes a `version`
  // that starts at 1 and increments on each mutation — an in-memory-only construct. Reads here surface a
  // stable `version: 1`; the real counter lands with the M7L-T02+ write lifecycle (writes are 501 today,
  // so nothing consumes it yet). Every element `version` below IS the real DB column.
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
    version: 1,
  });

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
          .where(inArray(SIG.carePlanVersionId, ids))
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
          version: 1,
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
        const [v] = await t
          .select()
          .from(CPV)
          .where(and(eq(CPV.id, versionId), eq(CPV.carePlanId, planId)))
          .limit(1);
        if (!v) throw new NotFoundError("care_plan_version", versionId);
        const sigRows = await t
          .select({ signerRole: SIG.signerRole, signedAt: SIG.signedAt })
          .from(SIG)
          .where(eq(SIG.carePlanVersionId, v.id));
        return versionDto(
          v,
          sigRows.map((s) => ({ signerRole: s.signerRole, signedAt: iso(s.signedAt) })),
        );
      });
    },

    // ── Writes — the M7L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ─────────────────────────
    bootstrapCarePlan: async () => notImpl(),
    createVersion: async () => notImpl(),
    finalizeVersion: async () => notImpl(),
    signVersion: async () => notImpl(),
    returnVersionToDraft: async () => notImpl(),
    addProblem: async () => notImpl(),
    patchProblem: async () => notImpl(),
    resolveProblem: async () => notImpl(),
    addGoal: async () => notImpl(),
    patchGoal: async () => notImpl(),
    addIntervention: async () => notImpl(),
    patchIntervention: async () => notImpl(),
    discontinueIntervention: async () => notImpl(),
  };
}
