// @chartwarden/x12-837-client — the direct-MAC ClearinghouseTransport (ADR-0053 D1, issue #706): the legacy launch
// gateway (X12 generation sidecar + MAC portal file drop + 999/277CA pulls) re-expressed behind the same port Stedi
// implements, so the port is proven by a second, non-Stedi implementation.
//
// This file performs NO network I/O. The gateway is an injected {@link DirectMacGateway}; the backend composes it
// from the existing `X12ClientPort` / `MacPortalPort` (apps/backend `direct-mac-gateway.ts`).
//
// Implemented: submitClaim, submitNotice (durable idempotency kept by OUR attempt store, tenant/usage scoped) and
// fetchAcknowledgments (the pending 999 / 277CA files). Everything the legacy gateway cannot answer is CH_NOT_WIRED:
// eligibility (HETS is its own M23 seam), dry-run validation (no side-effect-free endpoint), remittances (M25's 835
// worker port), claim status (the portal has no status inquiry) and signed push events (the portal pushes nothing).
// Replacement/void claims are refused, as in the Stedi adapter. Conformance capabilities: see direct-mac-transport.test.ts.
//
// Acknowledgments are NOT cursor-replayable here: the portal's "pending files" list is the cursor. A pull returns what
// is pending and `hasMore: false`; the returned `nextCursor` is accepted back (shape-checked) but carries no position.
// The M23 consumer is idempotent on the event id, so a re-delivery collapses.
import { X12FormatError, tokenizeInterchange } from "../eligibility/x12-envelope";
import { type X12WorkerResult, degraded } from "../types";
import type { SubmissionAttempt, SubmissionAttemptStore } from "./attempt-store";
import { identityOf, scopeKey } from "./submission-identity";
import {
  type AckEvent,
  CH,
  type ClaimStatus,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseEligibilityResult,
  type ClearinghouseEvent,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type Page,
  type RawWebhook,
  type RemittanceFile,
  type SubmissionKind,
  type SubmissionReceipt,
  type ValidationReport,
} from "./types";

/** What the legacy gateway can do, in the port's own vocabulary. The backend adapts X12ClientPort + MacPortalPort. */
export interface DirectMacGateway {
  /** Render a JSON submission document (claim / NOE / NOTR facts) to X12 via the generation sidecar. */
  generate(input: {
    readonly kind: SubmissionKind;
    readonly organizationId: string;
    readonly controlNumber: string;
    readonly document: unknown;
  }): Promise<{ readonly x12: string }>;
  /** Drop an X12 file at the MAC portal. `accepted: false` is a definitive refusal; a throw is ambiguous. */
  upload(input: {
    readonly kind: SubmissionKind;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly controlNumber: string;
    readonly x12: string;
  }): Promise<{ readonly accepted: boolean; readonly fileId: string }>;
  /** The pending 999 (clearinghouse stage) and 277CA (payer stage) answers for this provider, as port events. */
  pullAcknowledgments(ctx: ClearinghouseContext): Promise<readonly AckEvent[]>;
}

export interface DirectMacTransportOptions {
  readonly attempts: SubmissionAttemptStore;
  readonly gateway: DirectMacGateway;
  /** Injected clock for the reservation windows. */
  readonly now?: () => Date;
  /** PHI-free signals that need a human (a send that could not be recorded). */
  readonly onAnomaly?: (anomaly: DirectMacAnomaly) => void;
}

export type DirectMacAnomaly = {
  readonly type: "sent_but_unrecorded";
  readonly idempotencyKey: string;
  readonly clearinghouseSubmissionId: string;
};

const RECORD_ATTEMPTS = 3;
/** A reservation younger than this may still be mid-send: nothing else sends it. */
const IN_FLIGHT_MS = 15 * 60_000;
/** After an ambiguous failure, wait this long before the retake. */
const SETTLE_MS = 60_000;
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTROL_NUMBER_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
const CURSOR_SHAPE = /^\d+$/;
const MAX_FILE_ID_LENGTH = 200;

const refuse = <T>(reason: string): X12WorkerResult<T> => degraded<T>(CH.INVALID_REQUEST, reason);
const notImplemented = <T>(what: string): Promise<X12WorkerResult<T>> =>
  Promise.resolve(
    degraded<T>(CH.NOT_WIRED, `direct_mac ${what} is not available through the gateway`),
  );

/** Reason an X12 file must not be sent, or null. PHI-free: positions only. */
// Unlike the Stedi adapter this does not bind ISA13 to the control number: the legacy sidecar echoes OUR control number
// (claim / NOE / NOTR) into the file and mints its own interchange number.
function x12Problem(x12: string, ctx: ClearinghouseContext): string | null {
  try {
    const { segments } = tokenizeInterchange(x12);
    const isa = segments.find((s) => s[0] === "ISA");
    if (isa?.[15] !== (ctx.usage === "test" ? "T" : "P")) {
      return `ISA15 does not match usage ${ctx.usage}`;
    }
    const billingNpi = segments.find((s) => s[0] === "NM1" && s[1] === "85")?.[9];
    if (ctx.billingNpi !== undefined && billingNpi !== ctx.billingNpi) {
      return "the billing provider NPI does not match the context";
    }
    return null;
  } catch (e) {
    return e instanceof X12FormatError
      ? "payload is not a readable X12 interchange"
      : "payload could not be checked";
  }
}

function receiptOf(a: SubmissionAttempt, replayed: boolean): SubmissionReceipt | null {
  if (a.status !== "sent" || a.clearinghouseSubmissionId === null || a.receivedAt === null) {
    return null;
  }
  return {
    clearinghouseSubmissionId: a.clearinghouseSubmissionId,
    idempotencyKey: a.idempotencyKey,
    controlNumber: a.controlNumber,
    receivedAt: a.receivedAt,
    replayed,
  };
}

export class DirectMacTransport implements ClearinghouseTransport {
  readonly vendor = "direct_mac" as const;
  private readonly attempts: SubmissionAttemptStore;
  private readonly gateway: DirectMacGateway;
  private readonly now: () => Date;
  private readonly onAnomaly: (anomaly: DirectMacAnomaly) => void;

  constructor(options: DirectMacTransportOptions) {
    this.attempts = options.attempts;
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
    this.onAnomaly = options.onAnomaly ?? (() => {});
  }

  submitClaim(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (submission.kind !== "claim") {
      return Promise.resolve(refuse("submitClaim accepts kind=claim only"));
    }
    if (submission.adjustment) {
      return Promise.resolve(refuse("replacement and void are not supported through direct_mac"));
    }
    return this.submit(ctx, submission);
  }

  submitNotice(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (submission.kind !== "noe" && submission.kind !== "notr") {
      return Promise.resolve(refuse("submitNotice accepts kind=noe or notr only"));
    }
    if (submission.adjustment) {
      return Promise.resolve(refuse("a notice cannot carry a claim adjustment"));
    }
    return this.submit(ctx, submission);
  }

  private async submit(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (ctx.usage === "production" && !ctx.billingNpi) {
      return refuse("billingNpi is required for production usage");
    }
    if (!KEY_SHAPE.test(submission.idempotencyKey)) {
      return refuse("idempotencyKey must be 1-128 characters of A-Z a-z 0-9 _ . : -");
    }
    if (!CONTROL_NUMBER_SHAPE.test(submission.controlNumber)) {
      return refuse("controlNumber must be 1-64 characters of A-Z a-z 0-9 -");
    }
    const { payload } = submission;
    if (payload.format === "x12") {
      const problem = x12Problem(payload.x12, ctx);
      if (problem) return refuse(problem);
    } else if (
      payload.document === null ||
      typeof payload.document !== "object" ||
      Array.isArray(payload.document)
    ) {
      return refuse("JSON document must be an object");
    }
    let scope: string;
    let identity: string;
    try {
      scope = scopeKey(ctx);
      identity = identityOf(submission);
    } catch {
      return refuse("submission could not be fingerprinted");
    }
    const reservedAt = this.now().toISOString();
    const held = await this.reserve(ctx, submission, {
      organizationId: ctx.organizationId,
      providerEntityId: ctx.providerEntityId,
      scope,
      usage: ctx.usage,
      idempotencyKey: submission.idempotencyKey,
      controlNumber: submission.controlNumber,
      kind: submission.kind,
      identity,
      status: "reserved",
      clearinghouseSubmissionId: null,
      firstReservedAt: reservedAt,
      reservedAt,
      receivedAt: null,
    });
    if (held) return held;

    // From here this call owns the reservation.
    let x12: string;
    if (payload.format === "x12") {
      x12 = payload.x12;
    } else {
      try {
        x12 = (
          await this.gateway.generate({
            kind: submission.kind,
            organizationId: ctx.organizationId,
            controlNumber: submission.controlNumber,
            document: payload.document,
          })
        ).x12;
      } catch {
        // Nothing was sent: free the key and number.
        await this.release(ctx.organizationId, scope, submission);
        return degraded(CH.UNAVAILABLE, "the X12 generation gateway could not be reached");
      }
      const problem = x12Problem(x12, ctx);
      if (problem) {
        await this.release(ctx.organizationId, scope, submission);
        return refuse(`the generated file ${problem}`);
      }
    }
    let uploaded: { readonly accepted: boolean; readonly fileId: string };
    try {
      uploaded = await this.gateway.upload({
        kind: submission.kind,
        organizationId: ctx.organizationId,
        providerEntityId: ctx.providerEntityId,
        controlNumber: submission.controlNumber,
        x12,
      });
    } catch {
      // The file may have landed: keep the reservation, retaken after a short settle delay.
      await this.abandon(ctx.organizationId, scope, submission, reservedAt);
      return degraded(CH.UNAVAILABLE, "the MAC portal could not be reached");
    }
    if (!uploaded.accepted) {
      await this.release(ctx.organizationId, scope, submission);
      return refuse("the MAC portal refused the upload");
    }
    const fileId =
      uploaded.fileId.slice(0, MAX_FILE_ID_LENGTH) || `direct_mac:${submission.idempotencyKey}`;
    return this.complete(ctx, scope, submission, fileId);
  }

  /** Returns the result to hand back when this call must NOT send (replay, conflict, in flight), or null to send. */
  private async reserve(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
    attempt: SubmissionAttempt,
  ): Promise<X12WorkerResult<SubmissionReceipt> | null> {
    try {
      const { attempt: existing, reserved } = await this.attempts.reserve(attempt);
      if (reserved) return null;
      if (existing.scope !== attempt.scope || existing.idempotencyKey !== attempt.idempotencyKey) {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "the control number was already submitted under another key",
        );
      }
      if (existing.identity !== attempt.identity) {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "the idempotency key was used for a different submission",
        );
      }
      if (existing.status === "voided") {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "an operator voided this key after a stuck attempt; use a new idempotency key and control number",
        );
      }
      if (existing.status === "sent") {
        const receipt = receiptOf(existing, true);
        return receipt
          ? { ok: true, data: receipt }
          : degraded(CH.UNAVAILABLE, "the earlier attempt's record is incomplete");
      }
      const age = this.now().getTime() - Date.parse(existing.reservedAt);
      if (!(age >= IN_FLIGHT_MS)) {
        return degraded(
          CH.UNAVAILABLE,
          "an earlier attempt at this submission may still be in flight",
        );
      }
      const won = await this.attempts.retake(
        ctx.organizationId,
        attempt.scope,
        submission.idempotencyKey,
        existing.reservedAt,
        attempt.reservedAt,
      );
      return won
        ? null
        : degraded(CH.UNAVAILABLE, "an earlier attempt at this submission may still be in flight");
    } catch (e) {
      if (e instanceof Error && e.name === "PlatformControlNumberTaken") {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "the control number is already in use on this platform; allocate a new one",
        );
      }
      return degraded(CH.UNAVAILABLE, "the submission record could not be reserved");
    }
  }

  private async abandon(
    organizationId: string,
    scope: string,
    submission: ClearinghouseSubmission,
    reservedAt: string,
  ): Promise<void> {
    try {
      const backdated = new Date(Date.parse(reservedAt) - IN_FLIGHT_MS + SETTLE_MS).toISOString();
      await this.attempts.retake(
        organizationId,
        scope,
        submission.idempotencyKey,
        reservedAt,
        backdated,
      );
    } catch {
      // The reservation ages out of the in-flight window on its own.
    }
  }

  private async release(
    organizationId: string,
    scope: string,
    submission: ClearinghouseSubmission,
  ): Promise<void> {
    try {
      await this.attempts.release(organizationId, scope, submission.idempotencyKey);
    } catch {
      // The reservation ages out and is retaken; nothing was filed.
    }
  }

  /** The portal has the file; mark our record sent (retried: losing it risks a duplicate filing on a later retry). */
  private async complete(
    ctx: ClearinghouseContext,
    scope: string,
    submission: ClearinghouseSubmission,
    clearinghouseSubmissionId: string,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    for (let i = 0; i < RECORD_ATTEMPTS; i++) {
      try {
        const stored = await this.attempts.complete(
          ctx.organizationId,
          scope,
          submission.idempotencyKey,
          clearinghouseSubmissionId,
          this.now().toISOString(),
        );
        const receipt = stored === null ? null : receiptOf(stored, false);
        if (receipt === null) break;
        return { ok: true, data: receipt };
      } catch {
        // retry
      }
    }
    this.onAnomaly({
      type: "sent_but_unrecorded",
      idempotencyKey: submission.idempotencyKey,
      clearinghouseSubmissionId,
    });
    return degraded(
      CH.UNAVAILABLE,
      "uploaded to the MAC portal but the attempt could not be recorded; retry with the same key and reconcile",
    );
  }

  async fetchAcknowledgments(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>> {
    if (cursor !== null && !CURSOR_SHAPE.test(cursor)) {
      return refuse("cursor is malformed");
    }
    try {
      const items = await this.gateway.pullAcknowledgments(ctx);
      return { ok: true, data: { items, nextCursor: String(items.length), hasMore: false } };
    } catch {
      return degraded(CH.UNAVAILABLE, "the MAC portal acknowledgments could not be pulled");
    }
  }

  checkEligibility(
    _ctx: ClearinghouseContext,
    _req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    return notImplemented("eligibility");
  }

  validateOnly(
    _ctx: ClearinghouseContext,
    _submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>> {
    return notImplemented("dry-run validation");
  }

  fetchRemittances(
    _ctx: ClearinghouseContext,
    _cursor: string | null,
  ): Promise<X12WorkerResult<Page<RemittanceFile>>> {
    return notImplemented("remittances");
  }

  fetchClaimStatus(
    _ctx: ClearinghouseContext,
    _controlNumber: string,
  ): Promise<X12WorkerResult<ClaimStatus>> {
    return notImplemented("claim status");
  }

  verifyAndParseEvent(_webhook: RawWebhook): Promise<X12WorkerResult<ClearinghouseEvent>> {
    return notImplemented("event verification");
  }
}
