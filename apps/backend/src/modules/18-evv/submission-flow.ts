// apps/backend/src/modules/18-evv/submission-flow.ts — M18-T06 (§7.8, §7.9, §4.8).
//
// The pure orchestration that drives ONE per-state aggregator submission through the §2.2.5 D7 machine using a
// resolved `EvvAggregatorAdapter` (the §4.8 `m18.aggregator-submitter` + `m18.aggregator-response-poller`
// worker bodies call this; the route layer never hits a vendor directly — D11 outbox-only handoff). It composes
// the adapter calls with `transitionAggregatorSubmission` so the state transitions + side-effects stay in the
// one authoritative pure place. IO is confined to the injected adapter; the function itself has no DB access —
// the caller persists the returned status/transactionId + dispatches the returned effects in one tx.
//
//   §7.8 done: queued → submitting → (submit) → submitted → (poll) → accepted   (Sandata async)
//              queued → submitting → (submit accepted) → accepted               (open-model synchronous)
//   §7.9 done: queued → submitting → (submit rejected) → rejected   → operator resubmit → queued (route layer)
import type {
  AggregatorCredentials,
  BuildSubmissionPayloadArgs,
  EvvAggregatorAdapter,
} from "@wardenx/evv-aggregators";
import type { EvvAggregatorSubmissionStatus } from "@wardenx/types";
import { transitionAggregatorSubmission } from "./domain/aggregator-submission";
import type { EvvSideEffect } from "./domain/effects";

/** The terminal-or-awaiting outcome of one submission pass, with the collected effects to dispatch + persist. */
export interface SubmissionPassResult {
  readonly status: EvvAggregatorSubmissionStatus;
  readonly transactionId: string | null;
  readonly rejectionCode: string | null;
  readonly effects: readonly EvvSideEffect[];
  /** True when the pass left the row awaiting an async poll (`submitted`) rather than reaching a terminal. */
  readonly awaitingPoll: boolean;
}

/**
 * §7.8/§7.9 — dispatch a `queued` submission through `submitting` and the adapter `submit()`, applying each
 * result through the pure machine. Returns the resulting status + the ordered effects. For an async vendor the
 * status lands on `submitted` (awaitingPoll=true); {@link pollSubmissionOnce} completes it. For a synchronous
 * accept (open-model) or a hard rejection the status is already terminal.
 */
export async function dispatchSubmission(args: {
  readonly adapter: EvvAggregatorAdapter;
  readonly credentials: AggregatorCredentials;
  readonly payloadArgs: BuildSubmissionPayloadArgs;
  readonly fromStatus?: EvvAggregatorSubmissionStatus;
}): Promise<SubmissionPassResult> {
  const effects: EvvSideEffect[] = [];
  // queued → submitting (the in-flight attempt).
  const dispatched = transitionAggregatorSubmission(args.fromStatus ?? "queued", {
    type: "dispatch",
  });
  effects.push(...dispatched.effects);

  const { body, idempotencyKey } = await args.adapter.buildSubmissionPayload(args.payloadArgs);
  const result = await args.adapter.submit({ body, idempotencyKey, credentials: args.credentials });

  const t = transitionAggregatorSubmission("submitting", { type: "submit_result", result });
  effects.push(...t.effects);

  const transactionId =
    result.result === "accepted" || result.result === "pending_async"
      ? result.transactionId
      : result.result === "rejected"
        ? result.transactionId
        : null;
  const rejectionCode = result.result === "rejected" ? result.rejectionCode : null;
  return {
    status: t.status,
    transactionId,
    rejectionCode,
    effects,
    awaitingPoll: t.status === "submitted",
  };
}

/**
 * §7.8 — poll an async submission once (`submitted` → accepted | rejected | timeout, or stay `submitted`).
 * The `m18.aggregator-response-poller` cron calls this; the caller persists the status + dispatches effects.
 */
export async function pollSubmissionOnce(args: {
  readonly adapter: EvvAggregatorAdapter;
  readonly credentials: AggregatorCredentials;
  readonly transactionId: string;
}): Promise<SubmissionPassResult> {
  const result = await args.adapter.poll({
    transactionId: args.transactionId,
    credentials: args.credentials,
  });
  const t = transitionAggregatorSubmission("submitted", { type: "poll_result", result });
  const rejectionCode = result.result === "rejected" ? result.rejectionCode : null;
  return {
    status: t.status,
    transactionId: args.transactionId,
    rejectionCode,
    effects: t.effects,
    awaitingPoll: t.status === "submitted",
  };
}
