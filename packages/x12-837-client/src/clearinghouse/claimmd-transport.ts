import { createHash } from "node:crypto";
// @chartwarden/x12-837-client — the Claim.MD ClearinghouseTransport (ADR-0053, amendment 2026-11-04; contract:
// docs/audits/clearinghouse-integration/CLAIMMD_TRANSPORT_CONTRACT_20261104.md).
//
// Implemented: submitClaim (incl. replacement 7 / void 8), submitNotice (NOE/NOTR/transfer), fetchAcknowledgments
// (`/response/`), fetchRemittances (`/eralist/` + `/era835/`), fetchClaimStatus (`/response/` by claim id or by control
// number), checkEligibility (`/eligdata/`, claimmd-eligibility.ts) and validateOnly (LOCAL pre-upload checks only: Claim.MD
// has no dry run). CH_NOT_WIRED: verifyAndParseEvent (Claim.MD pushes enrollment/appeal events only).
//
// Rules this file enforces:
//   - ONE Claim.MD account (one key) per usage mode; a call whose usage has no key answers CH_NOT_WIRED, so test traffic
//     can never reach the production account or the reverse.
//   - the account is shared by every tenant: every read is filtered to `ctx.billingNpi` (provider_entity.npi is unique
//     platform-wide), and no call runs without it;
//   - Claim.MD refuses only a repeated Filename (code 61, observed 2026-11-05), not a repeated claim, so OUR attempt store is the idempotency authority: a submission is reserved
//     before the upload, the upload's Filename is derived from (scope, key), and an attempt whose upload may have landed
//     (timeout, 5xx, unreadable 2xx) is NEVER re-sent blind: after the in-flight window `/uploadlist/` is searched for that
//     Filename and only its absence allows a resend; a code-61 answer is the proof it landed and stays in doubt;
//   - one claim per upload: raw X12 with CLM01 == controlNumber (Claim.MD echoes it as `pcn`), ISA08 == CLAIMMD and
//     ISA15 == usage, or a Claim.MD JSON document (`{ claim: [ { pcn, bill_npi, … } ] }`) with the same pcn/NPI rules;
//   - no result, reason or anomaly carries the key, a response body or vendor message text (codes only); no method throws.
import { X12FormatError, tokenizeInterchange } from "../eligibility/x12-envelope";
import { type X12WorkerResult, degraded } from "../types";
import {
  PlatformControlNumberTaken,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "./attempt-store";
import { claimMdCheckEligibility } from "./claimmd-eligibility";
import {
  type ClaimMdRequestCounter,
  budgetedFetch,
  createInProcessClaimMdCounter,
} from "./claimmd-rate-limit";
import {
  type ClaimMdRecord,
  DUPLICATE_FILE_CODE,
  type WireResult,
  claimMdDay,
  hasList,
  listOf,
  postForm,
  postUpload,
  rawFiles,
  safeCodes,
  str,
  topAttr,
  vendorError,
} from "./claimmd-wire";
import { identityOf, scopeKey } from "./submission-identity";
import {
  type AckEvent,
  type AckStage,
  CH,
  type ClaimStatus,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseEligibilityResult,
  type ClearinghouseEvent,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type Page,
  type RemittanceFile,
  type SubmissionReceipt,
  type SubmissionState,
  type ValidationReport,
} from "./types";

export const CLAIMMD_ACCOUNT_KEY_ENV = "CLAIMMD_ACCOUNT_KEY";
/** Which Claim.MD account the key opens: `test` (a Claim.MD test account) or `production`. Required. */
export const CLAIMMD_ACCOUNT_USAGE_ENV = "CLAIMMD_ACCOUNT_USAGE";
/** Fixed reason for a rejected key (listed in CREDENTIAL_REJECTED_REASONS); never vendor text. */
export const CLAIMMD_CREDENTIAL_REJECTED = "Claim.MD rejected the platform credential";

/** Companion guide: ISA08 / GS03 = CLAIMMD; ISA06 / GS02 = our Claim.MD account number (billing_edi_profile data). */
const RECEIVER_ID = "CLAIMMD";
/** `senderid` of an answer Claim.MD itself produced (clearinghouse stage); any other sender is the payer. */
const CLEARINGHOUSE_SENDER = "CLMMD";
/** A reservation younger than this may still be mid-upload: nothing else sends or reconciles it. */
const IN_FLIGHT_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** `/uploadlist/` days searched around an attempt (Claim.MD dates are account-local, so one day either side). */
const MAX_LIST_DAYS = 9;
const UPLOAD_LIST_PAGE = 500;
const MAX_UPLOAD_LIST_PAGES = 10;
const RECORD_ATTEMPTS = 3;
/** `/response/` returns at most this many claims per call; a full page means more is waiting. */
const RESPONSE_PAGE_LIMIT = 20_000;
/** Pages of the account stream a status-by-control-number may read (see responsesFor). */
const STATUS_SCAN_PAGES = 5;
/** `/eralist/` page size; and how many ERAs one call downloads (each is a request against the shared budget, claimmd-rate-limit.ts). */
const ERA_PAGE_SIZE = 100;
const MAX_ERAS_PER_CALL = 25;
const CURSOR_SHAPE = /^\d{1,18}$/;
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTROL_NUMBER_SHAPE = /^[A-Za-z0-9-]{1,38}$/;
const MAX_VENDOR_ID_LENGTH = 64;

type Usage = ClearinghouseContext["usage"];
type EnvMap = Readonly<Record<string, string | undefined>>;

export interface ClaimMdTransportOptions {
  /** The account key per usage mode. Never logged, never returned. */
  readonly keys: Readonly<Partial<Record<Usage, string>>>;
  readonly attempts: SubmissionAttemptStore;
  readonly fetch?: typeof fetch;
  /** Claim.MD's per-account request budget (claimmd-rate-limit.ts). Default: in-process; the backend injects Valkey. */
  readonly requestCounter?: ClaimMdRequestCounter;
  readonly onAnomaly?: (anomaly: ClaimMdAnomaly) => void;
  readonly now?: () => Date;
}

/** PHI-free signals for the log / a reconciler. Ids and codes only. */
export type ClaimMdAnomaly =
  | {
      readonly type: "sent_but_unrecorded";
      readonly idempotencyKey: string;
      readonly clearinghouseSubmissionId: string;
    }
  /** An in-doubt upload was found in `/uploadlist/`; its Claim.MD claim id is unknown (status reads `received`). */
  | { readonly type: "reconciled_from_upload_list"; readonly idempotencyKey: string }
  /**
   * A response status letter with no mapping yet (only `A` and `R` are known); the response is skipped, not guessed.
   * controlNumber is our own id (no PHI), so an operator can find the claim whose answer was skipped.
   */
  | {
      readonly type: "unmapped_status";
      readonly stage: AckStage;
      readonly status: string;
      readonly controlNumber: string;
    }
  /** An `era835` `data` array that is neither whole interchanges nor fragments of one: remittances stop at this ERA. */
  | { readonly type: "era_unreadable"; readonly eraid: string; readonly elements: number };

/** Builds the transport from the platform environment: CLAIMMD_ACCOUNT_KEY and CLAIMMD_ACCOUNT_USAGE. */
export function createClaimMdTransportFromEnv(
  env: EnvMap,
  attempts: SubmissionAttemptStore,
  extras: Pick<ClaimMdTransportOptions, "onAnomaly" | "now" | "requestCounter"> = {},
): ClaimMdTransport {
  const key = env[CLAIMMD_ACCOUNT_KEY_ENV]?.trim();
  if (!key)
    throw new Error(`${CLAIMMD_ACCOUNT_KEY_ENV} is required for CLEARINGHOUSE_VENDOR=claimmd`);
  const usage = env[CLAIMMD_ACCOUNT_USAGE_ENV]?.trim();
  if (usage !== "test" && usage !== "production") {
    throw new Error(
      `${CLAIMMD_ACCOUNT_USAGE_ENV} must be "test" or "production" for CLEARINGHOUSE_VENDOR=claimmd`,
    );
  }
  return new ClaimMdTransport({ keys: { [usage]: key }, attempts, ...extras });
}

const refuse = <T>(reason: string): X12WorkerResult<T> => degraded<T>(CH.INVALID_REQUEST, reason);
const notImplemented = <T>(what: string): Promise<X12WorkerResult<T>> =>
  Promise.resolve(degraded<T>(CH.NOT_WIRED, `claimmd ${what} is not implemented`));

/**
 * The upload's Filename: unique per (scope, caller key), PHI-free, and how an in-doubt upload is found again. The
 * extension tells Claim.MD the format (`.837` raw X12, `.json` a Claim.MD JSON document).
 */
export function claimMdFilename(
  scope: string,
  idempotencyKey: string,
  format: "x12" | "json" = "x12",
): string {
  const digest = createHash("sha256").update(`${scope}\n${idempotencyKey}`).digest("hex");
  return `cw-${digest.slice(0, 40)}.${format === "x12" ? "837" : "json"}`;
}

/**
 * Reason a Claim.MD JSON document must not be uploaded, or null. Claim.MD's JSON carries no ISA, so usage is enforced
 * by the account key alone; adjustments travel as X12 only (CLM05-3 and REF*F8 are checked there).
 */
export function claimMdJsonProblem(
  document: unknown,
  ctx: ClearinghouseContext,
  submission: ClearinghouseSubmission,
): string | null {
  const claims = (document as { claim?: unknown } | null)?.claim;
  if (!Array.isArray(claims) || claims.length !== 1)
    return "a JSON upload carries exactly one claim";
  const only = claims[0] as { pcn?: unknown; bill_npi?: unknown } | null;
  if (only?.pcn !== submission.controlNumber) return "claim.pcn does not match the control number";
  if (only.bill_npi !== ctx.billingNpi)
    return "the billing provider NPI does not match the context";
  if (submission.kind !== "claim" || submission.adjustment)
    return "notices and adjustments are sent as raw X12";
  return null;
}

/**
 * May have reached Claim.MD, unconfirmed, and only a repeated Filename is refused (code 61): the port's "never retry"
 * code (ADR-0053). The reservation is kept, so a retry with the SAME key reconciles against `/uploadlist/` before any
 * resend; M23's retry (which mints a new key) stops and an operator settles it.
 */
function inDoubt<T>(reason: string): X12WorkerResult<T> {
  return degraded<T>(CH.IN_DOUBT, reason);
}

/** The larger of two numeric ids ("0" when both are null): a cursor never moves backwards. */
function maxId(a: string | null, b: string | null): string {
  if (a === null) return b ?? "0";
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

/**
 * A transport/HTTP failure as a degraded envelope. On a read, anything but a credential rejection is UNAVAILABLE:
 * consumers reset their stored cursor on INVALID_REQUEST, and one bad page must not replay the account's history.
 */
function wireFailure<T>(
  w: Extract<WireResult, { ok: false }>,
  op: "read" | "write",
): X12WorkerResult<T> {
  if (w.status === 401) return degraded<T>(CH.NOT_WIRED, CLAIMMD_CREDENTIAL_REJECTED);
  // 403 is Claim.MD's temporary block after 100 requests a minute.
  if (
    op === "read" ||
    w.status === null ||
    w.status === 403 ||
    w.status === 429 ||
    w.status >= 500
  ) {
    return degraded<T>(
      CH.UNAVAILABLE,
      w.status ? `Claim.MD answered HTTP ${w.status}` : "Claim.MD could not be reached",
    );
  }
  return refuse<T>(`Claim.MD refused the request, HTTP ${w.status}`);
}

/** A 2xx that carries `error` elements, as a degraded envelope; null when it carries none. */
function bodyFailure<T>(body: ClaimMdRecord, op: "read" | "write"): X12WorkerResult<T> | null {
  const e = vendorError(body);
  if (!e) return null;
  if (e.credential) return degraded<T>(CH.NOT_WIRED, CLAIMMD_CREDENTIAL_REJECTED);
  const suffix = e.codes.length > 0 ? ` (${e.codes.join(", ")})` : "";
  return op === "read"
    ? degraded<T>(CH.UNAVAILABLE, `Claim.MD answered with an error${suffix}`)
    : refuse<T>(`Claim.MD refused the request${suffix}`);
}

function receiptOf(a: SubmissionAttempt, replayed: boolean): SubmissionReceipt | null {
  if (a.status !== "sent" || a.clearinghouseSubmissionId === null || a.receivedAt === null)
    return null;
  return {
    clearinghouseSubmissionId: a.clearinghouseSubmissionId,
    idempotencyKey: a.idempotencyKey,
    controlNumber: a.controlNumber,
    receivedAt: a.receivedAt,
    replayed,
  };
}

/** Reason the X12 must not be uploaded, or null. Positions and rule names only. */
export function claimMdX12Problem(
  x12: string,
  ctx: ClearinghouseContext,
  submission: ClearinghouseSubmission,
): string | null {
  try {
    const { segments, delimiters } = tokenizeInterchange(x12);
    const isa = segments.find((s) => s[0] === "ISA");
    if (isa?.[8]?.trim() !== RECEIVER_ID) return `ISA08 must be ${RECEIVER_ID}`;
    if (isa[15] !== (ctx.usage === "test" ? "T" : "P"))
      return `ISA15 does not match usage ${ctx.usage}`;
    const claims = segments.filter((s) => s[0] === "CLM");
    if (claims.length !== 1) return "an upload carries exactly one CLM";
    const clm = claims[0] as readonly string[];
    if (clm[1] !== submission.controlNumber) return "CLM01 does not match the control number";
    const npi = segments.find((s) => s[0] === "NM1" && s[1] === "85")?.[9];
    if (npi !== ctx.billingNpi) return "the billing provider NPI does not match the context";
    if (submission.kind !== "claim") return null;
    const frequency = (clm[5] ?? "").split(delimiters.component)[2];
    const f8 = segments.find((s) => s[0] === "REF" && s[1] === "F8")?.[2];
    const adjustment = submission.adjustment;
    if (!adjustment) {
      return frequency === "7" || frequency === "8"
        ? "CLM05-3 is a replacement or void but the submission carries no adjustment"
        : null;
    }
    if (frequency !== (adjustment.kind === "replacement" ? "7" : "8")) {
      return `CLM05-3 does not match the ${adjustment.kind}`;
    }
    return f8 === adjustment.originalPayerClaimNumber
      ? null
      : "REF*F8 does not match the payer claim number";
  } catch (e) {
    return e instanceof X12FormatError
      ? "payload is not a readable X12 interchange"
      : "payload could not be checked";
  }
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export class ClaimMdTransport implements ClearinghouseTransport {
  readonly vendor = "claimmd" as const;
  private readonly keys: Readonly<Partial<Record<Usage, string>>>;
  private readonly attempts: SubmissionAttemptStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onAnomaly: (anomaly: ClaimMdAnomaly) => void;
  private readonly now: () => Date;

  constructor(options: ClaimMdTransportOptions) {
    this.keys = options.keys;
    this.attempts = options.attempts;
    // Every Claim.MD request goes through this fetch. The account a request opens is read back from its AccountKey
    // field (the key is compared, never kept or logged); the budget is counted per usage mode.
    const usageByKey = new Map(
      Object.entries(options.keys).map(([usage, key]) => [key, usage as Usage]),
    );
    this.fetchImpl = budgetedFetch(
      options.fetch ?? fetch,
      options.requestCounter ?? createInProcessClaimMdCounter(),
      (init) => {
        const body = init?.body;
        const key =
          body instanceof URLSearchParams || body instanceof FormData
            ? body.get("AccountKey")
            : null;
        return typeof key === "string" ? usageByKey.get(key) : undefined;
      },
    );
    this.onAnomaly = options.onAnomaly ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** The key for this call's usage, or the reason the call cannot run. */
  private keyFor(ctx: ClearinghouseContext): { key: string } | { fail: X12WorkerResult<never> } {
    const key = this.keys[ctx.usage];
    if (!key) {
      return {
        fail: degraded(CH.NOT_WIRED, `no Claim.MD account is configured for ${ctx.usage} usage`),
      };
    }
    if (!ctx.billingNpi) {
      return {
        fail: refuse(
          "billingNpi is required: it is what isolates tenants on the shared Claim.MD account",
        ),
      };
    }
    return { key };
  }

  // ─── Submission ───────────────────────────────────────────────────────────────────────────────

  async submitClaim(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (submission.kind !== "claim") return refuse("submitClaim accepts kind=claim only");
    const adjustment = submission.adjustment;
    if (adjustment) {
      if (!adjustment.originalPayerClaimNumber) {
        return refuse("a replacement or void needs the payer claim number (REF*F8)");
      }
      try {
        const original = await this.attempts.findByControlNumber(
          ctx.organizationId,
          scopeKey(ctx),
          adjustment.originalControlNumber,
        );
        if (original?.status !== "sent") {
          return degraded(
            CH.UNKNOWN_ORIGINAL,
            "the original claim was never submitted through this clearinghouse",
          );
        }
      } catch {
        return degraded(CH.UNAVAILABLE, "the original submission could not be looked up");
      }
    }
    return this.submit(ctx, submission);
  }

  submitNotice(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    const { kind } = submission;
    if (kind !== "noe" && kind !== "notr" && kind !== "transfer_notice") {
      return Promise.resolve(refuse("submitNotice accepts kind=noe, notr or transfer_notice only"));
    }
    if (submission.adjustment)
      return Promise.resolve(refuse("a notice cannot carry a claim adjustment"));
    return this.submit(ctx, submission);
  }

  private async submit(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return access.fail;
    if (!KEY_SHAPE.test(submission.idempotencyKey)) {
      return refuse("idempotencyKey must be 1-128 characters of A-Z a-z 0-9 _ . : -");
    }
    if (!CONTROL_NUMBER_SHAPE.test(submission.controlNumber)) {
      return refuse("controlNumber must be 1-38 characters of A-Z a-z 0-9 - (CLM01)");
    }
    const { payload } = submission;
    const problem =
      payload.format === "x12"
        ? claimMdX12Problem(payload.x12, ctx, submission)
        : claimMdJsonProblem(payload.document, ctx, submission);
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
    const attempt: SubmissionAttempt = {
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
    };
    const held = await this.reserve(ctx, access.key, attempt);
    if (held) return held;
    const file = payload.format === "x12" ? payload.x12 : JSON.stringify(payload.document);
    return this.upload(ctx, access.key, attempt, payload.format, file);
  }

  /** Returns the answer when this call must NOT upload (replay, conflict, in flight, reconciled), or null to upload. */
  private async reserve(
    ctx: ClearinghouseContext,
    key: string,
    attempt: SubmissionAttempt,
  ): Promise<X12WorkerResult<SubmissionReceipt> | null> {
    let existing: SubmissionAttempt;
    try {
      const r = await this.attempts.reserve(attempt);
      if (r.reserved) return null;
      existing = r.attempt;
    } catch (e) {
      return e instanceof PlatformControlNumberTaken
        ? degraded(
            CH.IDEMPOTENCY_CONFLICT,
            "the control number is already in use on this platform; allocate a new one",
          )
        : degraded(CH.UNAVAILABLE, "the submission record could not be reserved");
    }
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
    // Fails closed: an unparseable reservedAt counts as in flight.
    if (!(this.now().getTime() - Date.parse(existing.reservedAt) >= IN_FLIGHT_MS)) {
      return degraded(
        CH.UNAVAILABLE,
        "an earlier attempt at this submission may still be in flight",
      );
    }
    // A stale reservation: the earlier upload may have landed. A different claim is never deduped, so look before re-sending.
    const found = await this.findUpload(key, attempt, existing);
    if (found === "error") {
      return degraded(
        CH.UNAVAILABLE,
        "an earlier upload could not be reconciled with Claim.MD's upload list",
      );
    }
    if (found !== null) {
      this.onAnomaly({
        type: "reconciled_from_upload_list",
        idempotencyKey: attempt.idempotencyKey,
      });
      return this.complete(ctx, attempt, `file:${found}`, true);
    }
    try {
      const won = await this.attempts.retake(
        ctx.organizationId,
        attempt.scope,
        attempt.idempotencyKey,
        existing.reservedAt,
        attempt.reservedAt,
      );
      return won
        ? null
        : degraded(CH.UNAVAILABLE, "an earlier attempt at this submission may still be in flight");
    } catch {
      return degraded(CH.UNAVAILABLE, "the submission record could not be retaken");
    }
  }

  /** The Claim.MD inbound id of our file in `/uploadlist/`, null when it is provably absent, "error" when unknown. */
  private async findUpload(
    key: string,
    attempt: SubmissionAttempt,
    existing: SubmissionAttempt,
  ): Promise<string | null | "error"> {
    // The format is not recorded on the attempt, so either extension of OUR name counts as the upload.
    const names = new Set([
      claimMdFilename(attempt.scope, attempt.idempotencyKey, "x12"),
      claimMdFilename(attempt.scope, attempt.idempotencyKey, "json"),
    ]);
    // The upload being reconciled happened at the LATEST reservation (a retake moves it), so anchor there.
    const from = Date.parse(existing.reservedAt) - DAY_MS;
    const to = this.now().getTime() + DAY_MS;
    if (!Number.isFinite(from) || to - from > MAX_LIST_DAYS * DAY_MS) return "error";
    for (let day = 0; from + day * DAY_MS <= to; day++) {
      const date = isoDay(new Date(from + day * DAY_MS));
      for (let page = 1; page <= MAX_UPLOAD_LIST_PAGES; page++) {
        const w = await postForm(this.fetchImpl, "uploadlist", key, {
          UploadDate: date,
          Page: String(page),
        });
        // "Absent" needs positive evidence: a body that does not carry a `file` list at all is unknown, not empty.
        if (!w.ok || vendorError(w.body) || !hasList(w.body, "file")) return "error";
        const files = listOf(w.body, "file");
        const hit = files.find((f) => names.has(str(f.filename) ?? ""));
        if (hit) return str(hit.inboundid)?.slice(0, MAX_VENDOR_ID_LENGTH) || "unknown";
        if (files.length < UPLOAD_LIST_PAGE) break;
        if (page === MAX_UPLOAD_LIST_PAGES) return "error";
      }
    }
    return null;
  }

  private async upload(
    ctx: ClearinghouseContext,
    key: string,
    attempt: SubmissionAttempt,
    format: "x12" | "json",
    file: string,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    const filename = claimMdFilename(attempt.scope, attempt.idempotencyKey, format);
    const w = await postUpload(this.fetchImpl, key, filename, file);
    if (!w.ok) {
      // A request that may have landed keeps its reservation: the next attempt reconciles before any resend.
      if (w.reached) {
        return inDoubt("the upload to Claim.MD is unconfirmed; it is reconciled before any resend");
      }
      await this.releaseQuietly(attempt);
      return wireFailure(w, "write");
    }
    // Our claim in the answer wins over any error/warning element beside it: it landed, so never release it.
    const mine = listOf(w.body, "claim").find((c) => str(c.pcn) === attempt.controlNumber);
    // A repeated Filename (ours is fixed per scope + key) means an earlier upload of this submission landed: keep the
    // reservation and reconcile, never release (M23 would then mint a new control number and bill twice).
    if (!mine && vendorError(w.body)?.codes.includes(DUPLICATE_FILE_CODE)) {
      return inDoubt(
        "Claim.MD already holds this file from an earlier upload; it is reconciled before any resend",
      );
    }
    const refused = mine ? null : bodyFailure<SubmissionReceipt>(w.body, "write");
    if (refused) {
      await this.releaseQuietly(attempt);
      return refused;
    }
    const id = str(mine?.claimid) || (str(mine?.fileid) ? `file:${str(mine?.fileid)}` : "");
    if (!id || id.length > MAX_VENDOR_ID_LENGTH) {
      // Taken (2xx, no error) but our claim is not in the answer: unconfirmed, reconciled by Filename later.
      return inDoubt(
        "Claim.MD's upload answer does not name the claim; it is reconciled before any resend",
      );
    }
    return this.complete(ctx, attempt, id, false);
  }

  /** reserved -> sent. Retried, because losing the record could later cause a duplicate upload. */
  private async complete(
    ctx: ClearinghouseContext,
    attempt: SubmissionAttempt,
    clearinghouseSubmissionId: string,
    replayed: boolean,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    for (let i = 0; i < RECORD_ATTEMPTS; i++) {
      try {
        const stored = await this.attempts.complete(
          ctx.organizationId,
          attempt.scope,
          attempt.idempotencyKey,
          clearinghouseSubmissionId,
          this.now().toISOString(),
        );
        const receipt = stored === null ? null : receiptOf(stored, replayed);
        if (receipt === null) break;
        return { ok: true, data: receipt };
      } catch {
        // retry
      }
    }
    this.onAnomaly({
      type: "sent_but_unrecorded",
      idempotencyKey: attempt.idempotencyKey,
      clearinghouseSubmissionId,
    });
    return inDoubt(
      "uploaded to Claim.MD but the attempt could not be recorded; retry with the same key to reconcile",
    );
  }

  private async releaseQuietly(attempt: SubmissionAttempt): Promise<void> {
    try {
      await this.attempts.release(attempt.organizationId, attempt.scope, attempt.idempotencyKey);
    } catch {
      // The reservation ages out; the next attempt reconciles before uploading.
    }
  }

  // ─── Acknowledgments and status ───────────────────────────────────────────────────────────────

  /** One Claim.MD response (a claim entry of `/response/`) as a port event, or null when it cannot be mapped. */
  private toAck(ctx: ClearinghouseContext, claim: ClaimMdRecord): AckEvent | null {
    const controlNumber = str(claim.pcn);
    if (!controlNumber) return null;
    const messages = listOf(claim, "messages");
    const stage: AckStage =
      str(claim.senderid)?.toUpperCase() === CLEARINGHOUSE_SENDER ? "clearinghouse" : "payer";
    const status = str(claim.status)?.toUpperCase() ?? "";
    const disposition = status === "A" ? "accepted" : status === "R" ? "rejected" : null;
    if (disposition === null) {
      this.onAnomaly({
        type: "unmapped_status",
        stage,
        status: safeCodes([status])[0] ?? "?",
        controlNumber,
      });
      return null;
    }
    const responseIds = messages
      .map((m) => str(m.responseid))
      .filter((v): v is string => !!v && CURSOR_SHAPE.test(v));
    const eventKey =
      responseIds.sort((a, b) => Number(b) - Number(a))[0] ??
      createHash("sha256")
        .update(
          JSON.stringify([
            str(claim.claimid),
            controlNumber,
            str(claim.bill_npi),
            str(claim.response_time),
            status,
            str(claim.senderid),
          ]),
        )
        .digest("hex")
        .slice(0, 24);
    const reasonCodes =
      disposition === "rejected"
        ? safeCodes(
            messages.filter((m) => str(m.status)?.toUpperCase() !== "A").map((m) => str(m.mesgid)),
          )
        : [];
    const icn = str(claim.sender_icn);
    const base = {
      eventId: `claimmd:${ctx.usage}:${eventKey}`,
      controlNumber,
      reasonCodes,
      // The day only: Claim.MD's time is account-local with no zone, and consumers accept a bare YYYY-MM-DD.
      occurredAt: claimMdDay(str(claim.response_time)) ?? this.now().toISOString(),
      ...(stage === "payer" && icn && icn.length <= MAX_VENDOR_ID_LENGTH
        ? { payerClaimNumber: icn }
        : {}),
    };
    return stage === "clearinghouse"
      ? { ...base, stage, disposition }
      : { ...base, stage, disposition };
  }

  /** The claim entries of a `/response/` answer that belong to this provider. */
  private ownClaims(ctx: ClearinghouseContext, body: ClaimMdRecord): readonly ClaimMdRecord[] {
    return listOf(body, "claim").filter((c) => str(c.bill_npi) === ctx.billingNpi);
  }

  async fetchAcknowledgments(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return access.fail;
    if (cursor !== null && !CURSOR_SHAPE.test(cursor))
      return refuse("cursor is not a Claim.MD response id");
    // ponytail: every provider entity reads the whole account stream from its own cursor and keeps its own NPI's
    // entries; fine at tens of tenants. One account-wide reader fanning out by NPI is the upgrade if the stream grows.
    const w = await postForm(this.fetchImpl, "response", access.key, { ResponseID: cursor ?? "0" });
    if (!w.ok) return wireFailure(w, "read");
    const refused = bodyFailure<Page<AckEvent>>(w.body, "read");
    if (refused) return refused;
    const all = listOf(w.body, "claim");
    const items = this.ownClaims(ctx, w.body)
      .map((c) => this.toAck(ctx, c))
      .filter((a): a is AckEvent => a !== null);
    const last = topAttr(w.body, "last_responseid");
    return {
      ok: true,
      data: {
        items,
        // Never backwards: an empty poll answering a lower last_responseid would replay the whole history.
        nextCursor: maxId(last && CURSOR_SHAPE.test(last) ? last : null, cursor),
        hasMore: all.length >= RESPONSE_PAGE_LIMIT,
      },
    };
  }

  async fetchClaimStatus(
    ctx: ClearinghouseContext,
    controlNumber: string,
  ): Promise<X12WorkerResult<ClaimStatus>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return access.fail;
    let attempt: SubmissionAttempt | null;
    try {
      attempt = await this.attempts.findByControlNumber(
        ctx.organizationId,
        scopeKey(ctx),
        controlNumber,
      );
    } catch {
      return degraded(CH.UNAVAILABLE, "the submission record could not be read");
    }
    if (!attempt) return { ok: true, data: { controlNumber, state: "not_found", latest: null } };
    if (attempt.status !== "sent") {
      return { ok: true, data: { controlNumber, state: "received", latest: null } };
    }
    const claimId = attempt.clearinghouseSubmissionId ?? "";
    const entries = CURSOR_SHAPE.test(claimId)
      ? await this.responsesFor(access.key, { ResponseID: "0", ClaimID: claimId })
      : // Observed 2026-11-04: the upload answer names our claim with a `fileid` but no `claimid`, so most attempts
        // hold `file:<id>` and cannot be asked by id. Read the stream and match our control number instead.
        await this.responsesFor(access.key, null);
    if (!entries.ok) return entries;
    const events = entries.data
      .filter((c) => str(c.bill_npi) === ctx.billingNpi && str(c.pcn) === controlNumber)
      .map((c) => this.toAck(ctx, c))
      .filter((a): a is AckEvent => a !== null);
    // The highest stage reached wins, not the last delivered (a late clearinghouse ack never regresses a payer answer).
    const latest = events.filter((e) => e.stage === "payer").at(-1) ?? events.at(-1) ?? null;
    return { ok: true, data: { controlNumber, state: stateOf(latest), latest } };
  }

  /**
   * `/response/` entries: one call when asked by Claim.MD claim id, else the whole account stream from 0.
   * ponytail: a by-control-number status reads the account stream (up to STATUS_SCAN_PAGES x 20,000 entries) on every call;
   * fine while status is asked rarely. The upgrade is to record the `claimid` from the first ack and ask by id.
   */
  private async responsesFor(
    key: string,
    byClaim: Readonly<Record<string, string>> | null,
  ): Promise<X12WorkerResult<readonly ClaimMdRecord[]>> {
    const out: ClaimMdRecord[] = [];
    let cursor = "0";
    for (let page = 0; page < (byClaim ? 1 : STATUS_SCAN_PAGES); page++) {
      const w = await postForm(this.fetchImpl, "response", key, byClaim ?? { ResponseID: cursor });
      if (!w.ok) return wireFailure(w, "read");
      const refused = bodyFailure<readonly ClaimMdRecord[]>(w.body, "read");
      if (refused) return refused;
      const claims = listOf(w.body, "claim");
      out.push(...claims);
      const last = topAttr(w.body, "last_responseid");
      if (
        claims.length < RESPONSE_PAGE_LIMIT ||
        !last ||
        !CURSOR_SHAPE.test(last) ||
        last === cursor
      ) {
        return { ok: true, data: out };
      }
      cursor = last;
    }
    // Asked by claim id: one page is the answer. A stream scan that ran out of pages while they were still full has NOT
    // seen the whole stream, so "no answer yet" would be a guess (and aged held claims could be abandoned on it).
    return byClaim
      ? { ok: true, data: out }
      : degraded(CH.UNAVAILABLE, "the Claim.MD response stream is too long to scan for this claim");
  }

  // ─── Remittance ───────────────────────────────────────────────────────────────────────────────

  async fetchRemittances(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<RemittanceFile>>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return access.fail;
    if (cursor !== null && !CURSOR_SHAPE.test(cursor))
      return refuse("cursor is not a Claim.MD ERA id");
    const npi = ctx.billingNpi as string;
    // NewOnly=0: Claim.MD's "new" flag is account-wide state another reader would consume; our cursor is the position.
    const w = await postForm(this.fetchImpl, "eralist", access.key, {
      ERAID: cursor ?? "0",
      NPI: npi,
      NewOnly: "0",
    });
    if (!w.ok) return wireFailure(w, "read");
    const refused = bodyFailure<Page<RemittanceFile>>(w.body, "read");
    if (refused) return refused;
    const listed = listOf(w.body, "era");
    const ids = [
      ...new Set(
        listed
          .filter((e) => str(e.prov_npi) === npi)
          .map((e) => str(e.eraid))
          .filter(
            (id): id is string =>
              !!id && CURSOR_SHAPE.test(id) && (cursor === null || BigInt(id) > BigInt(cursor)),
          ),
      ),
    ].sort((a, b) => Number(a) - Number(b));
    const taken = ids.slice(0, MAX_ERAS_PER_CALL);
    const items: RemittanceFile[] = [];
    let lastGood: string | null = null;
    // Without its file the cursor must not pass an ERA (at-least-once, never skipped). The ERAs before it are delivered
    // with the cursor on the last good one, so one bad ERA (or a spent budget) neither withholds nor re-downloads them;
    // the failing ERA then comes first on the next call and fails alone. Nothing read yet: the failure itself.
    const stop = (
      failure: X12WorkerResult<Page<RemittanceFile>>,
    ): X12WorkerResult<Page<RemittanceFile>> =>
      lastGood === null
        ? failure
        : { ok: true, data: { items, nextCursor: maxId(lastGood, cursor), hasMore: true } };
    for (const eraid of taken) {
      const era = await postForm(this.fetchImpl, "era835", access.key, { eraid });
      if (!era.ok) return stop(wireFailure(era, "read"));
      const eraRefused = bodyFailure<Page<RemittanceFile>>(era.body, "read");
      if (eraRefused) return stop(eraRefused);
      const read = rawFiles(era.body, "data");
      if (!read.ok) {
        if (read.elements !== null)
          this.onAnomaly({ type: "era_unreadable", eraid, elements: read.elements });
        return stop(degraded(CH.UNAVAILABLE, "a Claim.MD ERA came back without a readable 835"));
      }
      // The first file keeps `claimmd-<eraid>` (stable if Claim.MD ever adds elements); later ones are `-2`, `-3`, … .
      read.files.forEach((rawX12, i) =>
        items.push({
          remittanceId: i === 0 ? `claimmd-${eraid}` : `claimmd-${eraid}-${i + 1}`,
          receivedAt: this.now().toISOString(),
          rawX12,
        }),
      );
      lastGood = eraid;
    }
    return {
      ok: true,
      data: {
        items,
        nextCursor: maxId(taken.at(-1) ?? null, cursor),
        hasMore: ids.length > taken.length || listed.length >= ERA_PAGE_SIZE,
      },
    };
  }

  // ─── Not available through Claim.MD ───────────────────────────────────────────────────────────

  /**
   * A LOCAL dry run: Claim.MD has no validate-only endpoint and an upload is a submission, so this never calls Claim.MD.
   * It runs the same pre-upload checks `submitClaim`/`submitNotice` run (envelope, usage, one CLM, control number, NPI,
   * frequency/REF*F8) and reports them as issues. Payer and Claim.MD edits are only known after a real upload.
   */
  async validateOnly(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return access.fail;
    const payload = submission.payload;
    const problem =
      payload.format === "x12"
        ? claimMdX12Problem(payload.x12, ctx, submission)
        : claimMdJsonProblem(payload.document, ctx, submission);
    const issues =
      problem === null
        ? []
        : [{ code: "CLAIMMD_PRECHECK", severity: "error" as const, message: problem }];
    return { ok: true, data: { valid: issues.length === 0, issues } };
  }

  checkEligibility(
    ctx: ClearinghouseContext,
    req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    const access = this.keyFor(ctx);
    if ("fail" in access) return Promise.resolve(access.fail);
    return claimMdCheckEligibility(
      this.fetchImpl,
      access.key,
      CLAIMMD_CREDENTIAL_REJECTED,
      ctx,
      req,
    );
  }

  verifyAndParseEvent(): Promise<X12WorkerResult<ClearinghouseEvent>> {
    return notImplemented("push events (enroll/appeal reports enter via M23's POST /api/v1/webhooks/claimmd/<usage>)");
  }
}

function stateOf(latest: AckEvent | null): SubmissionState {
  if (latest === null) return "received";
  if (latest.stage === "clearinghouse") {
    return latest.disposition === "accepted" ? "clearinghouse_accepted" : "clearinghouse_rejected";
  }
  return latest.disposition === "accepted"
    ? "payer_accepted"
    : latest.disposition === "partial"
      ? "payer_partial"
      : "payer_rejected";
}
