// @wardenx/x12-837-client — the Stedi ClearinghouseTransport, SUBMIT SIDE (ADR-0053; contract:
// docs/audits/clearinghouse-integration/STEDI_TRANSPORT_CONTRACT_20261011.md).
//
// Implemented: submitClaim and submitNotice. Everything else answers CH_NOT_WIRED (fail closed) until its contract
// rows are verified: validateOnly must never call a submission endpoint, acks/835/status/events need the receive-side
// PR, eligibility the later one.
//
// Rules this file enforces so a caller cannot get them wrong:
//   - idempotency is kept by OUR attempt store (scoped to org, provider and usage), never trusted to Stedi's 24 h key;
//   - a payload is checked locally (usage matches the call, Stedi's observed edits pass) BEFORE anything is sent, so
//     test traffic cannot reach production or the reverse and a known rejection is not filed;
//   - adjustments are refused without a send (Q17 open);
//   - a failure records nothing, so the same submission can be retried (we resend the same Idempotency-Key);
//   - no result, reason or log carries the API key, a response body or an edit description (codes and rule names only);
//   - no method throws.
import { X12FormatError, tokenizeInterchange } from "../eligibility/x12-envelope";
import { type X12WorkerResult, degraded } from "../types";
import type { SubmissionAttempt, SubmissionAttemptStore } from "./attempt-store";
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
}

/** Builds the transport from the platform environment, reading only STEDI_API_KEY. */
export function createStediTransportFromEnv(
  env: EnvMap,
  attempts: SubmissionAttemptStore,
): StediTransport {
  const apiKey = env[STEDI_API_KEY_ENV]?.trim();
  if (!apiKey) throw new Error(`${STEDI_API_KEY_ENV} is required for CLEARINGHOUSE_VENDOR=stedi`);
  return new StediTransport({ apiKey, attempts });
}

const notImplemented = <T>(what: string): Promise<X12WorkerResult<T>> =>
  Promise.resolve(degraded<T>(CH.NOT_WIRED, `stedi ${what} is not implemented in this build`));

const refuse = <T>(reason: string): X12WorkerResult<T> => degraded<T>(CH.INVALID_REQUEST, reason);

/** Reason a payload must not be sent, or null. PHI-free: positions and rule names only. */
function x12Problem(x12: string, usage: ClearinghouseContext["usage"]): string | null {
  try {
    const { segments } = tokenizeInterchange(x12);
    const isa15 = segments.find((s) => s[0] === "ISA")?.[15];
    if (isa15 !== (usage === "test" ? "T" : "P")) {
      return `ISA15 does not match usage ${usage}`;
    }
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

function jsonProblem(document: unknown, usage: ClearinghouseContext["usage"]): string | null {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return "JSON document must be an object";
  }
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
  if (typeof reference?.correlationId === "string" && reference.correlationId) {
    return reference.correlationId;
  }
  const meta = body?.meta as { traceId?: unknown } | undefined;
  if (typeof meta?.traceId === "string" && meta.traceId) return meta.traceId;
  // A 2xx means Stedi took the submission; keep a derived id rather than losing the record (U: no 2xx observed yet).
  return `stedi:${idempotencyKey}`;
}

const receiptOf = (a: SubmissionAttempt, replayed: boolean): SubmissionReceipt => ({
  clearinghouseSubmissionId: a.clearinghouseSubmissionId,
  idempotencyKey: a.idempotencyKey,
  controlNumber: a.controlNumber,
  receivedAt: a.receivedAt,
  replayed,
});

export class StediTransport implements ClearinghouseTransport {
  readonly vendor = "stedi" as const;
  private readonly apiKey: string;
  private readonly attempts: SubmissionAttemptStore;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StediTransportOptions) {
    this.apiKey = options.apiKey;
    this.attempts = options.attempts;
    this.fetchImpl = options.fetch ?? fetch;
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
    const problem =
      payload.format === "x12"
        ? x12Problem(payload.x12, ctx.usage)
        : jsonProblem(payload.document, ctx.usage);
    if (problem) return refuse(problem);
    try {
      const scope = scopeKey(ctx);
      const identity = identityOf(submission);
      const prior = await this.attempts.findByKey(scope, submission.idempotencyKey);
      if (prior) {
        return prior.identity === identity
          ? { ok: true, data: receiptOf(prior, true) }
          : degraded(
              CH.IDEMPOTENCY_CONFLICT,
              "the idempotency key was used for a different submission",
            );
      }
      if (await this.attempts.findByControlNumber(scope, submission.controlNumber)) {
        return degraded(
          CH.IDEMPOTENCY_CONFLICT,
          "the control number was already submitted under another key",
        );
      }
      const sent = await this.send(submission);
      if (!sent.ok) return sent;
      const stored = await this.attempts.putIfAbsent({
        scope,
        idempotencyKey: submission.idempotencyKey,
        controlNumber: submission.controlNumber,
        kind: submission.kind,
        identity,
        clearinghouseSubmissionId: sent.data,
        receivedAt: new Date().toISOString(),
      });
      return { ok: true, data: receiptOf(stored, stored.clearinghouseSubmissionId !== sent.data) };
    } catch {
      return degraded(CH.UNAVAILABLE, "the submission could not be recorded or sent");
    }
  }

  /** One POST. Returns the vendor's submission id, or a degraded envelope. Throws only into `submit`'s catch. */
  private async send(submission: ClearinghouseSubmission): Promise<X12WorkerResult<string>> {
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
          "Idempotency-Key": submission.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return degraded(CH.UNAVAILABLE, "Stedi could not be reached");
    }
    const parsed = await readJson(res);
    if (!res.ok) return failure(res.status, parsed);
    return { ok: true, data: submissionIdOf(parsed, submission.idempotencyKey) };
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
