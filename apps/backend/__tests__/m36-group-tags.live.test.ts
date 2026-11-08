/**
 * M36 ADR-0108 (PROPOSED) - group tags (@role, @care-team, @on-call), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 *   1. FLAG      off (absent) refuses every group kind with a typed 422 and stores nothing.
 *   2. TEAM      `@Care team` in a care-team conversation = its active members minus the author; frozen in message_group_tag_recipient;
 *                one ordinary `m36.message.mentioned` event per person (deduplicated with a personal mention).
 *   3. ROLE      the role's holders who are ACTIVE CHANNEL MEMBERS only; an outsider holding the role is neither stored nor notified.
 *   4. ON-CALL   the router's tier 1 now, intersected with the channel; a gap / unavailable roster refuses the send and leaves no message.
 *   5. RULES     wrong label, wrong channel kind, nobody reached, more than 50 people, more than 3 tags: typed 422, nothing stored.
 *   6. SNAPSHOT  the app role cannot update or delete it; an edit may keep a tag (snapshot untouched, no new alerts) but not add one;
 *                org B sees nothing.
 *   7. PICKER    group candidates appear only with the flag on and are labels only.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:group-tags:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type EscalationRouteAnswer,
  GROUP_TAG_MAX_PER_MESSAGE,
  GROUP_TAG_MAX_RECIPIENTS,
  ON_CALL_TAG_ENTITY_IDS,
} from "@chartwarden/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { type LiveKit, bootLiveKit, catalogOutbox, mkChannel } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a690107";
const ORG_B = "22222222-2222-4222-8222-22220a690108";
const KEYS = ["messaging.read", "messaging.send"];
const TEAM = "@Care team";
const ON_CALL_RN = "@On-call RN";

describe.skipIf(!DB_URL)("M36 ADR-0108 group tags - LIVE Postgres", () => {
  let kit: LiveKit;
  let svc: ReturnType<typeof createDbMessagingRouteService>;
  let author: string;
  let alice: string;
  let bob: string;
  let outsider: string; // active user, holds the role, NOT a channel member
  let userB: string;
  let careTeam: string;
  let group: string;
  let patient: string;
  let nurseRoleId: string;
  let flagOn = false;
  let routerAnswer: () => EscalationRouteAnswer;
  let routerCalls = 0;

  const refuseWith = (code: string) => expect.objectContaining({ code });

  const send = (channelId: string, body: string, references: unknown[], by = author) =>
    svc.sendMessage(ORG_A, {
      channelId,
      authorUserId: by,
      body,
      references: references as never,
    });
  const teamRef = (start = 0) => ({
    kind: "team",
    entityId: careTeam,
    start,
    end: start + TEAM.length,
  });
  const messageCount = async () =>
    kit.count(`SELECT count(*)::int AS n FROM message WHERE organization_id = $1`, [ORG_A]);
  const mentionedUsers = async (messageId: string) =>
    (
      await kit.one<{ u: string }>(
        `SELECT payload->>'mentionedUserId' AS u FROM outbox_event
          WHERE event_type = 'm36.message.mentioned' AND aggregate_id = $1`,
        [messageId],
      )
    )
      .map((r) => r.u)
      .sort();
  const snapshot = async (messageId: string, kind: string) =>
    (
      await kit.one<{ u: string }>(
        `SELECT user_id AS u FROM message_group_tag_recipient WHERE message_id = $1 AND tag_kind = $2`,
        [messageId, kind],
      )
    )
      .map((r) => r.u)
      .sort();
  const answer = (userIds: string[]): EscalationRouteAnswer => ({
    kind: "resolved",
    tier: 1,
    asOf: "x",
    source: "m19",
    userIds: userIds as [string, ...string[]],
    nextTier: null,
    timeZone: "America/Los_Angeles",
  });

  const grantRole = async (user: string, roleId: string) => {
    const membership = (
      await kit.one<{ id: string }>(
        `SELECT id FROM membership WHERE user_id = $1 AND organization_id = $2`,
        [user, ORG_A],
      )
    )[0]!.id;
    await kit.admin.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
      [ORG_A, membership, roleId],
    );
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "gt1");
    author = await kit.seedUser("author", ORG_A, KEYS);
    alice = await kit.seedUser("alice", ORG_A, KEYS);
    bob = await kit.seedUser("bob", ORG_A, KEYS);
    outsider = await kit.seedUser("outsider", ORG_A, KEYS);
    userB = await kit.seedUser("userb", ORG_B, KEYS);
    patient = randomUUID();
    careTeam = await mkChannel(kit, "care_team", patient, [author, alice, bob]);
    group = await mkChannel(kit, "group", null, [author, alice, bob]);
    nurseRoleId = (
      await kit.one<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'rn_gt','Registered Nurse','clinical_staff') RETURNING id`,
        [ORG_A],
      )
    )[0]!.id;
    await grantRole(alice, nurseRoleId);
    await grantRole(outsider, nurseRoleId);
    routerAnswer = () => answer([alice]);
    svc = createDbMessagingRouteService(kit.handle.db, {
      kek: randomBytes(32),
      outbox: catalogOutbox() as never,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      groupTags: {
        isEnabled: async () => flagOn,
        router: {
          resolveTier: async (_org, request) => {
            routerCalls += 1;
            return { ...routerAnswer(), asOf: request.asOf } as EscalationRouteAnswer;
          },
        },
      },
    });
  }, 240_000);

  afterAll(async () => {
    await kit?.close();
  });

  it("refuses every group kind while the flag is off and stores nothing", async () => {
    const before = await messageCount();
    await expect(send(careTeam, `${TEAM} hi`, [teamRef()])).rejects.toEqual(
      refuseWith("GROUP_TAGS_DISABLED"),
    );
    expect(await messageCount()).toBe(before);
    const offered = await svc.searchMentionCandidates(ORG_A, author, careTeam, "");
    expect(offered.filter((c) => c.kind !== "staff" && c.kind !== "patient")).toEqual([]);
  });

  it("flag on: the care-team tag reaches its members except the author, frozen, one event each", async () => {
    flagOn = true;
    const { messageId } = await send(careTeam, `${TEAM} please look`, [teamRef()]);
    expect(await snapshot(messageId, "team")).toEqual([alice, bob].sort());
    expect(await mentionedUsers(messageId)).toEqual([alice, bob].sort());
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_entity_reference WHERE message_id = $1 AND reference_kind = 'team'`,
        [messageId],
      ),
    ).toBe(1);
  });

  it("deduplicates a personal mention of someone a tag also reaches", async () => {
    const body = `${TEAM} and @gt1 alice`;
    const { messageId } = await send(careTeam, body, [
      teamRef(),
      { kind: "staff", entityId: alice, start: TEAM.length + 5, end: body.length },
    ]);
    expect(await mentionedUsers(messageId)).toEqual([alice, bob].sort());
  });

  it("the picker offers group labels (never people) only with the flag on, and only what fits the conversation", async () => {
    const candidates = await svc.searchMentionCandidates(ORG_A, author, careTeam, "");
    const groups = candidates.filter((c) => ["role", "team", "on_call"].includes(c.kind));
    expect(groups.map((c) => c.displayName).sort()).toEqual(
      ["Care team", "On-call RN", "On-call physician", "Registered Nurse"].sort(),
    );
    const inGroup = await svc.searchMentionCandidates(ORG_A, author, group, "");
    expect(
      inGroup.filter((c) => ["role", "team", "on_call"].includes(c.kind)).map((c) => c.kind),
    ).toEqual(["role"]);
  });

  it("a role tag reaches the role's holders who are channel members, never an outsider", async () => {
    const label = "@Registered Nurse";
    const { messageId } = await send(group, `${label} help`, [
      { kind: "role", entityId: nurseRoleId, start: 0, end: label.length },
    ]);
    expect(await snapshot(messageId, "role")).toEqual([alice]);
    expect(await mentionedUsers(messageId)).toEqual([alice]);
    expect(await snapshot(messageId, "role")).not.toContain(outsider);
  });

  it("an expired role grant no longer counts", async () => {
    await kit.admin.query(
      `UPDATE membership_role SET expires_at = now() - interval '1 minute'
        WHERE role_id = $1 AND membership_id = (SELECT id FROM membership WHERE user_id = $2)`,
      [nurseRoleId, alice],
    );
    const label = "@Registered Nurse";
    await expect(
      send(group, `${label} help`, [
        { kind: "role", entityId: nurseRoleId, start: 0, end: label.length },
      ]),
    ).rejects.toEqual(refuseWith("GROUP_TAG_EMPTY"));
    await kit.admin.query(`UPDATE membership_role SET expires_at = NULL WHERE role_id = $1`, [
      nurseRoleId,
    ]);
  });

  it("@on-call is the router's tier 1 now, kept to channel members", async () => {
    routerAnswer = () => answer([alice, outsider]);
    const { messageId } = await send(careTeam, `${ON_CALL_RN} needed`, [
      { kind: "on_call", entityId: ON_CALL_TAG_ENTITY_IDS.rn, start: 0, end: ON_CALL_RN.length },
    ]);
    expect(await snapshot(messageId, "on_call")).toEqual([alice]);
    expect(await mentionedUsers(messageId)).toEqual([alice]);
  });

  it("a coverage gap or an unavailable roster refuses the send: no message, no fall-back", async () => {
    const before = await messageCount();
    const ref = {
      kind: "on_call",
      entityId: ON_CALL_TAG_ENTITY_IDS.rn,
      start: 0,
      end: ON_CALL_RN.length,
    };
    for (const kind of ["coverage_gap", "unavailable"] as const) {
      routerAnswer = () =>
        ({
          kind,
          tier: 1,
          asOf: "x",
          source: "m19",
          nextTier: null,
          timeZone: "UTC",
          reason: "roster_unavailable",
        }) as EscalationRouteAnswer;
      await expect(send(careTeam, `${ON_CALL_RN} needed`, [ref])).rejects.toEqual(
        refuseWith("GROUP_TAG_ON_CALL_UNRESOLVED"),
      );
    }
    routerAnswer = () => {
      throw new Error("router down");
    };
    await expect(send(careTeam, `${ON_CALL_RN} needed`, [ref])).rejects.toThrow("router down");
    expect(await messageCount()).toBe(before);
    routerAnswer = () => answer([alice]);
  });

  it("refuses a wrong label, a tag outside a care-team conversation, and a team of nobody", async () => {
    await expect(send(careTeam, "@Everyone x", [teamRef()])).rejects.toEqual(
      refuseWith("GROUP_TAG_INVALID"),
    );
    await expect(
      send(group, `${TEAM} x`, [{ kind: "team", entityId: group, start: 0, end: TEAM.length }]),
    ).rejects.toEqual(refuseWith("GROUP_TAG_INVALID"));
    await expect(
      send(group, `${ON_CALL_RN} x`, [
        { kind: "on_call", entityId: ON_CALL_TAG_ENTITY_IDS.rn, start: 0, end: ON_CALL_RN.length },
      ]),
    ).rejects.toEqual(refuseWith("GROUP_TAG_INVALID"));
    const solo = await mkChannel(kit, "care_team", randomUUID(), [author]);
    await expect(
      send(solo, `${TEAM} x`, [{ kind: "team", entityId: solo, start: 0, end: TEAM.length }]),
    ).rejects.toEqual(refuseWith("GROUP_TAG_EMPTY"));
  });

  it("refuses more than 3 tags per message and more than 50 people per tag (never truncated)", async () => {
    const body = `${TEAM} ${TEAM} ${TEAM} ${TEAM}`;
    const refs = [0, 1, 2, 3].map((i) => teamRef(i * (TEAM.length + 1)));
    expect(refs.length).toBeGreaterThan(GROUP_TAG_MAX_PER_MESSAGE);
    await expect(send(careTeam, body, refs)).rejects.toEqual(refuseWith("GROUP_TAG_TOO_MANY"));

    const members: string[] = [author];
    for (let i = 0; i <= GROUP_TAG_MAX_RECIPIENTS; i += 1) {
      members.push(await kit.seedUser(`bulk${i}`, ORG_A, KEYS));
    }
    const big = await mkChannel(kit, "care_team", randomUUID(), members);
    const before = await messageCount();
    await expect(
      send(big, `${TEAM} x`, [{ kind: "team", entityId: big, start: 0, end: TEAM.length }]),
    ).rejects.toEqual(refuseWith("GROUP_TAG_TOO_MANY"));
    expect(await messageCount()).toBe(before);
  }, 120_000);

  it("the snapshot is insert-only for the app role and invisible to another organization", async () => {
    const { messageId } = await send(careTeam, `${TEAM} snapshot`, [teamRef()]);
    const asApp = async (org: string, user: string, sqlText: string) => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [org, user],
        );
        return await kit.appConn.query(sqlText);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    };
    await expect(
      asApp(
        ORG_A,
        author,
        `UPDATE message_group_tag_recipient SET user_id = '${bob}' WHERE message_id = '${messageId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      asApp(
        ORG_A,
        author,
        `DELETE FROM message_group_tag_recipient WHERE message_id = '${messageId}'`,
      ),
    ).rejects.toThrow();
    const seenByB = await asApp(
      ORG_B,
      userB,
      `SELECT count(*)::int AS n FROM message_group_tag_recipient`,
    );
    expect(seenByB.rows[0].n).toBe(0);
  });

  it("an edit may keep a tag the message was sent with (snapshot untouched, no new alerts) but cannot add one", async () => {
    const { messageId } = await send(careTeam, `${TEAM} original`, [teamRef()]);
    const eventsBefore = (await mentionedUsers(messageId)).length;
    const snapshotBefore = await snapshot(messageId, "team");
    await svc.editMessage(ORG_A, {
      userId: author,
      messageId,
      body: `${TEAM} edited`,
      references: [teamRef()] as never,
    });
    expect(await snapshot(messageId, "team")).toEqual(snapshotBefore);
    expect((await mentionedUsers(messageId)).length).toBe(eventsBefore);

    const plain = (await send(careTeam, "no tags here", [])).messageId;
    await expect(
      svc.editMessage(ORG_A, {
        userId: author,
        messageId: plain,
        body: `${TEAM} sneaky`,
        references: [teamRef()] as never,
      }),
    ).rejects.toEqual(refuseWith("INVALID_MESSAGE_REFERENCES"));
    expect(routerCalls).toBeGreaterThan(0);
  });
});
