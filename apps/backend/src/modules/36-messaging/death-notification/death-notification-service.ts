// apps/backend/src/modules/36-messaging/death-notification/death-notification-service.ts - the death-notification cascade (builds on ADR-0098).
//   fanOutInternal   m36.death_board.opened -> one row + one fixed-text in-app notice per internal recipient kind. Idempotent: a replay
//                    (redelivery, or the second death event) finds the rows and sends nothing new.
//   ack              the recipient (or a supervisor) EXPLICITLY acknowledges. Never a read receipt.
//   sendFuneralHome  a staff member selects the funeral home; the notice goes out through the M2 funeral link ONLY when a BAA is on file for
//                    that entity (fail closed). Without one the row is blocked_no_baa, a supervisor is told, and the board item stays open.
//   flagUnackedForOrg the stall sweep: an internal notice unacknowledged past the threshold tells the supervisors (deduped, once per notice).
// HARD RULE: nothing here puts clinical content, an order or PHI in any message. Medication and equipment instructions never travel by message.
import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DEATH_NOTIFICATION_EVENTS,
  DEATH_NOTIFICATION_INTERNAL_KINDS,
  DEATH_NOTIFICATION_SENDING_TIMEOUT_MINUTES,
  DEATH_NOTIFICATION_STALL_MINUTES,
  type DeathNotificationDto,
  type DeathNotificationInternalKind,
  type DeathNotificationKind,
  type DeathNotificationSendOutcome,
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
  emitStrandedSendAlert,
  emitUnackedAlert,
} from "./death-notification-alerts";
import type { DeathNotificationRow, DeathNotificationStore } from "./death-notification-store";

export const STALL_FLAG_MAX = 200;
const AGGREGATE_KIND = "death_notification";
/** The ref of an internal kind that is not tied to one user (role-resolved, or no attending assigned). */
const UNASSIGNED_REF = "unassigned";

export type FuneralRefusalReason =
  | "unknown_funeral_home"
  | "no_baa"
  /** The home was already notified at a different address; this address was NOT sent to. */
  | "recipient_changed"
  /** The actor is not on the decedent's caseload (the route's ABAC refused before any send). */
  | "caseload_denied";

/** Adapter failure classification: only a confirmed revocation makes the notification safely retryable. */
export class FuneralLinkIssueError extends Error {
  constructor(
    message: string,
    readonly revocationConfirmed: boolean,
    readonly reason: "no_baa" | "other" = "other",
  ) {
    super(message);
    this.name = "FuneralLinkIssueError";
  }
}

export interface FuneralLinkPort {
  /**
   * Mint and deliver the M2 funeral-home link (72 h, fixed PHI-free email), recording the same M2 audit event and `m2.funeral.invited` as
   * `POST /funeral/invite`. Throws when it cannot (a minted link is then revoked). Returns the link id; the token never leaves the adapter.
   */
  issue(a: {
    orgId: string;
    patientId: string;
    actorUserId: string;
    recipientEmail: string;
    funeralHomeEntityId: string;
    disclosureAttemptId: string;
    correlationId?: string | undefined;
    /** Pin/renew the credential fence before delivery. False means reconciliation owns the row. */
    pinLink(linkId: string): Promise<boolean>;
  }): Promise<{ linkId: string }>;
  /** Audit a refused or blocked disclosure (nothing left the perimeter). Ids only. */
  refused(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    funeralHomeEntityId: string;
    reason: FuneralRefusalReason;
    correlationId?: string | undefined;
  }): Promise<void>;
  /**
   * Stale-send reconcile: revoke only the link minted for this disclosure attempt (plus its pinned id), so a delivered-but-unrecorded send leaves
   * no live credential without touching a separate direct invite. Returns how many were revoked. Throws on failure.
   */
  revokeOrphans(a: {
    orgId: string;
    disclosureAttemptId: string;
    linkId: string | null;
  }): Promise<number>;
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
  readonly isBaaActive: (
    orgId: string,
    kind: "funeral_home",
    entityId: string,
    asOf: Date,
  ) => Promise<boolean>;
  /** True when the MDM register holds a funeral_home record (any BAA status) for this id in this org. A throw reads as unknown. */
  readonly isKnownFuneralHome: (orgId: string, entityId: string) => Promise<boolean>;
  readonly funeralLinks?: FuneralLinkPort | undefined;
  /**
   * Keyed digest (HMAC-SHA256 under a server-side per-tenant key) of the NORMALISED recipient address, hex. The address itself is never stored.
   * A throw refuses the send BEFORE any link is minted.
   */
  readonly recipientHash: (orgId: string, normalizedEmail: string) => Promise<string>;
  /** The `messaging.death_notifications` tenant flag. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly warn?: DeathNotificationWarn | undefined;
  readonly now?: () => Date;
}

export interface DeathNotificationService {
  fanOutInternal(
    orgId: string,
    boardId: string,
    openedEventId: string,
  ): Promise<{ notified: number }>;
  list(
    actor: DeathBoardActor,
    boardId: string,
  ): Promise<{ patient_id: string; notifications: DeathNotificationDto[] }>;
  ack(actor: DeathBoardActor, notificationId: string): Promise<DeathNotificationDto>;
  /** The board's patient for a viewer who may see the board (the caseload check of the funeral-home send needs it). Throws NotFoundError otherwise. */
  patientOf(actor: DeathBoardActor, boardId: string): Promise<string>;
  sendFuneralHome(
    actor: DeathBoardActor,
    boardId: string,
    input: {
      funeralHomeEntityId: string;
      recipientEmail: string;
      correlationId?: string | undefined;
    },
  ): Promise<FuneralHomeSendResult>;
  /** Audit a caseload refusal of a funeral-home send (the route's ABAC denied; nothing was sent). Never throws. */
  auditCaseloadDenied(
    actor: DeathBoardActor,
    a: { patientId: string; funeralHomeEntityId: string; correlationId?: string | undefined },
  ): Promise<void>;
  flagUnackedForOrg(orgId: string): Promise<{ examined: number; alerted: number }>;
  /** The stall tick's second half: reconcile funeral-home sends stranded in `sending`, free them for a re-send and tell the supervisors. */
  reconcileStrandedSendsForOrg(orgId: string): Promise<{ examined: number; reconciled: number }>;
}

/** `outcome` is present ONLY when nothing was sent now; absent keeps the original response shape. */
export interface FuneralHomeSendResult {
  readonly notification: DeathNotificationDto;
  readonly outcome?: DeathNotificationSendOutcome;
}

const notFound = (): NotFoundError => new NotFoundError("death_notification");
const notRecipient = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_NOT_RECIPIENT",
    "this notice is not addressed to you",
    403,
  );
const notAckable = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_STATE_CONFLICT",
    "the notice cannot be acknowledged now",
    409,
  );
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

const unknownFuneralHome = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_FUNERAL_HOME_UNKNOWN",
    "no such funeral home is registered for this organization; nothing was sent",
    404,
  );
const sendUnconfirmed = (): ChartWardenError =>
  new ChartWardenError(
    "DEATH_NOTIFICATION_SEND_UNCONFIRMED",
    "the funeral-home notice was delivered but could not be recorded; do not send it again, contact an administrator",
    503,
  );

/**
 * Trim and lowercase, nothing more. A `+tag` is NOT stripped: on many providers `a+x@` and `a@` are the same mailbox, but on others they are
 * different people, and a missed "recipient changed" (the unsafe direction) is worse than a spurious one.
 */
export const normalizeRecipientEmail = (email: string): string => email.trim().toLowerCase();

const isInternal = (kind: string): kind is DeathNotificationInternalKind =>
  (DEATH_NOTIFICATION_INTERNAL_KINDS as readonly string[]).includes(kind);

export function createDeathNotificationService(
  deps: DeathNotificationDeps,
): DeathNotificationService {
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
      {
        kind,
        notificationId: row.id,
        recipientUserId: kind === "attending" && ref !== UNASSIGNED_REF ? ref : undefined,
      },
      deps.warn,
    );
    await asSystem(orgId, async (tx) => {
      const sent = await store.transition(tx, {
        orgId,
        id: row.id,
        to: "sent",
        sentOutboxEventId: openedEventId,
      });
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
        DEATH_NOTIFICATION_INTERNAL_KINDS.map(
          (k) => [k, k === "attending" ? attending : UNASSIGNED_REF] as const,
        );
      let notified = 0;
      const failures: unknown[] = [];
      for (const [kind, ref] of targets) {
        try {
          if (await notifyInternal(orgId, boardId, patientId, kind, ref, openedEventId))
            notified += 1;
        } catch (err) {
          failures.push(err);
          deps.warn?.("death notification: a recipient could not be notified", {
            org_id: orgId,
            kind,
          });
        }
      }
      if (failures.length > 0)
        throw new Error(`death notification: ${failures.length} recipient(s) failed; retrying`);
      return { notified };
    },

    async list(actor, boardId) {
      const board = await deps.viewBoard(actor, boardId);
      const rows = await asUser(actor, (tx) => store.listForBoard(tx, actor.orgId, boardId));
      return {
        patient_id: board.patient_id,
        notifications: await Promise.all(rows.map(async (r) => toDto(r, await canAck(actor, r)))),
      };
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

    async patientOf(actor, boardId) {
      return (await deps.viewBoard(actor, boardId)).patient_id;
    },

    async sendFuneralHome(actor, boardId, input) {
      const board = await deps.viewBoard(actor, boardId);
      const links = deps.funeralLinks;
      if (!links) throw linkUnavailable();
      // Lower-cased once: the DB insert guard compares funeral_home_entity_id::text (always lowercase) with recipient_ref, so an uppercase id would 500.
      const entityId = input.funeralHomeEntityId.toLowerCase();
      const disclosure = {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        patientId: board.patient_id,
        funeralHomeEntityId: entityId,
        correlationId: input.correlationId,
      };
      const auditRefusal = (reason: FuneralRefusalReason) =>
        links.refused({ ...disclosure, reason }).catch(() => {
          deps.warn?.("death notification: a refused disclosure could not be audited", {
            org_id: actor.orgId,
            board_id: boardId,
            reason,
          });
        });

      // Validate BEFORE any row exists: a junk id must create nothing.
      if (!(await deps.isKnownFuneralHome(actor.orgId, entityId).catch(() => false))) {
        await auditRefusal("unknown_funeral_home");
        throw unknownFuneralHome();
      }
      const recipientHash = await deps
        .recipientHash(actor.orgId, normalizeRecipientEmail(input.recipientEmail))
        .catch(() => null);
      if (!recipientHash) throw linkUnavailable(); // no key, no send: nothing is minted without a joinable recipient digest
      const { row } = await asUser(actor, (tx) =>
        store.ensure(tx, {
          orgId: actor.orgId,
          boardId,
          patientId: board.patient_id,
          kind: "funeral_home",
          ref: entityId,
          funeralHomeEntityId: entityId,
        }),
      );
      // idempotent: never a second disclosure. A `sending` row is in flight (or delivered-but-unrecorded; the stall tick frees it).
      if (["sending", "reconciling"].includes(row.state))
        return { notification: toDto(row, false), outcome: "in_flight" };
      if (row.state === "sent" || row.state === "acked") {
        if (row.recipientEmailHash && row.recipientEmailHash !== recipientHash) {
          // Already notified at ANOTHER address: say so instead of answering as if this address were notified; the attempt is audited.
          await auditRefusal("recipient_changed");
          return { notification: toDto(row, false), outcome: "recipient_changed_not_sent" };
        }
        return { notification: toDto(row, false) };
      }
      const baa = await deps
        .isBaaActive(actor.orgId, "funeral_home", entityId, clock())
        .catch(() => false);
      if (!baa) {
        const blocked = await asUser(actor, async (tx) => {
          const moved =
            row.state === "blocked_no_baa"
              ? row
              : await store.transition(tx, {
                  orgId: actor.orgId,
                  id: row.id,
                  to: "blocked_no_baa",
                });
          if (moved && row.state !== "blocked_no_baa")
            await publish(tx, DEATH_NOTIFICATION_EVENTS.blocked, moved);
          return moved ?? row;
        });
        await auditRefusal("no_baa");
        await emitBlockedNoBaaAlert(deps.alerts, actor.orgId, boardId).catch(() => 0);
        return { notification: toDto(blocked, false) };
      }

      // The atomic claim: of any number of concurrent sends exactly one wins and may mint a link.
      const claimed = await asUser(actor, (tx) =>
        store.claim(tx, { orgId: actor.orgId, id: row.id }),
      );
      if (!claimed) {
        const current = await asUser(actor, (tx) => store.get(tx, actor.orgId, row.id));
        const lost = current ?? row;
        return {
          notification: toDto(lost, false),
          ...(["sending", "reconciling"].includes(lost.state)
            ? { outcome: "in_flight" as const }
            : {}),
        };
      }
      let linkId: string;
      const attemptId = claimed.sendAttemptId;
      if (!attemptId) throw new Error("claimed death notification has no send attempt id");
      try {
        ({ linkId } = await links.issue({
          ...disclosure,
          disclosureAttemptId: attemptId,
          recipientEmail: input.recipientEmail,
          pinLink: (candidateLinkId) =>
            asUser(actor, (tx) =>
              store.recordLink(tx, {
                orgId: actor.orgId,
                id: row.id,
                attemptId,
                linkId: candidateLinkId,
              }),
            ).then((pinned) => pinned !== null),
        }));
      } catch (err) {
        // A failed settle must not mask the typed refusal: the row then stays `sending` and the stall tick reconciles it.
        if (err instanceof FuneralLinkIssueError && err.revocationConfirmed) {
          const settled = await asUser(actor, async (tx) => {
            const moved = await store.settle(tx, {
              orgId: actor.orgId,
              id: row.id,
              attemptId,
              to: err.reason === "no_baa" ? "blocked_no_baa" : "failed",
            });
            if (moved && err.reason === "no_baa")
              await publish(tx, DEATH_NOTIFICATION_EVENTS.blocked, moved);
            return moved;
          }).catch((settleErr: unknown) => {
            deps.warn?.(
              "death notification: a failed send could not be settled; the stall tick will reconcile it",
              {
                org_id: actor.orgId,
                board_id: boardId,
                notification_id: row.id,
                error: settleErr instanceof Error ? settleErr.name : "unknown",
              },
            );
            return null;
          });
          if (err.reason === "no_baa" && settled) {
            await emitBlockedNoBaaAlert(deps.alerts, actor.orgId, boardId).catch(() => 0);
            return { notification: toDto(settled, false) };
          }
        }
        throw err instanceof FuneralLinkIssueError && !err.revocationConfirmed
          ? sendUnconfirmed()
          : linkFailed();
      }
      try {
        const sent = await asUser(actor, async (tx) => {
          const moved = await store.settle(tx, {
            orgId: actor.orgId,
            id: row.id,
            attemptId,
            to: "sent",
            linkId,
            recipientEmailHash: recipientHash,
          });
          if (!moved) throw new Error("the sending row was not settled");
          await publish(tx, DEATH_NOTIFICATION_EVENTS.sent, moved);
          return moved;
        });
        return { notification: toDto(sent, false) };
      } catch (err) {
        // The link is minted and delivered. The row stays `sending` (never re-claimable), so a retry cannot mint a second link. Pin the link id
        // on the row (best effort) so the disclosure stays joinable; the stall tick later revokes the link and frees the row for a re-send.
        await asUser(actor, (tx) =>
          store.recordLink(tx, {
            orgId: actor.orgId,
            id: row.id,
            attemptId,
            linkId,
          }),
        ).catch(() => null);
        deps.warn?.(
          "death notification: a funeral-home link was delivered but its sent state was not recorded",
          {
            org_id: actor.orgId,
            board_id: boardId,
            notification_id: row.id,
            link_id: linkId,
            error: err instanceof Error ? err.name : "unknown",
          },
        );
        throw sendUnconfirmed();
      }
    },

    async auditCaseloadDenied(actor, a) {
      await deps.funeralLinks
        ?.refused({
          orgId: actor.orgId,
          actorUserId: actor.userId,
          patientId: a.patientId,
          funeralHomeEntityId: a.funeralHomeEntityId.toLowerCase(),
          reason: "caseload_denied",
          correlationId: a.correlationId,
        })
        .catch(() => {
          deps.warn?.("death notification: a caseload refusal could not be audited", {
            org_id: actor.orgId,
          });
        });
    },

    async reconcileStrandedSendsForOrg(orgId) {
      const links = deps.funeralLinks;
      if (!links || !(await deps.isEnabled(orgId).catch(() => false)))
        return { examined: 0, reconciled: 0 };
      const stale = await asSystem(orgId, (tx) =>
        store.staleSending(tx, orgId, DEATH_NOTIFICATION_SENDING_TIMEOUT_MINUTES, STALL_FLAG_MAX),
      );
      let reconciled = 0;
      const failures: unknown[] = [];
      for (const row of stale) {
        try {
          const claimed = await asSystem(orgId, (tx) =>
            store.claimReconciliation(tx, {
              orgId,
              id: row.id,
              olderThanMinutes: DEATH_NOTIFICATION_SENDING_TIMEOUT_MINUTES,
            }),
          );
          if (!claimed) continue;
          const attemptId = claimed.sendAttemptId;
          if (!attemptId) throw new Error("reconciling death notification has no send attempt id");
          // Revoke FIRST: only a row whose live credential is gone may be freed for a re-send. A revoke failure leaves it fenced for the next tick.
          await links.revokeOrphans({
            orgId,
            disclosureAttemptId: attemptId,
            linkId: claimed.linkId,
          });
          const failed = await asSystem(orgId, (tx) =>
            store.settle(tx, {
              orgId,
              id: row.id,
              attemptId,
              to: "failed",
            }),
          );
          if (!failed) continue; // settled meanwhile
          reconciled += 1;
          await emitStrandedSendAlert(deps.alerts, orgId, row.id).catch(() => 0); // deduped per row; PHI-free fixed text
        } catch (err) {
          failures.push(err);
          deps.warn?.("death notification: a stranded send could not be reconciled", {
            org_id: orgId,
            notification_id: row.id,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      if (failures.length > 0)
        throw new Error(
          `death notification: ${failures.length} stranded send(s) could not be reconciled; retrying`,
        );
      return { examined: stale.length, reconciled };
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
