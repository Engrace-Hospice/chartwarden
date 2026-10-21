// apps/backend/src/modules/07-care-plan/erasers/care-plan-eraser.ts — M7-T09 the `care_plan_record`
// data eraser (M7 spec §3.6 / §11 D8; M4 destruction-cert workflow, D7/D8).
//
// M7 owns the destruction callback for a patient's CARE PLAN record — the IPOC satellites M7 creates
// around the M5 patient spine: care-plan versions, their signatures, and the problem / goal /
// intervention element rows. Under an M4 destruction certificate it erases that subtree for the subject
// patient while leaving the `care_plan` root as a TOMBSTONE (status flip; the PK survives for FK
// referential integrity) — the same D8 resolver pattern M5's `clinical_record` and M6's
// `admission_record` erasers use. The three erasers are disjoint by table ownership: M5 destroys the
// patient demographics subtree, M6 the admission subtree, M7 the care-plan subtree it owns.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`care_plan_record` is in REQUIRED_ERASERS);
// the composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq, inArray } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts a care-plan-record destruction removed (recorded on the destruction cert). */
export interface CarePlanEraseCounts {
  readonly versions: number;
  readonly signatures: number;
  readonly problems: number;
  readonly goals: number;
  readonly interventions: number;
  /** F-238 — DocLens problem proposals (pending/accepted/dismissed) on the patient's plans. */
  readonly problemProposals: number;
}

/** The narrow data port the care-plan eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface CarePlanEraseStore {
  /** Delete the patient's care-plan satellites; return per-table counts. The `care_plan` root is NOT deleted. */
  eraseCarePlanSubtree(organizationId: string, patientId: string): Promise<CarePlanEraseCounts>;
  /** Tombstone the patient's `care_plan` root(s) (status flip; keeps the PK for FK integrity, D8). */
  tombstoneCarePlans(organizationId: string, patientId: string): Promise<void>;
}

/**
 * Erase a patient's care-plan-record subtree under a destruction certificate (D7/D8): delete the
 * version/signature/problem/goal/intervention rows, tombstone the `care_plan` root(s), and report the
 * total removed. Pure orchestration over the store — no I/O of its own.
 */
export async function eraseCarePlanRecord(
  organizationId: string,
  patientId: string,
  store: CarePlanEraseStore,
): Promise<{ erased: number; counts: CarePlanEraseCounts }> {
  const counts = await store.eraseCarePlanSubtree(organizationId, patientId);
  await store.tombstoneCarePlans(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link CarePlanEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryCarePlanEraseStore(seed: Partial<CarePlanEraseCounts> = {}): {
  store: CarePlanEraseStore;
  tombstoned: string[];
} {
  const zero: CarePlanEraseCounts = {
    versions: 0,
    signatures: 0,
    problems: 0,
    goals: 0,
    interventions: 0,
    problemProposals: 0,
  };
  const counts: CarePlanEraseCounts = { ...zero, ...seed };
  const tombstoned: string[] = [];
  let used = false;
  return {
    tombstoned,
    store: {
      async eraseCarePlanSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
      async tombstoneCarePlans(_org, patientId) {
        tombstoned.push(patientId);
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path (TASK-003 / ARCH-007). Runs inside
 * `withOrgContext` so RLS scopes every statement to the acting org (a destruction certificate can
 * never reach across tenants). Deletes report ONLY rows actually removed (`returning` lengths);
 * migration 0029 grants `chartwarden_app` no DELETE on any care-plan table (append-only for survey
 * reconstruction), so under an app-role connection Postgres REFUSES the delete and this store THROWS —
 * the destruction path must be handed a privileged (chartwarden_admin) `DbClient` at the composition root.
 */
export function createDrizzleCarePlanEraseStore(db: DbClient): CarePlanEraseStore {
  const PLAN = schema.carePlans;
  const V = schema.carePlanVersions;
  const SIG = schema.carePlanSignatures;
  const PROB = schema.problems;
  const PP = schema.problemProposals;
  const G = schema.goals;
  const I = schema.interventions;

  /** The patient's plan-root ids — every satellite is keyed on `care_plan_id`, not on the patient. */
  const planIdsFor = async (tx: Tx, patientId: string): Promise<string[]> =>
    (await tx.select({ id: PLAN.id }).from(PLAN).where(eq(PLAN.patientId, patientId))).map(
      (r) => r.id,
    );

  return {
    async eraseCarePlanSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const planIds = await planIdsFor(tx, patientId);
        const zero: CarePlanEraseCounts = {
          versions: 0,
          signatures: 0,
          problems: 0,
          goals: 0,
          interventions: 0,
          problemProposals: 0,
        };
        if (planIds.length === 0) return zero; // idempotent: a second erase finds nothing.
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // FK order: signature → version (signatures hang off care_plan_version); goal / intervention →
        // problem (both carry a `problem_id` RESTRICT FK); versions and problems then fall to the plan.
        const signatures = await del(() =>
          tx
            .delete(SIG)
            .where(
              inArray(
                SIG.carePlanVersionId,
                tx.select({ id: V.id }).from(V).where(inArray(V.carePlanId, planIds)),
              ),
            )
            .returning({ id: SIG.id }),
        );
        const versions = await del(() =>
          tx.delete(V).where(inArray(V.carePlanId, planIds)).returning({ id: V.id }),
        );
        const goals = await del(() =>
          tx.delete(G).where(inArray(G.carePlanId, planIds)).returning({ id: G.id }),
        );
        const interventions = await del(() =>
          tx.delete(I).where(inArray(I.carePlanId, planIds)).returning({ id: I.id }),
        );
        // F-238 — proposals reference `problem` (accepted_problem_id / duplicate_of_problem_id, RESTRICT).
        const problemProposals = await del(() =>
          tx.delete(PP).where(inArray(PP.carePlanId, planIds)).returning({ id: PP.id }),
        );
        const problems = await del(() =>
          tx.delete(PROB).where(inArray(PROB.carePlanId, planIds)).returning({ id: PROB.id }),
        );

        return { versions, signatures, problems, goals, interventions, problemProposals };
      });
    },

    async tombstoneCarePlans(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // D8 tombstone: the root row SURVIVES for FK referential integrity — status flips to the
        // terminal 'discharged' and the soft self-ref to the (now-deleted) active version is cleared,
        // along with the scheduling columns that no longer mean anything.
        await tx
          .update(PLAN)
          .set({ status: "discharged", activeVersionId: null, nextReviewDueAt: null })
          .where(eq(PLAN.patientId, patientId));
      });
    },
  };
}

/** Injected adapter for the M7 eraser (slice defaults to in-memory). */
export interface CarePlanEraserDeps {
  store?: CarePlanEraseStore;
}

/** Build M7's `care_plan_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createCarePlanEraser(store: CarePlanEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseCarePlanRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M7's REAL `care_plan_record` eraser over the Phase-0 deny-stub (M7-T09; before validateErasers()). */
export function registerCarePlanErasers(deps: CarePlanEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryCarePlanEraseStore().store;
  registerEraser("care_plan_record", createCarePlanEraser(store));
}
