// apps/backend/src/modules/07-care-plan/outbox-consumers/m22-diagnosis-writeback.ts — the LIVE
// `m22.extraction.diagnosis_commit_requested` consumer: M7's half of the DocLens DIAGNOSIS writeback
// (M22 §7.1 W1 steps 11–12 / D5; F-238 dx-writeback).
//
// Each reviewer-attested diagnosis becomes a PENDING `problem_proposal` on the patient's current care plan
// — never a `problem` row. A clinician must accept it (choosing terminal/related/unrelated) before anything
// is charted; until then no `problem` reader (claims, the claim-diagnoses gate, HOPE, IDG packet, portal,
// snapshots) can see it. AI Governance v0.2 §2.1.1.
//
// RULES (each skip is reported back with its reason; the rest of the commit still applies):
//   • no headless patient, no invented care plan: the patient must have exactly one non-discharged care
//     plan — `no_care_plan` / `care_plan_ambiguous` otherwise (a plan is never created here).
//   • the code is the one sent (as printed / as typed by the DocLens reviewer); M7 re-checks its SHAPE
//     (`icd10_malformed` → skipped, never "fixed") and asks M38 whether it exists as of the referral date.
//     M38 unable to answer → kept, marked `unvalidated` — never dropped, never replaced.
//   • 42 CFR Part 2: `sud_related` = M22's flag OR an F10–F19 (not F17) code, re-derived here.
//   • idempotent per source item (UNIQUE org+commit+itemKey: a redelivery reports `already_proposed`);
//     deduped per patient (one PENDING proposal per code / normalized description); an ACTIVE problem with
//     the same code is FLAGGED (`duplicate_of_problem_id`), never merged.
//
// ONE TRANSACTION: the proposals and the `m7.problem.draft_created_from_extraction` reply commit together.
// FAIL DIRECTIONS: malformed / cross-tenant payload THROWS (retry → DLQ).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type DocLensDiagnosisOutcome,
  type ExtractionDiagnosisCommitRequestedPayload,
  M7_PROBLEM_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
  M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
  type ProblemDraftCreatedFromExtractionPayload,
  type ProblemProposalIcd10Validation,
  diagnosisDedupeKey,
  isSudIcd10Code,
  normalizeIcd10CmShape,
} from "@chartwarden/types";
import { and, asc, eq, ne } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { CarePlanWriteOutboxPort } from "../care-plan-route-service-db";

const CP = schema.carePlans;
const PROB = schema.problems;
const PP = schema.problemProposals;

export const M7_EXTRACTION_DIAGNOSIS_WRITEBACK_CONSUMER = {
  eventName: M22_EXTRACTION_DIAGNOSIS_COMMIT_REQUESTED_EVENT,
  consumerName: "m7.extraction-diagnosis-writeback",
} as const;

/** M38 verdicts for a set of codes as of a date. Injected in tests; the default asks the M38 seam. */
export type Icd10Validator = (
  codes: readonly string[],
  asOf: Date,
) => Promise<ReadonlyMap<string, ProblemProposalIcd10Validation>>;

/** The minimal M38 surface used (structural — the `TerminologyProvider` seam is opaque in the registry). */
interface M38Icd10Reader {
  lookupBatch(
    system: "icd10cm",
    codes: readonly string[],
    asOf?: Date,
  ): Promise<Map<string, { readonly status: string }>>;
}

/**
 * A code M38 must resolve whenever ICD-10-CM is loaded for a date on or after FY2016 (R69 "Illness,
 * unspecified" — in every release since the 2015 transition). It distinguishes "this code is not in the
 * loaded release" (`not_valid_as_of`) from "no release is loaded / M38 is unavailable" (`unvalidated`):
 * M38's per-code lookup returns nothing in both cases.
 */
const ICD10CM_LOADED_ANCHOR = "R69";

/** Default validator: the M38 `TerminologyProvider` seam, FAIL-SOFT to `unvalidated` (keep the code). */
export const m38Icd10Validator: Icd10Validator = async (codes, asOf) => {
  const out = new Map<string, ProblemProposalIcd10Validation>();
  for (const c of codes) out.set(c, "unvalidated");
  if (codes.length === 0) return out;
  try {
    const reader = getSeam("TerminologyProvider") as Partial<M38Icd10Reader> | undefined;
    if (!reader || typeof reader.lookupBatch !== "function") return out;
    const found = await reader.lookupBatch(
      "icd10cm",
      [...new Set([...codes, ICD10CM_LOADED_ANCHOR])],
      asOf,
    );
    if (!found.has(ICD10CM_LOADED_ANCHOR)) return out; // ICD-10-CM not loaded for that date
    for (const c of codes) {
      const concept = found.get(c);
      out.set(c, concept && concept.status === "active" ? "valid" : "not_valid_as_of");
    }
    return out;
  } catch {
    return out; // an M38 outage never drops a printed code
  }
};

function fail(msg: string): never {
  throw new Error(`${M7_EXTRACTION_DIAGNOSIS_WRITEBACK_CONSUMER.consumerName}: ${msg}`);
}

const ROLES = new Set(["principal", "secondary", "history", "unspecified"]);

export function parseDiagnosisCommitRequested(
  raw: unknown,
  organizationId: string,
): ExtractionDiagnosisCommitRequestedPayload {
  const p = raw as Partial<ExtractionDiagnosisCommitRequestedPayload> | null;
  if (
    !p ||
    typeof p.extractionCommitId !== "string" ||
    typeof p.organizationId !== "string" ||
    typeof p.intakeBatchId !== "string" ||
    typeof p.targetAggregateId !== "string" ||
    typeof p.reviewerMembershipId !== "string" ||
    typeof p.referralDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(p.referralDate) ||
    p.targetModule !== "m7" ||
    !Array.isArray(p.diagnoses) ||
    p.diagnoses.some(
      (d) =>
        typeof d?.itemKey !== "string" ||
        typeof d?.description !== "string" ||
        !(d.icd10Code === null || typeof d.icd10Code === "string") ||
        !(
          d.icd10Source === null ||
          d.icd10Source === "document" ||
          d.icd10Source === "reviewer_edit"
        ) ||
        (d.icd10Code === null) !== (d.icd10Source === null) ||
        !ROLES.has(d.documentRole) ||
        typeof d.sudRelated !== "boolean",
    )
  ) {
    fail("malformed m22.extraction.diagnosis_commit_requested payload — refusing to guess");
  }
  if (p.organizationId !== organizationId) {
    fail(`payload org ${p.organizationId} != outbox row org ${organizationId}`);
  }
  return p as ExtractionDiagnosisCommitRequestedPayload;
}

/** Apply one diagnosis commit in ONE transaction; returns the reply it published. */
export async function applyDiagnosisWriteback(
  db: DbClient,
  outbox: CarePlanWriteOutboxPort,
  payload: ExtractionDiagnosisCommitRequestedPayload,
  opts: { readonly validateIcd10?: Icd10Validator; readonly now?: () => Date } = {},
): Promise<ProblemDraftCreatedFromExtractionPayload> {
  const organizationId = payload.organizationId;
  const patientId = payload.targetAggregateId;
  const now = opts.now ?? (() => new Date());

  // M38 verdicts first, outside the transaction (a terminology round-trip never holds row locks).
  const shaped = payload.diagnoses.map((d) => ({
    item: d,
    code: d.icd10Code === null ? null : normalizeIcd10CmShape(d.icd10Code),
  }));
  const codes = [...new Set(shaped.flatMap((s) => (s.code ? [s.code] : [])))];
  const verdicts = await (opts.validateIcd10 ?? m38Icd10Validator)(
    codes,
    new Date(`${payload.referralDate}T00:00:00Z`),
  );

  return withOrgContext<DbClient, ProblemDraftCreatedFromExtractionPayload>(
    db,
    { organizationId, userId: "" },
    async (tx) => {
      const plans = await tx
        .select({
          id: CP.id,
          providerEntityId: CP.providerEntityId,
          locationId: CP.locationId,
        })
        .from(CP)
        .where(and(eq(CP.patientId, patientId), ne(CP.status, "discharged")))
        .orderBy(asc(CP.createdAt));

      const outcomes: DocLensDiagnosisOutcome[] = [];
      const plan = plans.length === 1 ? (plans[0] ?? null) : null;
      if (plan === null) {
        const reason = plans.length === 0 ? "no_care_plan" : "care_plan_ambiguous";
        for (const d of payload.diagnoses) {
          outcomes.push({ itemKey: d.itemKey, outcome: "skipped", reason });
        }
      } else {
        for (const { item, code } of shaped) {
          const description = item.description.trim();
          if (description.length === 0) {
            outcomes.push({
              itemKey: item.itemKey,
              outcome: "skipped",
              reason: "description_empty",
            });
            continue;
          }
          if (item.icd10Code !== null && code === null) {
            outcomes.push({ itemKey: item.itemKey, outcome: "skipped", reason: "icd10_malformed" });
            continue;
          }
          const dedupeKey = diagnosisDedupeKey(code, description);

          // An ACTIVE problem with the same code on any of the patient's plans — flagged, never merged.
          let duplicateOfProblemId: string | null = null;
          if (code !== null) {
            const [dup] = await tx
              .select({ id: PROB.id })
              .from(PROB)
              .innerJoin(CP, eq(CP.id, PROB.carePlanId))
              .where(
                and(
                  eq(CP.patientId, patientId),
                  eq(PROB.status, "active"),
                  eq(PROB.icd10Code, code),
                ),
              )
              .orderBy(asc(PROB.createdAt))
              .limit(1);
            duplicateOfProblemId = dup?.id ?? null;
          }

          const existing = async (): Promise<{
            id: string;
            duplicateOfProblemId: string | null;
          } | null> => {
            const [bySource] = await tx
              .select({ id: PP.id, duplicateOfProblemId: PP.duplicateOfProblemId })
              .from(PP)
              .where(
                and(
                  eq(PP.sourceExtractionCommitId, payload.extractionCommitId),
                  eq(PP.sourceItemKey, item.itemKey),
                ),
              )
              .limit(1);
            if (bySource) return bySource;
            const [byKey] = await tx
              .select({ id: PP.id, duplicateOfProblemId: PP.duplicateOfProblemId })
              .from(PP)
              .where(
                and(
                  eq(PP.patientId, patientId),
                  eq(PP.dedupeKey, dedupeKey),
                  eq(PP.status, "pending"),
                ),
              )
              .limit(1);
            return byKey ?? null;
          };

          const prior = await existing();
          if (prior) {
            outcomes.push({
              itemKey: item.itemKey,
              outcome: "already_proposed",
              proposalId: prior.id,
              duplicateOfProblemId: prior.duplicateOfProblemId,
            });
            continue;
          }

          const inserted = await tx
            .insert(PP)
            .values({
              organizationId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              carePlanId: plan.id,
              patientId,
              description,
              icd10Code: code,
              icd10Source: code === null ? null : item.icd10Source,
              icd10Validation: code === null ? null : (verdicts.get(code) ?? "unvalidated"),
              documentRole: item.documentRole,
              sudRelated: item.sudRelated || isSudIcd10Code(code),
              status: "pending",
              dedupeKey,
              sourceExtractionCommitId: payload.extractionCommitId,
              sourceItemKey: item.itemKey,
              sourceIntakeBatchId: payload.intakeBatchId,
              attestedByMembershipId: payload.reviewerMembershipId,
              duplicateOfProblemId,
            })
            .onConflictDoNothing()
            .returning({ id: PP.id });
          const row = inserted[0];
          if (row) {
            outcomes.push({
              itemKey: item.itemKey,
              outcome: "proposed",
              proposalId: row.id,
              duplicateOfProblemId,
            });
            continue;
          }
          // Lost a race on one of the unique indexes — report the row that won.
          const winner = await existing();
          if (!winner)
            fail(`proposal insert for '${item.itemKey}' conflicted but no row was found`);
          outcomes.push({
            itemKey: item.itemKey,
            outcome: "already_proposed",
            proposalId: winner.id,
            duplicateOfProblemId: winner.duplicateOfProblemId,
          });
        }
      }

      const reply: ProblemDraftCreatedFromExtractionPayload = {
        patientId,
        organizationId,
        extractionCommitId: payload.extractionCommitId,
        carePlanId: plan?.id ?? null,
        itemOutcomes: outcomes,
        appliedAt: now().toISOString(),
      };
      await outbox.publish(tx, {
        eventName: M7_PROBLEM_DRAFT_CREATED_FROM_EXTRACTION_EVENT,
        payload: reply as unknown as Record<string, unknown>,
        organizationId,
        aggregateKind: "care_plan",
        aggregateId: plan?.id ?? patientId,
      });
      return reply;
    },
  );
}

/** Build the live binding the composition root registers with the boot outbox dispatcher. */
export function buildM7ExtractionDiagnosisWritebackConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: CarePlanWriteOutboxPort;
  readonly validateIcd10?: Icd10Validator;
  readonly now?: () => Date;
}) {
  return {
    consumerName: M7_EXTRACTION_DIAGNOSIS_WRITEBACK_CONSUMER.consumerName,
    consumerModule: "m7" as const,
    eventTypes: [M7_EXTRACTION_DIAGNOSIS_WRITEBACK_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const payload = parseDiagnosisCommitRequested(event.payload, event.organizationId);
      await applyDiagnosisWriteback(deps.db, deps.outbox, payload, {
        ...(deps.validateIcd10 ? { validateIcd10: deps.validateIcd10 } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    },
  };
}
