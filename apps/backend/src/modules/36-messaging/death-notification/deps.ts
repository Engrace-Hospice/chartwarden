// apps/backend/src/modules/36-messaging/death-notification/deps.ts - the composition-root factory the boot calls once for the death-notification
// cascade. The flag `messaging.death_notifications` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off), cached a few
// seconds per org, and it also REQUIRES `messaging.death_board` (the cascade hangs off a board). The seams that are not M36's (care team, BAA register,
// role keys, the M2 funeral link) arrive as injected ports so M36 imports no other module.
import { type DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { DEATH_BOARD_FLAG_KEY, DEATH_NOTIFICATIONS_FLAG_KEY } from "@chartwarden/types";
import type { DeathBoardService } from "../death-board/death-board-service";
import { createDbDeathBoardStore } from "../death-board/death-board-store";
import type { HintOutboxPort } from "../message-hint-events";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { cacheFlagRead } from "../presence/binding";
import type { Tx } from "../messaging-write-core";
import type { DeathNotificationWarn } from "./death-notification-alerts";
import {
  type DeathNotificationDeps,
  type DeathNotificationService,
  type FuneralLinkPort,
  createDeathNotificationService,
} from "./death-notification-service";
import { createDbDeathNotificationStore } from "./death-notification-store";

export interface DeathNotificationBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly alerts: AlertEmitter;
  readonly outbox?: HintOutboxPort | undefined;
  readonly deathBoard: Pick<DeathBoardService, "get">;
  readonly attendingUserId: DeathNotificationDeps["attendingUserId"];
  readonly roleKeysForUser: DeathNotificationDeps["roleKeysForUser"];
  readonly isBaaActive: DeathNotificationDeps["isBaaActive"];
  readonly isKnownFuneralHome: DeathNotificationDeps["isKnownFuneralHome"];
  readonly funeralLinks?: FuneralLinkPort | undefined;
  readonly warn?: DeathNotificationWarn | undefined;
  readonly now?: () => Date;
  /** Test overrides; production uses the defaults below. */
  readonly overrides?: Partial<DeathNotificationDeps> | undefined;
}

export interface DeathNotificationBinding {
  /** `messaging.death_notifications` AND `messaging.death_board`. Routes answer the uniform 404 (list: enabled:false) when off. */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: DeathNotificationService;
}

export function buildDeathNotificationDeps(
  input: DeathNotificationBindingInput,
): DeathNotificationBinding {
  const { db, flags } = input;
  const boardStore = createDbDeathBoardStore();
  const isEnabled = cacheFlagRead(async (organizationId) => {
    if (!flags) return false;
    const all = await flags.forOrg(organizationId);
    return all[DEATH_NOTIFICATIONS_FLAG_KEY] === true && all[DEATH_BOARD_FLAG_KEY] === true;
  });
  return {
    isEnabled,
    service: createDeathNotificationService({
      db,
      store: createDbDeathNotificationStore(),
      alerts: input.alerts,
      ...(input.outbox ? { outbox: input.outbox } : {}),
      boardPatient: (orgId, boardId) =>
        withOrgContext(db, systemOrgContext(orgId), async (tx) => {
          const board = await boardStore.getBoard(tx as unknown as Tx, orgId, boardId);
          return board?.patientId ?? null;
        }),
      viewBoard: async (actor, boardId) => {
        const board = await input.deathBoard.get(actor, boardId);
        return { patient_id: board.patient_id };
      },
      attendingUserId: input.attendingUserId,
      isActiveUser: (orgId, userId) =>
        withOrgContext(db, systemOrgContext(orgId), (tx) =>
          isActiveMessagingUser(
            tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
            orgId,
            userId,
          ),
        ),
      roleKeysForUser: input.roleKeysForUser,
      isBaaActive: input.isBaaActive,
      isKnownFuneralHome: input.isKnownFuneralHome,
      ...(input.funeralLinks ? { funeralLinks: input.funeralLinks } : {}),
      isEnabled,
      ...(input.warn ? { warn: input.warn } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...input.overrides,
    }),
  };
}
