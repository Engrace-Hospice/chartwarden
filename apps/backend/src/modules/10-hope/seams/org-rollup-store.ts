// apps/backend/src/modules/10-hope/seams/org-rollup-store.ts — the DEDICATED Drizzle aggregate reader
// backing M10's ORG-LEVEL `HopeOrgRollupProvider` seam (#107). M10's three per-entity seams run on the
// in-memory `HopeSeamStore` (patient/admission/PE keyed); this is a SEPARATE org-scoped aggregate port the
// M30 `m30.measure_recompute` worker consumes to compute the four HOPE-family HQRP measures.
//
// AGGREGATE-ONLY (D6): the store returns thin intermediate rows (the per-row timestamps / J2051 entries the
// pure provider reduces to COUNTS — see org-rollup-provider.ts); only the resulting counts cross the seam
// boundary to M30, never a patient/admission/provider-entity id. The Drizzle adapter reads M10's OWN
// partitioned `hope_assessment` / schedule / SFV / submission tables. Per HARD RULE 1 every query carries a
// belt-and-suspenders `WHERE organization_id = $org` predicate on top of the worker's `withOrgContext` RLS
// envelope (the org param is the authoritative scope; RLS is the second wall).
//
// The pain/non-pain J2051 split is computed in JS in the provider over the `entries` this store projects
// from `hope_assessment.data.J.J2051.entries` (a bounded set — clearer + unit-testable than raw JSONB SQL,
// per the #107 brief). The in-memory double seeds the intermediate rows directly so the provider's
// derivation (the single correctness-critical logic) is exercised with no DB.
import { type DbClient, schema } from "@wardenx/db";
import {
  J2051_SEVERITY_ORDER,
  type HopeRollupPeriod,
  type IsoInstant,
  type J2051Severity,
} from "@wardenx/types";
import { and, count, eq, gte, inArray, lt } from "drizzle-orm";

// ── intermediate row projections (the provider reduces these to counts; never crosses the seam) ──────────

/** A completed timepoint window + its completing assessment's `signedAt` (the on-time anchor vs `lateDeadlineAt`). */
export interface TimepointCompletionRow {
  readonly lateDeadlineAt: IsoInstant;
  /** `signedAt` of the completing `hope_assessment`; null is treated as late (no on-time evidence). */
  readonly completingSignedAt: IsoInstant | null;
}

/** One terminal iQIES submission batch's item posture (the provider SUMs across the period). */
export interface SubmissionPostureRow {
  readonly itemCount: number;
  readonly acceptedCount: number;
}

/** One terminal SFV's due/completion timing (the provider counts due + on-time within the 2-day window). */
export interface SfvTimelinessRow {
  readonly dueAt: IsoInstant;
  /** `completedAt`; null is treated as not-on-time (missed). */
  readonly completedAt: IsoInstant | null;
}

/** One §J2051 symptom-impact reading (the pain/non-pain discriminator + the moderate-or-severe threshold input). */
export interface J2051SeverityEntry {
  readonly symptomCode: string;
  readonly severity: J2051Severity;
}

/** A trigger-fired assessment's J2051 readings + its SFV due/completion timing (the TFP-PI / TFP-NPSI input). */
export interface J2051TriggerRow {
  readonly entries: readonly J2051SeverityEntry[];
  readonly sfvDueAt: IsoInstant | null;
  readonly sfvCompletedAt: IsoInstant | null;
}

/**
 * The org-scoped aggregate data port the {@link createHopeOrgRollupProvider} composes over. Each period-
 * scoped method returns the period's intermediate rows for one HOPE-family measure; `openSfvObligationCount`
 * is point-in-time (no period). The Drizzle adapter projects partition-pruned rows under the caller's RLS +
 * the explicit `organizationId`; the in-memory double seeds the rows directly.
 */
export interface HopeOrgRollupStore {
  completedTimepoints(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<readonly TimepointCompletionRow[]>;
  submissionBatches(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<readonly SubmissionPostureRow[]>;
  terminalSfvs(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<readonly SfvTimelinessRow[]>;
  j2051Triggers(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<readonly J2051TriggerRow[]>;
  openSfvObligationCount(organizationId: string): Promise<number>;
}

// ── Drizzle aggregate reader ─────────────────────────────────────────────────────────────────────────────

const HS = schema.hopeTimepointSchedules;
const HA = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;
const SUB = schema.hopeSubmissions;

/** Project a Drizzle timestamp (Date) — or a defensive string — to an ISO-8601 instant, null-safe. */
const iso = (d: Date | string | null): IsoInstant | null =>
  d === null ? null : typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

/** Narrow an unknown jsonb value to a {@link J2051Severity} (the four CMS impact levels). */
const isSeverity = (v: unknown): v is J2051Severity =>
  typeof v === "string" && (J2051_SEVERITY_ORDER as readonly string[]).includes(v);

/**
 * Extract the §J2051 readings from a `hope_assessment.data` jsonb value at `data.J.J2051.entries`. Returns
 * only well-formed `{ symptomCode, severity }` entries (a malformed/absent payload yields an empty set — the
 * server-authoritative `j2051_trigger_fired` flag is the row filter, not this projection).
 */
function extractEntries(data: unknown): J2051SeverityEntry[] {
  const entries = (data as { J?: { J2051?: { entries?: unknown } } } | null)?.J?.J2051?.entries;
  if (!Array.isArray(entries)) return [];
  const out: J2051SeverityEntry[] = [];
  for (const e of entries) {
    if (e !== null && typeof e === "object") {
      const symptomCode = (e as { symptomCode?: unknown }).symptomCode;
      const severity = (e as { severity?: unknown }).severity;
      if (typeof symptomCode === "string" && isSeverity(severity)) {
        out.push({ symptomCode, severity });
      }
    }
  }
  return out;
}

/**
 * The production {@link HopeOrgRollupStore} over M10's tables. Closes over the pooled `DbClient` (the
 * composition root supplies it via `registerHopeSeams({ db })`); the worker's `withOrgContext` envelope sets
 * `app.org_id` for RLS, and every query additionally pins `organization_id = $org` (HARD RULE 1).
 */
export function createDrizzleHopeOrgRollupStore(db: DbClient): HopeOrgRollupStore {
  return {
    async completedTimepoints(organizationId, period) {
      // Completed schedule windows whose COMPLETING assessment was signed within the period (the completion
      // event is the period anchor); on-time vs late is decided in the provider against `lateDeadlineAt`.
      const rows = await db
        .select({ lateDeadlineAt: HS.lateDeadlineAt, completingSignedAt: HA.signedAt })
        .from(HS)
        .innerJoin(HA, eq(HS.completedByAssessmentId, HA.id))
        .where(
          and(
            eq(HS.organizationId, organizationId),
            eq(HA.organizationId, organizationId),
            eq(HS.status, "completed"),
            gte(HA.signedAt, new Date(period.from)),
            lt(HA.signedAt, new Date(period.to)),
          ),
        );
      return rows.map((r) => ({
        lateDeadlineAt: iso(r.lateDeadlineAt) ?? new Date(0).toISOString(),
        completingSignedAt: iso(r.completingSignedAt),
      }));
    },

    async submissionBatches(organizationId, period) {
      // Transmitted batches with a terminal acceptance posture in the period (period anchored on transmittedAt).
      const rows = await db
        .select({ itemCount: SUB.itemCount, acceptedCount: SUB.acceptedCount })
        .from(SUB)
        .where(
          and(
            eq(SUB.organizationId, organizationId),
            inArray(SUB.status, ["accepted", "rejected", "partially_accepted"]),
            gte(SUB.transmittedAt, new Date(period.from)),
            lt(SUB.transmittedAt, new Date(period.to)),
          ),
        );
      return rows.map((r) => ({ itemCount: r.itemCount, acceptedCount: r.acceptedCount }));
    },

    async terminalSfvs(organizationId, period) {
      // SFVs triggered in the period that reached a terminal outcome (completed / missed) — the on-time
      // denominator; `overdue`/`open` are still-running obligations and are excluded here.
      const rows = await db
        .select({ dueAt: SFV.dueAt, completedAt: SFV.completedAt })
        .from(SFV)
        .where(
          and(
            eq(SFV.organizationId, organizationId),
            inArray(SFV.status, ["completed", "missed"]),
            gte(SFV.triggeredAt, new Date(period.from)),
            lt(SFV.triggeredAt, new Date(period.to)),
          ),
        );
      return rows.map((r) => ({
        dueAt: iso(r.dueAt) ?? new Date(0).toISOString(),
        completedAt: iso(r.completedAt),
      }));
    },

    async j2051Triggers(organizationId, period) {
      // Trigger-fired assessments signed in the period, LEFT-joined to their single SFV (one SFV per
      // triggering assessment, D4). The pain/non-pain split + in-window check run in the provider over
      // `entries`. Only the J2051 readings + SFV timing leave the DB — no patient identifier.
      const rows = await db
        .select({ data: HA.data, sfvDueAt: SFV.dueAt, sfvCompletedAt: SFV.completedAt })
        .from(HA)
        .leftJoin(SFV, eq(SFV.triggeringAssessmentId, HA.id))
        .where(
          and(
            eq(HA.organizationId, organizationId),
            eq(HA.j2051TriggerFired, true),
            gte(HA.signedAt, new Date(period.from)),
            lt(HA.signedAt, new Date(period.to)),
          ),
        );
      return rows.map((r) => ({
        entries: extractEntries(r.data),
        sfvDueAt: iso(r.sfvDueAt),
        sfvCompletedAt: iso(r.sfvCompletedAt),
      }));
    },

    async openSfvObligationCount(organizationId) {
      const [row] = await db
        .select({ n: count() })
        .from(SFV)
        .where(and(eq(SFV.organizationId, organizationId), inArray(SFV.status, ["open", "overdue"])));
      return row?.n ?? 0;
    },
  };
}

// ── in-memory double (provider unit tests / boot-without-DB) ─────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link HopeOrgRollupStore} (provider-derivation tests). */
export interface HopeOrgRollupSeed {
  readonly completedTimepoints?: readonly TimepointCompletionRow[];
  readonly submissionBatches?: readonly SubmissionPostureRow[];
  readonly terminalSfvs?: readonly SfvTimelinessRow[];
  readonly j2051Triggers?: readonly J2051TriggerRow[];
  readonly openSfvObligations?: number;
}

/** An in-memory {@link HopeOrgRollupStore} that returns the seeded intermediate rows verbatim (no DB, no RLS). */
export function createInMemoryHopeOrgRollupStore(
  seed: HopeOrgRollupSeed = {},
): { store: HopeOrgRollupStore } {
  return {
    store: {
      async completedTimepoints() {
        return seed.completedTimepoints ?? [];
      },
      async submissionBatches() {
        return seed.submissionBatches ?? [];
      },
      async terminalSfvs() {
        return seed.terminalSfvs ?? [];
      },
      async j2051Triggers() {
        return seed.j2051Triggers ?? [];
      },
      async openSfvObligationCount() {
        return seed.openSfvObligations ?? 0;
      },
    },
  };
}
