// apps/backend/src/modules/23-billing-medicare/services/claim-state-service.ts — the M23 claim
// state-transition SERVICE (spec §10 task 25 / §2.2 lifecycle, D2 / D4).
//
// This is the single home that drives the PURE `claim` lifecycle reducer from `@wardenx/billing`
// (`machines/claim` → `reduce(state, event, ctx)`), persists the transition with the §2.5 If-Match version
// check (`ClaimRepository.transitionToState` → VERSION_CONFLICT → 412), APPENDS the `claim_state_history`
// row in the SAME transaction (append-only — the repo offers no mutating surface), and emits the canonical
// §4.10 `m23.*` outbox event(s) for that transition through the catalog-validating tx publisher (the
// injected {@link WriteOutboxPort}, bound at boot with `bindCallerModule("m23")`) — all inside ONE
// `withOrgContext` unit of work so Postgres RLS scopes every statement to `app.org_id` (the D2
// outbox-only / transactional-outbox posture, mirroring the M27 write-service-drizzle precedent).
//
// The service OWNS the transition → event-name mapping (it emits "the right event" for each
// `ClaimTransitionEvent`); the variable payload fields the catalog schema requires — control numbers,
// ack/remittance ids, rejection codes — are supplied by the caller through {@link ClaimEventExtra} (the
// caller is the only party that holds them). Some transitions emit ZERO events (e.g. the internal
// `ack_999_accepted` stage advance); the §835 remittance transitions emit TWO (the per-outcome event +
// the single `claim.adjudicated` recompute signal).
//
// THIS FILE IS THE BASE of the M23 service slice: it also declares the shared {@link BillingWriteActor},
// the {@link WriteOutboxPort}, the AI-actor reject guard (D13 — no `ai_*` principal may author a billing
// write) and the §D14 step-up gate, which the noe/notr, validation, and override services import.
//
// ENUM-CASE BOUNDARY: the reducer + this service speak the lowercase domain `ClaimState`; the repo maps to
// the UPPERCASE DB pgEnum at the DB boundary (the kernel conventions). NO PHI / NO MBI on any surface (D13).
import {
  type ClaimState,
  type ClaimTransitionEvent,
  reduce as reduceClaim,
  repositories,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";

// ── shared DB / actor / port primitives (re-used by the whole M23 service slice) ──────────────────────

/**
 * The Drizzle handle the M23 services write through — the package-kernel `BillingDb`
 * (`NodePgDatabase<typeof @wardenx/db/schema>`). Re-used from `@wardenx/billing` (rather than importing the
 * `@wardenx/db/schema` leaf here) so the apps/backend M23 module — whose `dependsOn` excludes M1 — never
 * imports the M1-owned `@wardenx/db` root client. Structurally identical to the M1 `DbClient`, so the
 * composition root passes its `DbClient` (and `withOrgContext`'s tx handle satisfies it) without a cast.
 */
export type BillingDb = repositories.BillingDb;
/** The structural org-context transaction handle the repos write through (a `BillingDb` for typing). */
export type BillingTx = BillingDb;

/** The legitimate `claim_state_history.actor_kind` values (D13 forbids any `ai_*` principal). */
export type BillingActorKind = "user" | "system" | "consumer" | "worker";

/**
 * The MUTATING-route/worker/consumer actor: org + user + roles, the server-assembled active membership id
 * (the row's acting principal), the §D14 recent-step-up flag, and the `actorKind`. The membership/org are
 * ALWAYS server-assembled (never off the wire). `actorKind` is `string` so the runtime AI-reject guard
 * stays meaningful even if an `ai_*` value is fabricated upstream.
 */
export interface BillingWriteActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly membershipId: string;
  readonly stepUpRecent: boolean;
  readonly actorKind: string;
}

/** A single §4.10 `m23.*` outbox emission (the fields the tx publisher inserts an `outbox_event` row from). */
export interface OutboxEmitInput {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The §4.10 transactional-outbox emitter (bound at boot with `bindCallerModule("m23")`; best-effort if unbound). */
export interface WriteOutboxPort {
  publish(tx: BillingTx, input: OutboxEmitInput): Promise<void>;
}

/**
 * AI-actor reject guard (D13): no `ai_*` principal may author an M23 billing write. Defense-in-depth
 * alongside the per-route `actor_kind='ai_*'` guard. Fail-closed.
 */
export function assertNotAiActor(actor: BillingWriteActor): void {
  if (actor.actorKind.startsWith("ai_")) {
    throw new WardenXError(
      "AI_ACTOR_FORBIDDEN",
      "AI principals may not author Medicare-billing writes (D13)",
      403,
    );
  }
}

/** §D14 server-side step-up gate (override / submit). Fail-closed. */
export function requireStepUp(actor: BillingWriteActor): void {
  if (!actor.stepUpRecent) {
    throw new WardenXError(
      "STEP_UP_REQUIRED",
      "this action requires a recent step-up re-authentication",
      403,
    );
  }
}

/**
 * Map a non-user actor kind to the nullable `actor_membership_id`. `system` / `worker` / `consumer`
 * transitions carry NULL — none of the three has an acting person, and `claim_state_history
 * .actor_membership_id` is a uuid: passing an empty string for a machine-driven transition is not a
 * missing value, it is a `22P02 invalid input syntax for type uuid` at write time. `consumer` joined the
 * list at GAP-037, which bound the first consumer-driven transition (M25's 835 posting).
 */
function membershipForKind(actor: BillingWriteActor): string | null {
  return actor.actorKind === "system" ||
    actor.actorKind === "worker" ||
    actor.actorKind === "consumer"
    ? null
    : actor.membershipId;
}

// ── claim-transition input / result ───────────────────────────────────────────────────────────────────

/** Logical-FK context pointers recorded on the `claim_state_history` row per transition kind. */
export interface ClaimTransitionContext {
  readonly validationRunId?: string | null;
  readonly submissionId?: string | null;
  readonly acknowledgmentId?: string | null;
  readonly remittanceAdviceId?: string | null;
}

/**
 * The variable fields the §4.10 catalog schemas require for the emitted event(s) — supplied by the caller
 * (the only party that holds the control numbers / ack ids / codes). The service picks exactly the fields
 * each event needs; `claimId` / `providerEntityId` come from the persisted claim row, not from here.
 */
export interface ClaimEventExtra {
  readonly validationRunId?: string;
  readonly trigger?: string;
  readonly failedRuleKeys?: readonly string[];
  readonly submissionId?: string;
  readonly attemptIndex?: number;
  readonly reason?: string;
  readonly acknowledgmentId?: string;
  readonly payerClaimControlNumber?: string;
  readonly rejectionCodes?: readonly string[];
  readonly acceptedLineNumbers?: readonly number[];
  readonly rejectedLineNumbers?: readonly number[];
  readonly remittanceAdviceId?: string;
  readonly paidAmountCents?: number;
  readonly paidAt?: string;
  readonly denialCodes?: readonly string[];
  readonly outcome?: "paid" | "partial_paid" | "denied";
  readonly adjudicatedAt?: string;
  readonly originalClaimId?: string;
  readonly replacementClaimId?: string;
  readonly voidClaimId?: string;
}

/** One claim lifecycle transition (the route/worker/consumer/validation-service command). */
export interface ApplyClaimTransitionInput {
  readonly claimId: string;
  /** The §2.5 If-Match version the transition is applied against (a stale value → 412). */
  readonly expectedVersion: number;
  readonly event: ClaimTransitionEvent;
  /** Columns the transition may set on the claim row (control numbers, back-refs, amounts). */
  readonly patch?: repositories.ClaimTransitionPatch;
  /** Free-text marker recorded on `claim_state_history` (overrides / corrections). */
  readonly reason?: string | null;
  readonly context?: ClaimTransitionContext;
  readonly extra?: ClaimEventExtra;
  /**
   * Pre-computed unresolved blocking-failure count for the §2.3 guarded events (`validation_passed` /
   * `overrides_applied` / `submit`). When omitted, the service derives it from the latest validation run.
   */
  readonly unresolvedBlockingFailures?: number;
}

/** The outcome of a claim transition. */
export interface ClaimTransitionResult {
  readonly claim: repositories.ClaimRecord;
  readonly fromState: ClaimState;
  readonly toState: ClaimState;
  readonly historyId: string;
  readonly emittedEvents: readonly string[];
}

/** The §2.3 events the pure reducer gates on zero unresolved blocking validation failures. */
const BLOCKING_GUARDED_EVENTS: ReadonlySet<ClaimTransitionEvent> = new Set([
  "validation_passed",
  "overrides_applied",
  "submit",
]);

/**
 * Build the canonical §4.10 `m23.*` emission(s) for a claim transition. Returns the event name + payload
 * (sans `organizationId`, injected by the emitter) + the aggregate pointer. The mapping IS the service's
 * source of truth for "the right event per transition"; events not listed (`begin_validation`'s peer
 * `ack_999_accepted`) emit nothing.
 */
function buildClaimEmissions(
  event: ClaimTransitionEvent,
  claim: repositories.ClaimRecord,
  extra: ClaimEventExtra,
): readonly Omit<OutboxEmitInput, "organizationId">[] {
  const claimId = claim.id;
  const ak = "claim";
  switch (event) {
    case "begin_validation":
    case "revalidate":
      return [
        {
          eventName: "m23.claim.validation_started",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: { claimId, validationRunId: extra.validationRunId, trigger: extra.trigger },
        },
      ];
    case "validation_failed":
      return [
        {
          eventName: "m23.claim.validation_failed",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            validationRunId: extra.validationRunId,
            failedRuleKeys: [...(extra.failedRuleKeys ?? [])],
          },
        },
      ];
    case "validation_passed":
    case "overrides_applied":
      return [
        {
          eventName: "m23.claim.ready_for_submission",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: { claimId, validationRunId: extra.validationRunId },
        },
      ];
    case "submit":
      return [
        {
          eventName: "m23.claim.submit_requested",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            submissionId: extra.submissionId,
            claimControlNumber: claim.claimControlNumber,
            attemptIndex: extra.attemptIndex ?? 0,
          },
        },
      ];
    case "submission_failed":
      return [
        {
          eventName: "m23.claim.submission_failed",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            submissionId: extra.submissionId,
            attemptIndex: extra.attemptIndex ?? 0,
            reason: extra.reason ?? "",
          },
        },
      ];
    case "ack_277ca_accepted":
      return [
        {
          eventName: "m23.claim.acknowledged",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            acknowledgmentId: extra.acknowledgmentId,
            payerClaimControlNumber: extra.payerClaimControlNumber,
          },
        },
      ];
    case "ack_277ca_partial":
      return [
        {
          eventName: "m23.claim.acknowledgment_partial",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            acknowledgmentId: extra.acknowledgmentId,
            acceptedLineNumbers: [...(extra.acceptedLineNumbers ?? [])],
            rejectedLineNumbers: [...(extra.rejectedLineNumbers ?? [])],
            rejectionCodes: [...(extra.rejectionCodes ?? [])],
          },
        },
      ];
    case "ack_277ca_rejected":
    case "ack_999_rejected":
      return [
        {
          eventName: "m23.claim.rejected",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            acknowledgmentId: extra.acknowledgmentId,
            rejectionStage: event === "ack_999_rejected" ? "999" : "277ca",
            rejectionCodes: [...(extra.rejectionCodes ?? [])],
          },
        },
      ];
    case "remittance_paid":
    case "appeal_succeeded":
      return [
        {
          eventName: "m23.claim.paid",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            remittanceAdviceId: extra.remittanceAdviceId,
            paidAmountCents: extra.paidAmountCents ?? 0,
            paidAt: extra.paidAt,
          },
        },
        {
          eventName: "m23.claim.adjudicated",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            providerEntityId: claim.providerEntityId,
            outcome: extra.outcome ?? "paid",
            remittanceAdviceId: extra.remittanceAdviceId,
            adjudicatedAt: extra.adjudicatedAt ?? extra.paidAt,
          },
        },
      ];
    case "remittance_partial_paid":
      // NO `m23.claim.paid` — the catalog defines that event as "M25 posted the 835 with FULL payment",
      // and a partial payment announcing full payment would be read downstream as a settled claim.
      // `claim.adjudicated` carries `outcome: "partial_paid"`, which is the whole signal (GAP-037).
      return [
        {
          eventName: "m23.claim.adjudicated",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            providerEntityId: claim.providerEntityId,
            outcome: "partial_paid",
            remittanceAdviceId: extra.remittanceAdviceId,
            adjudicatedAt: extra.adjudicatedAt ?? extra.paidAt,
          },
        },
      ];
    case "remittance_recouped":
      // A CLP02=22 reversal emits NOTHING from M23 (GAP-037). The §4.10 catalog has no recoupment event,
      // and the two modules that care already consume M25's own `m25.remittance.claim_recouped` directly
      // (it declares `["m23","m26"]`) — M26 reverses the cap accrual off that, not off a relay from here.
      // Minting an M23 event no module consumes would add a permanently-pending outbox row per reversal.
      return [];
    case "remittance_denied":
      return [
        {
          eventName: "m23.claim.denied",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            remittanceAdviceId: extra.remittanceAdviceId,
            denialCodes: [...(extra.denialCodes ?? [])],
          },
        },
        {
          eventName: "m23.claim.adjudicated",
          aggregateKind: ak,
          aggregateId: claimId,
          payload: {
            claimId,
            providerEntityId: claim.providerEntityId,
            outcome: "denied",
            remittanceAdviceId: extra.remittanceAdviceId,
            adjudicatedAt: extra.adjudicatedAt,
          },
        },
      ];
    case "replacement_accepted":
      return [
        {
          eventName: "m23.claim.replaced",
          aggregateKind: ak,
          aggregateId: extra.originalClaimId ?? claimId,
          payload: {
            originalClaimId: extra.originalClaimId ?? claim.replacesClaimId ?? claimId,
            replacementClaimId: extra.replacementClaimId ?? claimId,
            reason: extra.reason ?? "",
          },
        },
      ];
    case "void_accepted":
      return [
        {
          eventName: "m23.claim.voided",
          aggregateKind: ak,
          aggregateId: extra.originalClaimId ?? claimId,
          payload: {
            originalClaimId: extra.originalClaimId ?? claim.replacesClaimId ?? claimId,
            voidClaimId: extra.voidClaimId ?? claimId,
            reason: extra.reason ?? "",
          },
        },
      ];
    default:
      // `ack_999_accepted` and any future internal stage advance: no §4.10 event.
      return [];
  }
}

// ── the service ────────────────────────────────────────────────────────────────────────────────────────

export interface ClaimStateServicePorts {
  /** The §4.10 `m23.*` transactional-outbox emitter (best-effort until the dispatcher binds). */
  readonly outbox?: WriteOutboxPort;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now?: () => Date;
}

export interface ClaimStateService {
  /** Apply a claim transition in its OWN `withOrgContext` transaction (the route/worker entry point). */
  transition(
    actor: BillingWriteActor,
    input: ApplyClaimTransitionInput,
  ): Promise<ClaimTransitionResult>;
  /**
   * Apply a claim transition on a CALLER-PROVIDED tx (the same-unit-of-work entry point the validation /
   * override services compose so the reducer step + history append + outbox emit share their transaction).
   */
  applyInTx(
    tx: BillingTx,
    actor: BillingWriteActor,
    input: ApplyClaimTransitionInput,
  ): Promise<ClaimTransitionResult>;
}

/** Build the Drizzle-backed {@link ClaimStateService}. `db` is the RLS-enforced primary client. */
export function buildClaimStateService(
  db: BillingDb,
  ports: ClaimStateServicePorts = {},
): ClaimStateService {
  const emit = async (
    tx: BillingTx,
    organizationId: string,
    e: Omit<OutboxEmitInput, "organizationId">,
  ) => {
    if (ports.outbox) await ports.outbox.publish(tx, { ...e, organizationId });
  };

  /** The latest validation run's blocking-failure count (0 when the run cleared, else +∞). */
  const blockingFailuresForClaim = async (tx: BillingTx, claimId: string): Promise<number> => {
    const run = await new repositories.ValidationRunRepository(tx).findLatestForClaim(claimId);
    if (!run) return Number.POSITIVE_INFINITY;
    return run.outcome === "all_pass" || run.outcome === "ready_for_submission"
      ? 0
      : Number.POSITIVE_INFINITY;
  };

  const applyInTx = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    input: ApplyClaimTransitionInput,
  ): Promise<ClaimTransitionResult> => {
    assertNotAiActor(actor);
    const claimRepo = new repositories.ClaimRepository(tx);
    const claim = await claimRepo.findById(input.claimId);
    if (!claim || claim.organizationId !== actor.organizationId) throw new NotFoundError("claim");

    // Run the PURE reducer (with the §2.3 blocking-failure guard ctx for the gated events).
    const guardCtx = BLOCKING_GUARDED_EVENTS.has(input.event)
      ? {
          unresolvedBlockingFailures:
            input.unresolvedBlockingFailures ?? (await blockingFailuresForClaim(tx, claim.id)),
        }
      : {};
    const reduced = reduceClaim(claim.state, input.event, guardCtx);
    if (reduced.error === "GUARD_FAILED") {
      throw new WardenXError(
        "GUARD_FAILED",
        `claim '${input.event}' is blocked by unresolved blocking validation failures`,
        422,
      );
    }
    if (reduced.error) {
      throw new ConflictError(`cannot '${input.event}' a claim in state '${claim.state}'`);
    }

    // Persist the transition under the §2.5 If-Match version check.
    const versioned = await claimRepo.transitionToState(
      claim.id,
      input.expectedVersion,
      reduced.state,
      input.patch ?? {},
    );
    if (!versioned.ok) {
      throw new WardenXError(
        "VERSION_CONFLICT",
        `the claim was modified concurrently (current version ${versioned.currentVersion ?? "unknown"})`,
        412,
      );
    }
    const updated = versioned.row;

    // Append the append-only history row IN THE SAME TX.
    const history = await new repositories.ClaimStateHistoryRepository(tx).append({
      organizationId: actor.organizationId,
      claimId: claim.id,
      fromState: claim.state,
      toState: updated.state,
      actorMembershipId: membershipForKind(actor),
      actorKind: actor.actorKind,
      reason: input.reason ?? null,
      validationRunId: input.context?.validationRunId ?? null,
      submissionId: input.context?.submissionId ?? null,
      acknowledgmentId: input.context?.acknowledgmentId ?? null,
      remittanceAdviceId: input.context?.remittanceAdviceId ?? null,
    });

    // Emit the canonical §4.10 event(s) IN THE SAME TX (D2 outbox-only).
    const emissions = buildClaimEmissions(input.event, updated, input.extra ?? {});
    for (const e of emissions) await emit(tx, actor.organizationId, e);

    return {
      claim: updated,
      fromState: claim.state,
      toState: updated.state,
      historyId: history.id,
      emittedEvents: emissions.map((e) => e.eventName),
    };
  };

  return {
    applyInTx,
    async transition(actor, input) {
      return withOrgContext<BillingTx, ClaimTransitionResult>(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        (tx) => applyInTx(tx, actor, input),
      );
    },
  };
}
