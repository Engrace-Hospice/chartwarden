// apps/backend/src/modules/36-messaging/death-board/death-board-service.ts - WP 6.9 (ADR-0098): the death-event coordination board.
//
// Creation (the consumer, a system actor): one board per patient, the six template items, ONE owner each. The owner is the first
// eligible person of: the primary RN, the live care team (by user id), the people who last sat on the care-team channel. Eligible =
// an active messaging user whom the 42 CFR Part 2 gate admits for this patient. Nobody eligible => a supervisor alert and a THROW
// (relay retry, then DLQ): no board with an ownerless item is ever written, and a death is never silently unboarded.
//
// Reads and actions (a person): the board is visible only to the viewer who passes the Part 2 gate (FAIL CLOSED on a throw) AND is a
// supervisor (`messaging.review`), or owns / once owned / acted on an item of it, or is on the patient's live care team. Anything else
// is the SAME 404 a missing board gets. Complete is the owner's alone; reassign is the owner's or a supervisor's, onto an active,
// Part 2-admitted person. Both are idempotent. Offboarding reuses the WP 5.9 sweep: a leaver's open items move to the next eligible
// person or are flagged needs_owner and a supervisor is told (the owner column is never empty).
import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DEATH_BOARD_SCAN_MAX,
  DEATH_BOARD_TEMPLATE,
  DEATH_BOARD_TEMPLATE_VERSION,
  type DeathBoardDto,
  type DeathBoardEventDto,
  type DeathBoardItemDto,
  type DeathBoardItemKey,
  NotFoundError,
} from "@chartwarden/types";
import type { PatientLabelPort } from "../handoffs/handoff-dto";
import type { Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { type DeathBoardWarn, emitAssignedAlert, emitNeedsOwnerAlert } from "./death-board-alerts";
import type {
  DeathBoardEventRow,
  DeathBoardItemRow,
  DeathBoardRow,
  DeathBoardStore,
} from "./death-board-store";

export const OFFBOARDING_BATCH_SIZE = 100;
/** Stall sweep bounds per organization per tick (ADR-0098 D13): items read, pages of that read, and items flagged. */
export const STALL_SCAN_MAX = 2000;
export const STALL_SCAN_PAGE = 500;
export const STALL_FLAG_MAX = 200;
const NAME_LIMIT = 200;

export interface DeathBoardActor {
  readonly orgId: string;
  readonly userId: string;
  /** Holds `messaging.review` (the supervisor key). The route resolves it; the service never reads permissions. */
  readonly supervisor: boolean;
}

export interface DeathBoardDeps {
  readonly db: DbClient;
  readonly store: DeathBoardStore;
  readonly part2Gate: Part2ChannelGate;
  readonly patientLabels: PatientLabelPort;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
  /** CareTeamProvider seam. May throw: that step is then skipped. */
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  /** CareTeamProvider seam. May throw: that step is then skipped. */
  readonly primaryRn: (orgId: string, patientId: string) => Promise<string | null>;
  /** Everyone who sat on the patient's care-team channel, removed or not (the roster may already be closed at death). */
  readonly formerTeam: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly alerts: AlertEmitter;
  readonly warn?: DeathBoardWarn | undefined;
  readonly now?: () => Date;
}

export interface CreateBoardResult {
  readonly created: boolean;
  readonly boardId: string;
}

export interface LeaverSummary {
  readonly reassigned: number;
  readonly flaggedNeedsOwner: number;
}

export interface StallSummary {
  /** Open, unflagged items looked at this tick. */
  readonly examined: number;
  /** Items flagged needs_owner this tick (the owner column is never changed). */
  readonly flagged: number;
}

export interface DeathBoardService {
  createForDeath(orgId: string, patientId: string): Promise<CreateBoardResult>;
  list(actor: DeathBoardActor, limit: number): Promise<DeathBoardDto[]>;
  get(actor: DeathBoardActor, boardId: string): Promise<DeathBoardDto>;
  history(actor: DeathBoardActor, itemId: string): Promise<DeathBoardEventDto[]>;
  complete(actor: DeathBoardActor, itemId: string): Promise<DeathBoardItemDto>;
  reassign(actor: DeathBoardActor, itemId: string, toUserId: string): Promise<DeathBoardItemDto>;
  /** Offboarding (WP 5.9): move or flag every open item the leaver owns. Throws after the sweep if any item failed. */
  reassignForLeaver(orgId: string, leaverUserId: string): Promise<LeaverSummary>;
  /**
   * The periodic stall sweep (ADR-0098 D13), org-explicit (a tick is not a request): an open item whose owner is no longer an active user or no
   * longer admitted by the Part 2 gate for the patient is flagged needs_owner (owner untouched) and supervisors get the fixed-text alert.
   * Bounded, idempotent. A seam that cannot answer is NOT a verdict: that owner is skipped this tick. Throws after the sweep if any item failed.
   */
  flagStalledForOrg(orgId: string, opts?: { maxFlags?: number }): Promise<StallSummary>;
}

const notFound = (): NotFoundError => new NotFoundError("death_board");
const conflict = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_BOARD_ITEM_STATE_CONFLICT",
    "the item cannot change that way now",
    409,
  );
const notOwner = (): ChartWardenError =>
  new ChartWardenError("DEATH_BOARD_NOT_OWNER", "only the item's owner can do that", 403);
const ownerInvalid = (): ChartWardenError =>
  new ChartWardenError("DEATH_BOARD_OWNER_INVALID", "this person cannot own the item", 422);

/**
 * A flagged item cannot be "moved" to the person it already names (the database guard would raise), and a supervisor cannot hand an
 * item they do not own to themselves (they could then complete it, bypassing the owner; mirrors the S-10 self-approval control).
 */
function validNewOwner(
  actor: DeathBoardActor,
  item: Pick<DeathBoardItemRow, "ownerUserId" | "needsOwner">,
  toUserId: string,
): boolean {
  if (toUserId === item.ownerUserId) return !item.needsOwner;
  return !(actor.supervisor && toUserId === actor.userId);
}

const LABELS: ReadonlyMap<string, string> = new Map(
  DEATH_BOARD_TEMPLATE.map((t) => [t.key, t.label]),
);
const ORDER: ReadonlyMap<string, number> = new Map(DEATH_BOARD_TEMPLATE.map((t, i) => [t.key, i]));

const unique = (ids: readonly (string | null)[]): string[] => [
  ...new Set(ids.filter((id): id is string => !!id)),
];

export function createDeathBoardService(deps: DeathBoardDeps): DeathBoardService {
  const { store } = deps;
  const clock = deps.now ?? (() => new Date());

  const asSystem = <R>(orgId: string, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, systemOrgContext(orgId), (tx) => fn(tx as unknown as Tx));
  const asUser = <R>(actor: DeathBoardActor, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, { organizationId: actor.orgId, userId: actor.userId }, (tx) =>
      fn(tx as unknown as Tx),
    );

  async function settled<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch {
      return fallback; // a seam outage skips that step; the next one is tried
    }
  }

  /** Candidate owners in order, deduplicated. */
  async function candidates(orgId: string, patientId: string): Promise<string[]> {
    const rn = await settled(() => deps.primaryRn(orgId, patientId), null);
    const team = await settled(() => deps.careTeamMembers(orgId, patientId), []);
    const former = await settled(() => deps.formerTeam(orgId, patientId), []);
    return unique([rn, ...[...team].sort(), ...[...former].sort()]);
  }

  /** Active AND admitted by the Part 2 gate for this patient. The gate THROWS => nobody is admitted (fail closed). */
  async function eligible(
    orgId: string,
    patientId: string,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const active: string[] = [];
    for (const id of userIds) {
      if (await settled(() => deps.isActiveUser(orgId, id), false)) active.push(id);
    }
    if (active.length === 0) return new Set();
    return deps.part2Gate.allowedUserIds({ organizationId: orgId, patientId, userIds: active });
  }

  async function pickOwner(
    orgId: string,
    patientId: string,
    exclude: ReadonlySet<string>,
  ): Promise<string | null> {
    const ordered = (await candidates(orgId, patientId)).filter((id) => !exclude.has(id));
    const ok = await eligible(orgId, patientId, ordered);
    return ordered.find((id) => ok.has(id)) ?? null;
  }

  /** Per-request memo: the Part 2 verdict and the care team are read once per patient, however many boards name it. */
  interface ViewMemo {
    readonly admitted: Map<string, Promise<boolean>>;
    readonly team: Map<string, Promise<readonly string[]>>;
  }
  const newMemo = (): ViewMemo => ({ admitted: new Map(), team: new Map() });
  const memoised = <T>(
    m: Map<string, Promise<T>>,
    key: string,
    read: () => Promise<T>,
  ): Promise<T> => {
    const hit = m.get(key);
    if (hit) return hit;
    const next = read();
    m.set(key, next);
    return next;
  };

  /**
   * The Part 2 gate for the viewer, then supervisor / CURRENT owner of an item / live care team. A past owner has no standing
   * (ADR-0098 D7). `ownsItem` is supplied by the caller (in memory for a list, one query otherwise) and only asked when needed.
   */
  async function mayView(
    actor: DeathBoardActor,
    board: DeathBoardRow,
    memo: ViewMemo,
    ownsItem: () => Promise<boolean>,
  ): Promise<boolean> {
    const admitted = await memoised(memo.admitted, board.patientId, async () => {
      try {
        const ok = await deps.part2Gate.allowedUserIds({
          organizationId: actor.orgId,
          patientId: board.patientId,
          userIds: [actor.userId],
        });
        return ok.has(actor.userId);
      } catch {
        return false; // fail closed
      }
    });
    if (!admitted) return false;
    if (actor.supervisor) return true;
    if (await ownsItem()) return true;
    const team = await memoised(memo.team, board.patientId, () =>
      settled(() => deps.careTeamMembers(actor.orgId, board.patientId), []),
    );
    return team.includes(actor.userId);
  }

  const ownsViaStore = (actor: DeathBoardActor, boardId: string) => (): Promise<boolean> =>
    asUser(actor, (tx) => store.isInvolved(tx, actor.orgId, boardId, actor.userId));

  async function names(orgId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of unique(ids).slice(0, NAME_LIMIT)) {
      out.set(id, await deps.displayName(orgId, id).catch(() => null));
    }
    return out;
  }

  function itemDto(
    actor: DeathBoardActor,
    row: DeathBoardItemRow,
    nameOf: Map<string, string | null>,
  ): DeathBoardItemDto {
    const open = row.status === "open";
    const mine = row.ownerUserId === actor.userId;
    const actions: ("complete" | "reassign")[] = [];
    if (open && mine && !row.needsOwner) actions.push("complete");
    if (open && (mine || actor.supervisor)) actions.push("reassign");
    return {
      id: row.id,
      item_key: row.itemKey as DeathBoardItemKey,
      label: LABELS.get(row.itemKey) ?? row.itemKey,
      status: row.status as DeathBoardItemDto["status"],
      owner_user_id: row.ownerUserId,
      owner_display_name: nameOf.get(row.ownerUserId) ?? null,
      needs_owner: row.needsOwner,
      due_at: row.dueAt.toISOString(),
      overdue: open && row.dueAt.getTime() < clock().getTime(),
      completed_at: row.completedAt ? row.completedAt.toISOString() : null,
      completed_by_user_id: row.completedByUserId,
      actions,
    };
  }

  async function present(
    actor: DeathBoardActor,
    boards: readonly DeathBoardRow[],
    items: readonly DeathBoardItemRow[],
  ): Promise<DeathBoardDto[]> {
    if (boards.length === 0) return [];
    const labels = await deps
      .patientLabels(actor.orgId, unique(boards.map((b) => b.patientId)))
      .catch(() => new Map<string, { displayName: string; mrnSuffix: string | null }>());
    const nameOf = await names(
      actor.orgId,
      items.map((i) => i.ownerUserId),
    );
    return boards.map((b) => {
      const mine = items
        .filter((i) => i.boardId === b.id)
        .sort((x, y) => (ORDER.get(x.itemKey) ?? 99) - (ORDER.get(y.itemKey) ?? 99));
      const label = labels.get(b.patientId);
      return {
        id: b.id,
        patient_id: b.patientId,
        patient_display_name: label?.displayName ?? null,
        mrn_suffix: label?.mrnSuffix ?? null,
        created_at: b.createdAt.toISOString(),
        open_count: mine.filter((i) => i.status === "open").length,
        items: mine.map((i) => itemDto(actor, i, nameOf)),
      };
    });
  }

  /** Item + board + the access verdict, or the uniform 404. */
  async function itemForActor(
    actor: DeathBoardActor,
    itemId: string,
  ): Promise<{ item: DeathBoardItemRow; board: DeathBoardRow }> {
    const found = await asUser(actor, async (tx) => {
      const item = await store.getItem(tx, actor.orgId, itemId);
      const board = item ? await store.getBoard(tx, actor.orgId, item.boardId) : null;
      return item && board ? { item, board } : null;
    });
    if (
      !found ||
      !(await mayView(actor, found.board, newMemo(), ownsViaStore(actor, found.board.id)))
    ) {
      throw notFound();
    }
    return found;
  }

  async function alertOwners(
    orgId: string,
    boardId: string,
    owners: readonly string[],
  ): Promise<void> {
    for (const owner of unique(owners)) {
      await emitAssignedAlert(deps.alerts, orgId, owner, ["board", boardId]);
    }
  }

  return {
    flagStalledForOrg: (orgId, opts) => flagStalledForOrg(orgId, opts),

    async createForDeath(orgId, patientId) {
      const owner = await pickOwner(orgId, patientId, new Set());
      if (!owner) {
        await emitNeedsOwnerAlert(deps.alerts, orgId, ["board-unowned", patientId]).catch(() => 0);
        deps.warn?.("death board: no eligible owner", { org_id: orgId });
        throw new Error("death board: no eligible owner could be found for the patient");
      }
      const result = await asSystem(orgId, (tx) =>
        store.createBoard(tx, {
          orgId,
          patientId,
          templateVersion: DEATH_BOARD_TEMPLATE_VERSION,
          items: DEATH_BOARD_TEMPLATE.map((t) => ({
            key: t.key,
            ownerUserId: owner,
            dueMinutes: t.dueMinutes,
          })),
        }),
      );
      // Always (also on a replay): the correlation id dedupes, and a crash between commit and alert is healed by the retry.
      const owners = await asSystem(orgId, async (tx) =>
        (await store.itemsForBoards(tx, orgId, [result.boardId]))
          .filter((i) => i.status === "open")
          .map((i) => i.ownerUserId),
      );
      await alertOwners(orgId, result.boardId, owners);
      return result;
    },

    async list(actor, limit) {
      // Bounded: the DEATH_BOARD_SCAN_MAX newest boards, three queries in all. Older boards are invisible to non-supervisors.
      const recent = await asUser(actor, (tx) =>
        store.listBoards(tx, actor.orgId, DEATH_BOARD_SCAN_MAX),
      );
      if (recent.length === 0) return [];
      const items = await asUser(actor, (tx) =>
        store.itemsForBoards(
          tx,
          actor.orgId,
          recent.map((b) => b.id),
        ),
      );
      const memo = newMemo();
      const visible: DeathBoardRow[] = [];
      for (const board of recent) {
        if (visible.length >= limit) break;
        const owns = async (): Promise<boolean> =>
          items.some((i) => i.boardId === board.id && i.ownerUserId === actor.userId);
        if (await mayView(actor, board, memo, owns)) visible.push(board);
      }
      const ids = new Set(visible.map((b) => b.id));
      return present(
        actor,
        visible,
        items.filter((i) => ids.has(i.boardId)),
      );
    },

    async get(actor, boardId) {
      const board = await asUser(actor, (tx) => store.getBoard(tx, actor.orgId, boardId));
      if (!board || !(await mayView(actor, board, newMemo(), ownsViaStore(actor, board.id)))) {
        throw notFound();
      }
      const items = await asUser(actor, (tx) => store.itemsForBoards(tx, actor.orgId, [board.id]));
      const [dto] = await present(actor, [board], items);
      if (!dto) throw notFound();
      return dto;
    },

    async history(actor, itemId) {
      await itemForActor(actor, itemId);
      const rows: DeathBoardEventRow[] = await asUser(actor, (tx) =>
        store.eventsForItems(tx, actor.orgId, [itemId]),
      );
      return rows.map((e) => ({
        id: e.id,
        event_type: e.eventType as DeathBoardEventDto["event_type"],
        actor_kind: e.actorKind as "user" | "system",
        actor_user_id: e.actorUserId,
        from_owner_user_id: e.fromOwnerUserId,
        to_owner_user_id: e.toOwnerUserId,
        reason_code: e.reasonCode as DeathBoardEventDto["reason_code"],
        created_at: e.createdAt.toISOString(),
      }));
    },

    async complete(actor, itemId) {
      await itemForActor(actor, itemId);
      const row = await asUser(actor, async (tx) => {
        const item = await store.getItemForUpdate(tx, actor.orgId, itemId);
        if (!item) throw notFound();
        if (item.status === "done") {
          // Idempotent: the owner who completed it asking again is a 200; anyone else is not the owner.
          if (item.completedByUserId === actor.userId) return item;
          throw notOwner();
        }
        if (item.ownerUserId !== actor.userId) throw notOwner();
        if (item.needsOwner) throw conflict();
        const done = await store.complete(tx, {
          orgId: actor.orgId,
          itemId,
          userId: actor.userId,
        });
        if (!done) throw conflict();
        await store.addEvent(tx, {
          orgId: actor.orgId,
          itemId,
          eventType: "completed",
          actorUserId: actor.userId,
          fromOwnerUserId: actor.userId,
          toOwnerUserId: actor.userId,
          reasonCode: "manual",
        });
        return done;
      });
      return itemDto(actor, row, await names(actor.orgId, [row.ownerUserId]));
    },

    async reassign(actor, itemId, toUserId) {
      const { item: seen, board } = await itemForActor(actor, itemId);
      if (seen.ownerUserId !== actor.userId && !actor.supervisor) throw notOwner();
      if (seen.status !== "open") throw conflict();
      // Replay: already on the target. No event, no alert, no second write.
      if (seen.ownerUserId === toUserId && !seen.needsOwner) {
        return itemDto(actor, seen, await names(actor.orgId, [toUserId]));
      }
      if (!validNewOwner(actor, seen, toUserId)) throw ownerInvalid();
      if (!(await eligible(actor.orgId, board.patientId, [toUserId])).has(toUserId)) {
        throw ownerInvalid();
      }
      const row = await asUser(actor, async (tx) => {
        const item = await store.getItemForUpdate(tx, actor.orgId, itemId);
        if (!item) throw notFound();
        if (item.status !== "open") throw conflict();
        if (item.ownerUserId === toUserId && !item.needsOwner) return item;
        if (item.ownerUserId !== actor.userId && !actor.supervisor) throw notOwner();
        if (!validNewOwner(actor, item, toUserId)) throw ownerInvalid();
        const moved = await store.reassign(tx, {
          orgId: actor.orgId,
          itemId,
          fromUserId: item.ownerUserId,
          toUserId,
        });
        if (!moved) throw conflict();
        await store.addEvent(tx, {
          orgId: actor.orgId,
          itemId,
          eventType: "reassigned",
          actorUserId: actor.userId,
          fromOwnerUserId: item.ownerUserId,
          toOwnerUserId: toUserId,
          reasonCode: item.ownerUserId === actor.userId ? "manual" : "supervisor",
        });
        return moved;
      });
      if (row.ownerUserId === toUserId && toUserId !== actor.userId) {
        await emitAssignedAlert(deps.alerts, actor.orgId, toUserId, [
          "item",
          itemId,
          String(row.version),
        ]).catch((err: unknown) =>
          deps.warn?.("death board: assignment alert failed", {
            error_name: err instanceof Error ? err.name : "NonError",
          }),
        );
      }
      return itemDto(actor, row, await names(actor.orgId, [row.ownerUserId]));
    },

    async reassignForLeaver(orgId, leaverUserId) {
      const failed = new Set<string>();
      let reassigned = 0;
      let flagged = 0;
      for (;;) {
        const ids = await asSystem(orgId, (tx) =>
          store.leaverItemIds(tx, orgId, leaverUserId, OFFBOARDING_BATCH_SIZE, [...failed]),
        );
        if (ids.length === 0) break;
        for (const itemId of ids) {
          try {
            const outcome = await moveOne(orgId, leaverUserId, itemId);
            if (outcome === "reassigned") reassigned += 1;
            if (outcome === "flagged") flagged += 1;
          } catch (err) {
            failed.add(itemId);
            deps.warn?.("death board: offboarding reassignment failed", {
              item_id: itemId,
              error_name: err instanceof Error ? err.name : "NonError",
            });
          }
        }
      }
      if (failed.size > 0) {
        throw new Error(`death board offboarding failed for ${failed.size} item(s)`);
      }
      return { reassigned, flaggedNeedsOwner: flagged };
    },
  };

  /** Owners the seams positively say are not eligible. An unanswered seam leaves an owner out of the set (never flagged on an outage). */
  async function ineligibleOwners(
    orgId: string,
    patientId: string,
    owners: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    const active: string[] = [];
    for (const id of owners) {
      try {
        if (await deps.isActiveUser(orgId, id)) active.push(id);
        else out.add(id);
      } catch {
        // unknown: skip this owner this tick
      }
    }
    if (active.length === 0) return out;
    try {
      const admitted = await deps.part2Gate.allowedUserIds({
        organizationId: orgId,
        patientId,
        userIds: active,
      });
      for (const id of active) if (!admitted.has(id)) out.add(id);
    } catch {
      // the gate cannot answer: not a verdict
    }
    return out;
  }

  async function flagStalledOne(orgId: string, seen: DeathBoardItemRow): Promise<boolean> {
    // Alert FIRST (deduped on item + version): a failed alert leaves the item unflagged so the next tick retries; a flag without its alert
    // can never happen. The cost is a rare early alert when the item moved in between (ADR-0098 D13).
    await emitNeedsOwnerAlert(deps.alerts, orgId, ["item", seen.id, "stalled", String(seen.version)]);
    return asSystem(orgId, async (tx) => {
      const item = await store.getItemForUpdate(tx, orgId, seen.id);
      if (!item || item.status !== "open" || item.needsOwner || item.ownerUserId !== seen.ownerUserId) {
        return false;
      }
      if (!(await store.flagNeedsOwner(tx, { orgId, itemId: item.id }))) return false;
      await store.addEvent(tx, {
        orgId,
        itemId: item.id,
        eventType: "needs_owner",
        actorUserId: null,
        fromOwnerUserId: item.ownerUserId,
        toOwnerUserId: item.ownerUserId,
        reasonCode: "owner_ineligible",
      });
      return true;
    });
  }

  async function flagStalledForOrg(
    orgId: string,
    opts: { maxFlags?: number } = {},
  ): Promise<StallSummary> {
    const maxFlags = opts.maxFlags ?? STALL_FLAG_MAX;
    const scanned: DeathBoardItemRow[] = [];
    let after: string | null = null;
    let more = false;
    while (scanned.length < STALL_SCAN_MAX) {
      const cursor: string | null = after;
      const page: DeathBoardItemRow[] = await asSystem(orgId, (tx) =>
        store.openUnflaggedItems(tx, orgId, cursor, STALL_SCAN_PAGE),
      );
      scanned.push(...page);
      more = page.length === STALL_SCAN_PAGE;
      if (!more) break;
      after = page[page.length - 1]?.id ?? null;
    }
    if (more) deps.warn?.("death board: stall sweep scan truncated", { org_id: orgId });
    const byPatient = new Map<string, DeathBoardItemRow[]>();
    for (const item of scanned) byPatient.set(item.patientId, [...(byPatient.get(item.patientId) ?? []), item]);
    let flagged = 0;
    let failed = 0;
    for (const [patientId, items] of byPatient) {
      if (flagged >= maxFlags) break;
      const bad = await ineligibleOwners(orgId, patientId, unique(items.map((i) => i.ownerUserId)));
      for (const item of items) {
        if (flagged >= maxFlags) break;
        if (!bad.has(item.ownerUserId)) continue;
        try {
          if (await flagStalledOne(orgId, item)) flagged += 1;
        } catch (err) {
          failed += 1;
          deps.warn?.("death board: stall flag failed", {
            item_id: item.id,
            error_name: err instanceof Error ? err.name : "NonError",
          });
        }
      }
    }
    if (failed > 0) throw new Error(`death board stall sweep failed for ${failed} item(s)`);
    return { examined: scanned.length, flagged };
  }

  async function moveOne(
    orgId: string,
    leaverUserId: string,
    itemId: string,
  ): Promise<"reassigned" | "flagged" | "skipped"> {
    const seen = await asSystem(orgId, (tx) => store.getItem(tx, orgId, itemId));
    if (!seen || seen.ownerUserId !== leaverUserId || seen.status !== "open" || seen.needsOwner) {
      return "skipped";
    }
    // Chosen BEFORE the item is locked: seam and gate reads never run while a row lock is held.
    const successor = await pickOwner(orgId, seen.patientId, new Set([leaverUserId]));
    const outcome = await asSystem(orgId, async (tx) => {
      const item = await store.getItemForUpdate(tx, orgId, itemId);
      if (!item || item.ownerUserId !== leaverUserId || item.status !== "open" || item.needsOwner) {
        return "skipped" as const;
      }
      if (successor) {
        const moved = await store.reassign(tx, {
          orgId,
          itemId,
          fromUserId: leaverUserId,
          toUserId: successor,
        });
        if (!moved) return "skipped" as const;
        await store.addEvent(tx, {
          orgId,
          itemId,
          eventType: "reassigned",
          actorUserId: null,
          fromOwnerUserId: leaverUserId,
          toOwnerUserId: successor,
          reasonCode: "offboarding",
        });
        return "reassigned" as const;
      }
      if (!(await store.flagNeedsOwner(tx, { orgId, itemId }))) return "skipped" as const;
      await store.addEvent(tx, {
        orgId,
        itemId,
        eventType: "needs_owner",
        actorUserId: null,
        fromOwnerUserId: leaverUserId,
        toOwnerUserId: leaverUserId,
        reasonCode: "offboarding",
      });
      return "flagged" as const;
    });
    if (outcome === "reassigned" && successor) {
      await emitAssignedAlert(deps.alerts, orgId, successor, ["item", itemId, "offboarding"]);
    }
    if (outcome === "flagged") {
      await emitNeedsOwnerAlert(deps.alerts, orgId, ["item", itemId, "offboarding"]);
    }
    return outcome;
  }
}
