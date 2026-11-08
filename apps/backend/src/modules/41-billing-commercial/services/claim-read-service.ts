// apps/backend/src/modules/41-billing-commercial/services/claim-read-service.ts — the read view of a commercial claim and the
// API projection of a validation run (issue #722). Ids, dates, codes, money and rule messages only: no member id, no
// authorization number, no patient name.
import { schema } from "@chartwarden/db";
import { ROUTE_FORMATS, decodeCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { isBlocking } from "../domain/rules";
import { assertPatientReachable, assertProviderInScope, assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb, CommercialTx } from "./types";
import { type ValidationRunView, readPayerState } from "./validation-runner";

export interface ValidationRunApiView {
  readonly runId: string;
  readonly outcome: string;
  readonly results: readonly {
    readonly id: string;
    readonly ruleKey: string;
    readonly severity: string;
    readonly outcome: string;
    readonly overridable: boolean;
    readonly overridden: boolean;
    readonly blocking: boolean;
    readonly message: string;
  }[];
}

/** Drop the evidence and its hash: the API shows the decision, not the facts behind it. */
export function toRunApiView(run: ValidationRunView): ValidationRunApiView {
  return {
    runId: run.runId,
    outcome: run.outcome,
    results: run.results.map((r) => ({
      id: r.id,
      ruleKey: r.ruleKey,
      severity: r.severity,
      outcome: r.outcome,
      overridable: r.overridable,
      overridden: r.overridden,
      blocking: r.blocking,
      message: r.message,
    })),
  };
}

type ReadActor = Pick<CommercialActor, "organizationId" | "userId" | "billingScope">;

/** The work queue is one page; `hasMore` tells the screen to narrow its filters (no cursor yet). */
const QUEUE_PAGE_DEFAULT = 50;
const QUEUE_CHUNK = 100;
const QUEUE_SCAN_CAP = 500;
const PLAN_LIST_CAP = 200;

interface QueueCursor {
  readonly ts: string;
  readonly id: string;
}
const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?(\+|-)\d{2}(:\d{2})?$/;

/** The keyset position is bound into SQL, so a signed cursor must still carry a timestamp and a uuid. */
function isQueueCursor(value: unknown): value is QueueCursor {
  const v = value as Partial<QueueCursor> | null;
  return (
    typeof v?.ts === "string" &&
    typeof v.id === "string" &&
    CURSOR_TS.test(v.ts) &&
    ROUTE_FORMATS.uuid?.(v.id) === true
  );
}

export interface ClaimListFilter {
  readonly cursor?: string;
  readonly providerEntityId: string;
  readonly state?: string;
  readonly payerKind?: "commercial_only" | "medicare_secondary" | "medicaid_secondary";
  readonly patientId?: string;
  readonly limit?: number;
}

export interface PayerPlanView {
  readonly id: string;
  readonly payerId: string;
  readonly planName: string;
  readonly claimFilingIndicator: string;
  readonly authorizationRequirement: string;
  readonly authorizationLeadDays: number | null;
  readonly eligibilityStalenessPolicy: string;
  readonly eligibilityMaxAgeDays: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly payerStatus: string | null;
  readonly routes: readonly {
    readonly clearinghouseKey: string;
    readonly clearinghousePayerId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
}

export interface CommercialClaimReadService {
  listClaims(
    actor: ReadActor,
    filter: ClaimListFilter,
  ): Promise<{
    items: readonly Record<string, string | number | null>[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  listPlans(
    actor: ReadActor,
    providerEntityId: string,
  ): Promise<{ items: readonly PayerPlanView[] }>;
  getClaim(
    actor: Pick<CommercialActor, "organizationId" | "userId" | "billingScope">,
    claimId: string,
  ): Promise<{
    plan: Record<string, string | null>;
    authorizations: readonly Record<string, string | null>[];
    claim: Record<string, string | number | null>;
    lines: readonly Record<string, string | number | null>[];
    validation: ValidationRunApiView | null;
    correction: {
      readonly correctionOfClaimId: string | null;
      readonly correctionKind: string | null;
      readonly correctionReasonCode: string | null;
      readonly relatedClaims: readonly {
        readonly id: string;
        readonly claimControlNumber: string;
        readonly state: string;
        readonly relation: "original" | "correction";
      }[];
      readonly rejectedCorrection: { readonly eligible: boolean; readonly reasonCode: string };
    };
  }>;
}

export function buildCommercialClaimReadService(
  db: CommercialDb,
  seams: Pick<CommercialClaimSeams, "caseload">,
): CommercialClaimReadService {
  const inOrg = <T>(actor: ReadActor, fn: (tx: CommercialTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);
  return {
    async listClaims(actor, f) {
      assertProviderInScope(actor, f.providerEntityId);
      const limit = f.limit ?? QUEUE_PAGE_DEFAULT;
      const c = schema.commercialClaims;
      const conds = [
        eq(c.organizationId, actor.organizationId),
        eq(c.providerEntityId, f.providerEntityId),
      ];
      if (f.state) conds.push(eq(c.state, f.state));
      if (f.patientId) conds.push(eq(c.patientId, f.patientId));
      if (f.payerKind === "commercial_only") conds.push(isNull(c.secondaryPayerKind));
      if (f.payerKind === "medicare_secondary") conds.push(eq(c.secondaryPayerKind, "medicare"));
      if (f.payerKind === "medicaid_secondary") conds.push(eq(c.secondaryPayerKind, "medicaid"));
      // Keyset pages over (updated_at, id), newest first. The caseload axis runs per page and per distinct patient; a page that
      // yields nothing reachable moves on to the next one, up to QUEUE_SCAN_CAP rows, so a scoped actor's claims are never
      // hidden behind other people's newer ones. Hitting the cap reports `hasMore` (narrow the filters).
      const reachable = new Map<string, boolean>();
      const isReachable = async (patientId: string): Promise<boolean> => {
        const known = reachable.get(patientId);
        if (known !== undefined) return known;
        let ok = true;
        try {
          await assertPatientReachable(actor, seams.caseload, patientId);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error; // a seam failure is a 5xx, not "not in caseload"
          ok = false;
        }
        reachable.set(patientId, ok);
        return ok;
      };
      const items: Record<string, string | number | null>[] = [];
      let hasMore = false;
      let scanned = 0;
      let after: QueueCursor | null = decodeCursor(actor.organizationId, f.cursor, isQueueCursor);
      let lastReturned: QueueCursor | null = null;
      let lastScanned: QueueCursor | null = null;
      let stoppedByLimit = false;
      let exhausted = false;
      while (items.length < limit && !hasMore) {
        const page: { claim: typeof c.$inferSelect; planName: string; ts: string }[] = await inOrg(
          actor,
          (tx) =>
            tx
              .select({
                claim: c,
                planName: schema.commercialPayerPlan.planName,
                // Full-precision text: a JS Date truncates to milliseconds and a keyset on it would skip or repeat rows.
                ts: sql<string>`${c.updatedAt}::text`,
              })
              .from(c)
              .innerJoin(schema.commercialPayerPlan, eq(schema.commercialPayerPlan.id, c.planId))
              .where(
                and(
                  ...conds,
                  after
                    ? sql`(${c.updatedAt}, ${c.id}) < (${after.ts}::timestamptz, ${after.id}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(desc(c.updatedAt), desc(c.id))
              .limit(QUEUE_CHUNK),
        );
        if (page.length === 0) {
          exhausted = true;
          break;
        }
        await Promise.all(page.map((r) => isReachable(r.claim.patientId)));
        for (const { claim, planName, ts } of page) {
          scanned += 1;
          lastScanned = { ts, id: claim.id };
          if (!(await isReachable(claim.patientId))) continue;
          if (items.length === limit) {
            hasMore = true;
            stoppedByLimit = true;
            break;
          }
          lastReturned = { ts, id: claim.id };
          items.push({
            id: claim.id,
            claimControlNumber: claim.claimControlNumber,
            state: claim.state,
            patientId: claim.patientId,
            planId: claim.planId,
            planName,
            tob: claim.tob,
            serviceFrom: claim.serviceFrom,
            serviceTo: claim.serviceTo,
            secondaryPayerKind: claim.secondaryPayerKind,
            totalChargeCents: claim.totalChargeCents,
            expectedPaymentCents: claim.expectedPaymentCents,
            updatedAt: claim.updatedAt.toISOString(),
          });
        }
        if (hasMore) break;
        if (page.length < QUEUE_CHUNK) {
          exhausted = true;
          break;
        }
        after = lastScanned;
        if (items.length === limit) {
          // Exactly full at a page boundary with rows left unread: more may exist.
          hasMore = true;
          stoppedByLimit = true;
        } else if (scanned >= QUEUE_SCAN_CAP) {
          hasMore = true; // the scan cap: the caller continues from where the scan stopped
        }
      }
      const resume = stoppedByLimit ? lastReturned : lastScanned;
      const nextCursor =
        hasMore && !exhausted && resume ? encodeCursor(actor.organizationId, resume) : null;
      return { items, hasMore: nextCursor !== null, nextCursor };
    },

    async listPlans(actor, providerEntityId) {
      assertProviderInScope(actor, providerEntityId);
      return inOrg(actor, async (tx) => {
        const plans = await tx
          .select()
          .from(schema.commercialPayerPlan)
          .where(eq(schema.commercialPayerPlan.organizationId, actor.organizationId))
          .orderBy(asc(schema.commercialPayerPlan.planName), asc(schema.commercialPayerPlan.id))
          .limit(PLAN_LIST_CAP);
        const routes = await tx
          .select()
          .from(schema.commercialPayerRoute)
          .where(eq(schema.commercialPayerRoute.organizationId, actor.organizationId));
        const items: PayerPlanView[] = [];
        const payerStates = new Map<string, string | null>();
        for (const payerId of new Set(plans.map((p) => p.payerId))) {
          payerStates.set(payerId, (await readPayerState(tx, payerId))?.status ?? null);
        }
        for (const p of plans) {
          const state = { status: payerStates.get(p.payerId) ?? null };
          items.push({
            id: p.id,
            payerId: p.payerId,
            planName: p.planName,
            claimFilingIndicator: p.claimFilingIndicator,
            authorizationRequirement: p.authorizationRequirement,
            authorizationLeadDays: p.authorizationLeadDays,
            eligibilityStalenessPolicy: p.eligibilityStalenessPolicy,
            eligibilityMaxAgeDays: p.eligibilityMaxAgeDays,
            effectiveFrom: p.effectiveFrom,
            effectiveTo: p.effectiveTo,
            payerStatus: state.status,
            routes: routes
              .filter((r) => r.planId === p.id)
              .map((r) => ({
                clearinghouseKey: r.clearinghouseKey,
                clearinghousePayerId: r.clearinghousePayerId,
                effectiveFrom: r.effectiveFrom,
                effectiveTo: r.effectiveTo,
              })),
          });
        }
        return { items };
      });
    },

    async getClaim(actor, claimId) {
      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const [c] = await tx
            .select()
            .from(schema.commercialClaims)
            .where(
              and(
                eq(schema.commercialClaims.id, claimId),
                eq(schema.commercialClaims.organizationId, actor.organizationId),
              ),
            );
          if (!c) throw new NotFoundError("commercial claim");
          await assertRowReachable(actor, seams.caseload, c);
          const [plan] = await tx
            .select()
            .from(schema.commercialPayerPlan)
            .where(
              and(
                eq(schema.commercialPayerPlan.id, c.planId),
                eq(schema.commercialPayerPlan.organizationId, actor.organizationId),
              ),
            );
          if (!plan) throw new NotFoundError("payer plan");
          const payerState = await readPayerState(tx, plan.payerId);
          // Authorizations of this entity, patient and plan that touch the claim window. No authorization NUMBER leaves the server.
          const auths = await tx
            .select()
            .from(schema.commercialAuthorizations)
            .where(
              and(
                eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
                eq(schema.commercialAuthorizations.providerEntityId, c.providerEntityId),
                eq(schema.commercialAuthorizations.patientId, c.patientId),
                eq(schema.commercialAuthorizations.planId, c.planId),
                lte(schema.commercialAuthorizations.effectiveFrom, c.serviceTo),
                or(
                  isNull(schema.commercialAuthorizations.effectiveTo),
                  gte(schema.commercialAuthorizations.effectiveTo, c.serviceFrom),
                ),
              ),
            )
            .orderBy(asc(schema.commercialAuthorizations.effectiveFrom));
          const lines = await tx
            .select()
            .from(schema.commercialClaimLines)
            .where(eq(schema.commercialClaimLines.claimId, c.id))
            .orderBy(asc(schema.commercialClaimLines.lineNumber));
          const rootId = c.correctionRootClaimId ?? c.id;
          const related = await tx
            .select({
              id: schema.commercialClaims.id,
              claimControlNumber: schema.commercialClaims.claimControlNumber,
              state: schema.commercialClaims.state,
              correctionOfClaimId: schema.commercialClaims.correctionOfClaimId,
            })
            .from(schema.commercialClaims)
            .where(
              and(
                eq(schema.commercialClaims.organizationId, actor.organizationId),
                eq(schema.commercialClaims.providerEntityId, c.providerEntityId),
                eq(schema.commercialClaims.patientId, c.patientId),
                or(
                  eq(schema.commercialClaims.id, rootId),
                  eq(schema.commercialClaims.correctionRootClaimId, rootId),
                ),
              ),
            )
            .orderBy(asc(schema.commercialClaims.createdAt))
            .limit(20);
          const [existingCorrection] = await tx
            .select({ id: schema.commercialClaims.id })
            .from(schema.commercialClaims)
            .where(
              and(
                eq(schema.commercialClaims.organizationId, c.organizationId),
                eq(schema.commercialClaims.correctionOfClaimId, c.id),
              ),
            )
            .limit(1);
          let rejectedCorrectionReason = "CLAIM_NOT_REJECTED";
          let rejectedCorrectionEligible = false;
          if (existingCorrection) rejectedCorrectionReason = "CORRECTION_ALREADY_EXISTS";
          else if (["accepted", "paid", "partially_paid", "denied"].includes(c.state))
            rejectedCorrectionReason = "PAYER_REPLACEMENT_UNVERIFIED";
          else if (c.state === "rejected") {
            const [latestSubmission] = await tx
              .select()
              .from(schema.commercialSubmissions)
              .where(
                and(
                  eq(schema.commercialSubmissions.organizationId, c.organizationId),
                  eq(schema.commercialSubmissions.claimId, c.id),
                  eq(schema.commercialSubmissions.status, "sent"),
                ),
              )
              .orderBy(desc(schema.commercialSubmissions.requestedAt))
              .limit(1);
            if (!latestSubmission || latestSubmission.clearinghouseAcceptedAt !== null) {
              rejectedCorrectionReason = "CLEARINGHOUSE_REJECTION_NOT_VERIFIED";
            } else {
              const acks = await tx
                .select({
                  stage: schema.commercialAcknowledgments.stage,
                  disposition: schema.commercialAcknowledgments.disposition,
                })
                .from(schema.commercialAcknowledgments)
                .where(
                  and(
                    eq(schema.commercialAcknowledgments.claimId, c.id),
                    eq(schema.commercialAcknowledgments.submissionId, latestSubmission.id),
                  ),
                );
              if (acks.some((ack) => ack.stage === "payer"))
                rejectedCorrectionReason = "PAYER_RESPONSE_EXISTS";
              else if (
                acks.some((ack) => ack.stage === "clearinghouse" && ack.disposition === "rejected")
              ) {
                rejectedCorrectionEligible = true;
                rejectedCorrectionReason = "VERIFIED_CLEARINGHOUSE_REJECTION";
              } else rejectedCorrectionReason = "CLEARINGHOUSE_REJECTION_NOT_VERIFIED";
            }
          }
          let validation: ValidationRunApiView | null = null;
          if (c.latestValidationRunId) {
            const results = await tx
              .select()
              .from(schema.commercialValidationResults)
              .where(
                eq(schema.commercialValidationResults.validationRunId, c.latestValidationRunId),
              );
            const [run] = await tx
              .select({ outcome: schema.commercialValidationRuns.outcome })
              .from(schema.commercialValidationRuns)
              .where(eq(schema.commercialValidationRuns.id, c.latestValidationRunId));
            const overrides = await tx
              .select({
                ruleKey: schema.commercialValidationOverrides.ruleKey,
                evidenceHash: schema.commercialValidationOverrides.evidenceHash,
              })
              .from(schema.commercialValidationOverrides)
              .where(eq(schema.commercialValidationOverrides.claimId, c.id));
            const overridden = new Set(overrides.map((o) => `${o.ruleKey}:${o.evidenceHash}`));
            validation = {
              runId: c.latestValidationRunId,
              outcome: run?.outcome ?? "all_pass",
              results: results.map((r) => {
                const wasOverridden =
                  r.outcome === "fail" && overridden.has(`${r.ruleKey}:${r.evidenceHash}`);
                return {
                  id: r.id,
                  ruleKey: r.ruleKey,
                  severity: r.severity,
                  outcome: r.outcome,
                  overridable: r.overridable,
                  overridden: wasOverridden,
                  blocking: isBlocking(
                    {
                      outcome: r.outcome as "pass" | "fail" | "info",
                      severity: r.severity as "error" | "warn" | "info",
                    },
                    wasOverridden,
                  ),
                  message: r.message,
                };
              }),
            };
          }
          return {
            plan: {
              id: plan.id,
              payerId: plan.payerId,
              planName: plan.planName,
              authorizationRequirement: plan.authorizationRequirement,
              payerStatus: payerState?.status ?? null,
            },
            authorizations: auths.map((a) => ({
              id: a.id,
              status: a.status,
              levelOfCare: a.levelOfCare,
              effectiveFrom: a.effectiveFrom,
              effectiveTo: a.effectiveTo,
            })),
            claim: {
              id: c.id,
              claimControlNumber: c.claimControlNumber,
              state: c.state,
              patientId: c.patientId,
              providerEntityId: c.providerEntityId,
              planId: c.planId,
              tob: c.tob,
              serviceFrom: c.serviceFrom,
              serviceTo: c.serviceTo,
              claimFilingIndicator: c.claimFilingIndicator,
              secondaryPayerKind: c.secondaryPayerKind,
              totalChargeCents: c.totalChargeCents,
              expectedPaymentCents: c.expectedPaymentCents,
              readyAt: c.readyAt ? c.readyAt.toISOString() : null,
            },
            correction: {
              correctionOfClaimId: c.correctionOfClaimId,
              correctionKind: c.correctionKind,
              correctionReasonCode: c.correctionReasonCode,
              relatedClaims: related.map((r) => ({
                id: r.id,
                claimControlNumber: r.claimControlNumber,
                state: r.state,
                relation:
                  r.correctionOfClaimId === null ? ("original" as const) : ("correction" as const),
              })),
              rejectedCorrection: {
                eligible: rejectedCorrectionEligible,
                reasonCode: rejectedCorrectionReason,
              },
            },
            lines: lines.map((l) => ({
              lineNumber: l.lineNumber,
              levelOfCare: l.levelOfCare,
              revenueCode: l.revenueCode,
              hcpcsCode: l.hcpcsCode,
              serviceFrom: l.serviceFrom,
              serviceTo: l.serviceTo,
              units: l.units,
              unitRateCents: l.unitRateCents,
              lineChargeCents: l.lineChargeCents,
            })),
            validation,
          };
        },
      );
    },
  };
}
