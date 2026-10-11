import { createHash } from "node:crypto";
// @wardenx/x12-837-client — the Stedi ClearinghouseTransport, SUBMIT SIDE (ADR-0053; contract:
// docs/audits/clearinghouse-integration/STEDI_TRANSPORT_CONTRACT_20261011.md).
//
// Implemented: submitClaim and submitNotice. Everything else answers CH_NOT_WIRED (fail closed) until its contract
// rows are verified: validateOnly must never call a submission endpoint, acks/835/status/events need the receive-side
// PR, eligibility the later one.
//
// Rules this file enforces so a caller cannot get them wrong:
//   - idempotency is kept by OUR attempt store (scoped to org, provider and usage), never trusted to Stedi's 24 h key;
//   - a raw X12 payload is checked locally (ISA15 matches the usage, Stedi's observed edits pass) BEFORE anything is
//     sent; a JSON document (built by our mapper) is checked for its usageIndicator only, so test traffic cannot reach
//     production or the reverse, and a known rejection is not filed;
//   - the Idempotency-Key sent to Stedi is scoped by (org, provider, usage): Stedi's key space is account-wide and one
//     platform credential serves every tenant;
//   - adjustments are refused without a send (Q17 open);
//   - a failure records nothing, so the same submission can be retried (we resend the same Idempotency-Key);
//   - no result, reason or log carries the API key, a response body or an edit description (codes and rule names only);
//   - no method throws.
import { X12FormatError, tokenizeInterchange } from "../eligibility/x12-envelope";
import { type X12WorkerResult, degraded } from "../types";
import {
  PlatformControlNumberTaken,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "./attempt-store";
import { checkStediEdits } from "./stedi-edit-rules";
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
  type SubmissionReceipt,
  type ValidationReport,
} from "./types";

export const STEDI_API_KEY_ENV = "STEDI_API_KEY";
const BASE_URL =
  "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/institutionalclaims/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,24}$/;
const MAX_REPORTED_CODES = 5;

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface StediTransportOptions {
  /** The platform API key (test or production key). Never logged, never returned. */
  readonly apiKey: string;
  readonly attempts: SubmissionAttemptStore;
  /** Injected so tests (and a future circuit breaker) own the network. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** PHI-free signals that need a human or a reconciler (see {@link StediAnomaly}). */
  readonly onAnomaly?: (anomaly: StediAnomaly) => void;
  /** Injected clock, for the reservation windows. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** Things that cannot be expressed in a result but must not pass silently. No payload, no response body. */
export type StediAnomaly =
  | {
      readonly type: "sent_but_unrecorded";
      readonly idempotencyKey: string;
      readonly clearinghouseSubmissionId: string;
    }
  | { readonly type: "stale_reservation"; readonly idempotencyKey: string }
  | { readonly type: "derived_submission_id"; readonly idempotencyKey: string };

const RECORD_ATTEMPTS = 3;
/** A reservation younger than this may still be mid-send: nothing else sends it. */
const IN_FLIGHT_MS = 15 * 60_000;
/** Stedi replays a repeated Idempotency-Key for 24 h; past that a re-send could file a duplicate. */
const KEY_WINDOW_MS = 24 * 60 * 60_000;
/** Stop re-sending this long before Stedi's key window ends: a send takes up to REQUEST_TIMEOUT_MS to land. */
const KEY_WINDOW_MARGIN_MS = 5 * 60_000;
/**
 * After an ambiguous failure the first request may still be processing at Stedi; wait this long before the retake so
 * two requests with one wire key are not in flight together.
 */
const SETTLE_MS = 60_000;

/**
 * True once a re-send under the same wire key could no longer be replayed by Stedi (or would land too close to the
 * end of its window). Past this the transport refuses and an operator settles the attempt.
 */
export function settleGuard(now: Date): { firstReservedBefore: string; reservedBefore: string } {
  return {
    firstReservedBefore: new Date(
      now.getTime() - (KEY_WINDOW_MS - KEY_WINDOW_MARGIN_MS),
    ).toISOString(),
    reservedBefore: new Date(now.getTime() - IN_FLIGHT_MS).toISOString(),
  };
}

export function pastKeyWindow(firstReservedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(firstReservedAt) >= KEY_WINDOW_MS - KEY_WINDOW_MARGIN_MS;
}

/** The outcome of one POST: taken (with Stedi's id), or not. `ambiguous` = the request may still have been filed. */
type SendResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly result: X12WorkerResult<never>; readonly ambiguous: boolean };

/** The key Stedi sees: unique per (org, provider, usage, caller key), well under the 255-character limit. */
function wireIdempotencyKey(scope: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${scope}\n${idempotencyKey}`).digest("hex");
}

/** Builds the transport from the platform environment, reading only STEDI_API_KEY. */
export function createStediTransportFromEnv(
  env: EnvMap,
  attempts: SubmissionAttemptStore,
  extras: Pick<StediTransportOptions, "onAnomaly" | "now"> = {},
): StediTransport {
  const apiKey = env[STEDI_API_KEY_ENV]?.trim();
  if (!apiKey) throw new Error(`${STEDI_API_KEY_ENV} is required for CLEARINGHOUSE_VENDOR=stedi`);
  return new StediTransport({ apiKey, attempts, ...extras });
}

const notImplemented = <T>(what: string): Promise<X12WorkerResult<T>> =>
  Promise.resolve(degraded<T>(CH.NOT_WIRED, `stedi ${what} is not implemented in this build`));

const refuse = <T>(reason: string): X12WorkerResult<T> => degraded<T>(CH.INVALID_REQUEST, reason);

/** Reason a payload must not be sent, or null. PHI-free: positions and rule names only. */
function x12Problem(x12: string, ctx: ClearinghouseContext, controlNumber: string): string | null {
  const { usage } = ctx;
  try {
    const { segments } = tokenizeInterchange(x12);
    const isa = segments.find((s) => s[0] === "ISA");
    // The control number is what dedupes us and the payer; it must be the interchange's own ISA13, not a free string.
    if (isa?.[13]?.trim() !== controlNumber) return "controlNumber does not match ISA13";
    const isa15 = isa?.[15];
    if (isa15 !== (usage === "test" ? "T" : "P")) {
      return `ISA15 does not match usage ${usage}`;
    }
    const billingNpi = segments.find((s) => s[0] === "NM1" && s[1] === "85")?.[9];
    if (ctx.billingNpi !== undefined && billingNpi !== ctx.billingNpi)
      return "the billing provider NPI does not match the context";
    const findings = checkStediEdits(x12);
    if (findings.length > 0) {
      return `fails Stedi edit checks: ${[...new Set(findings.map((f) => f.rule))].join(", ")}`;
    }
    return null;
  } catch (e) {
    if (e instanceof X12FormatError) return "payload is not a readable X12 interchange";
    return "payload could not be checked";
  }
}

function jsonProblem(document: unknown, ctx: ClearinghouseContext): string | null {
  const { usage } = ctx;
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return "JSON document must be an object";
  }
  // U: the field name follows Stedi's institutional JSON (billing.npi); unverified against a 2xx. Fails closed.
  const npi = (document as { billing?: { npi?: unknown } }).billing?.npi;
  if (ctx.billingNpi !== undefined && npi !== ctx.billingNpi)
    return "the billing provider NPI does not match the context";
  const indicator = (document as { usageIndicator?: unknown }).usageIndicator;
  return indicator === (usage === "test" ? "T" : "P")
    ? null
    : `usageIndicator does not match usage ${usage}`;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Error codes from a Stedi 4xx body, restricted to short code-shaped strings (never descriptions). */
function errorCodes(body: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const top = body?.code;
  if (typeof top === "string" && SAFE_CODE.test(top)) out.push(top);
  const list = body?.errors;
  if (Array.isArray(list)) {
    for (const item of list) {
      const code = (item as { code?: unknown } | null)?.code;
      if (typeof code === "string" && SAFE_CODE.test(code)) out.push(code);
    }
  }
  return [...new Set(out)].slice(0, MAX_REPORTED_CODES);
}

/**
 * Statuses that prove Stedi did NOT take the request. Anything else (5xx, 408, 409 "in progress", 3xx, unknown) may
 * have been filed, so the reservation is kept and the retry re-sends under the same wire key rather than releasing the
 * control number for a fresh one.
 */
const DEFINITIVE_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);

/** Caller-supplied ids end up in logs and the audit trail: keep them opaque, short and PHI-shaped-free. */
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTROL_NUMBER_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_VENDOR_ID_LENGTH = 200;

function failure<T>(status: number, body: Record<string, unknown> | null): X12WorkerResult<T> {
  const codes = errorCodes(body);
  if (codes.includes("ACCOUNT_NOT_PROVISIONED")) {
    return degraded<T>(
      CH.NOT_PROVISIONED,
      "the Stedi account is not provisioned for this operation",
    );
  }
  if (status === 401 || status === 403) {
    return degraded<T>(CH.NOT_WIRED, "Stedi rejected the platform credential");
  }
  if (status === 409) {
    return degraded<T>(CH.IDEMPOTENCY_CONFLICT, "Stedi reports the idempotency key was reused");
  }
  if (status === 429 || status >= 500) {
    return degraded<T>(CH.UNAVAILABLE, `Stedi answered HTTP ${status}`);
  }
  const suffix = codes.length > 0 ? ` (${codes.join(", ")})` : "";
  return degraded<T>(CH.INVALID_REQUEST, `Stedi refused the request, HTTP ${status}${suffix}`);
}

function submissionIdOf(body: Record<string, unknown> | null, idempotencyKey: string): string {
  const reference = body?.claimReference as { correlationId?: unknown } | undefined;
  if (
    typeof reference?.correlationId === "string" &&
    reference.correlationId &&
    reference.correlationId.length <= MAX_VENDOR_ID_LENGTH
  ) {
    return reference.correlationId;
  }
  const meta = body?.meta as { traceId?: unknown } | undefined;
  if (
    typeof meta?.traceId === "string" &&
    meta.traceId &&
    meta.traceId.length <= MAX_VENDOR_ID_LENGTH
  ) {
    return meta.traceId;
  }
  // A 2xx means Stedi took the submission; keep a derived id rather than losing the record (U: no 2xx observed yet).
  return derivedSubmissionId(idempotencyKey);
}

const derivedSubmissionId = (idempotencyKey: string): string => `stedi:${idempotencyKey}`;

/** A sent attempt always carries the vendor id and the receipt time; anything else is not a receipt. */
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

export class StediTransport implements ClearinghouseTransport {
  readonly vendor = "stedi" as const;
  private readonly apiKey: string;
  private readonly attempts: SubmissionAttemptStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onAnomaly: (anomaly: StediAnomaly) => void;
  private readonly now: () => Date;

  constructor(options: StediTransportOptions) {
    this.apiKey = options.apiKey;
    this.attempts = options.attempts;
    this.fetchImpl = options.fetch ?? fetch;
    this.onAnomaly = options.onAnomaly ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  submitClaim(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (submission.kind !== "claim") {
      return Promise.resolve(refuse("submitClaim accepts kind=claim only"));
    }
    if (submission.adjustment) {
      return Promise.resolve(
        refuse("replacement and void are not supported through Stedi yet (Q17 is open)"),
      );
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
    if (submission.payload.format !== "x12") {
      return Promise.resolve(refuse("notices are sent as raw X12"));
    }
    return this.submit(ctx, submission);
  }

  private async submit(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    const { payload } = submission;
    if (ctx.usage === "production" && !ctx.billingNpi) {
      return refuse("billingNpi is required for production usage");
    }
    if (!KEY_SHAPE.test(submission.idempotencyKey)) {
      return refuse("idempotencyKey must be 1-128 characters of A-Z a-z 0-9 _ . : -");
    }
    if (!CONTROL_NUMBER_SHAPE.test(submission.controlNumber)) {
      return refuse("controlNumber must be 1-64 characters of A-Z a-z 0-9 -");
    }
    const problem =
      payload.format === "x12"
        ? x12Problem(payload.x12, ctx, submission.controlNumber)
        : jsonProblem(payload.document, ctx);
    if (problem) return refuse(problem);
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

    const sent = await this.send(scope, submission);
    if (!sent.ok) {
      if (sent.ambiguous) {
        // The request may have been filed. Re-sending under the SAME wire key is safe inside Stedi's 24 h window (it
        // replays), so the next attempt must not wait out the in-flight window: backdate the reservation so it is
        // retaken after a short settle delay. The window itself keeps running from the first reservation.
        await this.abandonQuietly(ctx.organizationId, scope, submission, reservedAt);
      } else {
        await this.releaseQuietly(ctx.organizationId, scope, submission);
      }
      return sent.result;
    }
    return this.complete(ctx, scope, submission, sent.id);
  }

  /**
   * Reserves the submission. Returns the result to hand back when this call must NOT send (replay, conflict, held),
   * or null when it owns the reservation and should send.
   */
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
      if (pastKeyWindow(existing.firstReservedAt, this.now())) {
        this.onAnomaly({ type: "stale_reservation", idempotencyKey: attempt.idempotencyKey });
        return degraded(
          CH.UNAVAILABLE,
          "an earlier attempt is past the vendor's key window and needs reconciliation before a re-send",
        );
      }
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
      if (e instanceof PlatformControlNumberTaken) {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "the control number is already in use on this platform; allocate a new one",
        );
      }
      return degraded(CH.UNAVAILABLE, "the submission record could not be reserved");
    }
  }

  private async abandonQuietly(
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

  private async releaseQuietly(
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

  /**
   * Stedi has taken the submission; mark our record sent. Retried a few times, because losing it means a later
   * retry (after Stedi's 24 h key window, or under a new key) could file a duplicate. If the record cannot be made
   * the caller gets a retryable result and the reconciler gets a PHI-free anomaly.
   */
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
        if (receipt === null) break; // the reservation is gone; retrying cannot recreate it
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
      "submitted to Stedi but the attempt could not be recorded; retry with the same key and reconcile",
    );
  }

  /** One POST. Never throws. */
  private async send(scope: string, submission: ClearinghouseSubmission): Promise<SendResult> {
    const { payload } = submission;
    const url = `${BASE_URL}/${payload.format === "x12" ? "raw-x12-submission" : "submission"}`;
    const body = payload.format === "x12" ? { x12: payload.x12 } : payload.document;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
          "Idempotency-Key": wireIdempotencyKey(scope, submission.idempotencyKey),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A 30x must never silently turn the POST into a GET or follow to another origin.
        redirect: "error",
      });
    } catch {
      return {
        ok: false,
        result: degraded(CH.UNAVAILABLE, "Stedi could not be reached"),
        ambiguous: true,
      };
    }
    const parsed = await readJson(res);
    if (!res.ok) {
      return {
        ok: false,
        result: failure(res.status, parsed),
        ambiguous: !DEFINITIVE_REFUSALS.has(res.status),
      };
    }
    const id = submissionIdOf(parsed, submission.idempotencyKey);
    if (id === derivedSubmissionId(submission.idempotencyKey)) {
      this.onAnomaly({ type: "derived_submission_id", idempotencyKey: submission.idempotencyKey });
    }
    return { ok: true, id };
  }

  validateOnly(
    _ctx: ClearinghouseContext,
    _submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>> {
    // MUST NOT call a submission endpoint: on a provisioned account a payload that passes edits is filed.
    return notImplemented("validateOnly (no dry-run endpoint is documented)");
  }

  checkEligibility(
    _ctx: ClearinghouseContext,
    _req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    return notImplemented("eligibility");
  }

  fetchAcknowledgments(
    _ctx: ClearinghouseContext,
    _cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>> {
    return notImplemented("acknowledgments");
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
