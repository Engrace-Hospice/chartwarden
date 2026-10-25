// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts — the M23 workers' use of the bound
// ClearinghouseTransport (ADR-0053, issue #707). ONE env switch decides the path: `CLEARINGHOUSE_VENDOR` unset keeps the
// legacy launch-gateway ports; set, the claim/NOE/NOTR submit + retry workers and the 999/277CA ack crons go through
// the transport and NEVER fall back to the legacy MAC portal (a degraded transport answer fails the job so BullMQ
// retries it).
import type {
  AckEvent,
  ClearinghouseBinding,
  ClearinghouseContext,
  SubmissionAttempt,
  SubmissionAttemptStore,
  SubmissionKind,
} from "@chartwarden/x12-837-client";
import { CH, routeAckEvent, scopeKey } from "@chartwarden/x12-837-client";

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
  /**
   * The durable attempt store behind the binding. Lets a retry see how an operator settled an in-doubt attempt
   * (filed or not filed); absent, an in-doubt attempt can never be judged settled and the retry stays blocked.
   */
  readonly attempts?: SubmissionAttemptStore;
  /** Durable ack cursors (#749); absent, every ack pull starts from a null cursor. */
  readonly ackCursors?: AckCursorStore;
}

/** The idempotency key {@link transportUpload} files a submission under. */
export const submissionKeyFor = (kind: SubmissionKind, controlNumber: string): string =>
  `m23.${kind}.${controlNumber}`;

/** The attempt record of a claim's earlier send, or null when there is none (or no store is bound). */
export async function priorClaimAttempt(
  transport: M23TransportDeps,
  organizationId: string,
  providerEntityId: string,
  controlNumber: string,
): Promise<SubmissionAttempt | null> {
  if (!transport.attempts) return null;
  const ctx = await transport.contexts.contextFor(organizationId, providerEntityId);
  return transport.attempts.find(
    organizationId,
    scopeKey(ctx),
    submissionKeyFor("claim", controlNumber),
  );
}

/** The vendor the workers must use, or null for the legacy ports. */
export function activeTransport(deps: {
  readonly transport?: M23TransportDeps;
}): M23TransportDeps | null {
  return deps.transport?.binding.vendor ? deps.transport : null;
}

/** Every legacy upload kind has a port kind (the 8xC/8xD transfer notice is `transfer_notice`, ADR-0053 amendment). */
const UPLOAD_TO_SUBMISSION_KIND: Record<TransportUploadKind, SubmissionKind> = {
  claim_837i: "claim",
  noe: "noe",
  notr: "notr",
  transfer_notice: "transfer_notice",
};

function failure(what: string, code: string, reason: string): Error {
  return new Error(`clearinghouse ${what} failed (${code}): ${reason}`);
}

type TransportUploadKind = "claim_837i" | "noe" | "notr" | "transfer_notice";

/** Structurally `MacPortalPort["upload"]` (declared here so m23-jobs can import this file without a cycle). */
export type TransportUpload = (input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly kind: TransportUploadKind;
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
    // A kind outside the map (a caller bypassing the types) is refused with a typed error, never sent or dropped.
    if (!kind) {
      throw failure(
        input.kind,
        CH.INVALID_REQUEST,
        "this file kind is not routable through the clearinghouse",
      );
    }
    const ctx = await transport.contexts.contextFor(input.organizationId, input.providerEntityId);
    const submission = {
      kind,
      controlNumber: input.controlNumber,
      idempotencyKey: submissionKeyFor(kind, input.controlNumber),
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

/** Map a port event to the M23 ack alphabet (two-stage routing per ADR-0053 D2). Pure. */
export function ackFromEvent(
  event: AckEvent,
  scope: { organizationId: string; providerEntityId: string; macJurisdiction: string },
): TransportAck {
  const routed = routeAckEvent(event);
  return {
    organizationId: scope.organizationId,
    providerEntityId: scope.providerEntityId,
    controlNumber: event.controlNumber,
    kind: routed.kind,
    stage: routed.stage,
    outcome: routed.outcome,
    payerControlNumber: event.payerClaimNumber ?? null,
    reasonCodes: event.reasonCodes,
    macJurisdiction: scope.macJurisdiction,
    ackFileUri: `clearinghouse:${event.eventId}`,
    day: ISO_DAY.test(event.occurredAt) ? event.occurredAt.slice(0, 10) : null,
  };
}

/** The identity of one persisted ack cursor. `kind` is the cron (each filters the one shared event stream). */
export interface AckCursorKey {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly usage: "test" | "production";
  readonly vendor: string;
  readonly kind: TransportAck["kind"];
}

/** A stored position; `version` is 0 when no row exists yet. */
export interface AckCursorState {
  readonly cursor: string | null;
  readonly version: number;
}

/**
 * Durable ack cursors (#749). `advance` is a compare-and-set on `version`: it returns false when another tick moved the
 * cursor first, so two ticks can neither double-advance nor regress it.
 */
export interface AckCursorStore {
  read(key: AckCursorKey): Promise<AckCursorState>;
  advance(key: AckCursorKey, expectedVersion: number, next: string | null): Promise<boolean>;
}

/**
 * Most pages one provider entity's stream may read in one tick. The cursor is persisted after every applied page, so a
 * longer chain is not lost: the next tick resumes where this one stopped (and `backlog` makes the remainder visible).
 */
export const MAX_ACK_PAGES_PER_TICK = 50;
/** The persisted cursor column accepts 1..512 characters (migration 1267). */
const MAX_CURSOR_LENGTH = 512;

/**
 * What one org's pull produced (acks went to `onPage`): PHI-free labels of the provider entities that failed, and of
 * those that stopped at {@link MAX_ACK_PAGES_PER_TICK} with more to read.
 */
export interface TransportAckPull {
  readonly failures: readonly string[];
  readonly backlog: readonly string[];
  /**
   * Events the vendor sent that cannot be routed (unknown stage/disposition, or a clearinghouse-stage `partial`),
   * reported by the `ack_999` pull only (both crons read the one stream; an unroutable event has no kind). Each is
   * skipped so it cannot stall the stream behind it; the caller must log them. PHI-free: id, control number, reason.
   */
  readonly quarantined: readonly QuarantinedAck[];
}

/** One unroutable vendor event, identified by our own fixed reason text and ids only. */
export interface QuarantinedAck {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly eventId: string;
  readonly controlNumber: string;
  readonly reason: string;
}

const MAX_QUARANTINE_FIELD = 128;
const clip = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, MAX_QUARANTINE_FIELD) : "";

type PageHandler = (acks: readonly TransportAck[]) => Promise<void>;

/**
 * Walk every pending acknowledgment of one stage for the org's credentialed provider entities, one page at a time.
 * Each page's acks of this stage go to `onPage`, which must have applied them durably (it throws otherwise); only then
 * is the stored cursor advanced, so a crash replays at most the page in flight (replays are idempotent: the ack row's
 * unique `(jurisdiction, ack_file_uri)` and the transition guards). A cursor the vendor refuses (`CH_INVALID_REQUEST`:
 * malformed or expired) is reset and the stream re-read from the start. One provider entity that fails (no NPI, a
 * degraded answer, a failed `onPage`) is recorded in `failures` without moving its cursor and does not stop the others.
 * Without `transport.ackCursors` every tick starts from a null cursor.
 */
export async function pullTransportAcks(
  transport: M23TransportDeps,
  organizationId: string,
  kind: TransportAck["kind"],
  onPage: PageHandler,
): Promise<TransportAckPull> {
  const failures: string[] = [];
  const backlog: string[] = [];
  const quarantined: QuarantinedAck[] = [];
  for (const providerEntityId of await transport.contexts.providerEntitiesFor(organizationId)) {
    try {
      const outcome = await pullEntity(
        transport,
        organizationId,
        providerEntityId,
        kind,
        onPage,
        quarantined,
      );
      if (outcome === "backlog") backlog.push(`org ${organizationId} provider ${providerEntityId}`);
    } catch (err) {
      // Ids and the (PHI-free) failure text only.
      failures.push(
        `org ${organizationId} provider ${providerEntityId}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }
  return { failures, backlog, quarantined };
}

async function pullEntity(
  transport: M23TransportDeps,
  organizationId: string,
  providerEntityId: string,
  kind: TransportAck["kind"],
  onPage: PageHandler,
  quarantined: QuarantinedAck[],
): Promise<"done" | "backlog"> {
  const ctx = await transport.contexts.contextFor(organizationId, providerEntityId);
  const macJurisdiction = ctx.jurisdiction;
  if (!macJurisdiction) return "done";
  const { vendor, transport: port } = transport.binding;
  const store = transport.ackCursors;
  const key: AckCursorKey = {
    organizationId,
    providerEntityId,
    usage: ctx.usage,
    vendor: vendor ?? "",
    kind,
  };
  let state: AckCursorState = store ? await store.read(key) : { cursor: null, version: 0 };
  let retriedFromStart = false;
  // Every position this tick has asked for: a vendor chain that comes back to one (A, B, A) is a cycle, not progress.
  const seen = new Set<string | null>([state.cursor]);
  for (let pages = 0; pages < MAX_ACK_PAGES_PER_TICK; ) {
    const result = await port.fetchAcknowledgments(ctx, state.cursor);
    if (!result.ok) {
      const refused = result.degraded.code === CH.INVALID_REQUEST;
      if (state.cursor === null || retriedFromStart || !refused) {
        throw failure("acknowledgment pull", result.degraded.code, result.degraded.reason);
      }
      retriedFromStart = true;
      // The vendor no longer honours the stored position: start over (replays are idempotent).
      if (store) {
        if (!(await store.advance(key, state.version, null))) return "done";
        state = await store.read(key);
      } else {
        state = { cursor: null, version: 0 };
      }
      seen.clear();
      seen.add(null);
      continue;
    }
    pages += 1;
    const { items, nextCursor, hasMore } = result.data;
    if (nextCursor.length < 1 || nextCursor.length > MAX_CURSOR_LENGTH) {
      throw failure(
        "acknowledgment pull",
        CH.INVALID_REQUEST,
        "the vendor cursor has an unusable length",
      );
    }
    if (hasMore && seen.has(nextCursor)) {
      throw failure(
        "acknowledgment pull",
        CH.INVALID_REQUEST,
        "the vendor cursor did not advance (repeated position)",
      );
    }
    const acks: TransportAck[] = [];
    for (const event of items) {
      try {
        routeAckEvent(event);
      } catch (err) {
        // Only an event we cannot ROUTE is quarantined (a mapping bug below must still fail the entity, not skip acks).
        // It must not stall every ack behind it: skipped, never applied, reported by the 999 cron. A replayed page
        // reports it again at most once per tick (deduped on the vendor event id).
        const eventId = clip(event?.eventId);
        if (kind === "ack_999" && !quarantined.some((q) => q.eventId === eventId)) {
          quarantined.push({
            organizationId,
            providerEntityId,
            eventId,
            controlNumber: clip(event?.controlNumber),
            reason: err instanceof Error ? err.message : "unroutable acknowledgment",
          });
        }
        continue;
      }
      const ack = ackFromEvent(event, { organizationId, providerEntityId, macJurisdiction });
      if (ack.kind === kind) acks.push(ack);
    }
    if (acks.length > 0) await onPage(acks);
    if (store && nextCursor !== state.cursor) {
      // Lost the race: another tick owns this stream now and its position stands. (An unchanged position is no write.)
      if (!(await store.advance(key, state.version, nextCursor))) return "done";
      state = { cursor: nextCursor, version: state.version + 1 };
    } else if (!store) {
      state = { cursor: nextCursor, version: 0 };
    }
    seen.add(nextCursor);
    if (!hasMore) return "done";
  }
  // The cap was reached with more to read; the persisted cursor is consistent with what was applied.
  return "backlog";
}
