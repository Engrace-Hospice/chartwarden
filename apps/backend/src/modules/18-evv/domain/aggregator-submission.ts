import type { AggregatorPollResult, AggregatorSubmitResult } from "@wardenx/evv-aggregators";
// apps/backend/src/modules/18-evv/domain/aggregator-submission.ts — M18-T06 (§2.2.5 D7, §7.8, §7.9).
//
// The pure per-state `evv_aggregator_submission` D7 state machine. One row per (state, visit) carries the
// vendor handshake through its lifecycle:
//
//   pending ─queue──────→ queued ─dispatch──→ submitting ─ack(2xx)──→ submitted ─accept─→ accepted   (terminal)
//                              ↑                    │                        ├─reject──→ rejected   (resubmittable)
//                              └──circuit_retry─────┘                        └─timeout─→ timeout    (resubmittable)
//   rejected | timeout ─resubmit→ queued            submitting ─accept─→ accepted   (open-model synchronous)
//   {pending,queued,submitting,submitted} ─cancel→ cancelled   (terminal)
//
// Per D7: resubmit is valid ONLY from `rejected` / `timeout` (→ `queued`, attempt_count++); cancel is valid
// ONLY from a non-terminal status. Idempotency is the adapter's `(state_code, visit_id, event_pair_hash)` key
// (the §2.2.5 unique index backstops one active row per (state, visit)). This machine is IO-free and mirrors
// the §2.2.4 missing-resolution machine: it validates the transition against the graph, then returns the new
// status + the ordered §2.4 side-effect list (audit + the §4.10 `m18.evv.aggregator_*` outbox event + the §4.9
// M36 alert on reject/timeout). The §4.8 BullMQ worker / route layer loads the row under RLS, checks the
// `version`, runs the adapter (M18-T06 `@wardenx/evv-aggregators`), and executes the effects in one tx.
//
// ADR-0008 — EVV is operational, never a Medicare claim gate: a `rejected` / `timeout` submission does NOT
// block the Medicare claim (only an `unresolved_missing` bracket does). The aggregator handshake is the
// state-Medicaid EVV substantiation, surfaced to M24/M25 via `EvvAggregatorReferenceReader`.
import type { EvvAggregatorSubmissionStatus } from "@wardenx/types";
import type { EvvSideEffect } from "./effects";
import { EvvStateError, require_ } from "./errors";

/** A §2.2.5 transition event. Per-event facts (operator identity, the adapter's result) are resolved upstream
 * (the §4.8 worker / the route ABAC + M2 session) and injected as plain data so the machine stays
 * deterministic. */
export type EvvAggregatorSubmissionEvent =
  /** pending → queued: the submission-prep worker (or a resubmit) hands the row to the submitter. */
  | { readonly type: "queue" }
  /** queued → submitting: the adapter call is in flight. */
  | { readonly type: "dispatch" }
  /** submitting → submitted: the adapter accepted asynchronously (polling-mode vendor; transactionId set). */
  | { readonly type: "ack_async"; readonly transactionId: string }
  /** submitting → submitted/accepted/rejected/queued — driven by the adapter's `submit()` result (§7.8/§7.9). */
  | { readonly type: "submit_result"; readonly result: AggregatorSubmitResult }
  /** submitted → accepted/rejected/timeout — driven by the adapter's `poll()` result (§7.8/§7.9). */
  | { readonly type: "poll_result"; readonly result: AggregatorPollResult }
  /** submitting → queued: per-state circuit-breaker tripped; retry per the adapter's policy (§2.2.5 / §4.8). */
  | { readonly type: "circuit_retry" }
  /** submitting → timeout: the per-state retry budget is spent (GAP-056) — the DLQ-equivalent landing the operator
   * triages and resubmits (§4.8 `m18.aggregator-submitter.dlq`). */
  | { readonly type: "retries_exhausted" }
  /** rejected | timeout → queued: operator-initiated resubmit after a fix (§7.9; attempt_count++). */
  | { readonly type: "resubmit" }
  /** {pending,queued,submitting,submitted} → cancelled: operator-initiated cancel (§4.1; D7 non-terminal only). */
  | { readonly type: "cancel" };

/** The deterministic result of a transition: the new status + the ordered §2.4 side-effect list. */
export interface AggregatorSubmissionTransition {
  readonly status: EvvAggregatorSubmissionStatus;
  readonly event: EvvAggregatorSubmissionEvent["type"];
  readonly effects: readonly EvvSideEffect[];
  /** True when the transition increments `attempt_count` (every resubmit; every fresh dispatch). */
  readonly incrementsAttempt: boolean;
}

/** The §2.2.5 mermaid graph (from → accepted event types). `accepted` / `cancelled` are fully terminal;
 * `rejected` / `timeout` are terminal-unless-resubmitted (D7). */
export const AGGREGATOR_SUBMISSION_GRAPH: Readonly<
  Record<EvvAggregatorSubmissionStatus, ReadonlyArray<EvvAggregatorSubmissionEvent["type"]>>
> = {
  pending: ["queue", "cancel"],
  queued: ["dispatch", "cancel"],
  submitting: ["ack_async", "submit_result", "circuit_retry", "retries_exhausted", "cancel"],
  submitted: ["poll_result", "cancel"],
  accepted: [],
  rejected: ["resubmit"],
  timeout: ["resubmit"],
  cancelled: [],
};

/** Whether a status is fully terminal (no operator action can move it; `rejected`/`timeout` are NOT — they
 * accept a resubmit per D7). */
export function isAggregatorSubmissionTerminal(status: EvvAggregatorSubmissionStatus): boolean {
  return status === "accepted" || status === "cancelled";
}

/** Whether a status accepts an operator resubmit (D7 — only `rejected` / `timeout`). */
export function isAggregatorSubmissionResubmittable(
  status: EvvAggregatorSubmissionStatus,
): boolean {
  return status === "rejected" || status === "timeout";
}

/** Whether a status accepts an operator cancel (D7 — any non-terminal status). */
export function isAggregatorSubmissionCancellable(status: EvvAggregatorSubmissionStatus): boolean {
  return (
    status === "pending" || status === "queued" || status === "submitting" || status === "submitted"
  );
}

/** Effects for entering `accepted` — the §7.8 billing-ready signal M23/M24 read. */
function acceptedEffects(): EvvSideEffect[] {
  return [{ kind: "audit" }, { kind: "outbox", event: "m18.evv.aggregator_accepted" }];
}

/** Effects for entering `rejected` — the §7.9 operator-triage signal (warn alert to billing ops). */
function rejectedEffects(): EvvSideEffect[] {
  return [
    { kind: "audit" },
    { kind: "outbox", event: "m18.evv.aggregator_rejected" },
    { kind: "alert", alert: "aggregator_rejected" },
  ];
}

/** Effects for entering `timeout` — the critical SLA-breach signal (billing + platform ops). */
function timeoutEffects(): EvvSideEffect[] {
  return [
    { kind: "audit" },
    { kind: "outbox", event: "m18.evv.aggregator_timeout" },
    { kind: "alert", alert: "aggregator_timeout" },
  ];
}

/** Map an adapter `submit()` result (§7.8/§7.9) to the next status + effects (from `submitting`). */
function fromSubmitResult(result: AggregatorSubmitResult): {
  status: EvvAggregatorSubmissionStatus;
  effects: EvvSideEffect[];
} {
  switch (result.result) {
    case "accepted":
      // Synchronous acceptance (e.g. the open-model adapter) — straight to terminal `accepted`.
      return { status: "accepted", effects: acceptedEffects() };
    case "pending_async":
      // Asynchronous vendor (Sandata) — handshake received; await the poller.
      return {
        status: "submitted",
        effects: [{ kind: "audit" }, { kind: "outbox", event: "m18.evv.aggregator_submitted" }],
      };
    case "rejected":
      return { status: "rejected", effects: rejectedEffects() };
    case "transport_failure":
      // Transport-level failure (vendor outage / circuit-breaker) — re-queue for the per-state retry policy.
      return { status: "queued", effects: [{ kind: "audit" }] };
  }
}

/** Map an adapter `poll()` result (§7.8/§7.9) to the next status + effects (from `submitted`). */
function fromPollResult(result: AggregatorPollResult): {
  status: EvvAggregatorSubmissionStatus;
  effects: EvvSideEffect[];
} {
  switch (result.result) {
    case "accepted":
      return { status: "accepted", effects: acceptedEffects() };
    case "still_pending":
      // No change — the poller re-checks at `nextPollAt`.
      return { status: "submitted", effects: [] };
    case "rejected":
      return { status: "rejected", effects: rejectedEffects() };
    case "timeout":
      return { status: "timeout", effects: timeoutEffects() };
  }
}

/**
 * Apply a §2.2.5 transition. Throws {@link EvvStateError} `ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION` when the
 * event is not accepted from `from`; `EVV_AGGREGATOR_NOT_RESUBMITTABLE` / `EVV_AGGREGATOR_NOT_CANCELLABLE` on a
 * resubmit/cancel from an ineligible status (D7). Returns the new status + the ordered §2.4 side-effect list.
 */
export function transitionAggregatorSubmission(
  from: EvvAggregatorSubmissionStatus,
  event: EvvAggregatorSubmissionEvent,
): AggregatorSubmissionTransition {
  if (!AGGREGATOR_SUBMISSION_GRAPH[from].includes(event.type)) {
    throw new EvvStateError(
      "ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION",
      `evv_aggregator_submission cannot ${event.type} from '${from}' (§2.2.5 lifecycle).`,
    );
  }

  switch (event.type) {
    case "queue":
      return {
        status: "queued",
        event: event.type,
        effects: [{ kind: "audit" }],
        incrementsAttempt: false,
      };

    case "dispatch":
      // Entering the in-flight adapter call counts as an attempt (instrumentation per §3.3).
      return {
        status: "submitting",
        event: event.type,
        effects: [{ kind: "audit" }],
        incrementsAttempt: true,
      };

    case "ack_async":
      return {
        status: "submitted",
        event: event.type,
        effects: [{ kind: "audit" }, { kind: "outbox", event: "m18.evv.aggregator_submitted" }],
        incrementsAttempt: false,
      };

    case "submit_result": {
      const { status, effects } = fromSubmitResult(event.result);
      return { status, event: event.type, effects, incrementsAttempt: false };
    }

    case "poll_result": {
      const { status, effects } = fromPollResult(event.result);
      return { status, event: event.type, effects, incrementsAttempt: false };
    }

    case "circuit_retry":
      return {
        status: "queued",
        event: event.type,
        effects: [{ kind: "audit" }],
        incrementsAttempt: false,
      };

    case "retries_exhausted":
      return {
        status: "timeout",
        event: event.type,
        effects: timeoutEffects(),
        incrementsAttempt: false,
      };

    case "resubmit":
      require_(
        isAggregatorSubmissionResubmittable(from),
        "EVV_AGGREGATOR_NOT_RESUBMITTABLE",
        "An aggregator submission may be resubmitted only from 'rejected' or 'timeout' (D7).",
      );
      return {
        status: "queued",
        event: event.type,
        effects: [{ kind: "audit" }],
        incrementsAttempt: true,
      };

    case "cancel":
      require_(
        isAggregatorSubmissionCancellable(from),
        "EVV_AGGREGATOR_NOT_CANCELLABLE",
        "An aggregator submission may be cancelled only from a non-terminal status (D7).",
      );
      return {
        status: "cancelled",
        event: event.type,
        effects: [{ kind: "audit" }, { kind: "outbox", event: "m18.evv.aggregator_cancelled" }],
        incrementsAttempt: false,
      };
  }
}
