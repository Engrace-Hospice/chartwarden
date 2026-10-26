// apps/backend/src/modules/41-billing-commercial/services/submission-service.ts - submit a commercial claim, read its send gate and its
// timeline (ADR-0053 D10, ADR-0100 D4/D5/D9).
//
// The route's job is to DECIDE and RECORD, never to send: the send gate is evaluated on the claim's current facts under the claim's row
// lock; a refusal writes nothing (no submission row, no event, so no job). An accepted request writes ONE `queued` submission
// (idempotency key, control number, interchange number, clearinghouse and payer id) and an `m41.claim.submit_requested` event in one
// transaction. The claim stays `ready` until the worker (`jobs/submission-worker.ts`) has the transport's receipt: `submitted` means
// the transport ACCEPTED the file, never that a job was queued (ADR-0100 D9).
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  COMMERCIAL_ERROR_CODES,
  COMMERCIAL_SEND_GATE_CODES,
  COMMERCIAL_SUBMISSION_FAILURE_MESSAGES,
  ChartWardenError,
  type CommercialEnrollmentStatus,
  type CommercialReconcileEvidence,
  type CommercialReconcileOutcome,
  ConflictError,
  NotFoundError,
  StepUpRequiredError,
  ValidationError,
} from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ALWAYS_READY, type DrainReadiness } from "../jobs/readiness";
import {
  type ClaimSendGateResult,
  evaluateClaimSendGate,
  statusForReasons,
} from "./claim-send-gate";
import type { SendGateReason } from "./claim-send-gate";
import { assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb, CommercialTx } from "./types";
import { evaluateClaim } from "./validation-runner";

type ClaimRow = typeof schema.commercialClaims.$inferSelect;

/** Rows the timeline returns at most (state history and submissions each); the response says when it cut. */
export const TIMELINE_HISTORY_LIMIT = 200;
export const TIMELINE_SUBMISSION_LIMIT = 50;
export const TIMELINE_ACK_LIMIT = 100;

/** The bound clearinghouse as the commercial lane needs it. `vendor` null means unbound: nothing can be sent. */
export interface CommercialClearinghouseBinding {
  readonly vendor: string | null;
}

export interface SendGateView {
  readonly claimId: string;
  readonly state: string;
  readonly patientId: string;
  readonly canSubmit: boolean;
  /** The bound clearinghouse's key, or null when the platform has none. */
  readonly clearinghouseKey: string | null;
  readonly reasons: readonly SendGateReason[];
}

export interface SubmissionView {
  readonly submissionId: string;
  readonly claimId: string;
  readonly status: string;
  readonly controlNumber: string;
  readonly clearinghouseKey: string;
  readonly attemptCount: number;
  readonly requestedAt: string;
  /** True when this response replays an earlier request with the same Idempotency-Key. */
  readonly replayed: boolean;
}

export type TimelineItem =
  | {
      readonly kind: "state_change";
      readonly at: string;
      readonly fromState: string | null;
      readonly toState: string;
      readonly actorKind: string;
    }
  | {
      readonly kind: "acknowledgment";
      readonly at: string;
      readonly submissionId: string;
      /** `clearinghouse` (the 999 level) or `payer` (the 277CA level): never conflated. */
      readonly stage: string;
      readonly disposition: string;
      /** Vendor reason CODES only. */
      readonly reasonCodes: readonly string[];
      readonly payerClaimNumber: string | null;
    }
  | {
      readonly kind: "submission";
      readonly at: string;
      readonly submissionId: string;
      readonly status: string;
      readonly controlNumber: string;
      readonly clearinghouseKey: string;
      readonly attemptCount: number;
      readonly failureCode: string | null;
      /** Fixed text for the code, when there is one. */
      readonly failureMessage: string | null;
      readonly resolution: string | null;
      readonly sentAt: string | null;
    };

export interface TimelineView {
  readonly claimId: string;
  readonly patientId: string;
  readonly state: string;
  readonly items: readonly TimelineItem[];
  /** True when older rows were cut by the bound. */
  readonly truncated: boolean;
}

export interface CommercialSubmissionService {
  sendGate(actor: ReadActor, claimId: string): Promise<SendGateView>;
  submit(actor: CommercialActor, claimId: string, idempotencyKey: string): Promise<SubmissionView>;
  reconcile(
    actor: CommercialActor,
    claimId: string,
    submissionId: string,
    outcome: CommercialReconcileOutcome,
    evidence?: CommercialReconcileEvidence,
  ): Promise<SubmissionView>;
  timeline(actor: ReadActor, claimId: string): Promise<TimelineView>;
}

/** What the read paths need of the caller. */
type ReadActor = Pick<CommercialActor, "organizationId" | "userId" | "billingScope">;

const LIVE_STATUSES = ["queued", "sent", "in_doubt"] as const;

/**
 * Evaluate the gate for one claim on the caller's transaction. Shared by the route, the read endpoint and the worker (which
 * re-judges at send time with `ignoreLiveSubmission`, because it IS the live submission).
 */
export async function evaluateGateForClaim(
  tx: CommercialTx,
  claim: ClaimRow,
  vendor: string | null,
  options: { readonly ignoreLiveSubmission?: boolean; readonly now?: Date } = {},
): Promise<ClaimSendGateResult> {
  const [plan] = await tx
    .select()
    .from(schema.commercialPayerPlan)
    .where(
      and(
        eq(schema.commercialPayerPlan.id, claim.planId),
        eq(schema.commercialPayerPlan.organizationId, claim.organizationId),
      ),
    );
  if (!plan) throw new Error("commercial_claim.plan_id names no plan in this organization");
  const routes =
    vendor === null
      ? []
      : await tx
          .select()
          .from(schema.commercialPayerRoute)
          .where(
            and(
              eq(schema.commercialPayerRoute.planId, plan.id),
              eq(schema.commercialPayerRoute.clearinghouseKey, vendor),
            ),
          );
  const enrollments =
    vendor === null
      ? []
      : await tx
          .select()
          .from(schema.commercialPayerEnrollment)
          .where(
            and(
              eq(schema.commercialPayerEnrollment.organizationId, claim.organizationId),
              eq(schema.commercialPayerEnrollment.providerEntityId, claim.providerEntityId),
              eq(schema.commercialPayerEnrollment.payerId, plan.payerId),
              eq(schema.commercialPayerEnrollment.clearinghouseKey, vendor),
            ),
          );
  const live = options.ignoreLiveSubmission
    ? []
    : await tx
        .select({ id: schema.commercialSubmissions.id })
        .from(schema.commercialSubmissions)
        .where(
          and(
            eq(schema.commercialSubmissions.claimId, claim.id),
            inArray(schema.commercialSubmissions.status, [...LIVE_STATUSES]),
          ),
        )
        .limit(1);
  // Validation is judged on the CURRENT facts (a stored run goes stale when an authorization is voided or a route ends).
  const validation =
    claim.state === "ready"
      ? (await evaluateClaim(tx, claim, undefined, options.now)).map((r) => ({
          ruleKey: r.ruleKey,
          blocking: r.blocking,
        }))
      : [];
  return evaluateClaimSendGate({
    claimState: claim.state,
    hasLiveSubmission: live.length > 0,
    validation,
    clearinghouseKey: vendor,
    routes,
    enrollments: enrollments.map((e) => ({ ...e, status: e.status as CommercialEnrollmentStatus })),
    serviceDate: claim.serviceTo,
    claimClearinghousePayerId: claim.clearinghousePayerId,
  });
}

export const DRAIN_NOT_SCHEDULED_MESSAGE =
  "The background sender is not running right now, so nothing would be sent. Try again in a few minutes, or ask a platform administrator.";

/** 503 while the drain is not scheduled: a queued submission would wait for a worker that is not ticking. */
async function assertDrainScheduled(readiness: DrainReadiness): Promise<void> {
  if (!(await readiness.drainScheduled())) {
    throw new ChartWardenError(
      COMMERCIAL_ERROR_CODES.drainNotScheduled,
      DRAIN_NOT_SCHEDULED_MESSAGE,
      503,
    );
  }
}

const reasonsOf = (gate: ClaimSendGateResult): readonly SendGateReason[] =>
  gate.ok ? [] : gate.reasons;

export function buildCommercialSubmissionService(
  db: CommercialDb,
  seams: CommercialClaimSeams,
  binding: CommercialClearinghouseBinding,
  /** Whether the drain is scheduled; absent = always (tests and callers that do not run workers). */
  readiness: DrainReadiness = ALWAYS_READY,
): CommercialSubmissionService {
  const now = seams.now ?? (() => new Date());
  const inOrg = <T>(actor: ReadActor, fn: (tx: CommercialTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);

  const loadClaim = async (
    tx: CommercialTx,
    actor: ReadActor,
    claimId: string,
    lock: boolean,
  ): Promise<ClaimRow> => {
    const base = tx
      .select()
      .from(schema.commercialClaims)
      .where(
        and(
          eq(schema.commercialClaims.id, claimId),
          eq(schema.commercialClaims.organizationId, actor.organizationId),
        ),
      );
    const [claim] = await (lock ? base.for("update") : base);
    if (!claim) throw new NotFoundError("commercial claim");
    await assertRowReachable(actor, seams.caseload, claim);
    return claim;
  };

  const viewOf = (
    row: typeof schema.commercialSubmissions.$inferSelect,
    replayed: boolean,
  ): SubmissionView => ({
    submissionId: row.id,
    claimId: row.claimId,
    status: row.status,
    controlNumber: row.controlNumber,
    clearinghouseKey: row.clearinghouseKey,
    attemptCount: row.attemptCount,
    requestedAt: row.requestedAt.toISOString(),
    replayed,
  });

  return {
    async sendGate(actor, claimId) {
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId, false);
        const gate = await evaluateGateForClaim(tx, claim, binding.vendor, { now: now() });
        const reasons: SendGateReason[] = [...reasonsOf(gate)];
        // nothing would send a queued row while no drain is scheduled, so the view says so instead of offering the button
        if (!(await readiness.drainScheduled())) {
          reasons.push({
            code: COMMERCIAL_SEND_GATE_CODES.DRAIN_NOT_SCHEDULED,
            message: DRAIN_NOT_SCHEDULED_MESSAGE,
          });
        }
        return {
          claimId: claim.id,
          state: claim.state,
          patientId: claim.patientId,
          canSubmit: gate.ok && reasons.length === 0,
          clearinghouseKey: binding.vendor,
          reasons,
        };
      });
    },

    async submit(actor, claimId, idempotencyKey) {
      if (actor.actorKind.startsWith("ai_")) {
        throw new ChartWardenError("AI_ACTOR_FORBIDDEN", "AI actors may not submit a claim", 403);
      }
      await assertDrainScheduled(readiness);
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId, true);
        // A retried request with the same key is answered from the row it wrote, whatever the claim has become since.
        const [existing] = await tx
          .select()
          .from(schema.commercialSubmissions)
          .where(
            and(
              eq(schema.commercialSubmissions.claimId, claim.id),
              eq(schema.commercialSubmissions.idempotencyKey, idempotencyKey),
            ),
          );
        if (existing) return viewOf(existing, true);

        const gate = await evaluateGateForClaim(tx, claim, binding.vendor, { now: now() });
        if (!gate.ok) {
          throw new ChartWardenError(
            COMMERCIAL_ERROR_CODES.sendRefused,
            `The claim was not sent: ${gate.reasons.map((r) => r.message).join(" ")}`,
            statusForReasons(gate.reasons),
            gate.reasons.map((r) => ({
              field: r.ruleKeys?.join(",") ?? "claim",
              code: r.code,
              message: r.message,
            })),
          );
        }
        // Every submission of one claim renders the SAME 837I (interchange number and stamp are copied from the first), and the
        // worker sends them all under ONE transport key, so a second row after a definite failure, or after an operator settled an
        // in-doubt one as "not received", replays an earlier receipt instead of filing the claim twice.
        const [first] = await tx
          .select({
            icn: schema.commercialSubmissions.interchangeControlNumber,
            stamp: schema.commercialSubmissions.payloadStamp,
          })
          .from(schema.commercialSubmissions)
          .where(eq(schema.commercialSubmissions.claimId, claim.id))
          .orderBy(sql`${schema.commercialSubmissions.requestedAt} ASC`)
          .limit(1);
        const [row] = await tx
          .insert(schema.commercialSubmissions)
          .values({
            ...(first ? { interchangeControlNumber: first.icn, payloadStamp: first.stamp } : {}),
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            locationId: claim.locationId,
            claimId: claim.id,
            idempotencyKey,
            controlNumber: claim.claimControlNumber,
            clearinghouseKey: gate.clearinghouseKey,
            clearinghousePayerId: gate.clearinghousePayerId,
            requestedByMembershipId: actor.membershipId,
            requestedAt: now(),
            updatedAt: now(),
          })
          .returning();
        if (!row) throw new Error("submission insert returned no row");
        await seams.outbox.publish(tx, {
          eventName: "m41.claim.submit_requested",
          organizationId: actor.organizationId,
          aggregateKind: "commercial_submission",
          aggregateId: row.id,
          payload: {
            claimId: claim.id,
            submissionId: row.id,
            controlNumber: row.controlNumber,
            clearinghouseKey: row.clearinghouseKey,
          },
        });
        return viewOf(row, false);
      });
    },

    /**
     * The way out of `in_doubt` for a person (ADR-0053 D5: an ambiguous send is reconciled before any resend). `not_received`:
     * the payer/clearinghouse has no such claim, so the submission ends `failed` and the claim (still `ready`) may be submitted
     * again; the re-send uses the same transport key and payload, so if the file HAD arrived the transport replays its receipt.
     * `received`: the claim is confirmed filed, so the submission is `sent` and the claim moves `ready -> submitted`. Audited by the
     * row-level write audit and an `m41.claim.submit_reconciled` event (no free text is taken or stored).
     */
    async reconcile(actor, claimId, submissionId, outcome, evidence) {
      if (actor.actorKind.startsWith("ai_")) {
        throw new ChartWardenError(
          "AI_ACTOR_FORBIDDEN",
          "AI actors may not reconcile a submission",
          403,
        );
      }
      if (!actor.stepUpRecent) throw new StepUpRequiredError();
      await assertDrainScheduled(readiness);
      // `received` is an attestation: it must say what the person relied on (a closed set), and `not_received` must not carry one.
      if (outcome === "received" && evidence === undefined) {
        throw new ValidationError("evidence is required when the claim is confirmed received", [
          { field: "evidence", code: "REQUIRED", message: "name what you relied on" },
        ]);
      }
      if (outcome === "not_received" && evidence !== undefined) {
        throw new ValidationError("evidence applies only when the claim is confirmed received", [
          { field: "evidence", code: "NOT_ALLOWED", message: "remove evidence" },
        ]);
      }
      return inOrg(actor, async (tx) => {
        // the claim is locked first (the same order as the ack path and the worker), then the submission THAT BELONGS TO IT: a
        // submission id of another claim is simply not found
        const claim = await loadClaim(tx, actor, claimId, true);
        const S = schema.commercialSubmissions;
        const [sub] = await tx
          .select()
          .from(S)
          .where(and(eq(S.id, submissionId), eq(S.claimId, claim.id)))
          .for("update");
        if (!sub) throw new NotFoundError("submission");
        if (sub.status !== "in_doubt") {
          throw new ConflictError("only a submission in doubt can be reconciled");
        }
        // A receipt is on file (the transport accepted the file and only our record failed): it cannot be "not received".
        if (outcome === "not_received" && sub.clearinghouseSubmissionId !== null) {
          throw new ChartWardenError(
            COMMERCIAL_ERROR_CODES.reconcileReceiptOnFile,
            "The clearinghouse accepted this file; only the record failed. Confirm it as received.",
            409,
          );
        }
        // Confirming it received moves the claim to submitted, which is only legal from ready.
        if (outcome === "received" && claim.state !== "ready") {
          throw new ChartWardenError(
            COMMERCIAL_SEND_GATE_CODES.CLAIM_NOT_READY,
            "The claim is no longer ready, so it cannot be confirmed as sent. Ask a platform administrator.",
            409,
          );
        }
        const at = now();
        if (outcome === "not_received") {
          await tx
            .update(S)
            .set({
              status: "failed",
              resolution: "operator_not_received",
              lastFailureCode: "COMMERCIAL_RECONCILED_NOT_RECEIVED",
              updatedAt: at,
            })
            .where(eq(S.id, sub.id));
        } else {
          await tx
            .update(S)
            .set({
              status: "sent",
              resolution: "operator_confirmed",
              reconcileEvidence: evidence ?? null,
              sentAt: at,
              lastFailureCode: null,
              transportCallStartedAt: null,
              updatedAt: at,
            })
            .where(eq(S.id, sub.id));
          if (claim.state === "ready") {
            await tx
              .update(schema.commercialClaims)
              .set({ state: "submitted", updatedAt: at })
              .where(eq(schema.commercialClaims.id, claim.id));
            await tx.insert(schema.commercialClaimStateHistory).values({
              organizationId: claim.organizationId,
              providerEntityId: claim.providerEntityId,
              locationId: claim.locationId,
              claimId: claim.id,
              fromState: "ready",
              toState: "submitted",
              actorKind: actor.actorKind,
              actorMembershipId: actor.membershipId,
              validationRunId: null,
            });
            // the claim moved to submitted: the same event the worker and the acknowledgment path publish for that move
            await seams.outbox.publish(tx, {
              eventName: "m41.claim.submitted",
              organizationId: claim.organizationId,
              aggregateKind: "commercial_submission",
              aggregateId: sub.id,
              payload: {
                claimId: claim.id,
                submissionId: sub.id,
                controlNumber: sub.controlNumber,
                clearinghouseKey: sub.clearinghouseKey,
              },
            });
          }
        }
        await seams.outbox.publish(tx, {
          eventName: "m41.claim.submit_reconciled",
          organizationId: actor.organizationId,
          aggregateKind: "commercial_submission",
          aggregateId: sub.id,
          payload: { claimId: claim.id, submissionId: sub.id, outcome, evidence: evidence ?? null },
        });
        const [settled] = await tx.select().from(S).where(eq(S.id, sub.id));
        return viewOf(settled ?? sub, false);
      });
    },

    async timeline(actor, claimId) {
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId, false);
        // newest first with a bound, then put back in order: the CUT drops the oldest rows, never the latest
        const history = await tx
          .select()
          .from(schema.commercialClaimStateHistory)
          .where(eq(schema.commercialClaimStateHistory.claimId, claim.id))
          .orderBy(sql`${schema.commercialClaimStateHistory.createdAt} DESC`)
          .limit(TIMELINE_HISTORY_LIMIT + 1);
        const submissions = await tx
          .select()
          .from(schema.commercialSubmissions)
          .where(eq(schema.commercialSubmissions.claimId, claim.id))
          .orderBy(sql`${schema.commercialSubmissions.requestedAt} DESC`)
          .limit(TIMELINE_SUBMISSION_LIMIT + 1);
        const acks = await tx
          .select()
          .from(schema.commercialAcknowledgments)
          .where(eq(schema.commercialAcknowledgments.claimId, claim.id))
          .orderBy(sql`${schema.commercialAcknowledgments.createdAt} DESC`)
          .limit(TIMELINE_ACK_LIMIT + 1);
        const truncated =
          history.length > TIMELINE_HISTORY_LIMIT ||
          submissions.length > TIMELINE_SUBMISSION_LIMIT ||
          acks.length > TIMELINE_ACK_LIMIT;
        const items: TimelineItem[] = [
          ...history.slice(0, TIMELINE_HISTORY_LIMIT).map(
            (h): TimelineItem => ({
              kind: "state_change",
              at: h.createdAt.toISOString(),
              fromState: h.fromState,
              toState: h.toState,
              actorKind: h.actorKind,
            }),
          ),
          ...submissions.slice(0, TIMELINE_SUBMISSION_LIMIT).map(
            (s): TimelineItem => ({
              kind: "submission",
              at: s.requestedAt.toISOString(),
              submissionId: s.id,
              status: s.status,
              controlNumber: s.controlNumber,
              clearinghouseKey: s.clearinghouseKey,
              attemptCount: s.attemptCount,
              failureCode: s.lastFailureCode,
              failureMessage: s.lastFailureCode
                ? (COMMERCIAL_SUBMISSION_FAILURE_MESSAGES[s.lastFailureCode] ?? null)
                : null,
              resolution: s.resolution,
              sentAt: s.sentAt ? s.sentAt.toISOString() : null,
            }),
          ),
          ...acks.slice(0, TIMELINE_ACK_LIMIT).map(
            (a): TimelineItem => ({
              kind: "acknowledgment",
              // the authority's own time when it gave one, else when we recorded it
              at: (a.occurredAt ?? a.createdAt).toISOString(),
              submissionId: a.submissionId,
              stage: a.stage,
              disposition: a.disposition,
              reasonCodes: a.reasonCodes,
              payerClaimNumber: a.payerClaimNumber,
            }),
          ),
        ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind.localeCompare(b.kind)));
        return {
          claimId: claim.id,
          patientId: claim.patientId,
          state: claim.state,
          items,
          truncated,
        };
      });
    },
  };
}
