// M36 WP 5.9 (ADR-0084) - the two ACCESS steps of an offboarding: sessions and devices (the ADR-0083 revoke, not rebuilt) and channel
// memberships (the existing soft-remove). Run first: access is cut before anything else is moved.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { createStaffSessionStore } from "../../02-identity/staff-session-store";
import type { SessionDeviceService } from "../session-devices/session-device-service";
import { asLeaver } from "./leaver-scope";
import type { OffboardingStep } from "./offboarding-types";

const DE = schema.deliveryEndpoints;
const USER = schema.users;
const CM = schema.channelMembers;

export function sessionsDevicesStep(input: {
  readonly db: DbClient;
  readonly sessionDevices: Pick<SessionDeviceService, "revokeForUser">;
  readonly now?: () => Date;
}): OffboardingStep {
  const { db } = input;
  const now = input.now ?? (() => new Date());
  const sessionStore = createStaffSessionStore();

  const liveSessionIds = (organizationId: string, leaverUserId: string): Promise<string[]> =>
    asLeaver(db, { organizationId, leaverUserId }, async (tx) =>
      (await sessionStore.listStaff(tx, { userId: leaverUserId, organizationId, now: now() })).map(
        (s) => s.id,
      ),
    );

  // delivery_endpoint belongs to the HUMAN and has no organisation column, so an organisation's officer may only touch endpoints that are
  // provably this organisation's (the ones linked to its sessions, expired by the ADR-0083 revoke). Endpoints no session links to are swept
  // only when the whole account is deactivated (M2, global): a person removed from this organisation but active in another keeps theirs.
  const accountDeactivated = (organizationId: string, userId: string): Promise<boolean> =>
    withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
      const [row] = await tx.select({ status: USER.status }).from(USER).where(eq(USER.id, userId));
      return row?.status === "deactivated";
    });

  const openEndpoints = (organizationId: string, leaverUserId: string): Promise<number> =>
    asLeaver(db, { organizationId, leaverUserId }, async (tx) => {
      const [row] = await tx
        .select({ n: count() })
        .from(DE)
        .where(and(eq(DE.userId, leaverUserId), ne(DE.verificationStatus, "expired")));
      return row?.n ?? 0;
    });

  return {
    key: "sessions_devices",
    kind: "sweep",
    async inspect(ctx) {
      const sessions = await liveSessionIds(ctx.organizationId, ctx.leaverUserId);
      const endpoints = (await accountDeactivated(ctx.organizationId, ctx.leaverUserId))
        ? await openEndpoints(ctx.organizationId, ctx.leaverUserId)
        : 0;
      return { auto: sessions.length + endpoints, human: 0 };
    },
    async run(ctx) {
      let acted = 0;
      const actor = {
        organizationId: ctx.organizationId,
        userId: ctx.actorUserId,
        sessionId: ctx.actorSessionId,
      };
      for (const sessionId of await liveSessionIds(ctx.organizationId, ctx.leaverUserId)) {
        const revoked = await input.sessionDevices.revokeForUser(actor, sessionId);
        acted += 1 + revoked.push_endpoints_expired;
      }
      // Endpoints no session links to (registered before ADR-0083, or whose session already ended) are expired too, but only for a
      // deactivated account (see above). Expired, not deleted: the history of the endpoint stays.
      if (!(await accountDeactivated(ctx.organizationId, ctx.leaverUserId))) return acted;
      acted += await asLeaver(
        db,
        { organizationId: ctx.organizationId, leaverUserId: ctx.leaverUserId },
        async (tx) =>
          (
            await tx
              .update(DE)
              .set({ verificationStatus: "expired" })
              .where(and(eq(DE.userId, ctx.leaverUserId), ne(DE.verificationStatus, "expired")))
              .returning({ id: DE.id })
          ).length,
      );
      return acted;
    },
  };
}

export function channelMembershipsStep(input: {
  readonly db: DbClient;
  readonly endMemberships: (organizationId: string, userId: string) => Promise<number>;
}): OffboardingStep {
  return {
    key: "channel_memberships",
    kind: "sweep",
    async inspect(ctx) {
      const n = await withOrgContext(input.db, systemOrgContext(ctx.organizationId), async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(CM)
          .where(
            and(
              eq(CM.organizationId, ctx.organizationId),
              eq(CM.userId, ctx.leaverUserId),
              isNull(CM.removedAt),
            ),
          );
        return row?.n ?? 0;
      });
      return { auto: n, human: 0 };
    },
    run: (ctx) => input.endMemberships(ctx.organizationId, ctx.leaverUserId),
  };
}
