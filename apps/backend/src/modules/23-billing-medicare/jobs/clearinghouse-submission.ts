// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts — the M23 workers' use of the bound
// ClearinghouseTransport (ADR-0053, issue #707). ONE env switch decides the path: `CLEARINGHOUSE_VENDOR` unset keeps the
// legacy launch-gateway ports; set, the claim/NOE/NOTR submit + retry workers and the 999/277CA ack crons go through
// the transport and NEVER fall back to the legacy MAC portal (a degraded transport answer fails the job so BullMQ
// retries it).
import type {
  AckEvent,
  ClearinghouseBinding,
  ClearinghouseContext,
  SubmissionKind,
} from "@chartwarden/x12-837-client";
import { routeAckEvent } from "@chartwarden/x12-837-client";

/** Resolves the per-call clearinghouse context (the composition root reads provider entity + MAC credential). */
export interface ClearinghouseContextPort {
  /** Context for one provider entity; throws when it has no MAC submitter credential (nothing to submit as). */
  contextFor(organizationId: string, providerEntityId: string): Promise<ClearinghouseContext>;
  /** Provider entities of the org that have a credential, i.e. whose acknowledgments are pulled. */
  providerEntitiesFor(organizationId: string): Promise<readonly string[]>;
}

/** The injected transport dependency of `buildM23WorkerDeps` (#707). */
export interface M23TransportDeps {
  readonly binding: ClearinghouseBinding;
  readonly contexts: ClearinghouseContextPort;
}

/** The vendor the workers must use, or null for the legacy ports. */
export function activeTransport(deps: {
  readonly transport?: M23TransportDeps;
}): M23TransportDeps | null {
  return deps.transport?.binding.vendor ? deps.transport : null;
}

const UPLOAD_TO_SUBMISSION_KIND: Record<string, SubmissionKind> = {
  claim_837i: "claim",
  noe: "noe",
  notr: "notr",
};

function failure(what: string, code: string, reason: string): Error {
  return new Error(`clearinghouse ${what} failed (${code}): ${reason}`);
}

/** Structurally `MacPortalPort["upload"]` (declared here so m23-jobs can import this file without a cycle). */
export type TransportUpload = (input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly kind: "claim_837i" | "noe" | "notr" | "transfer_notice";
  readonly x12: string;
  readonly controlNumber: string;
}) => Promise<{ readonly accepted: boolean; readonly generatedFileUri: string }>;

/**
 * `MacPortalPort.upload` over the transport. The legacy return shape is kept so the workers' success/failure handling
 * is unchanged: a vendor answer is `accepted`, anything degraded THROWS (the claim worker records `failed_portal`).
 */
export function transportUpload(transport: M23TransportDeps): TransportUpload {
  return async (input) => {
    const kind = UPLOAD_TO_SUBMISSION_KIND[input.kind];
    if (!kind) {
      // ponytail: 8xC/8xD transfer notices have no SubmissionKind yet; fail closed, never the legacy portal.
      throw failure(
        input.kind,
        "CH_INVALID_REQUEST",
        "this file kind is not routable through the clearinghouse",
      );
    }
    const ctx = await transport.contexts.contextFor(input.organizationId, input.providerEntityId);
    const submission = {
      kind,
      controlNumber: input.controlNumber,
      idempotencyKey: `m23.${kind}.${input.controlNumber}`,
      payload: { format: "x12", x12: input.x12 },
    } as const;
    const result =
      kind === "claim"
        ? await transport.binding.transport.submitClaim(ctx, submission)
        : await transport.binding.transport.submitNotice(ctx, submission);
    if (!result.ok) throw failure(kind, result.degraded.code, result.degraded.reason);
    return {
      accepted: true,
      generatedFileUri: `clearinghouse:${transport.binding.vendor}:${result.data.clearinghouseSubmissionId}`,
    };
  };
}

/** One acknowledgment ready for the M23 router (the `RoutedAck` fields the transport can supply). */
export interface TransportAck {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly controlNumber: string;
  readonly kind: "ack_999" | "ack_277ca";
  readonly stage: "clearinghouse" | "payer";
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerControlNumber: string | null;
  readonly reasonCodes: readonly string[];
  readonly macJurisdiction: string;
  /** The idempotency key of the ack row (`claim_acknowledgment` is unique on jurisdiction + this). */
  readonly ackFileUri: string;
  /** The authority's own day for its answer, or null when it did not give a calendar day. */
  readonly day: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const PARTIAL_MARKER = "PARTIAL";

/** Map a port event to the M23 ack alphabet (two-stage routing per ADR-0053 D2). Pure. */
export function ackFromEvent(
  event: AckEvent,
  scope: { organizationId: string; providerEntityId: string; macJurisdiction: string },
): TransportAck {
  const routed = routeAckEvent(event);
  const partial = routed.kind === "ack_277ca" && event.reasonCodes[0] === PARTIAL_MARKER;
  return {
    organizationId: scope.organizationId,
    providerEntityId: scope.providerEntityId,
    controlNumber: event.controlNumber,
    kind: routed.kind,
    stage: routed.stage,
    outcome: partial ? "partial" : routed.outcome,
    payerControlNumber: event.payerClaimNumber ?? null,
    reasonCodes: partial ? event.reasonCodes.slice(1) : event.reasonCodes,
    macJurisdiction: scope.macJurisdiction,
    ackFileUri: `clearinghouse:${event.eventId}`,
    day: ISO_DAY.test(event.occurredAt) ? event.occurredAt.slice(0, 10) : null,
  };
}

/** What one org's pull produced: the acknowledgments, and PHI-free labels of the provider entities that failed. */
export interface TransportAckPull {
  readonly acks: readonly TransportAck[];
  readonly failures: readonly string[];
}

/**
 * Every pending acknowledgment of one stage for the org's credentialed provider entities. One provider entity that
 * cannot be pulled (no NPI on file, a degraded vendor answer) is recorded in `failures` and does not stop the others;
 * the caller applies what arrived and then fails the run so BullMQ retries.
 * ponytail: each tick re-reads from a null cursor (no persisted cursor yet); replays collapse on the ack row's unique
 * `(jurisdiction, ack_file_uri)` and the transition guards. Persist the cursor per provider entity when chains grow.
 */
export async function pullTransportAcks(
  transport: M23TransportDeps,
  organizationId: string,
  kind: TransportAck["kind"],
): Promise<TransportAckPull> {
  const acks: TransportAck[] = [];
  const failures: string[] = [];
  for (const providerEntityId of await transport.contexts.providerEntitiesFor(organizationId)) {
    try {
      const ctx = await transport.contexts.contextFor(organizationId, providerEntityId);
      const macJurisdiction = ctx.jurisdiction;
      if (!macJurisdiction) continue;
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await transport.binding.transport.fetchAcknowledgments(ctx, cursor);
        if (!result.ok) {
          throw failure("acknowledgment pull", result.degraded.code, result.degraded.reason);
        }
        for (const event of result.data.items) {
          const ack = ackFromEvent(event, { organizationId, providerEntityId, macJurisdiction });
          if (ack.kind === kind) acks.push(ack);
        }
        if (!result.data.hasMore) break;
        cursor = result.data.nextCursor;
      }
    } catch (err) {
      // Ids and the (PHI-free) failure text only.
      failures.push(
        `org ${organizationId} provider ${providerEntityId}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }
  return { acks, failures };
}

const MAX_PAGES = 100;
