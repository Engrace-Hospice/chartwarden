// apps/backend/src/modules/36-messaging/death-board/deps.ts - WP 6.9 (ADR-0098): the composition-root factory the boot calls once. ONE
// binding for the routes (flag + service), the death consumer and the offboarding sweep, so they share a store. The flag
// `messaging.death_board` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off) and cached a few seconds
// per org like its siblings. The Part 2 gate, active-user check, display-name resolver and care-team seams default to the platform's own.
import { type DbClient, schema } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { DEATH_BOARD_FLAG_KEY } from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import type { PatientLabelPort } from "../handoffs/handoff-dto";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import {
  DEATH_BOARD_CONSENT_CALLER_ROUTE,
  createSeamPart2ChannelGate,
} from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";
import { seamCareTeamMembers, seamPrimaryRn } from "../tasks/binding";
import type { DeathBoardWarn } from "./death-board-alerts";
import {
  type DeathBoardDeps,
  type DeathBoardService,
  createDeathBoardService,
} from "./death-board-service";
import { createDbDeathBoardStore } from "./death-board-store";

export interface DeathBoardBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly alerts: AlertEmitter;
  readonly patientLabels: PatientLabelPort;
  readonly warn?: DeathBoardWarn | undefined;
  readonly now?: () => Date;
  /** Test overrides; production uses the defaults below. */
  readonly overrides?: Partial<DeathBoardDeps> | undefined;
}

export interface DeathBoardBinding {
  /** The tenant flag `messaging.death_board`. Routes answer the uniform 404 (list: enabled:false) when it is off. */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: DeathBoardService;
}

/** Everyone who ever sat on the patient's care-team channel (soft-removed rows included), by user id. */
function formerTeamReader(db: DbClient): DeathBoardDeps["formerTeam"] {
  const CM = schema.channelMembers;
  const CH = schema.channels;
  return (orgId, patientId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const rows = await tx
        .selectDistinct({ userId: CM.userId })
        .from(CM)
        .innerJoin(CH, and(eq(CH.organizationId, CM.organizationId), eq(CH.id, CM.channelId)))
        .where(
          and(
            eq(CM.organizationId, orgId),
            eq(CH.channelKind, "care_team"),
            eq(CH.subjectId, patientId),
          ),
        )
        .orderBy(asc(CM.userId));
      return rows.map((r) => r.userId);
    });
}

export function buildDeathBoardDeps(input: DeathBoardBindingInput): DeathBoardBinding {
  const { db, flags } = input;
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[DEATH_BOARD_FLAG_KEY] === true : false,
    ),
    service: createDeathBoardService({
      db,
      store: createDbDeathBoardStore(),
      part2Gate: createSeamPart2ChannelGate(db, DEATH_BOARD_CONSENT_CALLER_ROUTE),
      patientLabels: input.patientLabels,
      displayName: createMentionActorNameResolver(db),
      isActiveUser: (orgId, userId) =>
        withOrgContext(db, systemOrgContext(orgId), (tx) =>
          isActiveMessagingUser(
            tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
            orgId,
            userId,
          ),
        ),
      careTeamMembers: seamCareTeamMembers,
      primaryRn: seamPrimaryRn,
      formerTeam: formerTeamReader(db),
      alerts: input.alerts,
      ...(input.warn ? { warn: input.warn } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...input.overrides,
    }),
  };
}
