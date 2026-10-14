// apps/backend/src/modules/36-messaging/promotions/promotion-service.ts - WP 3.7: the chart-promotion policy (ADR-0063).
//
// A request is a thin pointer at ONE message plus the facts that attribute it (author, sent time, a hash of the body). The
// service owns the rules the routes must not re-derive: the caller must be able to see the channel, hold messaging.promote
// and patient.read, and pass the 42 CFR Part 2 gate for the patient (a gate or permission lookup that throws is a denial);
// the patient is derived from the channel, never taken from the client; only the two chart targets exist (no path to an
// order); a repeat request replays, an edited message supersedes. M36 NEVER decides accepted/rejected: it records the outcome
// the owning module reports (applyOutcome), which is the only way result_ref is ever set. Flag-independent: the routes gate
// the `messaging.promotions` flag. It writes no M8/M14 table and calls no mutating seam (m36-promotion-no-foreign-writes).
import type { DbClient } from "@wardenx/db";
import {
  allowedPromotionActions,
  applyPromotionOutcome as decideOutcome,
  decidePromotionRequest,
  derivePatient,
  promotionActorRole,
} from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import {
  type ChartPromotionDto,
  type ChartPromotionOutcome,
  type ChartPromotionReasonCode,
  type ChartPromotionStatus,
  type ChartPromotionTargetKind,
  type ChartPromotionTargetModule,
  ForbiddenError,
  NotFoundError,
  WardenXError,
  isChartPromotionTarget,
} from "@wardenx/types";
import { gateAdmits } from "../handoffs/handoff-eligibility";
import type { HintOutboxPort } from "../message-hint-events";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { publishPromotionRequested } from "./promotion-events";
import {
  type PromotionListState,
  type PromotionRow,
  type PromotionStore,
  createDbPromotionStore,
} from "./promotion-store-db";

export const PROMOTIONS_FLAG_KEY = "messaging.promotions";

/** What a request needs of the caller on top of seeing the channel. */
const REQUEST_PERMISSIONS = ["messaging.promote", "patient.read"] as const;
const READ_PERMISSION = "patient.read";

export interface PromotionActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface PromotionMessageFacts {
  /** Not deleted and not erased. */
  readonly live: boolean;
  readonly channelKind: string;
  readonly subjectId: string | null;
  /** Null for a system-authored message, which cannot be proposed. */
  readonly authorUserId: string | null;
  readonly bodySha256: string;
  readonly createdAt: Date;
}

export interface PromotionOutcomeEvent {
  /** The module whose `mN.chart_promotion.decided` event this is (taken from the event name, not the payload). */
  readonly ownerModule: string;
  readonly promotionRequestId: string;
  readonly outcome: ChartPromotionOutcome;
  readonly resultRef: string | null;
  readonly decidedByUserId: string | null;
  readonly reasonCode: ChartPromotionReasonCode | null;
  readonly at: Date;
}

export type PromotionOutcomeResult =
  | { readonly applied: "accepted" | "rejected"; readonly requestedByUserId: string }
  | { readonly applied: "noop" | "ignored" | "conflict" | "unknown" };

export interface PromotionService {
  request(
    actor: PromotionActorRef,
    a: {
      channelId: string;
      messageId: string;
      targetModule: string;
      targetKind: string;
      suggestedTargetRef?: string | null;
    },
  ): Promise<{ promotion: ChartPromotionDto; created: boolean }>;
  listForMessage(
    actor: PromotionActorRef,
    channelId: string,
    messageId: string,
  ): Promise<ChartPromotionDto[]>;
  listMine(
    actor: PromotionActorRef,
    q: { state: PromotionListState; limit: number },
  ): Promise<ChartPromotionDto[]>;
  get(actor: PromotionActorRef, promotionId: string): Promise<ChartPromotionDto>;
  withdraw(actor: PromotionActorRef, promotionId: string): Promise<ChartPromotionDto>;
  /** Called by the outcome consumer (not a request): records the owning module's decision. */
  applyOutcome(orgId: string, event: PromotionOutcomeEvent): Promise<PromotionOutcomeResult>;
}

export interface PromotionServiceDeps {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort | undefined;
  readonly store?: PromotionStore;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly messageLookup: (
    orgId: string,
    channelId: string,
    messageId: string,
  ) => Promise<PromotionMessageFacts | null>;
  readonly part2Gate: Part2ChannelGate;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  /** Is this an IDG meeting of the organisation? Absent or throwing = no (a suggested meeting is then refused). */
  readonly meetingExists?: (orgId: string, meetingId: string) => Promise<boolean>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
  /** Failure log sink (ids and enum values only). */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

/** One refusal for missing / not visible / no longer permitted / message gone / Part 2: names nothing. */
const notFound = (): NotFoundError => new NotFoundError("chart_promotion_request");
const targetInvalid = (): WardenXError =>
  new WardenXError("PROMOTION_TARGET_INVALID", "that chart target is not available", 422);
const suggestedInvalid = (): WardenXError =>
  new WardenXError("PROMOTION_SUGGESTED_REF_INVALID", "the suggested meeting is not valid", 422);
const notPatientLinked = (): WardenXError =>
  new WardenXError(
    "PROMOTION_SOURCE_NOT_PATIENT_LINKED",
    "only a message in a patient's channel can be proposed for the chart",
    422,
  );
const stateConflict = (): WardenXError =>
  new WardenXError(
    "PROMOTION_STATE_CONFLICT",
    "the request is not in a state that allows this",
    409,
  );

export function createPromotionService(deps: PromotionServiceDeps): PromotionService {
  const store = deps.store ?? createDbPromotionStore(deps.db);
  const clock = deps.now ?? (() => new Date());

  const canView = (orgId: string, userId: string, channelId: string) =>
    deps.messaging.canViewChannel(orgId, userId, channelId);

  /** The caller's permissions; a lookup that throws holds none. */
  async function held(orgId: string, userId: string): Promise<ReadonlySet<string>> {
    try {
      return await deps.permissionsFor(orgId, userId);
    } catch {
      return new Set();
    }
  }

  async function names(orgId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of new Set(ids)) out.set(id, await deps.displayName(orgId, id));
    return out;
  }

  function toDto(
    row: PromotionRow,
    userId: string,
    nameOf: Map<string, string | null>,
  ): ChartPromotionDto {
    const status = row.status as ChartPromotionStatus;
    return {
      id: row.id,
      message_id: row.messageId,
      channel_id: row.channelId,
      patient_id: row.patientId,
      target_module: row.targetModule as ChartPromotionTargetModule,
      target_kind: row.targetKind as ChartPromotionTargetKind,
      suggested_target_ref: row.suggestedTargetRef,
      status,
      requested_by: row.requestedByUserId,
      requested_by_display_name: nameOf.get(row.requestedByUserId) ?? null,
      requested_at: row.requestedAt.toISOString(),
      source_author_user_id: row.sourceAuthorUserId,
      source_author_display_name: nameOf.get(row.sourceAuthorUserId) ?? null,
      source_sent_at: row.sourceSentAt.toISOString(),
      result_ref: row.resultRef,
      decided_by: row.decidedByUserId,
      decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
      reason_code: row.reasonCode as ChartPromotionReasonCode | null,
      allowed_actions: [...allowedPromotionActions({ status }, promotionActorRole(row, userId))],
    };
  }

  async function dtosFor(
    rows: readonly PromotionRow[],
    userId: string,
  ): Promise<ChartPromotionDto[]> {
    if (rows.length === 0) return [];
    const orgId = rows[0]?.organizationId ?? "";
    const nameOf = await names(
      orgId,
      rows.flatMap((r) => [r.requestedByUserId, r.sourceAuthorUserId]),
    );
    return rows.map((r) => toDto(r, userId, nameOf));
  }

  /**
   * May this caller read this row? patient.read still held AND the Part 2 gate admits them for the patient AND (they
   * proposed it OR they can see the channel). Any doubt, including a lookup that throws, is a no.
   */
  async function canRead(actor: PromotionActorRef, row: PromotionRow): Promise<boolean> {
    if (!(await held(actor.orgId, actor.userId)).has(READ_PERMISSION)) return false;
    if (!(await gateAdmits(deps.part2Gate, actor.orgId, actor.userId, [row.patientId])))
      return false;
    if (row.requestedByUserId === actor.userId) return true;
    return canView(actor.orgId, actor.userId, row.channelId);
  }

  async function visibleRow(actor: PromotionActorRef, promotionId: string): Promise<PromotionRow> {
    const row = await store.get(actor.orgId, promotionId);
    if (!row || !(await canRead(actor, row))) throw notFound();
    return row;
  }

  /** Rows the caller may read: permission once, gate and channel per distinct patient / channel. */
  async function readableRows(
    actor: PromotionActorRef,
    rows: readonly PromotionRow[],
  ): Promise<PromotionRow[]> {
    if (!(await held(actor.orgId, actor.userId)).has(READ_PERMISSION)) return [];
    const patientOk = new Map<string, boolean>();
    const channelOk = new Map<string, boolean>();
    const out: PromotionRow[] = [];
    for (const row of rows) {
      if (!patientOk.has(row.patientId)) {
        patientOk.set(
          row.patientId,
          await gateAdmits(deps.part2Gate, actor.orgId, actor.userId, [row.patientId]),
        );
      }
      if (!patientOk.get(row.patientId)) continue;
      if (row.requestedByUserId !== actor.userId) {
        if (!channelOk.has(row.channelId)) {
          channelOk.set(row.channelId, await canView(actor.orgId, actor.userId, row.channelId));
        }
        if (!channelOk.get(row.channelId)) continue;
      }
      out.push(row);
    }
    return out;
  }

  async function suggestedRefValid(orgId: string, meetingId: string): Promise<boolean> {
    try {
      return (await deps.meetingExists?.(orgId, meetingId)) === true;
    } catch {
      return false;
    }
  }

  /** Everything between "a target was named" and "the write": returns the source facts or throws the uniform refusals. */
  async function checkSource(
    actor: PromotionActorRef,
    a: { channelId: string; messageId: string },
  ): Promise<{ msg: PromotionMessageFacts & { authorUserId: string }; patientId: string }> {
    if (!(await canView(actor.orgId, actor.userId, a.channelId))) throw notFound();
    const msg = await deps.messageLookup(actor.orgId, a.channelId, a.messageId);
    if (!msg || !msg.live || msg.authorUserId === null) throw notFound();
    const patientId = derivePatient(msg.channelKind, msg.subjectId);
    if (patientId === null) throw notPatientLinked();
    const permissions = await held(actor.orgId, actor.userId);
    if (!REQUEST_PERMISSIONS.every((p) => permissions.has(p))) throw notFound();
    if (!(await gateAdmits(deps.part2Gate, actor.orgId, actor.userId, [patientId])))
      throw notFound();
    return { msg: { ...msg, authorUserId: msg.authorUserId }, patientId };
  }

  return {
    async request(actor, a) {
      if (!isChartPromotionTarget(a.targetModule, a.targetKind)) throw targetInvalid();
      const targetModule = a.targetModule as ChartPromotionTargetModule;
      const targetKind = a.targetKind as ChartPromotionTargetKind;
      const suggested = a.suggestedTargetRef ?? null;
      if (suggested !== null && targetModule !== "m14") throw targetInvalid();
      const { msg, patientId } = await checkSource(actor, a);
      if (suggested !== null && !(await suggestedRefValid(actor.orgId, suggested))) {
        throw suggestedInvalid();
      }
      const key = { messageId: a.messageId, targetModule, targetKind };
      const result = await withOrgContext(
        deps.db,
        { organizationId: actor.orgId, userId: actor.userId },
        async (tx) => {
          const existing = await store.lockKey(tx, actor.orgId, key);
          const decision = decidePromotionRequest(
            existing.map((r) => ({ ...r, status: r.status as ChartPromotionStatus })),
            msg.bodySha256,
          );
          if (decision.kind === "replay") {
            return { row: existing[decision.index] as PromotionRow, created: false };
          }
          if (decision.kind === "supersede") {
            const old = existing[decision.index] as PromotionRow;
            if (!(await store.supersede(tx, actor.orgId, old.id))) throw stateConflict();
          }
          const inserted = await store.insertProposed(tx, {
            ...key,
            orgId: actor.orgId,
            channelId: a.channelId,
            patientId,
            suggestedTargetRef: suggested,
            requestedByUserId: actor.userId,
            sourceAuthorUserId: msg.authorUserId,
            sourceSentAt: msg.createdAt,
            sourceBodySha256: msg.bodySha256,
          });
          if (!inserted) {
            // A concurrent identical request won the race: replay its row (the key lock above was empty).
            const winner = (await store.lockKey(tx, actor.orgId, key)).find(
              (r) => r.status === "proposed",
            );
            if (!winner || winner.sourceBodySha256 !== msg.bodySha256) throw stateConflict();
            return { row: winner, created: false };
          }
          await publishPromotionRequested(deps.outbox, tx, {
            orgId: actor.orgId,
            promotionRequestId: inserted.id,
            targetModule,
            targetKind,
            requestedByUserId: actor.userId,
            at: clock(),
          });
          return { row: inserted, created: true };
        },
      );
      const [promotion] = await dtosFor([result.row], actor.userId);
      return { promotion: promotion as ChartPromotionDto, created: result.created };
    },

    async listForMessage(actor, channelId, messageId) {
      if (!(await canView(actor.orgId, actor.userId, channelId))) throw notFound();
      const rows = (await store.listForMessage(actor.orgId, messageId)).filter(
        (r) => r.channelId === channelId,
      );
      return dtosFor(await readableRows(actor, rows), actor.userId);
    },

    async listMine(actor, q) {
      const rows = await store.listForRequester(actor.orgId, actor.userId, q.state, q.limit);
      return dtosFor(await readableRows(actor, rows), actor.userId);
    },

    async get(actor, promotionId) {
      const row = await visibleRow(actor, promotionId);
      const [dto] = await dtosFor([row], actor.userId);
      return dto as ChartPromotionDto;
    },

    async withdraw(actor, promotionId) {
      const row = await visibleRow(actor, promotionId);
      if (row.requestedByUserId !== actor.userId) throw new ForbiddenError("not permitted");
      if (row.status === "withdrawn")
        return (await dtosFor([row], actor.userId))[0] as ChartPromotionDto;
      if (row.status !== "proposed") throw stateConflict();
      const updated = await withOrgContext(
        deps.db,
        { organizationId: actor.orgId, userId: actor.userId },
        async (tx) => {
          const locked = await store.lockById(tx, actor.orgId, promotionId);
          if (!locked) throw notFound();
          if (locked.status === "withdrawn") return locked;
          const moved = await store.withdraw(tx, actor.orgId, promotionId);
          if (!moved) throw stateConflict();
          return moved;
        },
      );
      return (await dtosFor([updated], actor.userId))[0] as ChartPromotionDto;
    },

    async applyOutcome(orgId, event) {
      const unknown = { applied: "unknown" } as const;
      if (!event.promotionRequestId) return unknown;
      return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
        const row = await store.lockById(tx, orgId, event.promotionRequestId);
        if (!row) return unknown;
        const decision = decideOutcome(
          {
            status: row.status as ChartPromotionStatus,
            targetModule: row.targetModule,
            resultRef: row.resultRef,
          },
          {
            ownerModule: event.ownerModule,
            outcome: event.outcome,
            resultRef: event.resultRef,
            reasonCode: event.reasonCode,
          },
        );
        if (decision.kind === "ignore") return { applied: "ignored" } as const;
        if (decision.kind === "noop") return { applied: "noop" } as const;
        if (decision.kind === "conflict") {
          deps.warn?.("chart promotion already accepted with a different result", {
            organizationId: orgId,
            promotionRequestId: row.id,
          });
          return { applied: "conflict" } as const;
        }
        if (!event.decidedByUserId) return { applied: "ignored" } as const;
        const base = { decidedByUserId: event.decidedByUserId, at: event.at };
        const moved =
          decision.kind === "accept"
            ? await store.markAccepted(tx, orgId, row.id, {
                ...base,
                resultRef: decision.resultRef,
              })
            : await store.markRejected(tx, orgId, row.id, {
                ...base,
                reasonCode: decision.reasonCode,
              });
        if (!moved) return { applied: "noop" } as const;
        return {
          applied: decision.kind === "accept" ? "accepted" : "rejected",
          requestedByUserId: row.requestedByUserId,
        } as const;
      });
    },
  };
}
