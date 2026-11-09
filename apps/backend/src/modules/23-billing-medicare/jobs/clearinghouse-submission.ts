// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts — the M23 workers' use of the bound
// ClearinghouseTransport (ADR-0053, issue #707). ONE env switch decides the path: `CLEARINGHOUSE_VENDOR` unset keeps the
// legacy launch-gateway ports; set, the claim/NOE/NOTR submit + retry workers and the 999/277CA ack crons go through
// the transport and NEVER fall back to the legacy MAC portal. Claim workers distinguish a known pre-send refusal
// from a transport result explicitly marked ambiguous; only the latter remains in doubt.
import { ChartWardenError } from "@chartwarden/types";
import type {
  AckEvent,
  ClearinghouseBinding,
  ClearinghouseContext,
  StediClaimJson,
  SubmissionAttempt,
  SubmissionAttemptStore,
  SubmissionKind,
  SubmissionPayload,
} from "@chartwarden/x12-837-client";
import {
  CH,
  bindingForOrg,
  claimMdFilename,
  compareStediClaimJsonToX12,
  cursorVendorKey,
  extractX12NoticeEvidence,
  extractX12SubmissionEvidence,
  isPerOrgBinding,
  routeAckEvent,
  scopeKey,
} from "@chartwarden/x12-837-client";
import type { ClaimMdNoticeEvidencePort } from "../claimmd-evidence/notice-store";
import {
  type ClaimMdReceiptIdentifier,
  type ClaimMdSubmissionEvidencePort,
  type TenantClaimMdEvidence,
  claimMdEvidenceFor,
} from "../claimmd-evidence/store";
import {
  type CredentialAlertPort,
  type CredentialGuardDeps,
  withCredentialGuard,
} from "./clearinghouse-credential-guard";

/** What a context is for. `payerRoute: "skip"`: it is not addressed to a payer (an ack or remittance pull), so no Claim.MD payer route is resolved. */
export interface ClearinghouseContextOptions {
  readonly payerRoute?: "skip";
}

/** Resolves the per-call clearinghouse context (the composition root reads provider entity + MAC credential). */
export interface ClearinghouseContextPort {
  /**
   * Context for one provider entity; throws when it has no MAC submitter credential (nothing to submit as). For a Claim.MD account it
   * also throws when no payer route is configured, unless `options.payerRoute` is `"skip"`: only a claim is addressed to a payer.
   */
  contextFor(
    organizationId: string,
    providerEntityId: string,
    options?: ClearinghouseContextOptions,
  ): Promise<ClearinghouseContext>;
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
  /** Mandatory for Claim.MD; committed before the vendor transport is invoked. */
  readonly claimMdEvidence?: ClaimMdSubmissionEvidencePort;
  readonly claimMdNoticeEvidence?: ClaimMdNoticeEvidencePort;
  /** The stores a tenant's OWN Claim.MD account (`account: "tenant"`) records under; absent, such a send fails closed. */
  readonly tenantClaimMdEvidence?: TenantClaimMdEvidence;
  /** Separate, default-off gate. A configured clearinghouse vendor alone never enables notice uploads. */
  readonly claimMdNoticeUploadsEnabled?: boolean;
  /** Durable ack cursors (#749); absent, every ack pull starts from a null cursor. */
  readonly ackCursors?: AckCursorStore;
  /** Raised once per scope when the vendor rejects the credential (#714); absent, only the log line is written. */
  readonly alerts?: CredentialAlertPort;
  readonly logger?: CredentialGuardDeps["logger"];
  readonly now?: () => number;
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

/** The vendor the workers must use, or null for the legacy ports. A per-organization binding is resolved with {@link transportForOrg}. */
export function activeTransport(deps: {
  readonly transport?: M23TransportDeps;
}): M23TransportDeps | null {
  return deps.transport?.binding.vendor ? deps.transport : null;
}

/** True when each organization has its own clearinghouse (tenant clearinghouses); the legacy ports are then never a fallback. */
export function hasPerOrgTransport(deps: { readonly transport?: M23TransportDeps }): boolean {
  return deps.transport !== undefined && isPerOrgBinding(deps.transport.binding);
}

/**
 * The transport that serves `organizationId`: null for the legacy ports (no transport injected, or one platform binding
 * with no vendor), else the injected deps with THAT organization's binding in place. With per-organization bindings it is
 * never null: an organization with no live clearinghouse gets an UNBOUND binding (`vendor` null, every call answers
 * CH_NOT_WIRED), never the legacy MAC portal, so nothing is sent through an account that is not the organization's own.
 */
export async function transportForOrg(
  deps: { readonly transport?: M23TransportDeps },
  organizationId: string,
): Promise<M23TransportDeps | null> {
  const t = deps.transport;
  if (!t) return null;
  if (!isPerOrgBinding(t.binding)) return t.binding.vendor ? t : null;
  return { ...t, binding: await bindingForOrg(t.binding, organizationId) };
}

/** Refuse, with the port's own code, to send for an organization whose resolved binding is unbound. */
export function assertOrgBound(transport: M23TransportDeps, what: string): void {
  if (transport.binding.vendor === null) {
    throw failure(
      what,
      CH.NOT_WIRED,
      "no clearinghouse is active for this organization; choose and activate one first",
    );
  }
}

/** Every legacy upload kind has a port kind (the 8xC/8xD transfer notice is `transfer_notice`, ADR-0053 amendment). */
const UPLOAD_TO_SUBMISSION_KIND: Record<TransportUploadKind, SubmissionKind> = {
  claim_837i: "claim",
  noe: "noe",
  notr: "notr",
  transfer_notice: "transfer_notice",
};

export class ClearinghouseTransportError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
    readonly ambiguous = false,
    message = `clearinghouse ${operation} failed (${code})`,
  ) {
    super(message);
    this.name = "ClearinghouseTransportError";
  }
}

function failure(
  what: string,
  code: string,
  reason: string,
  ambiguous = false,
): ClearinghouseTransportError {
  // `reason` is useful to the caller but must never be persisted or logged; it may contain vendor details.
  return new ClearinghouseTransportError(
    what,
    code,
    ambiguous,
    `clearinghouse ${what} failed (${code}): ${reason}`,
  );
}

/**
 * A PHI-free label for an error: a typed refusal's stable code, else the error's class name, never its message (which can carry a
 * connection string or a row). What a job error, a log line or an alert may say about an unexpected failure.
 */
export const failureLabel = (err: unknown): string =>
  err instanceof ChartWardenError || err instanceof ClearinghouseTransportError
    ? err.code
    : err instanceof Error
      ? err.name
      : "failed";

/**
 * A step BEFORE anything reaches a vendor (resolving the org's transport, building its context) that threw: nothing was sent, so
 * it is a typed, retryable, NON-ambiguous refusal. An untyped throw here would be read by the claim worker as "the outcome of the
 * send is uncertain" and park a send that never happened (`TRANSPORT_OUTCOME_UNCERTAIN`).
 */
async function beforeSend<T>(kind: string, what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof ClearinghouseTransportError) throw err;
    throw failure(kind, CH.UNAVAILABLE, `${what} (${failureLabel(err)})`);
  }
}

type TransportUploadKind = "claim_837i" | "noe" | "notr" | "transfer_notice";

/** Structurally `MacPortalPort["upload"]` (declared here so m23-jobs can import this file without a cycle). */
export type TransportUpload = (input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly kind: TransportUploadKind;
  readonly x12: string;
  /** The same claim as Stedi's JSON; used for a Stedi claim, where it replaces the raw X12 (no ISA13 to match). */
  readonly stediJson?: StediClaimJson;
  readonly controlNumber: string;
  readonly claimId?: string;
  readonly submissionId?: string;
  readonly attemptIndex?: number;
  readonly locationId?: string | null;
  readonly noticeId?: string;
  /** Server-stamped route snapshot carried by the durable submit request; never accepted from user input. */
  readonly expectedRouteFingerprint?: string;
}) => Promise<{ readonly accepted: boolean; readonly generatedFileUri: string }>;

/**
 * Stedi's raw-X12 route requires ISA13 to equal the submission's control number, which ours (a numeric interchange
 * number against an alphanumeric claim control number) never does; its JSON route carries no ISA13. So a Stedi claim
 * goes as JSON, after proving it agrees with the X12 built from the same input. Everything else is raw X12.
 */
function payloadFor(
  vendor: string | null,
  kind: SubmissionKind,
  input: {
    readonly kind: TransportUploadKind;
    readonly x12: string;
    readonly stediJson?: StediClaimJson;
  },
): SubmissionPayload {
  if (vendor !== "stedi" || kind !== "claim" || !input.stediJson) {
    return { format: "x12", x12: input.x12 };
  }
  const disagree = compareStediClaimJsonToX12(input.stediJson, input.x12);
  if (disagree.length > 0) {
    throw failure(
      kind,
      CH.INVALID_REQUEST,
      `the Stedi JSON and the X12 of this claim disagree on: ${disagree.join(", ")}`,
    );
  }
  return { format: "json", document: input.stediJson };
}

/**
 * `MacPortalPort.upload` when each organization has its own clearinghouse: the organization's transport is resolved per
 * call, and an organization with none fails closed (never the legacy portal).
 */
export function transportUploadPerOrg(deps: {
  readonly transport?: M23TransportDeps;
}): TransportUpload {
  return async (input) => {
    const transport = await beforeSend(
      input.kind,
      "the organization's clearinghouse could not be resolved",
      () => transportForOrg(deps, input.organizationId),
    );
    if (!transport)
      throw failure(input.kind, CH.NOT_WIRED, "no clearinghouse transport is injected");
    assertOrgBound(transport, input.kind);
    return transportUpload(transport)(input);
  };
}

/**
 * `MacPortalPort.upload` over the transport. The legacy return shape is kept; typed errors preserve whether a degraded
 * answer proves a pre-send refusal or whether the external outcome is ambiguous.
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
    const ctx = await beforeSend(kind, "the clearinghouse context could not be built", () =>
      transport.contexts.contextFor(input.organizationId, input.providerEntityId),
    );
    // A tenant's own Claim.MD account records under its own stores, the platform account under the platform's (never crossed).
    const evidence = claimMdEvidenceFor(transport, input.organizationId, ctx.usage);
    let evidenceId: string | null = null;
    let noticeEvidenceId: string | null = null;
    if (transport.binding.vendor === "claimmd") {
      if (
        kind === "claim" &&
        (!input.expectedRouteFingerprint ||
          input.expectedRouteFingerprint !== ctx.claimMdRouteFingerprint)
      ) {
        throw failure(
          kind,
          CH.INVALID_REQUEST,
          "the Claim.MD payer route changed after submission was authorized",
        );
      }
      const exact = payloadFor(transport.binding.vendor, kind, input);
      if (exact.format !== "x12")
        throw failure(kind, CH.INVALID_REQUEST, "Claim.MD evidence requires the final X12 payload");
      if (kind === "claim") {
        const evidenceStore = evidence.submission;
        if (
          !evidenceStore ||
          !input.claimId ||
          !input.submissionId ||
          input.attemptIndex === undefined
        ) {
          throw failure(
            kind,
            CH.NOT_WIRED,
            "Claim.MD claim evidence is not configured for this attempt",
          );
        }
        if (ctx.usage !== evidenceStore.usage)
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD account environment does not match submission context",
          );
        let parsed: ReturnType<typeof extractX12SubmissionEvidence>;
        try {
          parsed = extractX12SubmissionEvidence(exact.x12, undefined);
        } catch {
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD outbound X12 identity is incomplete or unsupported",
          );
        }
        if (parsed.claims.length !== 1)
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD send requires one claim identity per submission",
          );
        const outbound = parsed.claims[0]!;
        if (
          outbound.pcn !== input.controlNumber ||
          (ctx.billingNpi && outbound.billingNpi !== ctx.billingNpi)
        ) {
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD outbound X12 identity conflicts with the validated submission context",
          );
        }
        try {
          evidenceId = await evidenceStore.reserve({
            organizationId: input.organizationId,
            providerEntityId: input.providerEntityId,
            locationId: input.locationId ?? null,
            claimId: input.claimId,
            billingModule: "M23",
            submissionId: input.submissionId,
            attemptKey: `${input.submissionId}:${input.attemptIndex}`,
            accountReference: evidenceStore.accountReference,
            usage: ctx.usage,
            x12Claim: outbound,
            payloadSha256: parsed.payloadSha256,
            outboundReference: claimMdFilename(
              scopeKey(ctx),
              submissionKeyFor(kind, input.controlNumber),
              "x12",
            ),
            reservedAt: new Date(),
          });
        } catch {
          throw failure(kind, CH.UNAVAILABLE, "immutable Claim.MD evidence could not be reserved");
        }
      } else {
        const noticeKind = input.kind === "claim_837i" ? null : input.kind;
        const noticeStore = evidence.notice;
        if (!noticeKind || !transport.claimMdNoticeUploadsEnabled || !noticeStore)
          throw failure(
            kind,
            CH.NOT_WIRED,
            "Claim.MD notice uploads are disabled or notice evidence is not configured",
          );
        if (!input.noticeId || !input.submissionId || input.attemptIndex === undefined)
          throw failure(kind, CH.NOT_WIRED, "Claim.MD notice attempt identity is incomplete");
        if (ctx.usage !== noticeStore.usage)
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD account environment does not match notice context",
          );
        let parsed: ReturnType<typeof extractX12NoticeEvidence>;
        try {
          parsed = extractX12NoticeEvidence(exact.x12, noticeKind, input.controlNumber, ctx.usage);
        } catch {
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD notice X12 identity is incomplete or unsupported",
          );
        }
        if (
          (ctx.billingNpi && parsed.billingNpi !== ctx.billingNpi) ||
          parsed.payerId !== ctx.payerId
        )
          throw failure(
            kind,
            CH.INVALID_REQUEST,
            "Claim.MD notice provider or payer identity conflicts with validated context",
          );
        try {
          noticeEvidenceId = await noticeStore.reserve({
            organizationId: input.organizationId,
            providerEntityId: input.providerEntityId,
            locationId: input.locationId ?? null,
            noticeId: input.noticeId,
            noticeKind,
            submissionId: input.submissionId,
            attemptIndex: input.attemptIndex,
            noticeControlNumber: input.controlNumber,
            accountReference: noticeStore.accountReference,
            usage: ctx.usage,
            x12: parsed,
            outboundReference: claimMdFilename(
              scopeKey(ctx),
              submissionKeyFor(kind, input.controlNumber),
              "x12",
            ),
            reservedAt: new Date(),
          });
        } catch {
          throw failure(
            kind,
            CH.UNAVAILABLE,
            "immutable Claim.MD notice evidence could not be reserved",
          );
        }
      }
    }
    const submission = {
      kind,
      controlNumber: input.controlNumber,
      idempotencyKey: submissionKeyFor(kind, input.controlNumber),
      payload: payloadFor(transport.binding.vendor, kind, input),
    } as const;
    const result = await withCredentialGuard(transport, ctx, () =>
      kind === "claim"
        ? transport.binding.transport.submitClaim(ctx, submission)
        : transport.binding.transport.submitNotice(ctx, submission),
    );
    if (!result.ok)
      throw failure(
        kind,
        result.degraded.code,
        result.degraded.reason,
        result.degraded.ambiguous === true || result.degraded.code === CH.IN_DOUBT,
      );
    if ((evidenceId && evidence.submission) || (noticeEvidenceId && evidence.notice)) {
      const value = result.data.clearinghouseSubmissionId;
      const fieldNamespace: Record<
        string,
        "file" | "batch" | "claim" | "remote_claim" | "pcn" | "message" | "opaque_submission"
      > = {
        fileid: "file",
        inboundid: "file",
        batchid: "batch",
        claimid: "claim",
        claimmd_id: "remote_claim",
        remote_claimid: "remote_claim",
        pcn: "pcn",
      };
      const identifiers = result.data.vendorIdentifiers?.flatMap(({ field, value: identifier }) => {
        const namespace = fieldNamespace[field];
        return namespace
          ? [
              {
                field: field as ClaimMdReceiptIdentifier["field"],
                namespace,
                value: identifier,
              },
            ]
          : [];
      }) ?? [
        {
          field: "clearinghouseSubmissionId" as const,
          namespace: "opaque_submission" as const,
          value,
        },
      ];
      try {
        const evidencePort = evidenceId ? evidence.submission! : evidence.notice!;
        await evidencePort.observe({
          evidenceId: evidenceId ?? noticeEvidenceId!,
          organizationId: input.organizationId,
          accountReference: evidencePort.accountReference,
          usage: ctx.usage,
          identifiers,
          source: result.data.vendorIdentifiers
            ? result.data.replayed
              ? "upload_reconciliation"
              : "upload_response"
            : "attempt_store_replay",
          sourceReference: input.submissionId ?? input.controlNumber,
          observedAt: new Date(),
        });
      } catch {
        throw failure(
          kind,
          CH.IN_DOUBT,
          "Claim.MD accepted the upload but receipt evidence could not be recorded",
          true,
        );
      }
    }
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
  scope: {
    organizationId: string;
    providerEntityId: string;
    macJurisdiction: string;
    /** `tenant` when the event came from the org's OWN vendor account (its own id space). */
    account?: "tenant";
  },
): TransportAck {
  const routed = routeAckEvent(event);
  // claim_ack_file_uq is (jurisdiction, uri), not org-scoped: a tenant account's ids are its own, so its key names the org.
  // The platform account's key is unchanged (rows already stored for it keep deduping).
  const ackFileUri =
    scope.account === "tenant"
      ? `clearinghouse:tenant:${scope.organizationId}:${event.eventId}`
      : `clearinghouse:${event.eventId}`;
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
    ackFileUri,
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
      // Ids and a code or class only: the error's message can carry the vendor's reason text (see `failure`), and this string
      // reaches the job error (BullMQ's failedReason) and the logs.
      failures.push(`org ${organizationId} provider ${providerEntityId}: ${failureLabel(err)}`);
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
  // An ack pull is not addressed to a payer: it must not fail for want of a Claim.MD payer route.
  const ctx = await transport.contexts.contextFor(organizationId, providerEntityId, {
    payerRoute: "skip",
  });
  const macJurisdiction = ctx.jurisdiction;
  if (!macJurisdiction) return "done";
  const { vendor, transport: port } = transport.binding;
  const store = transport.ackCursors;
  const key: AckCursorKey = {
    organizationId,
    providerEntityId,
    usage: ctx.usage,
    // A tenant's own account has its own position space (never the platform account's cursor, and vice versa).
    vendor: cursorVendorKey({
      vendor: vendor ?? "",
      ...(transport.binding.account ? { account: transport.binding.account } : {}),
    }),
    kind,
  };
  let state: AckCursorState = store ? await store.read(key) : { cursor: null, version: 0 };
  let retriedFromStart = false;
  // Every position this tick has asked for: a vendor chain that comes back to one (A, B, A) is a cycle, not progress.
  const seen = new Set<string | null>([state.cursor]);
  for (let pages = 0; pages < MAX_ACK_PAGES_PER_TICK; ) {
    const result = await withCredentialGuard(transport, ctx, () =>
      port.fetchAcknowledgments(ctx, state.cursor),
    );
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
      const ack = ackFromEvent(event, {
        organizationId,
        providerEntityId,
        macJurisdiction,
        ...(transport.binding.account ? { account: transport.binding.account } : {}),
      });
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
