// apps/backend/src/modules/07-care-plan/seams/drizzle-store.ts — the FULL Drizzle implementation of
// M7's seam store (TASK-002; previously a partial overlay that spread the in-memory slice).
//
// Every {@link CarePlanReaderStore} method now answers from the real care-plan tables — nothing falls
// back to the in-memory Map, so a prod boot that binds this store serves M8's encounter picker + sign
// gate, M14's packet build, and M15's discipline plans from the same rows the M7 routes write.
//
// TENANCY, two shapes (the M21 store-drizzle precedent):
//   • `activeCarePlanElements` / `activeCarePlanClock` take NO org argument — they run under the
//     CONSUMER'S ambient request context via `withOrgContextFromRequest`, so RLS pins `app.org_id`
//     from whoever is asking (M8's caller's org, never a tenant switch). Called outside a request
//     scope they THROW rather than read unscoped — the correct direction for a PHI surface.
//   • `fifteenDayCycleCountsForOrg` takes an explicit `organizationId` (the M30 recompute worker has
//     no request scope) — it SELF-SCOPES via `withOrgContext`, with the explicit `organization_id`
//     predicate as the second wall.
//
// SUD (D7, §7.8): `sudReadAllowed` is the patient-level M39 Part-2 consent fact — resolved through the
// `ConsentEvaluator` seam at call time (the M16 disclosure-gate precedent), NEVER a caller-asserted
// scope. FAIL-CLOSED: while M39 is a deny-stub, throws, or denies, the record reads
// `sudReadAllowed=false` and the reader drops SUD problems + flags `redacted` — a consent outage
// narrows what a clinician sees; it never widens it. The consent round-trip is skipped entirely when
// the plan carries no SUD-flagged problem (the verdict would be unobservable).
import { type DbClient, schema } from "@wardenx/db";
import { getRequestContext, withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type { CarePlanCodeUsageRecord } from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getSeam } from "../../../bootstrap/index";
import {
  type ClaimDiagnosisCandidate,
  type ClaimDiagnosisRecord,
  type ClaimDiagnosisResult,
  applyPart2ClaimGate,
  needsPart2Decision,
} from "./claim-diagnoses-gate";
import type {
  CarePlanClockRecord,
  CarePlanElementsRecord,
  CarePlanReaderStore,
  StoredRelevantProblem,
} from "./store";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;

/** The actor id the org-level read's withOrgContext envelope carries — an aggregate read has no acting user. */
const CARE_PLAN_READER_SYSTEM_USER_ID = "";

/** Coerce a Drizzle timestamp to an ISO instant (non-null column). */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);
/** Same, nullable. */
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));

/** The minimal M39 surface this store calls — structurally typed so M7 takes no `@wardenx/consent`
 * import edge (the M16 `ConsentEvaluatorShape` precedent). */
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string; membershipId?: string };
    callerModule: string;
  }): Promise<{ allowed: boolean }>;
}

/**
 * The patient-level 42 CFR Part 2 release fact (D7): is a `42_cfr_part_2_release` consent satisfied
 * for this patient right now? Lazy `getSeam` per call (registration order is irrelevant), FAIL-CLOSED
 * on an unbound/erroring M39 — redact, never disclose. The evaluator's verdict keys on the patient's
 * consent records (active/expiry/post-death), not the session class; `staff` + the ambient membership
 * are passed as the truthful in-request context of the staff-app seam consumers (M8/M14/M15).
 */
async function part2ReleaseAllowed(organizationId: string, patientId: string): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
    const verdict = await evaluator.evaluate({
      organizationId,
      patientId,
      consentType: "42_cfr_part_2_release",
      sessionContext: { sessionClass: "staff", membershipId: getRequestContext()?.userId },
      callerModule: "m7",
    });
    return verdict.allowed === true;
  } catch {
    return false; // §8.7 — an unbound/erroring M39 REDACTS, never discloses
  }
}

/**
 * Build the production Drizzle-backed {@link CarePlanReaderStore}. No in-memory fallback: every
 * method reads M7's tables.
 *
 * ACTIVE-PLAN SELECTION (both patient-keyed reads): the patient's non-`discharged` plan, oldest
 * `created_at` first — the same row the route service's `getCarePlanForPatient` resolves, narrowed by
 * the bootstrap invariant (`care_plan_one_per_admission_uq` keeps at most one non-discharged plan per
 * admission). No visible plan ⇒ null, per the interface docs.
 *
 * ★ INTERPRETATION (flagged): `RelevantGoal.text` is the goal's CURRENT display text —
 *   `revised_text` when a clinician has revised it, else the verbatim `original_text` (the §7.3/D6
 *   pair the write path maintains). The alternative — always `original_text` — would show a stale
 *   goal in the encounter picker after every revision.
 */
export function createDrizzleCarePlanReaderStore(db: DbClient): CarePlanReaderStore {
  /** Resolve the patient's active (non-discharged) plan row under the ambient tenant, or null. */
  async function loadActivePlan(
    tx: DbClient,
    patientId: string,
    admissionId?: string,
  ): Promise<typeof CP.$inferSelect | null> {
    const [row] = await tx
      .select()
      .from(CP)
      .where(
        and(
          eq(CP.patientId, patientId),
          ne(CP.status, "discharged"),
          ...(admissionId ? [eq(CP.admissionId, admissionId)] : []),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    async activeCarePlanElements(patientId, admissionId): Promise<CarePlanElementsRecord | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadActivePlan(t, patientId, admissionId);
        if (!plan) return null;
        // Full element sets, every status — the reader owns the active/discipline filters (§7.8), so
        // the store must not pre-narrow (mirrors the in-memory record shape).
        const [probRows, goalRows, intvRows] = await Promise.all([
          t.select().from(PROB).where(eq(PROB.carePlanId, plan.id)),
          t.select().from(GOAL).where(eq(GOAL.carePlanId, plan.id)),
          t.select().from(INTV).where(eq(INTV.carePlanId, plan.id)),
        ]);
        const problems: StoredRelevantProblem[] = probRows.map((r) => ({
          problemId: r.id,
          icd10Code: r.icd10Code ?? null,
          snomedCode: r.snomedCode ?? null,
          description: r.description,
          kind: r.kind,
          status: r.status,
          containsSud: r.sudRelated,
        }));
        // The D7 decision is only observable when SUD content exists — skip the M39 round-trip otherwise.
        const sudPresent = problems.some((p) => p.containsSud);
        const sudReadAllowed = sudPresent
          ? await part2ReleaseAllowed(plan.organizationId, patientId)
          : true;
        return {
          planId: plan.id,
          patientId: plan.patientId,
          problems,
          goals: goalRows.map((r) => ({
            goalId: r.id,
            problemId: r.problemId,
            text: r.revisedText ?? r.originalText,
            source: r.source,
            status: r.status,
          })),
          interventions: intvRows.map((r) => ({
            interventionId: r.id,
            problemId: r.problemId,
            scopeText: r.scopeText,
            frequencyText: r.frequencyText,
            discipline: r.discipline,
            status: r.status,
          })),
          sudReadAllowed,
        };
      });
    },

    async activeCarePlanClock(patientId): Promise<CarePlanClockRecord | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const t = tx as unknown as DbClient;
        const plan = await loadActivePlan(t, patientId);
        if (!plan) return null;
        return {
          planId: plan.id,
          patientId: plan.patientId,
          // The column `signVersion` stamps when the initial version's quorum is met (§2.2.2) — the
          // write path's own signed-initial fact, not a re-derivation over the version ledger.
          hasSignedInitialVersion: plan.initialSignedAt !== null,
          initialDueAt: iso(plan.initialDueAt),
          nextReviewDueAt: isoN(plan.nextReviewDueAt),
        };
      });
    },

    /**
     * ORG-LEVEL 15-day review-cycle tally over a DUE-DATE window — M30's `care_plan_15_day_adherence`
     * input. Denominator = care plans whose `next_review_due_at` fell inside `[from, to)`; numerator =
     * those with a signed version by that due date.
     *
     * ★ INTERPRETATION (flagged): "updated within 15 days" is read as "a signed care-plan version
     *   exists with `signed_at <= next_review_due_at`", i.e. the review happened by the date the
     *   15-day clock set. The alternative reading — a grace period AFTER the due date — would score a
     *   late review as adherent, which is the opposite of what a CoP 418.56(d) adherence measure is
     *   for. Revisit if the HQRP spec disagrees.
     *
     * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score perfect
     * adherence.
     */
    fifteenDayCycleCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: CARE_PLAN_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where exists (
                select 1 from ${CPV}
                where ${CPV.carePlanId} = ${CP.id}
                  and ${CPV.status} = 'signed'
                  and ${CPV.signedAt} is not null
                  and ${CPV.signedAt} <= ${CP.nextReviewDueAt}
              ))::int`,
            })
            .from(CP)
            .where(
              and(
                eq(CP.organizationId, organizationId),
                gte(CP.nextReviewDueAt, new Date(window.from)),
                lt(CP.nextReviewDueAt, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },

    /**
     * ORG-LEVEL problem-list terminology-code usage — M38's §7.3 remediation report input (GAP-063).
     *
     * `problem` carries the two code columns M38's Phase-1 systems can deprecate (`icd10_code`,
     * `snomed_code`), so the read is two indexed `IN` probes, one per column, restricted to the
     * (system, code) pairs the caller asked about. Systems with no column here (loinc, rxnorm, …)
     * simply contribute nothing — a problem list does not carry a lab or drug code.
     *
     * ACTIVE problems only: a resolved or inactive problem's code is history, not remediation work.
     * A row whose BOTH codes are deprecated yields two records — two distinct remediation actions —
     * so the caller's totals count code-usages, not distinct rows. Aggregate-ish by construction: the
     * projection is the row id + the code, never the description or the patient (D6 minimum necessary).
     */
    terminologyCodeUsageForOrg(organizationId, codes) {
      const wantedFor = (system: string): string[] => [
        ...new Set(codes.filter((c) => c.systemId === system).map((c) => c.code)),
      ];
      const icd10 = wantedFor("icd10cm");
      const snomed = wantedFor("snomed");
      if (icd10.length === 0 && snomed.length === 0) return Promise.resolve([]);

      return withOrgContext(
        db,
        { organizationId, userId: CARE_PLAN_READER_SYSTEM_USER_ID },
        async (tx) => {
          // The two code columns are structurally identical but nominally distinct in Drizzle's types
          // (the literal column name is part of the type), so the probe takes the widened `PgColumn`.
          const probe = async (
            column: PgColumn,
            systemId: string,
            wanted: string[],
          ): Promise<CarePlanCodeUsageRecord[]> => {
            if (wanted.length === 0) return [];
            const rows = await tx
              .select({ recordId: PROB.id, code: column })
              .from(PROB)
              .where(
                and(
                  eq(PROB.organizationId, organizationId),
                  eq(PROB.status, "active"),
                  inArray(column, wanted),
                ),
              )
              .orderBy(asc(PROB.id));
            return rows.flatMap((r) =>
              r.code === null
                ? [] // unreachable under `inArray`, but the column is nullable — keep the narrowing honest
                : [{ recordId: r.recordId, recordType: "problem_list", systemId, code: r.code }],
            );
          };
          const [fromIcd10, fromSnomed] = await Promise.all([
            probe(PROB.icd10Code, "icd10cm", icd10),
            probe(PROB.snomedCode, "snomed", snomed),
          ]);
          return [...fromIcd10, ...fromSnomed];
        },
      );
    },
  };
}

// ── M14 §2.4 `CarePlanSummaryInput` packet-cover read (F-171, #248) ─────────────────────────────────────
//
// M14's T-24h packet-build worker needs the active-plan summary D1's `carePlanSummary` block declares
// (activeProblemCount / activeGoalCount / activeInterventionCount / lastSignedVersionId / lastSignedAt /
// nextReviewDueAt / isReviewOverdue) — checked against the PUBLISHED `CarePlanReader` interface rather than
// assumed available because the builder's own doc comment cites it: `isReviewOverdue(patientId)` answers
// only `{planId, overdue, initialOverdue, reviewOverdue, initialDueAt, nextReviewDueAt}` (packages/types/
// src/care-plan.ts) — no element counts, no last-signed version/date. Genuine gap, on the OWNING module
// (M7 holds `care_plan`/`care_plan_version`/`problem`/`goal`/`intervention`), the
// `idgPacketInclusionForOrg`/`idgCurrentLevelOfCareForOrg` (M6) precedent one module over — not an
// M14-side wrapper over a narrower seam.
//
// Org-explicit and worker-callable: every id-keyed CarePlanReader method in this file opens
// `withOrgContextFromRequest` (a T-24h cron tick is not a request), so this self-scopes via
// `withOrgContext` with the explicit `organization_id` predicate as the second wall, the
// `fifteenDayCycleCountsForOrg` shape immediately above.
//
// The terminal diagnosis + SUD flag also live here rather than in a separate read: `problem.kind='terminal'`
// IS the primary/terminal diagnosis (`CarePlanMutation.problem_add.problemKind: 'terminal'` — §2.6 names
// no other diagnosis source anywhere in the module), and `problem.sud_related` is a REAL, already-written
// column (§3.3) — `patientCover.activeSudFlag` is populated from it directly rather than defaulted, unlike
// the packet-cover facts this pass reports as genuinely unbuilt (nextRecertDueAt / f2fWindowState /
// activeDpoa — no cheap, correct M6/M39 org-explicit source for any of the three exists yet; each stays
// honestly `null`, never guessed, per this pass's own restraint on ambiguous clinical/regulatory timing
// rules). `primaryDiagnosisLabel` uses the problem's stored `description` verbatim rather than an M38
// terminology-resolved label — the spec's own comment says "resolved via M38", a real, separate
// integration this pass does not attempt; the stored clinician-authored description is a real fact, not a
// fabricated one.
export interface IdgPacketCarePlanContext {
  readonly carePlanId: string;
  readonly activeProblemCount: number;
  readonly activeGoalCount: number;
  readonly activeInterventionCount: number;
  /** `null` when the plan has never been signed — the caller (M14) treats this as a per-patient packet
   *  build failure rather than fabricating a version/date; `PacketBuildInput.carePlanSummary` requires
   *  both non-null. */
  readonly lastSignedVersionId: string | null;
  readonly lastSignedAt: string | null;
  readonly nextReviewDueAt: string | null;
  readonly isReviewOverdue: boolean;
  /** `null` when no `kind='terminal'` problem is active — see {@link lastSignedVersionId}. */
  readonly terminalDiagnosisIcd10: string | null;
  readonly terminalDiagnosisLabel: string | null;
  readonly sudFlag: boolean;
}

/**
 * Resolve the §2.4 packet-cover care-plan facts for one patient, org-explicit. `null` when the patient has
 * no `care_plan` row at all (never bootstrapped — M14 reports this as a build failure, never a fabricated
 * empty summary).
 */
export function idgPacketCarePlanContextForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  asOfIso: string,
): Promise<IdgPacketCarePlanContext | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [plan] = await tx
      .select({ id: CP.id, nextReviewDueAt: CP.nextReviewDueAt })
      .from(CP)
      .where(and(eq(CP.organizationId, organizationId), eq(CP.patientId, patientId)))
      .orderBy(desc(CP.createdAt))
      .limit(1);
    if (!plan) return null;

    const [problemCounts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(PROB)
      .where(and(eq(PROB.carePlanId, plan.id), eq(PROB.status, "active")));
    const [goalCounts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(GOAL)
      .where(
        and(
          eq(GOAL.carePlanId, plan.id),
          inArray(GOAL.status, ["not_started", "in_progress"] as never),
        ),
      );
    const [interventionCounts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(INTV)
      .where(and(eq(INTV.carePlanId, plan.id), eq(INTV.status, "active")));

    const [lastSigned] = await tx
      .select({ id: CPV.id, signedAt: CPV.signedAt })
      .from(CPV)
      .where(and(eq(CPV.carePlanId, plan.id), eq(CPV.status, "signed")))
      .orderBy(desc(CPV.signedAt))
      .limit(1);

    const [terminal] = await tx
      .select({ icd10Code: PROB.icd10Code, description: PROB.description })
      .from(PROB)
      .where(
        and(eq(PROB.carePlanId, plan.id), eq(PROB.kind, "terminal"), eq(PROB.status, "active")),
      )
      .orderBy(asc(PROB.createdAt))
      .limit(1);

    const [sudRow] = await tx
      .select({ id: PROB.id })
      .from(PROB)
      .where(
        and(eq(PROB.carePlanId, plan.id), eq(PROB.status, "active"), eq(PROB.sudRelated, true)),
      )
      .limit(1);

    const asOf = new Date(asOfIso);
    const nextReviewDueAt = plan.nextReviewDueAt?.toISOString() ?? null;

    return {
      carePlanId: plan.id,
      activeProblemCount: problemCounts?.n ?? 0,
      activeGoalCount: goalCounts?.n ?? 0,
      activeInterventionCount: interventionCounts?.n ?? 0,
      lastSignedVersionId: lastSigned?.id ?? null,
      lastSignedAt: lastSigned?.signedAt?.toISOString() ?? null,
      nextReviewDueAt,
      isReviewOverdue: nextReviewDueAt !== null && new Date(nextReviewDueAt) < asOf,
      terminalDiagnosisIcd10: terminal?.icd10Code ?? null,
      terminalDiagnosisLabel: terminal?.description ?? null,
      sudFlag: !!sudRow,
    };
  });
}

export type { ClaimDiagnosisRecord, ClaimDiagnosisResult };

/**
 * F-214 (#251) — may a `sud_related` diagnosis code go on a Medicare claim? Decided by M39's
 * `ConsentEvaluator` (resolved opaquely through the M1 registry — M7 takes no `@wardenx/consent` edge, the
 * `part2ReleaseAllowed` / M22 `resolveSudConsentPresent` shape), org-explicit (no request scope: the assembly
 * worker is not a request). The question asked: is a `42_cfr_part_2_release` consent active, effective,
 * unexpired, unrevoked (with at least one active named recipient, patient not deceased — all decided by the
 * evaluator) AS OF NOW? NOW, not the service dates: the disclosure to the MAC happens when the claim is
 * assembled/sent, and M39 defines revocation as blocking FUTURE disclosures (ARCHITECTURE §M39: "revoked ->
 * future record disclosures blocked; past disclosures audited"). FAIL-CLOSED: an unbound seam, a throw, or
 * anything but `allowed === true` withholds the code.
 */
async function part2BillingDisclosureAllowed(
  organizationId: string,
  patientId: string,
): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
    const verdict = await evaluator.evaluate({
      organizationId,
      patientId,
      consentType: "42_cfr_part_2_release",
      sessionContext: { sessionClass: "staff" },
      callerModule: "m23",
    });
    return verdict.allowed === true;
  } catch {
    return false;
  }
}

/**
 * F-209 (#251) — the diagnosis sequence M23 claim assembly needs, org-explicit and patient-keyed (the
 * `idgPacketCarePlanContextForOrg` shape; the assembly worker has no request scope). Reads the patient's
 * `problem` rows across ALL of their care plans (`problem.organization_id` + the plan's `patient_id`).
 *
 * Selection: `status = 'active'`, non-null/non-blank `icd10_code`, overlapping the service range —
 * `onset_at` (null = onset unknown, kept) is before the END of `to`, and `resolved_at` is null or after
 * the START of `from`. This is an APPROXIMATE as-of read: `problem` keeps no status history, so a problem
 * since flipped to `resolved`/`inactive` is excluded even if it was active during the range (never
 * fabricates a past status). Ordered terminal, related, unrelated, then `created_at`, `id`; capped at
 * `CLAIM_DIAGNOSIS_MAX` (12); positions 1..n. A code repeated across problems keeps its first (highest
 * ranked) occurrence — a claim lists each diagnosis once. Whether the sequence is a VALID claim sequence
 * (exactly one terminal, first) is deliberately NOT decided here: the M23 `icd10_sequencing` rule judges it.
 *
 * F-214 (#251) — PART 2 GATE, enforced here where the rows are read (defense in depth: there is no ungated
 * variant for a future caller to reach for). A `problem.sud_related` code is included only when
 * {@link part2BillingDisclosureAllowed}; otherwise it is WITHHELD (never in `sequence`), the rest re-ranked
 * contiguously, and `withheldForConsentCount` / `terminalWithheldForConsent` (no codes) report it so the M23
 * rule layer can hold the claim. See `claim-diagnoses-gate.ts`.
 */
export function claimDiagnosesForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  range: { readonly from: string; readonly to: string },
): Promise<ClaimDiagnosisResult> {
  const fromStart = new Date(`${range.from}T00:00:00.000Z`);
  const toExclusive = new Date(`${range.to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  return withOrgContext(
    db,
    { organizationId, userId: CARE_PLAN_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({ code: PROB.icd10Code, kind: PROB.kind, sudRelated: PROB.sudRelated })
        .from(PROB)
        .innerJoin(CP, eq(CP.id, PROB.carePlanId))
        .where(
          and(
            eq(PROB.organizationId, organizationId),
            eq(CP.organizationId, organizationId),
            eq(CP.patientId, patientId),
            eq(PROB.status, "active"),
            sql`${PROB.icd10Code} IS NOT NULL AND btrim(${PROB.icd10Code}) <> ''`,
            sql`(${PROB.onsetAt} IS NULL OR ${PROB.onsetAt} < ${toExclusive.toISOString()}::timestamptz)`,
            sql`(${PROB.resolvedAt} IS NULL OR ${PROB.resolvedAt} > ${fromStart.toISOString()}::timestamptz)`,
          ),
        )
        .orderBy(
          sql`CASE ${PROB.kind} WHEN 'terminal' THEN 0 WHEN 'related' THEN 1 ELSE 2 END`,
          asc(PROB.createdAt),
          asc(PROB.id),
        );
      const candidates: ClaimDiagnosisCandidate[] = rows.map((r) => ({
        code: (r.code ?? "").trim(),
        kind: r.kind as ClaimDiagnosisCandidate["kind"],
        sudRelated: r.sudRelated === true,
      }));
      // F-214: the consent round-trip happens only when a SUD-flagged code is actually in play. The gate is
      // applied HERE, where the data is read, so no caller can obtain a Part 2 code without the decision.
      const part2Allowed = needsPart2Decision(candidates)
        ? await part2BillingDisclosureAllowed(organizationId, patientId)
        : true;
      return applyPart2ClaimGate(candidates, part2Allowed);
    },
  );
}
