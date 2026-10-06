// apps/backend/src/modules/23-billing-medicare/jobs/notice-ack-jobs.ts — what the 999 / 277CA ack crons do when an
// acknowledgment's submission is a Notice of Election's (`claim_submission.kind = 'noe'`) or a Notice of
// Termination/Revocation's (`'notr'`):
//
//   1. append the `claim_acknowledgment` (no claim back-link; the notice id rides in `parsed_payload`) — the
//      per-ack audit trail, idempotent on `(mac_jurisdiction, ack_file_uri)`;
//   2. drive the notice's §2.2 ack transition (the pure `noeMachine` / `notrMachine`, version-checked), stamping
//      the 277CA acceptance date, or the rejection date + stage + PHI-free reason codes;
//   3. emit `m23.noe.*` / `m23.notr.accepted` | `.rejected` and, on a rejection, raise the M36 biller alert.
//
// A re-pulled ack is a no-op: the append collapses onto the original row, which the notice already points at.
// An ack that fits no transition from the notice's state (a late or out-of-order file) is kept in the audit
// trail and drives nothing. The raw 999 / 277CA never reaches the notice (it stays in object storage).
//
// Leaf module: it takes its ports explicitly (no import of `m23-jobs.ts`, which imports THIS file), so the
// no-circular fitness rule holds. Runs on the caller's org-scoped tx (`withOrgContext` per ack, system actor).
import { type NoticeState, noeMachine, notrMachine, repositories } from "@wardenx/billing";

type BillingDb = repositories.BillingDb;

/** At most this many reason codes are kept (the `*_rejection_codes_chk` constraint, migration 0377). */
const MAX_REASON_CODES = 20;
/**
 * X12 reason codes are short colon-joined parts (`IK5:R`, `A7:21`, `A7:562:85`), each at most 6 characters.
 * Anything else is dropped — free text, and long bare tokens such as an MBI (11), an NPI (10) or a claim number.
 */
const REASON_CODE_SHAPE = /^[A-Z0-9]{1,6}(?::[A-Z0-9]{1,6}){0,3}$/;

/**
 * The PHI-free subset of a parsed acknowledgment's reason codes: code-shaped tokens only, upper-cased,
 * de-duplicated, capped. The gateway contract is codes-only; this is the defence in depth before the codes are
 * persisted on the notice, published and put in an alert.
 */
export function sanitizeAckReasonCodes(codes: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!REASON_CODE_SHAPE.test(code) || kept.includes(code)) continue;
    kept.push(code);
    if (kept.length === MAX_REASON_CODES) break;
  }
  return kept;
}

export interface NoticeAckOutbox {
  publish(
    tx: BillingDb,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface NoticeAckAlerts {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface NoticeAckPorts {
  readonly outbox: NoticeAckOutbox;
  readonly alerts: NoticeAckAlerts;
}

/** The submission an acknowledgment answered, already narrowed to a notice kind by the caller. */
export interface NoticeSubmission {
  readonly id: string;
  readonly kind: "noe" | "notr";
  readonly noeId: string | null;
  readonly notrId: string | null;
}

/** One parsed acknowledgment line for a NOE / NOTR submission. */
export interface NoticeAck {
  readonly organizationId: string;
  readonly kind: "ack_999" | "ack_277ca";
  /** 999: accepted / rejected. 277CA: accepted / rejected / partial (a notice has no lines: partial = rejected). */
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerControlNumber: string | null;
  readonly reasonCodes: readonly string[];
  readonly macJurisdiction: string;
  readonly ackFileUri: string;
  readonly receivedAt: Date;
}

type AckEvent =
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected";

/** The fields of a NOE / NOTR row this routing reads (both tables share them). */
interface NoticeRow {
  readonly id: string;
  readonly providerEntityId: string;
  readonly admissionId: string;
  readonly state: NoticeState;
  readonly version: number;
  readonly latestAcknowledgmentId: string | null;
}

/** The per-kind table, machine, column and event names. */
interface NoticeKindSpec {
  readonly idKey: "noeId" | "notrId";
  readonly aggregateKind: "noe_record" | "notr_record";
  readonly payerColumn: "payerNoeControlNumber" | "payerNotrControlNumber";
  canTransition(state: NoticeState, event: AckEvent): boolean;
  reduce(state: NoticeState, event: AckEvent): NoticeState;
  find(tx: BillingDb, id: string): Promise<NoticeRow | null>;
  transition(
    tx: BillingDb,
    row: NoticeRow,
    next: NoticeState,
    patch: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly row?: NoticeRow }>;
}

const SPECS: Record<"noe" | "notr", NoticeKindSpec> = {
  noe: {
    idKey: "noeId",
    aggregateKind: "noe_record",
    payerColumn: "payerNoeControlNumber",
    canTransition: (s, e) => noeMachine.canTransition(s, e),
    reduce: (s, e) => noeMachine.reduce(s, e).state,
    find: (tx, id) => new repositories.NoeRepository(tx).findById(id),
    transition: (tx, row, next, patch) =>
      new repositories.NoeRepository(tx).transitionToState(row.id, row.version, next, patch),
  },
  notr: {
    idKey: "notrId",
    aggregateKind: "notr_record",
    payerColumn: "payerNotrControlNumber",
    canTransition: (s, e) => notrMachine.canTransition(s, e),
    reduce: (s, e) => notrMachine.reduce(s, e).state,
    find: (tx, id) => new repositories.NotrRepository(tx).findById(id),
    transition: (tx, row, next, patch) =>
      new repositories.NotrRepository(tx).transitionToState(row.id, row.version, next, patch),
  },
};

/**
 * Route one acknowledgment to its NOE / NOTR. Returns the notice's new state, or null when nothing changed (the
 * notice row is not visible under this org, the ack was already applied, or it fits no transition yet).
 *
 * Idempotency: the append collapses a re-pulled file onto its original row. Every applied ack moves the notice to
 * a different state (no self-loops) and stamps `latest_acknowledgment_id`, so a replay either is that latest ack or
 * fits no transition from the notice's current state.
 */
export async function applyNoticeAck(
  tx: BillingDb,
  ports: NoticeAckPorts,
  submission: NoticeSubmission,
  ack: NoticeAck,
): Promise<NoticeState | null> {
  const spec = SPECS[submission.kind];
  const noticeId = submission.kind === "noe" ? submission.noeId : submission.notrId;
  const notice = noticeId ? await spec.find(tx, noticeId) : null;
  if (!notice) return null;

  const outcome = ack.outcome === "accepted" ? "accepted" : "rejected";
  const reasonCodes = sanitizeAckReasonCodes(ack.reasonCodes);
  const acks = new repositories.ClaimAcknowledgmentRepository(tx);
  const recorded = await acks.append({
    organizationId: ack.organizationId,
    submissionId: submission.id,
    claimId: null,
    kind: ack.kind,
    macJurisdiction: ack.macJurisdiction as never,
    ackFileUri: ack.ackFileUri,
    ackReceivedAt: ack.receivedAt,
    parsedPayload: {
      outcome: ack.outcome,
      payerControlNumber: ack.payerControlNumber,
      reasonCodes,
      [spec.idKey]: notice.id,
    },
    outcomeStatus: outcome,
  });
  // A re-pulled file: the append collapsed onto the ack this notice already applied.
  if (notice.latestAcknowledgmentId === recorded.id) return null;

  const applied = await applyRecorded(tx, ports, spec, submission.kind, notice, {
    acknowledgmentId: recorded.id,
    kind: ack.kind,
    outcome,
    payerControlNumber: ack.payerControlNumber,
    reasonCodes,
    receivedAt: ack.receivedAt,
    organizationId: ack.organizationId,
  });
  if (!applied || applied.state !== "ack_pending") return applied?.state ?? null;

  // The 999 just accepted the file. A 277CA for this submission may already be on record — it arrived before the
  // 999 (crons race, a late 999 file) and fit no transition then: apply the latest one now, in the same tx.
  const early = (await acks.listForSubmission(submission.id)).find((a) => a.kind === "ack_277ca");
  if (!early) return applied.state;
  const payload = early.parsedPayload as {
    readonly payerControlNumber?: string | null;
    readonly reasonCodes?: readonly string[];
  };
  const caughtUp = await applyRecorded(tx, ports, spec, submission.kind, applied, {
    acknowledgmentId: early.id,
    kind: "ack_277ca",
    outcome: early.outcomeStatus === "accepted" ? "accepted" : "rejected",
    payerControlNumber: payload.payerControlNumber ?? null,
    reasonCodes: sanitizeAckReasonCodes(payload.reasonCodes ?? []),
    receivedAt: early.ackReceivedAt,
    organizationId: ack.organizationId,
  });
  return (caughtUp ?? applied).state;
}

/** An acknowledgment already recorded in `claim_acknowledgment`, normalised for a notice (partial = rejected). */
interface RecordedNoticeAck {
  readonly acknowledgmentId: string;
  readonly kind: "ack_999" | "ack_277ca";
  readonly outcome: "accepted" | "rejected";
  readonly payerControlNumber: string | null;
  readonly reasonCodes: readonly string[];
  /** When WardenX received the ack — the gateway's 277CA carries no payer status date. */
  readonly receivedAt: Date;
  readonly organizationId: string;
}

/** Drive the notice's transition for one recorded ack, then emit / alert. Null when it fits no transition. */
async function applyRecorded(
  tx: BillingDb,
  ports: NoticeAckPorts,
  spec: NoticeKindSpec,
  kind: "noe" | "notr",
  notice: NoticeRow,
  ack: RecordedNoticeAck,
): Promise<NoticeRow | null> {
  const event: AckEvent =
    ack.kind === "ack_999" ? `ack_999_${ack.outcome}` : `ack_277ca_${ack.outcome}`;
  if (!spec.canTransition(notice.state, event)) return null;
  const next = spec.reduce(notice.state, event);
  const rejectionStage = ack.kind === "ack_999" ? "999" : "277ca";
  const patch: Record<string, unknown> = { latestAcknowledgmentId: ack.acknowledgmentId };
  if (event === "ack_277ca_accepted") {
    patch.acceptedAt = ack.receivedAt;
    if (ack.payerControlNumber) patch[spec.payerColumn] = ack.payerControlNumber;
  } else if (ack.outcome === "rejected") {
    patch.rejectedAt = ack.receivedAt;
    patch.rejectionStage = rejectionStage;
    patch.rejectionCodes = [...ack.reasonCodes];
  }
  const res = await spec.transition(tx, notice, next, patch);
  if (!res.ok || !res.row) {
    throw new Error(`${spec.aggregateKind} ${notice.id} version conflict on ${event}`);
  }

  const base = {
    organizationId: ack.organizationId,
    aggregateKind: spec.aggregateKind,
    aggregateId: notice.id,
  };
  if (event === "ack_277ca_accepted") {
    await ports.outbox.publish(tx, {
      ...base,
      eventName: `m23.${kind}.accepted`,
      payload: {
        [spec.idKey]: notice.id,
        acknowledgmentId: ack.acknowledgmentId,
        [spec.payerColumn]: ack.payerControlNumber ?? "",
        acceptedAt: ack.receivedAt.toISOString(),
      },
    });
  } else if (ack.outcome === "rejected") {
    await ports.outbox.publish(tx, {
      ...base,
      eventName: `m23.${kind}.rejected`,
      payload: {
        [spec.idKey]: notice.id,
        acknowledgmentId: ack.acknowledgmentId,
        rejectionStage,
        rejectionCodes: [...ack.reasonCodes],
        rejectedAt: ack.receivedAt.toISOString(),
      },
    });
    // Inside the tx (the window-watch precedent): a failed dispatch rolls the transition back, so the next pull
    // retries both rather than leaving a rejected notice nobody was told about.
    await ports.alerts.dispatch({
      alertCode: `m23.${kind}.rejected`,
      severity: "critical",
      organizationId: ack.organizationId,
      payload: {
        [spec.idKey]: notice.id,
        providerEntityId: notice.providerEntityId,
        admissionId: notice.admissionId,
        rejectionStage,
        rejectionCodes: [...ack.reasonCodes],
      },
    });
  }
  return res.row;
}
