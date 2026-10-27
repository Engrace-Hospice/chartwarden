// @chartwarden/x12-837-client — the in-memory ClearinghouseTransport: the executable SPECIFICATION of the port
// (ADR-0053 D4). It is the reference every real adapter is compared against by ./conformance, and a
// deterministic double for module tests (claim-cycle workers, DDE queue triggers) that need a clearinghouse
// without a network. TEST SUPPORT ONLY: it is exported from `@chartwarden/x12-837-client/testing`, not from the
// package barrel, so production code cannot pull it (or `node:crypto`) in by accident.
//
// All state is partitioned by (organizationId, providerEntityId, usage) — the port's isolation boundary — so one
// tenant, one provider or the other usage mode can never see, replay or collide with another's (C14, C15).
import { createHmac, timingSafeEqual } from "node:crypto";
import { type X12WorkerResult, degraded } from "../types";
import { type ClearinghouseHarness, type ConformanceScript, DEFAULT_SCOPE } from "./conformance";
import { identityOf, scopeKey } from "./submission-identity";
import {
  type AckEvent,
  CH,
  CLEARINGHOUSE_EVENT_KINDS,
  type ClaimStatus,
  type ClaimStatusInquiry,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseEligibilityResult,
  type ClearinghouseEvent,
  type ClearinghouseEventKind,
  type ClearinghouseScope,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type Page,
  type RawWebhook,
  type RemittanceFile,
  type SubmissionReceipt,
  type SubmissionState,
  type ValidationReport,
} from "./types";

const PAGE_SIZE = 2;
const SIGNATURE_HEADER = "x-clearinghouse-signature";
const CURSOR_RE = /^\d+$/;

interface StoredSubmission {
  readonly id: string;
  readonly controlNumber: string;
  readonly idempotencyKey: string;
  readonly identity: string;
  readonly receivedAt: string;
}

interface Partition {
  readonly submissions: Map<string, StoredSubmission>; // by controlNumber
  readonly byKey: Map<string, StoredSubmission>; // by idempotencyKey
  readonly acks: AckEvent[];
  readonly remittances: RemittanceFile[];
}

function emptyPartition(): Partition {
  return { submissions: new Map(), byKey: new Map(), acks: [], remittances: [] };
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function pageOf<T>(items: readonly T[], cursor: string | null): X12WorkerResult<Page<T>> {
  if (cursor !== null && !CURSOR_RE.test(cursor)) {
    return degraded(CH.INVALID_REQUEST, "cursor is malformed");
  }
  const from = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (from > items.length)
    return degraded(CH.INVALID_REQUEST, "cursor is beyond the end of the data");
  const slice = items.slice(from, from + PAGE_SIZE);
  const end = from + slice.length;
  return { ok: true, data: { items: slice, nextCursor: String(end), hasMore: end < items.length } };
}

/** The highest stage reached wins; within a stage, the latest event. Order of delivery never regresses it. */
function latestAckOf(acks: readonly AckEvent[], controlNumber: string): AckEvent | null {
  const mine = acks.filter((a) => a.controlNumber === controlNumber);
  return (
    [...mine].reverse().find((a) => a.stage === "payer") ??
    [...mine].reverse().find((a) => a.stage === "clearinghouse") ??
    null
  );
}

function stateOf(latest: AckEvent | null): SubmissionState {
  if (latest === null) return "received";
  if (latest.stage === "clearinghouse") {
    return latest.disposition === "accepted" ? "clearinghouse_accepted" : "clearinghouse_rejected";
  }
  if (latest.disposition === "partial") return "payer_partial";
  return latest.disposition === "accepted" ? "payer_accepted" : "payer_rejected";
}

function isEventKind(value: unknown): value is ClearinghouseEventKind {
  return (CLEARINGHOUSE_EVENT_KINDS as readonly unknown[]).includes(value);
}

export interface InMemoryClearinghouseOptions {
  readonly now?: () => Date;
  readonly webhookSecret?: string;
}

/** The reference transport. Drive the far side through {@link InMemoryClearinghouse.control}. */
export class InMemoryClearinghouse implements ClearinghouseTransport {
  readonly vendor = "in_memory" as const;

  private readonly partitions = new Map<string, Partition>();
  private readonly unenrolled = new Set<string>();
  private down = false;
  private seq = 0;
  private readonly now: () => Date;
  private readonly secret: string;

  constructor(opts: InMemoryClearinghouseOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.secret = opts.webhookSecret ?? "in-memory-webhook-secret";
  }

  private partition(scope: ClearinghouseScope): Partition {
    const key = scopeKey(scope);
    let p = this.partitions.get(key);
    if (!p) {
      p = emptyPartition();
      this.partitions.set(key, p);
    }
    return p;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private outageOnly(): X12WorkerResult<never> | null {
    return this.down ? degraded(CH.UNAVAILABLE, "clearinghouse unavailable") : null;
  }

  /** Outage first (retryable), then enrollment (terminal). Enrollment gates sends, not reads or dry-runs. */
  private gate(ctx: ClearinghouseContext): X12WorkerResult<never> | null {
    return (
      this.outageOnly() ??
      (this.unenrolled.has(scopeKey(ctx))
        ? degraded(CH.NOT_ENROLLED, "provider is not enrolled with the payer")
        : null)
    );
  }

  async checkEligibility(
    ctx: ClearinghouseContext,
    _req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    const blocked = this.gate(ctx);
    if (blocked) return blocked;
    // The MBI is deliberately unused: nothing is stored, echoed or logged.
    return { ok: true, data: { outcome: "active", asOfDate: this.stamp().slice(0, 10) } };
  }

  async validateOnly(
    _ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>> {
    const blocked = this.outageOnly();
    if (blocked) return blocked;
    const p = submission.payload;
    const empty = p.format === "x12" ? p.x12.trim() === "" : p.document == null;
    const issues = empty
      ? [{ code: "EMPTY_PAYLOAD", severity: "error" as const, message: "payload is empty" }]
      : [];
    return { ok: true, data: { valid: issues.length === 0, issues } };
  }

  async submitNotice(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (
      submission.kind !== "noe" &&
      submission.kind !== "notr" &&
      submission.kind !== "transfer_notice"
    ) {
      return degraded(
        CH.INVALID_REQUEST,
        "submitNotice requires kind noe, notr or transfer_notice",
      );
    }
    if (submission.adjustment) {
      return degraded(CH.INVALID_REQUEST, "a notice cannot carry a claim adjustment");
    }
    return this.submit(ctx, submission);
  }

  async submitClaim(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    if (submission.kind !== "claim") {
      return degraded(CH.INVALID_REQUEST, "submitClaim requires kind claim");
    }
    return this.submit(ctx, submission);
  }

  private submit(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): X12WorkerResult<SubmissionReceipt> {
    const blocked = this.gate(ctx);
    if (blocked) return blocked;
    const part = this.partition(ctx);
    const identity = identityOf(submission);

    const prior = part.byKey.get(submission.idempotencyKey);
    if (prior) {
      return prior.identity === identity
        ? { ok: true, data: this.receipt(prior, true) }
        : degraded(CH.IDEMPOTENCY_CONFLICT, "idempotency key reused for a different submission");
    }
    if (part.submissions.has(submission.controlNumber)) {
      return degraded(CH.IDEMPOTENCY_CONFLICT, "control number already used under another key");
    }
    const adjustment = submission.adjustment;
    if (adjustment && !part.submissions.has(adjustment.originalControlNumber)) {
      return degraded(
        CH.UNKNOWN_ORIGINAL,
        "the original submission is unknown to the clearinghouse",
      );
    }
    const stored: StoredSubmission = {
      id: this.nextId("chs"),
      controlNumber: submission.controlNumber,
      idempotencyKey: submission.idempotencyKey,
      identity,
      receivedAt: this.stamp(),
    };
    part.submissions.set(stored.controlNumber, stored);
    part.byKey.set(stored.idempotencyKey, stored);
    return { ok: true, data: this.receipt(stored, false) };
  }

  private receipt(s: StoredSubmission, replayed: boolean): SubmissionReceipt {
    return {
      clearinghouseSubmissionId: s.id,
      idempotencyKey: s.idempotencyKey,
      controlNumber: s.controlNumber,
      receivedAt: s.receivedAt,
      replayed,
    };
  }

  async fetchAcknowledgments(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>> {
    return this.outageOnly() ?? pageOf(this.partition(ctx).acks, cursor);
  }

  async fetchRemittances(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<RemittanceFile>>> {
    return this.outageOnly() ?? pageOf(this.partition(ctx).remittances, cursor);
  }

  async fetchClaimStatus(
    ctx: ClearinghouseContext,
    controlNumber: string,
    _inquiry?: ClaimStatusInquiry,
  ): Promise<X12WorkerResult<ClaimStatus>> {
    const blocked = this.outageOnly();
    if (blocked) return blocked;
    const part = this.partition(ctx);
    if (!part.submissions.has(controlNumber)) {
      return { ok: true, data: { controlNumber, state: "not_found", latest: null } };
    }
    const latest = latestAckOf(part.acks, controlNumber);
    return { ok: true, data: { controlNumber, state: stateOf(latest), latest } };
  }

  async verifyAndParseEvent(webhook: RawWebhook): Promise<X12WorkerResult<ClearinghouseEvent>> {
    const given = Buffer.from(webhook.headers[SIGNATURE_HEADER] ?? "");
    const expected = Buffer.from(sign(this.secret, webhook.rawBody));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return degraded(CH.INVALID_SIGNATURE, "webhook signature did not verify");
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(webhook.rawBody) as Record<string, unknown>;
    } catch {
      return degraded(CH.INVALID_REQUEST, "webhook body is not JSON");
    }
    const { eventId, kind, reference, occurredAt } = body;
    if (
      typeof eventId !== "string" ||
      !isEventKind(kind) ||
      typeof reference !== "string" ||
      typeof occurredAt !== "string"
    ) {
      return degraded(CH.INVALID_REQUEST, "webhook body is not a clearinghouse event");
    }
    // Rebuilt from the known keys only, so nothing extra the sender included can leak through. There is no
    // replay window: duplicates are expected and are absorbed by consumers deduping on eventId (ADR-0053 D7).
    return { ok: true, data: { eventId, kind, reference, occurredAt } };
  }

  // ─── Far-side control (conformance script + module-test double) ───────────────────────────────

  readonly control: ConformanceScript = {
    clearinghouseAccepts: async (controlNumber, scope = DEFAULT_SCOPE) =>
      this.pushAck(scope, controlNumber, "clearinghouse", "accepted", []),
    clearinghouseRejects: async (controlNumber, codes, scope = DEFAULT_SCOPE) =>
      this.pushAck(scope, controlNumber, "clearinghouse", "rejected", codes),
    payerAccepts: async (controlNumber, payerClaimNumber, scope = DEFAULT_SCOPE) =>
      this.pushAck(scope, controlNumber, "payer", "accepted", [], payerClaimNumber),
    payerRejects: async (controlNumber, codes, scope = DEFAULT_SCOPE) =>
      this.pushAck(scope, controlNumber, "payer", "rejected", codes),
    payerPartiallyAccepts: async (controlNumber, codes, scope = DEFAULT_SCOPE) =>
      this.pushAck(scope, controlNumber, "payer", "partial", codes),
    deliverRemittance: async (remittanceId, rawX12, scope = DEFAULT_SCOPE) => {
      const part = this.partition(scope);
      if (part.remittances.some((r) => r.remittanceId === remittanceId)) return; // the vendor repeats itself
      part.remittances.push({ remittanceId, receivedAt: this.stamp(), rawX12 });
    },
    setEnrollment: async (enrolled, scope = DEFAULT_SCOPE) => {
      if (enrolled) this.unenrolled.delete(scopeKey(scope));
      else this.unenrolled.add(scopeKey(scope));
    },
    setOutage: async (down) => {
      this.down = down;
    },
    signedEvent: async (kind, reference, eventId) => this.webhook(kind, reference, eventId, false),
    tamperedEvent: async (kind, reference, eventId) => this.webhook(kind, reference, eventId, true),
  };

  private pushAck(
    scope: ClearinghouseScope,
    controlNumber: string,
    stage: AckEvent["stage"],
    disposition: AckEvent["disposition"],
    reasonCodes: readonly string[],
    payerClaimNumber?: string,
  ): void {
    const part = this.partition(scope);
    if (!part.submissions.has(controlNumber)) {
      throw new Error(`in-memory clearinghouse: no submission ${controlNumber} to acknowledge`);
    }
    part.acks.push({
      eventId: this.nextId("ack"),
      stage,
      disposition,
      controlNumber,
      reasonCodes: [...reasonCodes],
      occurredAt: this.stamp(),
      ...(payerClaimNumber === undefined ? {} : { payerClaimNumber }),
      // The test control surface may deliberately inject an event the type forbids (a clearinghouse-stage partial).
    } as AckEvent);
  }

  private webhook(
    kind: ClearinghouseEventKind,
    reference: string,
    eventId: string,
    tamper: boolean,
  ): RawWebhook {
    const rawBody = JSON.stringify({ eventId, kind, reference, occurredAt: this.stamp() });
    const signature = sign(this.secret, tamper ? `${rawBody} ` : rawBody);
    return { headers: { [SIGNATURE_HEADER]: signature }, rawBody };
  }
}

/** A fresh reference transport plus its control script, shaped for `runClearinghouseConformance`. */
export function createInMemoryHarness(
  opts: InMemoryClearinghouseOptions = {},
): ClearinghouseHarness {
  const transport = new InMemoryClearinghouse(opts);
  return { transport, script: transport.control };
}
