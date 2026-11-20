// apps/backend/src/modules/07-care-plan/seams/store.ts — M7-T04 the data PORT the §7.8 CarePlanReader
// composes over, plus an in-memory slice for tests/boot-without-DB. The reader (./reader.ts) is pure
// orchestration over this port; production injects a Drizzle-backed store that reads M7's tables under
// the CONSUMER's `withOrgContext` (the reader never switches tenants — RLS scopes every read by
// `app.org_id`, §7.8). Mirrors the M6 seams/store.ts precedent.
//
// SUD redaction (D7): the store resolves `sudReadAllowed` through the M39 evaluator at call time (only
// `containsSud`, the problem's own flag, comes from the row) and tags each problem `containsSud`. It never
// trusts a caller-asserted SCOPE (§7.8). A caller supplies an audience (`CarePlanElementsAudience`): either a
// per-ACTOR verdict its ROUTE resolved from the same M39 closure every other M7 read uses (only trustworthy from
// such a route — a module that hand-builds `{ sudDisclosureAllowed: true }` would bypass M39), or its SESSION
// identity (`{ actor }`), from which the Drizzle store resolves that verdict itself. The in-memory slice seeds the
// decision directly so reader tests can exercise both the entitled and the redacted paths.
import type {
  CarePlanCodeUsageRecord,
  CarePlanElementsAudience,
  CarePlanId,
  CarePlanVersionStatus,
  ClinicalLinkSummary,
  IsoInstant,
  PatientId,
  RelevantGoal,
  RelevantIntervention,
  RelevantProblem,
} from "@chartwarden/types";

/** A care-plan problem the store hands the reader, carrying the row's own `containsSud` flag (D7). */
export interface StoredRelevantProblem extends Omit<RelevantProblem, "sudRelated"> {
  /** True when this problem is a 42 CFR Part 2 SUD problem — dropped by the reader unless entitled, and handed on
   * as `RelevantProblem.sudRelated` when it is kept. */
  readonly containsSud: boolean;
}

/**
 * The active care plan's element set for a patient, already tenant-scoped by RLS. `sudReadAllowed` is
 * the store's D7 decision, resolved through the M39 evaluator at call time (the caller's scope is never
 * trusted); the reader filters SUD problems out and flags `redacted` when it does.
 */
export interface CarePlanElementsRecord {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly problems: readonly StoredRelevantProblem[];
  readonly goals: readonly RelevantGoal[];
  readonly interventions: readonly RelevantIntervention[];
  /**
   * Whether the caller is entitled to read SUD-flagged content for this patient (resolved through the M39 evaluator
   * at call time, never from the row; or a hand-built viewer's route-resolved verdict, or the seeded value in the
   * in-memory slice).
   */
  readonly sudReadAllowed: boolean;
}

/**
 * The care-plan version in effect at an instant (VN-D11), handed to the reader RAW: `stateSnapshot` is the jsonb
 * the plan was frozen into at finalize (never trusted to have the expected shape), and `sudReadAllowed` is the
 * store's per-viewer Part 2 decision, resolved exactly as for {@link CarePlanElementsRecord}. The reader owns
 * redaction and projection, so no store can hand back an unredacted result for a viewer without disclosure.
 */
export interface CarePlanVersionAtRecord {
  readonly versionId: string;
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly stateSnapshot: unknown;
  readonly sudReadAllowed: boolean;
}

/** The version-clock facts driving the overdue gate — the columns M7's cron maintains (§2.6). */
export interface CarePlanClockRecord {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  readonly hasSignedInitialVersion: boolean;
  readonly initialDueAt: IsoInstant;
  readonly nextReviewDueAt: IsoInstant | null;
  /** `care_plan.initial_signed_at` — lets the gate date a legacy plan whose `nextReviewDueAt` is NULL. */
  readonly initialSignedAt?: IsoInstant | null;
  /** The org's IANA timezone; the writers compute due instants in it, so the gate must grade them in it. */
  readonly timeZone?: string;
}

/**
 * The data port the §7.8 CarePlanReader composes over. Methods return read-only DTO shapes (never
 * Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Both
 * reads key only on `patientId` — the org is already pinned by RLS — and return null when the patient
 * has no active care plan (or it is not visible under the consumer's tenant).
 */
export interface CarePlanReaderStore {
  /** The active care plan's problems/goals/interventions for a patient + the D7 redaction decision. */
  activeCarePlanElements(
    patientId: PatientId,
    admissionId: string | undefined,
    /** REQUIRED: a route-resolved per-actor verdict, or the caller's session identity (`{ actor }`, resolved to a
     * per-actor verdict by the store), replaces the patient-level release check; `"patient_level"` is the explicit
     * choice of the patient-level check, for a caller with no human actor. */
    viewer: CarePlanElementsAudience,
  ): Promise<CarePlanElementsRecord | null>;
  /**
   * VN-D11: the care-plan version of the patient's plan (of `admissionId` when given) in effect at `asOf`: status
   * `signed` or `superseded`, `signed_at <= asOf`, and not superseded at or before `asOf`. A `superseded` version
   * with no `superseded_at` is in effect at no instant (fail closed). Null when none is. The patient's plan may
   * since have been discharged: a late entry for a visit before discharge still reads the plan that was in effect.
   */
  carePlanVersionAsOf(
    patientId: PatientId,
    admissionId: string | undefined,
    asOf: IsoInstant,
    viewer: CarePlanElementsAudience,
  ): Promise<CarePlanVersionAtRecord | null>;
  /** The active care plan's overdue-gate clock facts for a patient (initial/review due columns). */
  activeCarePlanClock(patientId: PatientId): Promise<CarePlanClockRecord | null>;
  /**
   * ORG-LEVEL 15-day review-cycle tally over a DUE-DATE window — M30's `care_plan_15_day_adherence`
   * input. Denominator = care plans whose review fell due inside the window; numerator = those with a
   * signed version by that due date. Aggregate counts only, no patient row crosses (D6).
   */
  fifteenDayCycleCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;

  /**
   * ORG-LEVEL problem-list terminology-code usage restricted to `codes` — M38's §7.3 remediation
   * report input (GAP-063). Active problems only; returns the row id + which code it uses, nothing
   * else (the report is a code-and-count surface, not a chart read).
   */
  terminologyCodeUsageForOrg(
    organizationId: string,
    codes: readonly { readonly systemId: string; readonly code: string }[],
  ): Promise<readonly CarePlanCodeUsageRecord[]>;

  /** M36 clinical link: id, patient, status, updated_at of ONE plan in `organizationId`; null if absent. Org-explicit. */
  linkSummary(organizationId: string, id: CarePlanId): Promise<ClinicalLinkSummary | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────

/** One care-plan version row the in-memory slice serves the as-of read from. */
export interface SeededCarePlanVersion extends CarePlanVersionAtRecord {
  readonly admissionId: string;
  readonly status: CarePlanVersionStatus;
  readonly signedAt: IsoInstant | null;
  readonly supersededAt: IsoInstant | null;
}

/** The as-of slice of the seed (VN-D11). */
export interface CarePlanAsOfSeed {
  readonly versions?: readonly SeededCarePlanVersion[];
}

/** Deterministic, I/O-free seed for the in-memory {@link CarePlanReaderStore} (slice + seam tests). */
export interface CarePlanReaderSeed extends CarePlanAsOfSeed {
  readonly elements?: readonly CarePlanElementsRecord[];
  readonly clocks?: readonly CarePlanClockRecord[];
  /** Problem-list code usage the slice serves M38's remediation rollup (filtered by the caller's set). */
  readonly codeUsage?: readonly CarePlanCodeUsageRecord[];
  /** Plans the by-id link read serves, each tagged with its owning org. */
  readonly links?: readonly (ClinicalLinkSummary & { readonly organizationId: string })[];
}

/**
 * Whether a version is in effect at `asOfMs`: signed at or before it and not superseded until after it. A
 * `superseded` row with no `superseded_at` is an anomaly that cannot be placed in time, so it is in effect at no
 * instant (fail closed). The Drizzle store applies the same predicate in SQL.
 */
function isInEffectAt(v: SeededCarePlanVersion, asOfMs: number): boolean {
  if (v.status !== "signed" && v.status !== "superseded") return false;
  if (v.signedAt === null || Date.parse(v.signedAt) > asOfMs) return false;
  if (v.supersededAt === null) return v.status === "signed";
  return Date.parse(v.supersededAt) > asOfMs;
}

/** An in-memory {@link CarePlanReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryCarePlanReaderStore(seed: CarePlanReaderSeed = {}): {
  store: CarePlanReaderStore;
} {
  const elements = seed.elements ?? [];
  const versions = seed.versions ?? [];
  const clocks = seed.clocks ?? [];
  const codeUsage = seed.codeUsage ?? [];
  const links = seed.links ?? [];
  return {
    store: {
      async activeCarePlanElements(patientId, _admissionId, viewer) {
        const record = elements.find((e) => e.patientId === patientId) ?? null;
        // A route-resolved viewer decides SUD visibility; `"patient_level"` and an `{ actor }` audience both mean
        // "use the seeded `sudReadAllowed`" (this slice has no consent round-trip to run, so it cannot resolve a
        // per-actor verdict — the Drizzle store does, through M39).
        return record && viewer !== "patient_level" && !("actor" in viewer)
          ? { ...record, sudReadAllowed: viewer.sudDisclosureAllowed }
          : record;
      },
      async carePlanVersionAsOf(patientId, admissionId, asOf, viewer) {
        const asOfMs = Date.parse(asOf);
        const inEffect = versions
          .filter(
            (v) =>
              v.patientId === patientId &&
              (admissionId === undefined || v.admissionId === admissionId) &&
              isInEffectAt(v, asOfMs),
          )
          // Exactly one is in effect by construction; if data ever overlaps, the newest signing wins.
          .sort((a, b) => Date.parse(b.signedAt as string) - Date.parse(a.signedAt as string));
        const found = inEffect[0];
        if (found === undefined) return null;
        // Same stance as `activeCarePlanElements`: a route-resolved viewer decides; `"patient_level"` and an
        // `{ actor }` audience use the seeded verdict (this slice has no consent round-trip to run).
        const { admissionId: _a, status: _s, signedAt: _g, supersededAt: _u, ...record } = found;
        return viewer !== "patient_level" && !("actor" in viewer)
          ? { ...record, sudReadAllowed: viewer.sudDisclosureAllowed }
          : record;
      },
      async activeCarePlanClock(patientId) {
        return clocks.find((c) => c.patientId === patientId) ?? null;
      },
      /** Slice default: 0/0 — M30's kernel SUPPRESSES rather than scoring perfect adherence. */
      async fifteenDayCycleCountsForOrg() {
        return { numerator: 0, denominator: 0 };
      },
      async terminologyCodeUsageForOrg(_organizationId, codes) {
        // Same filter the SQL applies, so a seeded row only surfaces when the caller asked for its code.
        const wanted = new Set(codes.map((c) => `${c.systemId} ${c.code}`));
        return codeUsage.filter((r) => wanted.has(`${r.systemId} ${r.code}`));
      },
      async linkSummary(organizationId, id) {
        const hit = links.find((l) => l.organizationId === organizationId && l.id === id);
        if (!hit) return null;
        const { organizationId: _org, ...summary } = hit;
        return summary;
      },
    },
  };
}
