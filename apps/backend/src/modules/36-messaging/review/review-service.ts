// apps/backend/src/modules/36-messaging/review/review-service.ts - WP 3.8: the supervisor's decisions on the lifecycle
// review queue (ADR-0065 D4). A holder of `messaging.review` (the routes check it) either REASSIGNS an open task to an
// eligible colleague or CLOSES it with a reason code. Nothing is ever deleted and there is no free-text justification: the
// code is the justification.
//
// Order of work inside one transaction: lock the TASK, then the review row (the order the task-close trigger takes them,
// so a racing close cannot deadlock with a decision), decide the review row FIRST, then move the task through the shared
// task store with `reviewOverride`. A task already closed elsewhere is the uniform 409 (its trigger resolved the row).
// A restricted (Part 2) or missing row is the same byte-identical 404, for reads and for actions alike.
import type { DbClient } from "@wardenx/db";
import { REVIEW_LIST_DEFAULT, closeActionForReason } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import {
  NotFoundError,
  type ReviewItemDto,
  TASK_ACTIVE_STATUSES,
  TASK_CLOSE_REASONS,
  type TaskCloseReason,
  WardenXError,
} from "@wardenx/types";
import type { PatientLabelPort } from "../handoffs/handoff-dto";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { publishTaskEvent } from "../tasks/task-events";
import {
  TaskAssigneeAlreadyHasActive,
  TaskNotFound,
  type TaskRow,
  TaskStateConflict,
  type TaskStore,
} from "../tasks/task-store-db";
import { buildReviewDtos, visiblePatientIds } from "./review-dto";
import type { ReviewRow, ReviewStore } from "./review-store-db";

export interface ReviewActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface ReviewService {
  list(
    actor: ReviewActorRef,
    q: { state: "open" | "resolved" | "all"; limit: number },
  ): Promise<ReviewItemDto[]>;
  reassign(actor: ReviewActorRef, reviewItemId: string, toUserId: string): Promise<ReviewItemDto>;
  close(
    actor: ReviewActorRef,
    reviewItemId: string,
    reason: TaskCloseReason,
  ): Promise<ReviewItemDto>;
}

export interface ReviewServiceDeps {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort | undefined;
  readonly store: ReviewStore;
  readonly taskStore: TaskStore;
  /** Active user who can see the task's channel (Part 2 included). A throw is "not eligible". */
  /** Full eligibility (active + can view the channel, Part 2 included). Opens its own connections: call it OUTSIDE the decide tx. */
  readonly isEligible: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** The target is still an active member, read on the decide tx's OWN connection (no pool checkout while locks are held). */
  readonly isActiveInTx: (tx: Tx, orgId: string, userId: string) => Promise<boolean>;
  readonly part2Gate: Part2ChannelGate;
  readonly patientLabels: PatientLabelPort;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

const REVIEW_NAME_LIMIT = 200;

/** One refusal for missing / other tenant / restricted: names nothing. */
const notFound = (): NotFoundError => new NotFoundError("messaging_review_item");
const assigneeInvalid = (): WardenXError =>
  new WardenXError("REVIEW_ASSIGNEE_INVALID", "this person cannot be assigned the task", 422);
const stateConflict = (): WardenXError =>
  new WardenXError(
    "REVIEW_ITEM_STATE_CONFLICT",
    "review item is not in a state that allows this",
    409,
  );
const reasonInvalid = (): WardenXError =>
  new WardenXError("REVIEW_REASON_INVALID", "closing reason is not recognised", 422);

const isActiveStatus = (status: string): boolean =>
  (TASK_ACTIVE_STATUSES as readonly string[]).includes(status);

function mapError(err: unknown): never {
  if (err instanceof TaskAssigneeAlreadyHasActive) throw assigneeInvalid();
  if (err instanceof TaskNotFound || err instanceof TaskStateConflict) throw stateConflict();
  throw err;
}

type Decision =
  | { readonly kind: "reassign"; readonly toUserId: string }
  | { readonly kind: "close"; readonly reason: TaskCloseReason };

/** Is `row` already the outcome this very actor asked for? Then a repeat is a 200, not a conflict. */
function isReplay(row: ReviewRow, actor: ReviewActorRef, d: Decision): boolean {
  if (row.state !== "resolved" || row.resolvedByUserId !== actor.userId) return false;
  return d.kind === "reassign"
    ? row.resolution === "reassigned" && row.reassignedToUserId === d.toUserId
    : row.resolution === "closed" && row.resolutionReason === d.reason;
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { store, taskStore } = deps;
  const clock = deps.now ?? (() => new Date());

  const run = <R>(actor: ReviewActorRef, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, { organizationId: actor.orgId, userId: actor.userId }, (tx) =>
      fn(tx as unknown as Tx),
    ).catch(mapError);

  async function names(orgId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of [...new Set(ids)].slice(0, REVIEW_NAME_LIMIT)) {
      out.set(id, await deps.displayName(orgId, id).catch(() => null));
    }
    return out;
  }

  async function present(
    actor: ReviewActorRef,
    rows: readonly ReviewRow[],
  ): Promise<ReviewItemDto[]> {
    const tasks = await run(actor, (tx) =>
      store.tasksByIds(
        tx,
        actor.orgId,
        rows.map((r) => r.itemId),
      ),
    );
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const nameMap = await names(
      actor.orgId,
      [
        ...tasks.flatMap((t) => [t.assigneeId, t.createdBy]),
        ...rows.flatMap((r) => [r.reassignedToUserId, r.resolvedByUserId]),
      ].filter((id): id is string => id !== null),
    );
    return buildReviewDtos(
      deps,
      actor.orgId,
      actor.userId,
      rows,
      taskById,
      (id) => nameMap.get(id) ?? null,
    );
  }

  /** The row for a viewer who may see its patient; the uniform 404 for a missing, foreign or restricted one. */
  async function visibleRow(actor: ReviewActorRef, id: string): Promise<ReviewRow> {
    const row = await run(actor, (tx) => store.get(tx, actor.orgId, id));
    if (!row) throw notFound();
    const visible = await visiblePatientIds(deps.part2Gate, actor.orgId, actor.userId, [
      row.patientId,
    ]);
    if (!visible.has(row.patientId)) throw notFound();
    return row;
  }

  async function eligible(
    actor: ReviewActorRef,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    try {
      return await deps.isEligible(actor.orgId, userId, channelId);
    } catch {
      return false;
    }
  }

  /** Locks task then row; "replay" when this actor already made this very decision, else applies it. */
  async function decide(
    tx: Tx,
    actor: ReviewActorRef,
    id: string,
    taskId: string,
    channelId: string,
    d: Decision,
  ): Promise<"applied" | "replay" | "stale"> {
    const task = await taskStore.getForUpdate(tx, actor.orgId, taskId);
    const row = await store.getForUpdate(tx, actor.orgId, id);
    if (!row) throw notFound();
    if (isReplay(row, actor, d)) return "replay";
    if (row.state !== "open" || !task) throw stateConflict();
    if (!isActiveStatus(task.status)) {
      // The task closed after the row was queued and its trigger never saw the row (the queue/close race): clear the
      // stranded row so it does not sit open for ever, then report the conflict AFTER commit ("stale").
      await store.resolveClosedElsewhere(tx, {
        orgId: actor.orgId,
        id,
        reason: task.closedReason ?? null,
      });
      return "stale";
    }
    if (task.channelId !== channelId) throw assigneeInvalid();
    if (d.kind === "reassign") {
      // Full eligibility ran before this tx (it needs other connections, which must not be taken while row locks are held:
      // N concurrent reassigns would starve the pool). Here only what the tx's own connection can answer is rechecked.
      // Residual window (ADR-0065): a target who loses channel access between the two checks is still assigned.
      if (!(await deps.isActiveInTx(tx, actor.orgId, d.toUserId))) throw assigneeInvalid();
      const holders = await taskStore.activeAssigneeIds(tx, actor.orgId, task.messageId);
      if (task.assigneeId === d.toUserId || holders.includes(d.toUserId)) throw assigneeInvalid();
    }
    const resolved = await store.resolve(tx, {
      orgId: actor.orgId,
      id,
      resolution: d.kind === "reassign" ? "reassigned" : "closed",
      resolutionReason: d.kind === "close" ? d.reason : null,
      reassignedToUserId: d.kind === "reassign" ? d.toUserId : null,
      resolvedByUserId: actor.userId,
    });
    if (!resolved) throw stateConflict();
    await moveTask(tx, actor, task, d);
    return "applied";
  }

  async function moveTask(
    tx: Tx,
    actor: ReviewActorRef,
    task: TaskRow,
    d: Decision,
  ): Promise<void> {
    const at = clock();
    const base = {
      orgId: actor.orgId,
      taskId: task.id,
      actor: { kind: "user", userId: actor.userId } as const,
      reviewOverride: true,
    } as const;
    if (d.kind === "reassign") {
      await taskStore.transition(tx, {
        ...base,
        action: "reassign",
        toAssigneeId: d.toUserId,
        reassignReason: "review",
      });
      await publishTaskEvent(deps.outbox, tx, {
        kind: "reassigned",
        orgId: actor.orgId,
        taskId: task.id,
        channelId: task.channelId,
        fromUserId: task.assigneeId,
        toUserId: d.toUserId,
        source: "review",
        at,
      });
      return;
    }
    const action = closeActionForReason(d.reason);
    const result = await taskStore.transition(tx, { ...base, action, reason: d.reason });
    await publishTaskEvent(deps.outbox, tx, {
      kind: "statusChanged",
      orgId: actor.orgId,
      taskId: task.id,
      channelId: task.channelId,
      from: task.status as "open" | "accepted",
      to: result.task.status as "done" | "cancelled",
      at,
    });
  }

  async function act(actor: ReviewActorRef, id: string, d: Decision): Promise<ReviewItemDto> {
    const row = await visibleRow(actor, id);
    if (isReplay(row, actor, d)) return presentOne(actor, row);
    if (row.state !== "open") throw stateConflict();
    const [task] = await run(actor, (tx) => store.tasksByIds(tx, actor.orgId, [row.itemId]));
    if (!task) throw stateConflict();
    if (d.kind === "reassign") {
      if (d.toUserId === task.assigneeId) throw assigneeInvalid();
      if (!(await eligible(actor, d.toUserId, task.channelId))) throw assigneeInvalid();
    }
    const outcome = await run(actor, (tx) => decide(tx, actor, id, task.id, task.channelId, d));
    if (outcome === "stale") throw stateConflict();
    const after = await run(actor, (tx) => store.get(tx, actor.orgId, id));
    if (!after) throw notFound();
    return presentOne(actor, after);
  }

  async function presentOne(actor: ReviewActorRef, row: ReviewRow): Promise<ReviewItemDto> {
    const [dto] = await present(actor, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  return {
    async list(actor, q) {
      const rows = await run(actor, (tx) =>
        store.list(tx, actor.orgId, { state: q.state, limit: q.limit || REVIEW_LIST_DEFAULT }),
      );
      return present(actor, rows);
    },
    reassign: (actor, id, toUserId) => act(actor, id, { kind: "reassign", toUserId }),
    async close(actor, id, reason) {
      if (!(TASK_CLOSE_REASONS as readonly string[]).includes(reason)) throw reasonInvalid();
      return act(actor, id, { kind: "close", reason });
    },
  };
}
