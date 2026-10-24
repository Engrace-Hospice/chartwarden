// apps/backend/src/modules/36-messaging/handoffs/handoff-service.ts - WP 3.5: the clinical-handoff policy (ADR-0062).
//
// A handoff is a sender-authorised disclosure of patient identity and open-work STATUS to one named colleague, accepted or
// declined PER ITEM. This service owns the rules the routes must not re-derive: the sender must have every patient on their
// caseload; the SERVER re-collects the open work and refuses anything it cannot verify (fail closed); the recipient is
// checked at offer and again at accept; only the sender or recipient ever sees a handoff (everyone else, and every missing
// id, gets the one not-found); accountability stays with the sender until an item is accepted. It is flag-independent -
// the routes gate `messaging.handoffs`. It never writes another module's data: the only cross-aggregate write is the
// module's own communication task, reassigned through the task store when its handoff item is accepted.
import type { DbClient } from "@chartwarden/db";
import {
  HANDOFF_MAX_ITEMS,
  HANDOFF_MAX_PATIENTS,
  closeOutcome,
  effectiveHandoffMinutes,
  handoffPolicyView,
  handoffRole,
  isPastDeadline,
  prepareHandoffPolicy,
  validateOfferShape,
} from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  ForbiddenError,
  type HandoffDto,
  type HandoffItemKind,
  type HandoffItemState,
  type HandoffPolicyView,
  NotFoundError,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import {
  TaskAssigneeAlreadyHasActive,
  TaskNotFound,
  TaskStateConflict,
  type TaskStore,
} from "../tasks/task-store-db";
import {
  type HandoffDtoContext,
  type ItemDtoDeps,
  type PatientLabelPort,
  buildItemDtos,
  toHandoffDto,
} from "./handoff-dto";
import { type EligibilityPorts, gateAdmits, recipientEligible } from "./handoff-eligibility";
import { publishHandoffEvent } from "./handoff-events";
import { expireHandoffInTx } from "./handoff-expiry";
import type { HandoffPolicyStore } from "./handoff-policy-store-db";
import { finishHandoff } from "./handoff-settle";
import { type HandoffSourcePorts, type PrefillResult, collectOpenWork } from "./handoff-sources";
import {
  HandoffItemConflict,
  type HandoffItemRow,
  type HandoffRow,
  HandoffStateConflict,
  type HandoffStore,
  type HandoffWithItems,
} from "./handoff-store-db";
import type { HandoffSummaryPorts } from "./handoff-summaries";

export const HANDOFFS_FLAG_KEY = "messaging.handoffs";

export interface HandoffActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface CaseloadPatient {
  readonly patient_id: string;
  readonly display_name: string;
  readonly mrn_suffix: string | null;
}

export interface HandoffService {
  caseload(actor: HandoffActorRef): Promise<CaseloadPatient[]>;
  prefill(actor: HandoffActorRef, patientIds: string[]): Promise<PrefillResult>;
  offer(
    actor: HandoffActorRef,
    a: {
      toUserId: string;
      items: { kind: HandoffItemKind; ref_id: string; patient_id: string }[];
    },
  ): Promise<{ handoff: HandoffDto; created: boolean }>;
  get(actor: HandoffActorRef, handoffId: string): Promise<HandoffDto>;
  list(
    actor: HandoffActorRef,
    q: { scope: "incoming" | "outgoing"; state: "active" | "closed" | "all"; limit: number },
  ): Promise<HandoffDto[]>;
  accept(actor: HandoffActorRef, handoffId: string, itemIds: string[]): Promise<HandoffDto>;
  decline(actor: HandoffActorRef, handoffId: string, itemIds?: string[]): Promise<HandoffDto>;
  cancel(actor: HandoffActorRef, handoffId: string): Promise<HandoffDto>;
  policy(actor: HandoffActorRef): Promise<HandoffPolicyView>;
  setPolicy(actor: HandoffActorRef, expiryMinutes: number): Promise<HandoffPolicyView>;
  clearPolicy(actor: HandoffActorRef): Promise<HandoffPolicyView>;
}

export interface HandoffServiceDeps extends EligibilityPorts {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort | undefined;
  readonly store: HandoffStore;
  readonly policyStore: HandoffPolicyStore;
  readonly taskStore: TaskStore;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly caseloadPatientIds: (orgId: string, userId: string) => Promise<readonly string[]>;
  readonly patientLabels: PatientLabelPort;
  readonly sources: HandoffSourcePorts;
  readonly summaries: HandoffSummaryPorts;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

const CASELOAD_LIST_MAX = 200;
const MS_PER_MINUTE = 60_000;

/** One refusal for missing / not a participant: names nothing. */
const notFound = (): NotFoundError => new NotFoundError("clinical_handoff");
const typed = (code: string, message: string, status: number): ChartWardenError =>
  new ChartWardenError(code, message, status);
const recipientInvalid = () =>
  typed("HANDOFF_RECIPIENT_INVALID", "this person cannot receive a handoff", 422);
const itemInvalid = () =>
  typed("HANDOFF_ITEM_INVALID", "one or more items cannot be handed off", 422);
const stateConflict = () =>
  typed("HANDOFF_STATE_CONFLICT", "handoff is not in a state that allows this", 409);
const notTransferable = () =>
  typed("HANDOFF_ITEM_NOT_TRANSFERABLE", "an item cannot be transferred to you", 422);

/** Store errors become the typed envelope errors; anything else propagates untouched. */
function mapStoreError(err: unknown): never {
  if (err instanceof HandoffStateConflict) throw stateConflict();
  if (err instanceof HandoffItemConflict)
    throw typed("HANDOFF_ITEM_CONFLICT", "an item is already part of another open handoff", 409);
  throw err;
}

export function createHandoffService(deps: HandoffServiceDeps): HandoffService {
  const { store, policyStore } = deps;
  const clock = deps.now ?? (() => new Date());
  const itemDeps: ItemDtoDeps = {
    patientLabels: deps.patientLabels,
    part2Gate: deps.part2Gate,
    summaries: deps.summaries,
  };

  const run = <R>(actor: HandoffActorRef, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, { organizationId: actor.orgId, userId: actor.userId }, (tx) =>
      fn(tx as unknown as Tx),
    ).catch(mapStoreError);

  const minutesFor = async (actor: HandoffActorRef): Promise<number> =>
    effectiveHandoffMinutes(await policyStore.read(actor.orgId, actor.userId));

  async function names(orgId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of new Set(ids)) out.set(id, await deps.displayName(orgId, id));
    return out;
  }

  async function present(
    actor: HandoffActorRef,
    rows: readonly HandoffWithItems[],
    withItems: boolean,
  ): Promise<HandoffDto[]> {
    const [minutes, attention] = await Promise.all([
      minutesFor(actor),
      store.needsAttentionIds(
        actor.orgId,
        rows.map((r) => r.handoff.id),
      ),
    ]);
    const nameMap = await names(
      actor.orgId,
      rows.flatMap((r) => [
        r.handoff.fromUserId,
        r.handoff.toUserId,
        ...(withItems ? r.items.map((i) => i.accountableUserId) : []),
      ]),
    );
    const nameOf = (id: string) => nameMap.get(id) ?? null;
    const now = clock();
    return Promise.all(
      rows.map(async ({ handoff, items }) => {
        const ctx: HandoffDtoContext = {
          viewerId: actor.userId,
          now,
          effectiveMinutes: minutes,
          needsAttention: attention.has(handoff.id),
          nameOf,
        };
        const dtos = withItems
          ? await buildItemDtos(itemDeps, actor.orgId, actor.userId, items, nameOf)
          : undefined;
        return toHandoffDto(handoff, items, ctx, dtos);
      }),
    );
  }

  async function presentOne(actor: HandoffActorRef, handoffId: string): Promise<HandoffDto> {
    const row = await store.participantGet(actor.orgId, actor.userId, handoffId);
    if (!row) throw notFound();
    return (await present(actor, [row], true))[0] as HandoffDto;
  }

  /** The caller's own caseload, intersected with the patients they name. */
  async function ownCaseload(actor: HandoffActorRef): Promise<Set<string>> {
    return new Set(await deps.caseloadPatientIds(actor.orgId, actor.userId));
  }

  async function verifyOfferItems(
    actor: HandoffActorRef,
    toUserId: string,
    items: readonly { kind: HandoffItemKind; ref_id: string; patient_id: string }[],
  ): Promise<void> {
    const patientIds = [...new Set(items.map((i) => i.patient_id))];
    const caseload = await ownCaseload(actor);
    if (!patientIds.every((p) => caseload.has(p))) throw itemInvalid();
    if (!(await gateAdmits(deps.part2Gate, actor.orgId, actor.userId, patientIds)))
      throw itemInvalid();
    if (!(await recipientEligible(deps, actor.orgId, toUserId, patientIds)))
      throw recipientInvalid();
    const open = await collectOpenWork(
      deps.sources,
      { orgId: actor.orgId, userId: actor.userId, now: clock() },
      patientIds,
    );
    const byPatient = new Map(open.patients.map((p) => [p.patient_id, p]));
    for (const item of items) {
      const found = byPatient.get(item.patient_id);
      const verified = found?.items.some((o) => o.kind === item.kind && o.ref_id === item.ref_id);
      if (!found || !verified) throw itemInvalid();
    }
  }

  async function offer(
    actor: HandoffActorRef,
    a: { toUserId: string; items: { kind: HandoffItemKind; ref_id: string; patient_id: string }[] },
  ) {
    const shape = validateOfferShape(a.items);
    if (shape) throw typed(shape, "the handoff items are not acceptable", 422);
    if (a.toUserId === actor.userId) throw recipientInvalid();
    // A repeat offer to the same person returns the sender's OWN open handoff (the pair contains the caller's id) and
    // ignores the new body; it is checked first so a replay never trips over its own pending items.
    const minutes = await minutesFor(actor);
    const existing = await run(actor, async (tx) => {
      const open = await store.findOpenForPair(tx, actor.orgId, actor.userId, a.toUserId);
      if (!open) return null;
      // An open offer past its effective deadline is dead, the sweep just has not reached it: settle it here (same code
      // as the sweep, same transaction) and let the new offer proceed instead of handing back a handoff nobody can accept.
      const locked = await store.getForUpdate(tx, actor.orgId, open.id);
      if (!locked || locked.state !== "offered") return null;
      if (!isPastDeadline(locked, minutes, clock())) return locked;
      await expireHandoffInTx({ store, outbox: deps.outbox, now: clock }, tx, locked);
      return null;
    });
    if (existing) return { handoff: await presentOne(actor, existing.id), created: false };
    await verifyOfferItems(actor, a.toUserId, a.items);
    const offeredAt = clock();
    const expiresAt = new Date(offeredAt.getTime() + minutes * MS_PER_MINUTE);
    const result = await run(actor, async (tx) => {
      const r = await store.insertOffered(tx, {
        orgId: actor.orgId,
        fromUserId: actor.userId,
        toUserId: a.toUserId,
        offeredAt,
        expiresAt,
        items: a.items.map((i) => ({ kind: i.kind, refId: i.ref_id, patientId: i.patient_id })),
      });
      if (r.created)
        await publishHandoffEvent(deps.outbox, tx, {
          kind: "offered",
          orgId: actor.orgId,
          handoffId: r.handoff.id,
          fromUserId: actor.userId,
          toUserId: a.toUserId,
          itemCount: r.items.length,
          expiresAt,
          at: offeredAt,
        });
      return r;
    });
    return {
      handoff: (await present(actor, [result], true))[0] as HandoffDto,
      created: result.created,
    };
  }

  /** Loads and locks the handoff for a participant; the uniform not-found for anyone else. */
  async function lockForParticipant(tx: Tx, actor: HandoffActorRef, handoffId: string) {
    const h = await store.getForUpdate(tx, actor.orgId, handoffId);
    if (!h || handoffRole(h, actor.userId) === "none") throw notFound();
    return h;
  }

  /** Item ids must all belong to the handoff; otherwise the uniform item-invalid (names nothing). */
  function chooseItems(all: readonly HandoffItemRow[], ids: readonly string[]): HandoffItemRow[] {
    const byId = new Map(all.map((i) => [i.id, i]));
    const chosen = [...new Set(ids)].map((id) => byId.get(id));
    if (chosen.some((c) => !c)) throw itemInvalid();
    return chosen as HandoffItemRow[];
  }

  async function transferTask(
    tx: Tx,
    actor: HandoffActorRef,
    h: HandoffRow,
    item: HandoffItemRow,
    viewableChannels: ReadonlySet<string>,
  ): Promise<void> {
    const task = await deps.taskStore.getForUpdate(tx, actor.orgId, item.refId);
    const active = task && (task.status === "open" || task.status === "accepted");
    if (!task || !active || task.assigneeId !== h.fromUserId || task.patientId !== item.patientId)
      throw notTransferable();
    // Membership was resolved BEFORE the locks (canViewChannel uses its own connection); a task that moved to a channel
    // we did not check fails closed.
    if (!viewableChannels.has(task.channelId)) throw notTransferable();
    try {
      await deps.taskStore.transition(tx, {
        orgId: actor.orgId,
        taskId: task.id,
        actor: { kind: "user", userId: actor.userId },
        action: "reassign",
        toAssigneeId: actor.userId,
        reassignReason: "handoff",
      });
    } catch (err) {
      if (
        err instanceof TaskNotFound ||
        err instanceof TaskStateConflict ||
        err instanceof TaskAssigneeAlreadyHasActive
      )
        throw notTransferable();
      throw err;
    }
  }

  /**
   * The channels of the chosen pending task items that the acceptor may view, resolved outside the accept transaction so
   * no pooled connection is awaited while handoff and task rows are locked. A short read tx only learns the channel ids.
   */
  async function viewableTaskChannels(
    actor: HandoffActorRef,
    chosen: readonly HandoffItemRow[],
  ): Promise<ReadonlySet<string>> {
    const taskIds = chosen.filter((i) => i.itemKind === "task" && i.state === "pending");
    if (taskIds.length === 0) return new Set();
    const channelIds = await run(actor, async (tx) => {
      const found = new Set<string>();
      for (const item of taskIds) {
        const task = await deps.taskStore.getForUpdate(tx, actor.orgId, item.refId);
        if (task) found.add(task.channelId);
      }
      return found;
    });
    const viewable = new Set<string>();
    for (const channelId of channelIds)
      if (await deps.messaging.canViewChannel(actor.orgId, actor.userId, channelId))
        viewable.add(channelId);
    return viewable;
  }

  /** The recipient-only preconditions shared by accept and decline. */
  function requireOpenForRecipient(h: HandoffRow, actor: HandoffActorRef, minutes: number): void {
    if (handoffRole(h, actor.userId) !== "recipient") throw new ForbiddenError("not permitted");
    if (h.state !== "offered" || isPastDeadline(h, minutes, clock())) throw stateConflict();
  }

  async function accept(actor: HandoffActorRef, handoffId: string, itemIds: string[]) {
    if (itemIds.length === 0)
      throw typed("HANDOFF_ITEMS_REQUIRED", "choose at least one item", 422);
    if (itemIds.length > HANDOFF_MAX_ITEMS)
      throw typed("HANDOFF_TOO_MANY_ITEMS", "too many items", 422);
    const current = await store.participantGet(actor.orgId, actor.userId, handoffId);
    if (!current) throw notFound();
    const chosenNow = chooseItems(current.items, itemIds);
    const chosenPatients = chosenNow.map((i) => i.patientId);
    if (current.handoff.toUserId === actor.userId && current.handoff.state === "offered") {
      // Re-checked at accept: the recipient may have lost a permission or a Part 2 release since the offer.
      if (!(await recipientEligible(deps, actor.orgId, actor.userId, chosenPatients)))
        throw recipientInvalid();
    }
    const minutes = await minutesFor(actor);
    const viewableChannels =
      current.handoff.toUserId === actor.userId && current.handoff.state === "offered"
        ? await viewableTaskChannels(actor, chosenNow)
        : new Set<string>();
    await run(actor, async (tx) => {
      const h = await lockForParticipant(tx, actor, handoffId);
      const all = await store.itemsOf(tx, actor.orgId, handoffId);
      const chosen = chooseItems(all, itemIds);
      const settledByMe =
        chosen.every((i) => i.state === "accepted") && h.toUserId === actor.userId;
      if (settledByMe) return; // idempotent replay: nothing changes, nothing is published
      requireOpenForRecipient(h, actor, minutes);
      if (chosen.some((i) => i.state !== "pending" && i.state !== "accepted"))
        throw stateConflict();
      const toAccept = chosen.filter((i) => i.state === "pending");
      for (const item of toAccept.filter((i) => i.itemKind === "task"))
        await transferTask(tx, actor, h, item, viewableChannels);
      const moved = await store.resolveItems(tx, {
        orgId: actor.orgId,
        handoffId,
        itemIds: toAccept.map((i) => i.id),
        action: "accept",
        accountableUserId: actor.userId,
        now: clock(),
      });
      if (moved.length !== toAccept.length) throw stateConflict();
      await store.appendEvent(tx, {
        orgId: actor.orgId,
        handoffId,
        type: "items_accepted",
        actor: { kind: "user", userId: actor.userId },
        itemCount: moved.length,
      });
      const after = await store.itemsOf(tx, actor.orgId, handoffId);
      const states = after.map((i) => i.state as HandoffItemState);
      await publishHandoffEvent(deps.outbox, tx, {
        kind: "accepted",
        orgId: actor.orgId,
        handoffId,
        fromUserId: h.fromUserId,
        toUserId: h.toUserId,
        acceptedItemCount: moved.length,
        pendingItemCount: states.filter((s) => s === "pending").length,
        at: clock(),
      });
      await closeIfResolved(tx, actor, h, states);
    });
    return presentOne(actor, handoffId);
  }

  async function closeIfResolved(
    tx: Tx,
    actor: HandoffActorRef,
    h: HandoffRow,
    states: readonly HandoffItemState[],
  ): Promise<void> {
    const outcome = closeOutcome(states);
    if (outcome.kind === "open") return;
    await finishHandoff({ store, outbox: deps.outbox, now: clock }, tx, h, {
      state: outcome.state,
      reason: outcome.reason,
      eventType: "closed",
      actor: { kind: "user", userId: actor.userId },
      unacceptedCause: "declined",
    });
  }

  async function decline(actor: HandoffActorRef, handoffId: string, itemIds?: string[]) {
    if (itemIds && itemIds.length > HANDOFF_MAX_ITEMS)
      throw typed("HANDOFF_TOO_MANY_ITEMS", "too many items", 422);
    const minutes = await minutesFor(actor);
    await run(actor, async (tx) => {
      const h = await lockForParticipant(tx, actor, handoffId);
      const all = await store.itemsOf(tx, actor.orgId, handoffId);
      const chosen = itemIds ? chooseItems(all, itemIds) : all.filter((i) => i.state === "pending");
      const settledAsDeclined =
        all.some((i) => i.state === "declined") &&
        all.every((i) => i.state === "declined" || i.state === "accepted");
      const replay = itemIds
        ? chosen.length > 0 && chosen.every((i) => i.state === "declined")
        : settledAsDeclined;
      if (replay && h.toUserId === actor.userId) return; // idempotent replay: nothing changes, nothing is published
      requireOpenForRecipient(h, actor, minutes);
      if (chosen.some((i) => i.state !== "pending" && i.state !== "declined"))
        throw stateConflict();
      const toDecline = chosen.filter((i) => i.state === "pending");
      if (toDecline.length === 0) return;
      const moved = await store.resolveItems(tx, {
        orgId: actor.orgId,
        handoffId,
        itemIds: toDecline.map((i) => i.id),
        action: "decline",
        now: clock(),
      });
      await store.appendEvent(tx, {
        orgId: actor.orgId,
        handoffId,
        type: "items_declined",
        actor: { kind: "user", userId: actor.userId },
        itemCount: moved.length,
      });
      const after = await store.itemsOf(tx, actor.orgId, handoffId);
      await closeIfResolved(
        tx,
        actor,
        h,
        after.map((i) => i.state as HandoffItemState),
      );
    });
    return presentOne(actor, handoffId);
  }

  async function cancel(actor: HandoffActorRef, handoffId: string) {
    await run(actor, async (tx) => {
      const h = await lockForParticipant(tx, actor, handoffId);
      if (handoffRole(h, actor.userId) !== "sender") throw new ForbiddenError("not permitted");
      if (h.state === "cancelled") return; // idempotent replay
      if (h.state !== "offered") throw stateConflict();
      await store.resolveItems(tx, {
        orgId: actor.orgId,
        handoffId,
        itemIds: null,
        action: "cancel",
        now: clock(),
      });
      // Nothing was left unowned (the sender keeps every item), so there is no supervisor announcement.
      await finishHandoff({ store, outbox: deps.outbox, now: clock }, tx, h, {
        state: "cancelled",
        reason: "sender_cancelled",
        eventType: "cancelled",
        actor: { kind: "user", userId: actor.userId },
        unacceptedCause: null,
      });
    });
    return presentOne(actor, handoffId);
  }

  const policy = async (actor: HandoffActorRef) =>
    handoffPolicyView(await policyStore.read(actor.orgId, actor.userId));

  return {
    async caseload(actor) {
      const ids = (await ownCaseload(actor)) as ReadonlySet<string>;
      const labels = await deps.patientLabels(
        actor.orgId,
        [...ids].slice(0, CASELOAD_LIST_MAX * 2),
      );
      return [...ids]
        .flatMap((id) => {
          const l = labels.get(id);
          return l
            ? [{ patient_id: id, display_name: l.displayName, mrn_suffix: l.mrnSuffix }]
            : [];
        })
        .sort(
          (a, b) =>
            a.display_name.localeCompare(b.display_name) ||
            a.patient_id.localeCompare(b.patient_id),
        )
        .slice(0, CASELOAD_LIST_MAX);
    },
    async prefill(actor, patientIds) {
      const caseload = await ownCaseload(actor);
      const unique = [...new Set(patientIds)];
      if (
        unique.length === 0 ||
        unique.length > HANDOFF_MAX_PATIENTS ||
        !unique.every((p) => caseload.has(p))
      )
        throw itemInvalid();
      if (!(await gateAdmits(deps.part2Gate, actor.orgId, actor.userId, unique)))
        throw itemInvalid();
      return collectOpenWork(
        deps.sources,
        { orgId: actor.orgId, userId: actor.userId, now: clock() },
        unique,
      );
    },
    offer,
    get: presentOne,
    async list(actor, q) {
      const rows = await store.participantList(actor.orgId, actor.userId, q);
      return present(actor, rows, false);
    },
    accept,
    decline,
    cancel,
    policy,
    async setPolicy(actor, expiryMinutes) {
      await policyStore.put(actor.orgId, actor.userId, prepareHandoffPolicy(expiryMinutes));
      return policy(actor);
    },
    async clearPolicy(actor) {
      await policyStore.remove(actor.orgId, actor.userId);
      return policy(actor);
    },
  };
}
