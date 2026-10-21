// Polls in an announcement channel: creating one is posting (needs messaging.announce), voting is participation (does not),
// and closing stays with the author / a channel manager (the service decides; the route passes the manager flag).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { AnnouncementService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import type { MessagePollService } from "../src/modules/36-messaging/polls/poll-service-db";
import { registerPollRoutes } from "../src/modules/36-messaging/routes/poll-routes";

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d1d1";
const OPT = "cccccccc-cccc-4ccc-8ccc-00000000e1e1";
const POLL = { id: "p1", closed: false };

function auth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

function makeApp(calls: string[]) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            // a member of the announcement channel with read + send, but NOT messaging.announce
            permissionKeys: ["messaging.read", "messaging.send"],
          },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async () => true);
  registerAbacRegistry(registry);
  const service = {
    createPoll: async () => {
      calls.push("create");
      return { messageId: MSG, channelId: CH, createdAt: "now", poll: POLL };
    },
    getPoll: async () => ({ poll: POLL }),
    vote: async () => {
      calls.push("vote");
      return { poll: POLL };
    },
    closePoll: async (_org: string, input: { canManage: boolean }) => {
      calls.push(`close:${input.canManage}`);
      return { poll: POLL };
    },
  } as unknown as MessagePollService;
  const app = buildServer({
    db: {} as DbClient,
    authenticate: auth,
    security: { rateLimitEnabled: false },
  });
  registerPollRoutes(app, {
    service,
    announcements: { isAnnouncementChannel: async () => true } as unknown as AnnouncementService,
    canManageMembers: async () => false,
  });
  return app;
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("polls in an announcement channel", () => {
  const headers = (key: string) => ({ "x-test-user": "rn_1", "idempotency-key": key });

  it("refuses creating a poll without messaging.announce", async () => {
    const calls: string[] = [];
    const app = makeApp(calls);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${CH}/polls`,
      headers: headers("k-create"),
      payload: { question: "Lunch?", options: ["Yes", "No"], clientMessageId: "cm-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("lets a member vote, and passes the manager flag (false) when they try to close", async () => {
    const calls: string[] = [];
    const app = makeApp(calls);
    const vote = await app.inject({
      method: "PUT",
      url: `/api/v1/messaging/channels/${CH}/messages/${MSG}/poll/vote`,
      headers: headers("k-vote"),
      payload: { optionId: OPT },
    });
    const close = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${CH}/messages/${MSG}/poll/close`,
      headers: headers("k-close"),
      payload: {},
    });
    expect(vote.statusCode).toBe(200);
    expect(close.statusCode).toBe(200);
    expect(calls).toEqual(["vote", "close:false"]);
    await app.close();
  });
});
