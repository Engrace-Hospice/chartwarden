// apps/backend/src/modules/10-hope/erasers/hope-eraser.ts — M10-T08 the `hope_record` data eraser
// (M10 spec §8.4; M4 destruction-cert workflow, D7/D8).
//
// M10 owns the destruction callback for a patient's HOPE record — the timepoint subtree M10 captures around
// the M5 patient spine / M6 admission anchor. Under an M4 destruction certificate it (1) acquires a
// per-patient advisory lock so a concurrent write cannot interleave with the destruction (§8.4 #1), (2)
// validates the CMS 10-year EXTENDED RETENTION on submitted assessments — if any `hope_assessment` was
// transmitted to iQIES and `beforeDate` falls before `youngest.transmittedAt + 10y`, the erase is REFUSED
// with {@link HopeRetentionBlockedError} unless a legal-hold override is supplied (§8.4 step 1), (3) erases
// the partitioned `hope_assessment` rows — at PARTITION granularity (DETACH + DROP) when a partition is
// wholly erasable, by row-level delete for a mixed partition (§8.4 step 2) — together with the child
// `hope_timepoint_schedule` / `symptom_follow_up_visit` / `hope_validation_finding` rows (§8.4 step 3).
// `hope_submission` / `hope_submission_item` rows SURVIVE: the envelope SHA-256 is operational/compliance
// evidence; the per-patient envelope CONTENT in MinIO is purged by M4's envelope-purge worker, not here.
// Both `signed` AND `superseded` assessments are erased so a correction-supersede chain is removed at both
// ends and no orphaned half survives. The four sibling clinical erasers are disjoint by table ownership: M5
// destroys the patient demographics subtree, M6 the admission subtree, M7 the care-plan subtree, M8 the
// encounter subtree, M9 the clinical-scale rows, M10 the HOPE timepoint subtree.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`hope_record` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts a HOPE-record destruction removed (recorded on the destruction cert, §8.4). */
export interface HopeEraseCounts {
  /** `hope_timepoint_schedule` rows deleted. */
  readonly schedules: number;
  /** `symptom_follow_up_visit` rows deleted. */
  readonly sfvs: number;
  /** `hope_validation_finding` rows deleted. */
  readonly validationFindings: number;
  /** `hope_assessment` rows removed (whether by partition drop or row delete). */
  readonly assessments: number;
  /** Whole `hope_assessment` partitions DETACHed + DROPped (the partition-drop path, §8.4 step 2). */
  readonly partitionsDropped: number;
}

/** A submitted assessment's retention anchor — its iQIES transmission instant drives the CMS 10-year clock. */
export interface SubmittedAssessmentRef {
  readonly id: string;
  /** ISO instant the envelope carrying this assessment was transmitted to iQIES. */
  readonly transmittedAt: string;
}

/** Thrown when an erase would breach the CMS 10-year extended retention on a submitted assessment (§8.4). */
export class HopeRetentionBlockedError extends Error {
  readonly dataClass = "hope_record" as const;
  readonly earliestErasable: string;
  readonly submittedCount: number;
  constructor(earliestErasable: string, submittedCount: number) {
    super(
      `hope_record erase blocked: ${submittedCount} submitted assessment(s) under CMS 10-year retention; earliest erasable ${earliestErasable}`,
    );
    this.name = "HopeRetentionBlockedError";
    this.earliestErasable = earliestErasable;
    this.submittedCount = submittedCount;
  }
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now, no override). */
export interface HopeEraseOptions {
  /** Erase rows with `target_date < beforeDate`; defaults to {@link HopeEraseOptions.now}'s instant. */
  readonly beforeDate?: string;
  /** Bypass the CMS 10-year extended-retention block (M4 legal-hold workflow, §8.4). */
  readonly legalHoldOverride?: boolean;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/**
 * Add `years` calendar years to an ISO instant, preserving month/day (the CMS 10-year retention horizon).
 * Pure — no ambient clock. Feb-29 anchors land on Feb-28/Mar-1 per JS `setUTCFullYear`, acceptable at the
 * 10-year granularity this guards.
 */
export function addYears(isoInstant: string, years: number): string {
  const d = new Date(isoInstant);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

/**
 * The earliest instant a patient's submitted HOPE assessments may be erased — `youngest.transmittedAt + 10y`,
 * or `null` when nothing was submitted (no retention floor applies). Pure (≥95% covered per §9.1).
 */
export function earliestErasableInstant(
  submitted: readonly SubmittedAssessmentRef[],
): string | null {
  if (submitted.length === 0) return null;
  const youngest = submitted.reduce((a, b) => (a.transmittedAt > b.transmittedAt ? a : b));
  return addYears(youngest.transmittedAt, 10);
}

/**
 * Decide whether a HOPE erase is blocked by the CMS 10-year extended retention (§8.4 step 1). Blocked iff
 * there is at least one submitted assessment, no legal-hold override, AND `beforeDate` precedes the
 * earliest-erasable instant. Pure.
 */
export function isHopeErasureBlocked(
  submitted: readonly SubmittedAssessmentRef[],
  beforeDate: string,
  legalHoldOverride: boolean,
): boolean {
  if (legalHoldOverride) return false;
  const earliest = earliestErasableInstant(submitted);
  return earliest !== null && beforeDate < earliest;
}

/** The narrow data port the HOPE eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface HopeEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with
   * the destruction (§8.4 #1). Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /** The patient's submitted (iQIES-transmitted) assessments — the CMS-retention anchors (§8.4 step 1). */
  getSubmittedAssessments(
    organizationId: string,
    patientId: string,
  ): Promise<readonly SubmittedAssessmentRef[]>;
  /**
   * Erase the patient's `hope_assessment` rows (`target_date < beforeDate`; partition DETACH+DROP where a
   * partition is wholly erasable, row-level delete otherwise) plus the child `hope_timepoint_schedule` /
   * `symptom_follow_up_visit` / `hope_validation_finding` rows. `hope_submission` rows are left intact
   * (§8.4 steps 2–3). Returns per-table counts.
   */
  eraseHopeSubtree(
    organizationId: string,
    patientId: string,
    beforeDate: string,
  ): Promise<HopeEraseCounts>;
}

/**
 * Erase a patient's HOPE-record subtree under a destruction certificate (D7/D8): lock the patient, enforce
 * the CMS 10-year extended retention, then delete the assessment rows and child rows and report the total
 * removed. Pure orchestration over the store — no I/O of its own. Throws {@link HopeRetentionBlockedError}
 * when retention blocks the erase (§8.4 step 1).
 */
export async function eraseHopeRecord(
  organizationId: string,
  patientId: string,
  store: HopeEraseStore,
  options: HopeEraseOptions = {},
): Promise<{ erased: number; counts: HopeEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const beforeDate = options.beforeDate ?? now();
  const legalHoldOverride = options.legalHoldOverride ?? false;

  await store.lockPatient(organizationId, patientId);

  const submitted = await store.getSubmittedAssessments(organizationId, patientId);
  if (isHopeErasureBlocked(submitted, beforeDate, legalHoldOverride)) {
    // earliest is non-null here (isHopeErasureBlocked returned true).
    const earliest = earliestErasableInstant(submitted) as string;
    throw new HopeRetentionBlockedError(earliest, submitted.length);
  }

  const counts = await store.eraseHopeSubtree(organizationId, patientId, beforeDate);
  // partitionsDropped is bookkeeping (how the assessment rows left), already counted in `assessments`.
  const erased = counts.schedules + counts.sfvs + counts.validationFindings + counts.assessments;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link HopeEraseStore} (slice/tests). */
export interface InMemoryHopeEraseSeed {
  /** Per-table counts a first erase removes; `partitionsDropped` selects the partition-drop vs row-delete path. */
  readonly counts?: Partial<HopeEraseCounts>;
  /** Submitted assessments under CMS retention (drives the extended-retention block / override paths). */
  readonly submitted?: readonly SubmittedAssessmentRef[];
}

/** An in-memory {@link HopeEraseStore} for the slice/tests (seeded counts + submitted refs). */
export function createInMemoryHopeEraseStore(seed: InMemoryHopeEraseSeed = {}): {
  store: HopeEraseStore;
  locked: string[];
} {
  const zero: HopeEraseCounts = {
    schedules: 0,
    sfvs: 0,
    validationFindings: 0,
    assessments: 0,
    partitionsDropped: 0,
  };
  const counts: HopeEraseCounts = { ...zero, ...seed.counts };
  const submitted = seed.submitted ?? [];
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async getSubmittedAssessments() {
        return submitted;
      },
      async eraseHopeSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path (TASK-003 / ARCH-007). Runs inside
 * `withOrgContext` so RLS scopes every statement to the acting org. The CMS 10-year retention decision
 * itself stays in the ORCHESTRATOR ({@link eraseHopeRecord} refuses with
 * {@link HopeRetentionBlockedError}); this store only answers `getSubmittedAssessments` truthfully —
 * an assessment is "submitted" iff a `hope_submission_item` links it to a `hope_submission` whose
 * `transmitted_at` is set (the iQIES transmission instant that anchors the 10-year clock).
 *
 * `hope_assessment` is RANGE-partitioned by `target_date`: every statement targets the PARTITIONED
 * PARENT (exactly how the M10 route services access it), so Postgres routes across all monthly
 * partitions. This store always takes the §8.4-step-2 ROW-DELETE path (`target_date < beforeDate` via
 * the parent) and reports `partitionsDropped: 0` — DETACH+DROP is a DDL fast-path over the same
 * semantics that requires table ownership and partition-boundary bookkeeping a tenant-scoped
 * transaction cannot do; the row path is correct at every granularity. `hope_submission` /
 * `hope_submission_item` rows SURVIVE untouched (compliance evidence; the envelope CONTENT is purged
 * by M4's envelope-purge worker). Counts come from `returning` lengths (rows ACTUALLY removed). The
 * M10 grants give `wardenx_app` no DELETE (append-only), so under an app-role connection Postgres
 * REFUSES the delete and this store THROWS — the destruction path must be handed a privileged
 * (wardenx_admin) `DbClient` at the composition root.
 */
export function createDrizzleHopeEraseStore(db: DbClient): HopeEraseStore {
  const A = schema.hopeAssessments;
  const SCHED = schema.hopeTimepointSchedules;
  const SFV = schema.symptomFollowUpVisits;
  const FINDING = schema.hopeValidationFindings;
  const SUB = schema.hopeSubmissions;
  const ITEM = schema.hopeSubmissionItems;

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key (§8.4 #1), released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async getSubmittedAssessments(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ id: A.id, transmittedAt: SUB.transmittedAt })
          .from(A)
          .innerJoin(ITEM, eq(ITEM.hopeAssessmentId, A.id))
          .innerJoin(SUB, eq(SUB.id, ITEM.hopeSubmissionId))
          .where(and(eq(A.patientId, patientId), isNotNull(SUB.transmittedAt)));
        // transmittedAt is non-null under the isNotNull predicate; keep the guard for the type system.
        return rows
          .filter((r): r is { id: string; transmittedAt: Date } => r.transmittedAt !== null)
          .map((r) => ({ id: r.id, transmittedAt: r.transmittedAt.toISOString() }));
      });
    },

    async eraseHopeSubtree(organizationId, patientId, beforeDate) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const zero: HopeEraseCounts = {
          schedules: 0,
          sfvs: 0,
          validationFindings: 0,
          assessments: 0,
          partitionsDropped: 0,
        };
        const boundary = new Date(beforeDate);
        // The erasable assessments (`target_date < beforeDate`, via the partitioned parent) — the
        // validation findings are keyed on assessment id (plain uuid), so resolve the ids first.
        const erasableIds = (
          await tx
            .select({ id: A.id })
            .from(A)
            .where(and(eq(A.patientId, patientId), lt(A.targetDate, boundary)))
        ).map((r) => r.id);

        // §8.4 step 3 children first. Findings are scoped to the ERASED assessments; SFVs and
        // schedules are patient-level children (plain-uuid links, no FK from them to the parent).
        const validationFindings =
          erasableIds.length === 0
            ? 0
            : (
                await tx
                  .delete(FINDING)
                  .where(inArray(FINDING.hopeAssessmentId, erasableIds))
                  .returning({ id: FINDING.id })
              ).length;
        const sfvs = (
          await tx.delete(SFV).where(eq(SFV.patientId, patientId)).returning({ id: SFV.id })
        ).length;
        // §8.4 step 2: the assessment rows themselves — signed AND superseded — via the parent.
        // Deleted BEFORE the schedules: `hope_assessment.schedule_id` is a real intra-module FK, so a
        // schedule delete with a surviving referencing assessment would (correctly) fail closed.
        const assessments =
          erasableIds.length === 0
            ? 0
            : (
                await tx
                  .delete(A)
                  .where(and(eq(A.patientId, patientId), lt(A.targetDate, boundary)))
                  .returning({ id: A.id })
              ).length;
        const schedules = (
          await tx.delete(SCHED).where(eq(SCHED.patientId, patientId)).returning({ id: SCHED.id })
        ).length;

        // Row-delete path only — see the factory doc; a partition is never DETACHed/DROPped here.
        // Idempotent by construction: a second erase finds nothing and reports `zero`'s shape.
        return { ...zero, schedules, sfvs, validationFindings, assessments };
      });
    },
  };
}

/** Injected adapter for the M10 eraser (slice defaults to in-memory). */
export interface HopeEraserDeps {
  store?: HopeEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: HopeEraseOptions;
}

/** Build M10's `hope_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createHopeEraser(
  store: HopeEraseStore,
  options: HopeEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseHopeRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M10's REAL `hope_record` eraser over the Phase-0 deny-stub (M10-T08; before validateErasers()). */
export function registerHopeErasers(deps: HopeEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryHopeEraseStore().store;
  registerEraser("hope_record", createHopeEraser(store, deps.options ?? {}));
}
