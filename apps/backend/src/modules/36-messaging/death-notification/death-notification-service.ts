// apps/backend/src/modules/36-messaging/death-notification/death-notification-service.ts - the death-notification cascade (builds on ADR-0098).
//   fanOutInternal   m36.death_board.opened -> one row + one fixed-text in-app notice per internal recipient kind. Idempotent: a replay
//                    (redelivery, or the second death event) finds the rows and sends nothing new.
//   ack              the recipient (or a supervisor) EXPLICITLY acknowledges. Never a read receipt.
//   sendFuneralHome  a staff member selects the funeral home; the notice goes out through the M2 funeral link ONLY when a BAA is on file for
//                    that entity (fail closed). Without one the row is blocked_no_baa, a supervisor is told, and the board item stays open.
//   flagUnackedForOrg the stall sweep: an internal notice unacknowledged past the threshold tells the supervisors (deduped, once per notice).
// HARD RULE: nothing here puts clinical content, an order or PHI in any message. Medication and equipment instructions never travel by message.
import { type DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DEATH_NOTIFICATION_EVENTS,
  DEATH_NOTIFICATION_INTERNAL_KINDS,
  DEATH_NOTIFICATION_STALL_MINUTES,
  type DeathNotificationDto,
  type DeathNotificationInternalKind,
  type DeathNotificationKind,
  NotFoundError,
} from "@chartwarden/types";
import type { DeathBoardActor } from "../death-board/death-board-service";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import {
  DEATH_NOTIFICATION_ROLE_KEYS,
  type DeathNotificationWarn,
  emitBlockedNoBaaAlert,
  emitInternalNotice,
  emitUnackedAlert,
} from "./death-notification-alerts";
import type { DeathNotificationRow, DeathNotificationStore } from "./death-notification-store";

export const STALL_FLAG_MAX = 200;
const AGGREGATE_KIND = "death_notification";
/** The ref of an internal kind that is not tied to one user (role-resolved, or no attending assigned). */
const UNASSIGNED_REF = "unassigned";

export interface FuneralLinkPort {
  /** Mint and deliver the M2 funeral-home link (72 h, fixed PHI-free email). Throws when it cannot. */
  issue(a: {
    orgId: string;
    patientId: string;
    actorUserId: string;
    recipientEmail: string;
  }): Promise<void>;
}

export interface DeathNotificationDeps {
  readonly db: DbClient;
  readonly store: DeathNotificationStore;
  readonly alerts: AlertEmitter;
  readonly outbox?: HintOutboxPort | undefined;
  /** The board's patient, or null when the board does not exist in this org. */
  readonly boardPatient: (orgId: string, boardId: string) => Promise<string | null>;
  /** The viewer-visibility check of the board service (Part 2 gate included). Throws NotFoundError when the viewer may not see the board. */
  readonly viewBoard: (actor: DeathBoardActor, boardId: string) => Promise<{ patient_id: string }>;
  /** CareTeamProvider seam. May throw: the attending is then treated as unassigned. */
  readonly attendingUserId: (orgId: string, patientId: string) => Promise<string | null>;
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
  /** The role keys the user holds (null when none can be read). */
  readonly roleKeysForUser: (orgId: string, userId: string) => Promise<readonly string[] | null>;
  /** BAA on file for the entity as of now. Throws read as NOT active. */
  readonly isBaaActive: (orgId: string, kind: "funeral_home", entityId: string, asOf: Date) => Promise<boolean>;
  readonly funeralLinks?: FuneralLinkPort | undefined;
  /** The `messaging.death_notifications` tenant flag. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly warn?: DeathNotificationWarn | undefined;
  readonly now?: () => Date;
}

export interface DeathNotificationService {
  fanOutInternal(orgId: string, boardId: string, openedEventId: string): Promise<{ notified: number }>;
  list(actor: DeathBoardActor, boardId: string): Promise<DeathNotificationDto[]>;
  ack(actor: DeathBoardActor, notificationId: string): Promise<DeathNotificationDto>;
  sendFuneralHome(
    actor: DeathBoardActor,
    boardId: string,
    input: { funeralHomeEntityId: string; recipientEmail: string },
  ): Promise<DeathNotificationDto>;
  flagUnackedForOrg(orgId: string): Promise<{ examined: number; alerted: number }>;
}

const notFound = (): NotFoundError => new NotFoundError("death_notification");
const notRecipient = (): ChartWardenError =>
  new ChartWardenError("DEATH_NOTIFICATION_NOT_RECIPIENT", "this notice is not addressed to you", 403);
const notAckable = (): ChartWardenError =>
  new ChartWardenError("DEATH_NOTIFICATION_STATE_CONFLICT", "the notice cannot be acknowledged now", 409);
const linkUnavailable = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_LINK_UNAVAILABLE",
    "the funeral-home link channel is not available; nothing was sent",
    503,
  );
const linkFailed = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_LINK_FAILED",
    "the funeral-home notice could not be delivered; try again",
    503,
  );

const isInternal = (kind: string): kind is DeathNotificationInternalKind =>
  (DEATH_NOTIFICATION_INTERNAL_KINDS as readonly string[]).includes(kind);

export function createDeathNotificationService(deps: DeathNotificationDeps): DeathNotificationService {
  const { store } = deps;
  const clock = deps.now ?? (() => new Date());

  const asSystem = <R>(orgId: string, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, systemOrgContext(orgId), (tx) => fn(tx as unknown as Tx));
  const asUser = <R>(actor: DeathBoardActor, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(deps.db, { organizationId: actor.orgId, userId: actor.userId }, (tx) =>
      fn(tx as unknown as Tx),
    );

  const publish = (
    tx: Tx,
    eventName: string,
    row: DeathNotificationRow,
    extra: Record<string, unknown> = {},
  ) =>
    deps.outbox?.publish(tx, {
      eventName,
      organizationId: row.organizationId,
      aggregateKind: AGGREGATE_KIND,
      aggregateId: row.id,
      payload: {
        organizationId: row.organizationId,
        notificationId: row.id,
        boardId: row.boardId,
        recipientKind: row.recipientKind,
        ...extra,
        at: clock().toISOString(),
      },
    });

  async function canAck(actor: DeathBoardActor, row: DeathNotificationRow): Promise<boolean> {
    if (!isInternal(row.recipientKind) || row.state === "acked") return false;
    if (actor.supervisor) return true;
    if (row.recipientKind === "attending") return row.recipientRef === actor.userId;
    const wanted = DEATH_NOTIFICATION_ROLE_KEYS[row.recipientKind];
    const held = await deps.roleKeysForUser(actor.orgId, actor.userId).catch(() => null);
    return !!held && held.some((k) => wanted.includes(k));
  }

  const toDto = (row: DeathNotificationRow, ackable: boolean): DeathNotificationDto => ({
    id: row.id,
    board_id: row.boardId,
    recipient_kind: row.recipientKind as DeathNotificationKind,
    state: row.state as DeathNotificationDto["state"],
    created_at: row.createdAt.toISOString(),
    acked_at: row.ackedAt ? row.ackedAt.toISOString() : null,
    acked_by: row.ackedBy,
    can_ack: ackable,
  });

  async function notifyInternal(
    orgId: string,
    boardId: string,
    patientId: string,
    kind: DeathNotificationInternalKind,
    ref: string,
    openedEventId: string,
  ): Promise<boolean> {
    const { row } = await asSystem(orgId, (tx) =>
      store.ensure(tx, { orgId, boardId, patientId, kind, ref }),
    );
    if (row.state !== "pending") return false; // a replay: already sent (or acked)
    await emitInternalNotice(
      deps.alerts,
      orgId,
      { kind, notificationId: row.id, recipientUserId: kind === "attending" && ref !== UNASSIGNED_REF ? ref : undefined },
      deps.warn,
    );
    await asSystem(orgId, async (tx) => {
      const sent = await store.transition(tx, { orgId, id: row.id, to: "sent", sentOutboxEventId: openedEventId });
      if (sent) await publish(tx, DEATH_NOTIFICATION_EVENTS.sent, sent);
    });
    return true;
  }

  async function resolveAttending(orgId: string, patientId: string): Promise<string> {
    const id = await deps.attendingUserId(orgId, patientId).catch(() => null);
    if (!id) return UNASSIGNED_REF;
    return (await deps.isActiveUser(orgId, id).catch(() => false)) ? id : UNASSIGNED_REF;
  }

  return {
    async fanOutInternal(orgId, boardId, openedEventId) {
      if (!(await deps.isEnabled(orgId).catch(() => false))) return { notified: 0 };
      const patientId = await deps.boardPatient(orgId, boardId);
      if (!patientId) throw new Error("death notification: the board does not exist");
      const attending = await resolveAttending(orgId, patientId);
      const targets: ReadonlyArray<readonly [DeathNotificationInternalKind, string]> =
        DEATH_NOTIFICATION_INTERNAL_KINDS.map((k) => [k, k === "attending" ? attending : UNASSIGNED_REF] as const);
      let notified = 0;
      const failures: unknown[] = [];
      for (const [kind, ref] of targets) {
        try {
          if (await notifyInternal(orgId, boardId, patientId, kind, ref, openedEventId)) notified += 1;
        } catch (err) {
          failures.push(err);
          deps.warn?.("death notification: a recipient could not be notified", { org_id: orgId, kind });
        }
      }
      if (failures.length > 0) throw new Error(`death notification: ${failures.length} recipient(s) failed; retrying`);
      return { notified };
    },

    async list(actor, boardId) {
      await deps.viewBoard(actor, boardId);
      const rows = await asUser(actor, (tx) => store.listForBoard(tx, actor.orgId, boardId));
      return Promise.all(rows.map(async (r) => toDto(r, await canAck(actor, r))));
    },

    async ack(actor, notificationId) {
      const row = await asUser(actor, (tx) => store.get(tx, actor.orgId, notificationId));
      if (!row) throw notFound();
      await deps.viewBoard(actor, row.boardId); // a Part 2-refused or foreign viewer gets the board's own 404
      if (!isInternal(row.recipientKind)) throw notAckable();
      if (row.state === "acked") {
        if (row.ackedBy === actor.userId) return toDto(row, false); // idempotent for the person who acknowledged
        throw notRecipient();
      }
      if (!(await canAck(actor, row))) throw notRecipient();
      const acked = await asUser(actor, async (tx) => {
        const done = await store.ack(tx, { orgId: actor.orgId, id: row.id, userId: actor.userId });
        if (!done) return null;
        await publish(tx, DEATH_NOTIFICATION_EVENTS.acked, done, { ackedBy: actor.userId });
        return done;
      });
      if (!acked) throw notAckable();
      return toDto(acked, false);
    },

    async sendFuneralHome(actor, boardId, input) {
      const board = await deps.viewBoard(actor, boardId);
      if (!deps.funeralLinks) throw linkUnavailable();
      const { row } = await asUser(actor, (tx) =>
        store.ensure(tx, {
          orgId: actor.orgId,
          boardId,
          patientId: board.patient_id,
          kind: "funeral_home",
          ref: input.funeralHomeEntityId,
        }),
      );
      if (row.state === "sent" || row.state === "acked") return toDto(row, false); // idempotent: never a second disclosure
      const baa = await deps
        .isBaaActive(actor.orgId, "funeral_home", input.funeralHomeEntityId, clock())
        .catch(() => false);
      if (!baa) {
        const blocked = await asUser(actor, async (tx) => {
          const moved =
            row.state === "blocked_no_baa"
              ? row
              : await store.transition(tx, { orgId: actor.orgId, id: row.id, to: "blocked_no_baa" });
          if (moved && row.state !== "blocked_no_baa") await publish(tx, DEATH_NOTIFICATION_EVENTS.blocked, moved);
          return moved ?? row;
        });
        await emitBlockedNoBaaAlert(deps.alerts, actor.orgId, row.id).catch(() => 0);
        return toDto(blocked, false);
      }
      try {
        await deps.funeralLinks.issue({
          orgId: actor.orgId,
          patientId: board.patient_id,
          actorUserId: actor.userId,
          recipientEmail: input.recipientEmail,
        });
      } catch {
        await asUser(actor, (tx) => store.transition(tx, { orgId: actor.orgId, id: row.id, to: "failed" }));
        throw linkFailed();
      }
      const sent = await asUser(actor, async (tx) => {
        const moved = await store.transition(tx, { orgId: actor.orgId, id: row.id, to: "sent" });
        if (moved) await publish(tx, DEATH_NOTIFICATION_EVENTS.sent, moved);
        return moved ?? row;
      });
      return toDto(sent, false);
    },

    async flagUnackedForOrg(orgId) {
      if (!(await deps.isEnabled(orgId).catch(() => false))) return { examined: 0, alerted: 0 };
      const stale = await asSystem(orgId, (tx) =>
        store.staleUnacked(tx, orgId, DEATH_NOTIFICATION_STALL_MINUTES, STALL_FLAG_MAX),
      );
      let alerted = 0;
      for (const row of stale) {
        // The correlation id dedupes: a notice is escalated once however many ticks see it.
        const n = await emitUnackedAlert(deps.alerts, orgId, row.id).catch(() => 0);
        if (n > 0) alerted += 1;
      }
      return { examined: stale.length, alerted };
    },
  };
}
