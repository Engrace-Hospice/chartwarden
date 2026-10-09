// apps/backend/src/modules/23-billing-medicare/services/dde-notice-acceptance.ts — what recording an ACCEPTED outcome
// on an NOE / NOTR DDE work item does to the notice itself (ADR-0052 D5).
//
// The queue never writes a second, divergent acceptance state. It walks the notice through its EXISTING §2.2
// edges (`noeMachine` / `notrMachine`: submit -> ack_999_accepted -> ack_277ca_accepted) to `ack_accepted`, version
// checked through the same repositories the 999 / 277CA ack crons use, and stamps `accepted_at` with the time the
// operator recorded it plus the MAC's own date (`payer_status_date`, source `dde_manual`), so the late-NOE span-77
// derivation and the timeliness rule keep reading the same column. Only the edges the notice has not yet taken are
// applied (a `ready` notice keyed by hand takes all three; a `submitted` one two; an `ack_pending` one the last).
//
// No claim_submission / claim_acknowledgment row exists for a hand-keyed notice, so the intermediate hops emit no
// `.submitted` event or confirmation-receipt render; the `.accepted` event carries a null acknowledgment id.
// A notice that is ALREADY `ack_accepted` (the electronic path got there first) is left untouched: the electronic
// answer stays the notice's truth and the queue item just records its own outcome.
import { type NoticeState, noeMachine, notrMachine, repositories } from "@wardenx/billing";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";
import type { BillingTx, WriteOutboxPort } from "./claim-state-service";

export type DdeNoticeKind = "noe" | "notr";

export interface DdeNoticeAcceptanceInput {
  readonly organizationId: string;
  readonly kind: DdeNoticeKind;
  readonly noticeId: string;
  /** The MAC acceptance date the operator read off DDE (`YYYY-MM-DD`). */
  readonly macAcceptedOn: string;
  /** When the operator recorded it. */
  readonly recordedAt: Date;
  readonly outbox?: WriteOutboxPort;
}

export interface DdeNoticeAcceptanceResult {
  readonly applied: boolean;
  readonly fromState: NoticeState;
  readonly toState: NoticeState;
}

type AckEdge = "submit" | "ack_999_accepted" | "ack_277ca_accepted";
const EDGES_FROM: Partial<Record<NoticeState, readonly AckEdge[]>> = {
  ready: ["submit", "ack_999_accepted", "ack_277ca_accepted"],
  submitted: ["ack_999_accepted", "ack_277ca_accepted"],
  ack_pending: ["ack_277ca_accepted"],
};

interface NoticeRow {
  readonly id: string;
  readonly state: NoticeState;
  readonly version: number;
}

interface KindOps {
  readonly aggregateKind: "noe_record" | "notr_record";
  readonly idKey: "noeId" | "notrId";
  readonly payerKey: "payerNoeControlNumber" | "payerNotrControlNumber";
  readonly eventName: "m23.noe.accepted" | "m23.notr.accepted";
  find(tx: BillingTx, id: string): Promise<NoticeRow | null>;
  reduce(state: NoticeState, edge: AckEdge): { state: NoticeState; error?: string };
  transition(
    tx: BillingTx,
    row: NoticeRow,
    next: NoticeState,
    patch: repositories.NoeTransitionPatch,
  ): Promise<{ ok: boolean; row?: NoticeRow }>;
}

const OPS: Record<DdeNoticeKind, KindOps> = {
  noe: {
    aggregateKind: "noe_record",
    idKey: "noeId",
    payerKey: "payerNoeControlNumber",
    eventName: "m23.noe.accepted",
    find: (tx, id) => new repositories.NoeRepository(tx).findById(id),
    reduce: (s, e) => noeMachine.reduce(s, e),
    transition: (tx, row, next, patch) =>
      new repositories.NoeRepository(tx).transitionToState(row.id, row.version, next, patch),
  },
  notr: {
    aggregateKind: "notr_record",
    idKey: "notrId",
    payerKey: "payerNotrControlNumber",
    eventName: "m23.notr.accepted",
    find: (tx, id) => new repositories.NotrRepository(tx).findById(id),
    reduce: (s, e) => notrMachine.reduce(s, e),
    transition: (tx, row, next, patch) =>
      new repositories.NotrRepository(tx).transitionToState(row.id, row.version, next, patch),
  },
};

/** Drive the notice to `ack_accepted` through its existing edges, on the caller's org-scoped transaction. */
export async function applyDdeNoticeAcceptance(
  tx: BillingTx,
  input: DdeNoticeAcceptanceInput,
): Promise<DdeNoticeAcceptanceResult> {
  const ops = OPS[input.kind];
  const notice = await ops.find(tx, input.noticeId);
  if (!notice) throw new NotFoundError(`${input.kind} record`);
  if (notice.state === "ack_accepted") {
    return { applied: false, fromState: notice.state, toState: notice.state };
  }
  const edges = EDGES_FROM[notice.state];
  if (!edges) {
    throw new ConflictError(
      `a ${input.kind} in state '${notice.state}' cannot be accepted through the DDE queue`,
    );
  }

  let current: NoticeRow = notice;
  for (const edge of edges) {
    const reduced = ops.reduce(current.state, edge);
    if (reduced.error)
      throw new ConflictError(`cannot '${edge}' a ${input.kind} in '${current.state}'`);
    const isFinal = edge === "ack_277ca_accepted";
    const res = await ops.transition(
      tx,
      current,
      reduced.state,
      isFinal
        ? {
            acceptedAt: input.recordedAt,
            payerStatusDate: input.macAcceptedOn,
            payerStatusDateSource: "dde_manual",
          }
        : {},
    );
    if (!res.ok || !res.row) {
      throw new WardenXError(
        "VERSION_CONFLICT",
        `the ${input.kind.toUpperCase()} was modified concurrently`,
        412,
      );
    }
    current = res.row;
  }

  if (input.outbox) {
    await input.outbox.publish(tx, {
      eventName: ops.eventName,
      organizationId: input.organizationId,
      aggregateKind: ops.aggregateKind,
      aggregateId: notice.id,
      payload: {
        [ops.idKey]: notice.id,
        acknowledgmentId: null,
        [ops.payerKey]: "",
        acceptedAt: input.recordedAt.toISOString(),
        payerStatusDate: input.macAcceptedOn,
        payerStatusDateSource: "dde_manual",
      },
    });
  }
  return { applied: true, fromState: notice.state, toState: current.state };
}
