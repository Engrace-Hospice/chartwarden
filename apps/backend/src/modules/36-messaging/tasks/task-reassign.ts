// apps/backend/src/modules/36-messaging/tasks/task-reassign.ts - WP 3.4: offboarding never leaves a task ownerless.
//
// Called from the access-revocation consumer on `m2.membership.revoked` / `m2.user.deactivated` (not `suspended`:
// reinstatable). A relay tick is not a request, so this is org-explicit and runs under the system actor. For each ACTIVE
// task assigned to the leaver the successor is, in order: the task's creator, then (patient task) the first eligible
// care-team member by user id. Eligible = not the leaver, active and able to view the channel, holding no active task on
// the message. No successor => the task keeps the leaver, is flagged `needs_owner`, and the creator is told by the
// `m36.task.needs_owner` event. Converges on redelivery: a reassigned or flagged task no longer matches. Revocation never
// depends on the `messaging.tasks` flag. Per-task failures are isolated, counted, and rethrown at the end so the
// dispatcher retries; the error text carries no seam message.
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { HintOutboxPort } from "../message-hint-events";
import { publishTaskEvent } from "./task-events";
import type { TaskRow, TaskStore } from "./task-store-db";
import { createDbTaskStore } from "./task-store-db";

export const OFFBOARDING_BATCH_SIZE = 100;

export interface ReassignDeps {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort | undefined;
  /** Active user who can view the channel (the same rule as assignment). */
  readonly isEligible: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Care-team user ids for a patient (CareTeamProvider seam). May throw: step 2 is then skipped. */
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly now?: () => Date;
  readonly store?: TaskStore;
}

export interface ReassignSummary {
  readonly reassigned: number;
  readonly flaggedNeedsOwner: number;
  readonly failed: number;
}

type Outcome = "reassigned" | "flagged" | "skipped";

async function careTeamCandidates(
  deps: ReassignDeps,
  orgId: string,
  task: TaskRow,
): Promise<string[]> {
  if (!task.patientId) return [];
  try {
    return [...(await deps.careTeamMembers(orgId, task.patientId))].sort();
  } catch {
    // A seam outage must not fail the whole job or strand the task: fall through to the needs_owner flag.
    return [];
  }
}

async function pickSuccessor(
  deps: ReassignDeps,
  orgId: string,
  task: TaskRow,
  holders: ReadonlySet<string>,
): Promise<string | null> {
  const careTeam = await careTeamCandidates(deps, orgId, task);
  const candidates = [task.createdBy, ...careTeam].filter(
    (id, i, all) => id !== task.assigneeId && !holders.has(id) && all.indexOf(id) === i,
  );
  for (const userId of candidates) {
    if (await deps.isEligible(orgId, userId, task.channelId)) return userId;
  }
  return null;
}

async function reassignOne(
  deps: ReassignDeps,
  store: TaskStore,
  orgId: string,
  leaverUserId: string,
  taskId: string,
): Promise<Outcome> {
  const clock = deps.now ?? (() => new Date());
  return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
    const task = await store.getForUpdate(tx, orgId, taskId);
    const stillTheirs =
      task &&
      task.assigneeId === leaverUserId &&
      (task.status === "open" || task.status === "accepted") &&
      !task.needsOwner;
    if (!task || !stillTheirs) return "skipped";
    const holders = new Set(await store.activeAssigneeIds(tx, orgId, task.messageId));
    const successor = await pickSuccessor(deps, orgId, task, holders);
    if (successor) {
      await store.transition(tx, {
        orgId,
        taskId,
        actor: { kind: "system" },
        action: "reassign",
        toAssigneeId: successor,
      });
      await publishTaskEvent(deps.outbox, tx, {
        kind: "reassigned",
        orgId,
        taskId,
        channelId: task.channelId,
        fromUserId: leaverUserId,
        toUserId: successor,
        source: "offboarding",
        at: clock(),
      });
      return "reassigned";
    }
    await store.flagNeedsOwner(tx, { orgId, taskId });
    await publishTaskEvent(deps.outbox, tx, {
      kind: "needsOwner",
      orgId,
      taskId,
      channelId: task.channelId,
      creatorUserId: task.createdBy,
      at: clock(),
    });
    return "flagged";
  });
}

export async function reassignTasksForLeaver(
  deps: ReassignDeps,
  orgId: string,
  leaverUserId: string,
): Promise<ReassignSummary> {
  const store = deps.store ?? createDbTaskStore(deps.db);
  const failedIds = new Set<string>();
  let reassigned = 0;
  let flaggedNeedsOwner = 0;
  for (;;) {
    const ids = await store.leaverTaskIds(orgId, leaverUserId, OFFBOARDING_BATCH_SIZE, [
      ...failedIds,
    ]);
    if (ids.length === 0) break;
    for (const taskId of ids) {
      try {
        const outcome = await reassignOne(deps, store, orgId, leaverUserId, taskId);
        if (outcome === "reassigned") reassigned += 1;
        if (outcome === "flagged") flaggedNeedsOwner += 1;
      } catch {
        failedIds.add(taskId);
      }
    }
  }
  if (failedIds.size > 0) {
    throw new Error(`offboarding task reassignment failed for ${failedIds.size} task(s)`);
  }
  return { reassigned, flaggedNeedsOwner, failed: 0 };
}
