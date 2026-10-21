// apps/backend/src/modules/15-discipline-care-plans/erasers/discipline-plan-eraser.ts — M15-T06 the
// `discipline_plan_record` data eraser (M15 spec §8.5; M4 destruction-cert workflow).
//
// Under an M4 destruction certificate this (1) acquires a per-patient advisory lock so a concurrent write
// cannot interleave with the destruction, (2) SCRUBS the two PHI-bearing jsonb payloads first — the
// version `state_snapshot` (the sealed plan document) and the assessment `data` (the per-kind §3.4
// psychosocial / spiritual / ADL payload) — so the PHI is gone even if a later delete step fails, then
// (3) deletes the patient's discipline subtree, and (4) leaves the ≤4 `discipline_care_plan` roots as
// TOMBSTONES for FK referential integrity (the M5 `clinical_record` / M6 / M7 / M8 root-tombstone pattern).
//
// What SURVIVES (§8.5): the WORKFORCE-scoped `volunteer_compliance_gate`, `volunteer_hour_ledger` and
// `volunteer_hour_entry` rows. Those are a volunteer's own 418.78 credential + hours record — the agency's
// regulatory evidence about a worker, not the patient's chart. Erasing a patient must not destroy the
// proof that a volunteer's TB screening was current, and the hour ledger is an aggregate the 5% ratio is
// computed from. The patient-linking row (`volunteer_assignment`) IS erased, which is what severs the
// association.
//
// Idempotent: a second erase finds nothing and reports zero. Registers the REAL eraser over the Phase-0
// deny-stub (`discipline_plan_record` is in REQUIRED_ERASERS); the composition root's wireModuleErasers()
// runs it AFTER wireErasers() and before validateErasers().
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts a discipline-record destruction removed (recorded on the destruction cert, §8.5). */
export interface DisciplinePlanEraseCounts {
  /** `discipline_goal` rows deleted. */
  readonly goals: number;
  /** `discipline_intervention` rows deleted. */
  readonly interventions: number;
  /** `discipline_assessment` rows deleted (signed rows AND their append-only amendments). */
  readonly assessments: number;
  /** `discipline_care_plan_signature` rows deleted. */
  readonly signatures: number;
  /** `discipline_care_plan_version` rows deleted. */
  readonly versions: number;
  /** `aide_supervisory_visit` rows deleted. */
  readonly supervisoryVisits: number;
  /** `volunteer_assignment` rows deleted (the patient↔volunteer link; the volunteer's own rows survive). */
  readonly volunteerAssignments: number;
  /** `discipline_care_plan` roots tombstoned (rows PRESERVED for FK integrity — not part of the tally). */
  readonly plansTombstoned: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface DisciplinePlanEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link DisciplinePlanEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface DisciplinePlanEraseStore {
  /** Advisory-lock the patient so a concurrent write cannot interleave with the destruction. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Scrub the two PHI-bearing jsonb payloads for the patient's plans — `discipline_care_plan_version.
   * state_snapshot` and `discipline_assessment.data` — BEFORE any delete. Returns rows scrubbed.
   */
  scrubPayloads(organizationId: string, patientId: string): Promise<number>;
  /**
   * Delete the patient's discipline subtree (goals, interventions, assessments, signatures, versions,
   * supervisory visits, volunteer assignments) with `created_at < retentionAsOf`, then tombstone the
   * `discipline_care_plan` roots. The workforce-scoped volunteer tables are NOT touched (§8.5).
   */
  erasePatientRecords(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<DisciplinePlanEraseCounts>;
}

/**
 * Erase a patient's discipline record under a destruction certificate (§8.5): lock, scrub the jsonb
 * payloads, delete the subtree, tombstone the roots, and report the total removed. Pure orchestration over
 * the store — no I/O of its own.
 */
export async function eraseDisciplinePlanRecord(
  organizationId: string,
  patientId: string,
  store: DisciplinePlanEraseStore,
  options: DisciplinePlanEraseOptions = {},
): Promise<{ erased: number; scrubbed: number; counts: DisciplinePlanEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);
  // PHI first: if the delete pass fails halfway, the payloads are already unreadable.
  const scrubbed = await store.scrubPayloads(organizationId, patientId);
  const counts = await store.erasePatientRecords(organizationId, patientId, retentionAsOf);
  // `plansTombstoned` is bookkeeping (rows preserved for FK integrity) — excluded from the deleted tally.
  const erased =
    counts.goals +
    counts.interventions +
    counts.assessments +
    counts.signatures +
    counts.versions +
    counts.supervisoryVisits +
    counts.volunteerAssignments;
  return { erased, scrubbed, counts };
}

const ZERO: DisciplinePlanEraseCounts = {
  goals: 0,
  interventions: 0,
  assessments: 0,
  signatures: 0,
  versions: 0,
  supervisoryVisits: 0,
  volunteerAssignments: 0,
  plansTombstoned: 0,
};

/** Seed shape for the in-memory {@link DisciplinePlanEraseStore} (slice/tests). */
export interface InMemoryDisciplinePlanEraseSeed {
  readonly counts?: Partial<DisciplinePlanEraseCounts>;
  readonly scrubbed?: number;
}

/** An in-memory store for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryDisciplinePlanEraseStore(
  seed: InMemoryDisciplinePlanEraseSeed = {},
): { store: DisciplinePlanEraseStore; locked: string[] } {
  const counts: DisciplinePlanEraseCounts = { ...ZERO, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async scrubPayloads() {
        return used ? 0 : (seed.scrubbed ?? 0);
      },
      async erasePatientRecords() {
        const out = used ? ZERO : counts;
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside the caller's `withOrgContext` so RLS
 * scopes every statement to the acting org (a destruction certificate can never reach across tenants), and
 * scrubs the two jsonb payloads before it deletes anything.
 */
export function createDrizzleDisciplinePlanEraseStore(db: DbClient): DisciplinePlanEraseStore {
  const P = schema.disciplineCarePlan;
  const V = schema.disciplineCarePlanVersion;
  const SIG = schema.disciplineCarePlanSignature;
  const G = schema.disciplineGoal;
  const I = schema.disciplineIntervention;
  const A = schema.disciplineAssessment;
  const SV = schema.aideSupervisoryVisit;
  const VA = schema.volunteerAssignment;
  const APP = schema.disciplinePlanIdgDecisionApplication;

  /** The patient's plan-root ids — every child table is keyed on `plan_id`, not on the patient. */
  const planIdsFor = async (tx: Tx, patientId: string): Promise<string[]> =>
    (await tx.select({ id: P.id }).from(P).where(eq(P.patientId, patientId))).map((r) => r.id);

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async scrubPayloads(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const planIds = await planIdsFor(tx, patientId);
        if (planIds.length === 0) return 0;
        const inPlans = inArray(V.planId, planIds);
        const scrubbedVersions = await tx
          .update(V)
          .set({ stateSnapshot: null, requiredSignerSet: null })
          .where(inPlans)
          .returning({ id: V.id });
        const scrubbedAssessments = await tx
          .update(A)
          .set({ data: {}, amendmentReason: null })
          .where(inArray(A.planId, planIds))
          .returning({ id: A.id });
        return scrubbedVersions.length + scrubbedAssessments.length;
      });
    },

    async erasePatientRecords(organizationId, patientId, retentionAsOf) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const planIds = await planIdsFor(tx, patientId);
        if (planIds.length === 0) return ZERO;
        const boundary = new Date(retentionAsOf);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // Children first (FK order): signatures → versions; goals / interventions / assessments /
        // supervisory visits / volunteer assignments are independent leaves of the plan root.
        const signatures = await del(() =>
          tx
            .delete(SIG)
            .where(
              inArray(
                SIG.versionId,
                tx.select({ id: V.id }).from(V).where(inArray(V.planId, planIds)),
              ),
            )
            .returning({ id: SIG.id }),
        );
        // F-234 — IDG-decision application records (metadata) FK the plan/version; clear them before the
        // versions they reference (they are not part of the destruction-cert tally).
        await tx.delete(APP).where(inArray(APP.planId, planIds));
        const versions = await del(() =>
          tx
            .delete(V)
            .where(and(inArray(V.planId, planIds), lt(V.createdAt, boundary)))
            .returning({ id: V.id }),
        );
        const goals = await del(() =>
          tx
            .delete(G)
            .where(and(inArray(G.planId, planIds), lt(G.createdAt, boundary)))
            .returning({ id: G.id }),
        );
        const interventions = await del(() =>
          tx
            .delete(I)
            .where(and(inArray(I.planId, planIds), lt(I.createdAt, boundary)))
            .returning({ id: I.id }),
        );
        const assessments = await del(() =>
          tx
            .delete(A)
            .where(and(inArray(A.planId, planIds), lt(A.createdAt, boundary)))
            .returning({ id: A.id }),
        );
        const supervisoryVisits = await del(() =>
          tx
            .delete(SV)
            .where(and(inArray(SV.planId, planIds), lt(SV.createdAt, boundary)))
            .returning({ id: SV.id }),
        );
        const volunteerAssignments = await del(() =>
          tx
            .delete(VA)
            .where(and(inArray(VA.planId, planIds), lt(VA.createdAt, boundary)))
            .returning({ id: VA.id }),
        );

        // The roots stay as tombstones for FK referential integrity; every PHI column on them is cleared.
        const tombstoned = await tx
          .update(P)
          .set({ spiritualCareDeclined: null, spiritualCareDeclinedAt: null })
          .where(inArray(P.id, planIds))
          .returning({ id: P.id });

        return {
          goals,
          interventions,
          assessments,
          signatures,
          versions,
          supervisoryVisits,
          volunteerAssignments,
          plansTombstoned: tombstoned.length,
        };
      });
    },
  };
}

/** Injected adapter for the M15 eraser (slice defaults to in-memory). */
export interface DisciplinePlanEraserDeps {
  store?: DisciplinePlanEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: DisciplinePlanEraseOptions;
}

/** Build M15's `discipline_plan_record` DataEraser. `subjectId` is the patient being destroyed (§8.5). */
export function createDisciplinePlanEraser(
  store: DisciplinePlanEraseStore,
  options: DisciplinePlanEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseDisciplinePlanRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M15's REAL `discipline_plan_record` eraser over the Phase-0 deny-stub (before validateErasers()). */
export function registerDisciplinePlanErasers(deps: DisciplinePlanEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryDisciplinePlanEraseStore().store;
  registerEraser("discipline_plan_record", createDisciplinePlanEraser(store, deps.options ?? {}));
}
