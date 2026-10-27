/**
 * M36 ADR-0082 slices S3-S4 - the after-hours triage SEND PATH, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role, over the REAL
 * catalog-validating outbox publisher (not NOOP_OUTBOX), the real urgent send, the real acknowledgment tracker, the real link store and
 * the real outcome consumer.
 *   1. FLAG OFF     no event, no link row, the role send is the plain ADR-0081 send.
 *   2. SEND         flag on: the message, its response request, the id-only `m36.afterhours_triage.requested` event and the link row commit
 *                   together; the link's source_outbox_event_id IS the committed outbox row's id; the payload is ids and an instant only.
 *   3. REPLAY       a retried send writes no second event and no second link.
 *   4. ATOMIC       a failing link insert rolls the message, request and event back.
 *   5. STATUSES     coverage gap and the unconnected deny-stub refuse and write nothing; a router failure is `lookup_failed` (503), not a gap.
 *   6. OUTCOME      the consumer, fed the REAL outbox row id, fills the link; a redelivery converges; a different second outcome, an unknown
 *                   id and a malformed payload throw (dead-letter); the link records the outcome once.
 *   7. LINES        the thread line is a closed-map sentence, "triage call not confirmed" until M19 answers, withheld in a restricted channel,
 *                   and another tenant / another channel sees nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:afterhours-send:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import type { EscalationRouteAnswer, EscalationRouter } from "@chartwarden/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escalationRouterDenyStub } from "../src/bootstrap/seams/providers";
import { guardEscalationRouter } from "../src/modules/36-messaging/ack-escalation/escalation-router-guard";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbRoleReplayLookup } from "../src/modules/36-messaging/ack-requests/role-replay-lookup";
import { createAfterHoursLinesService } from "../src/modules/36-messaging/afterhours-triage/afterhours-lines";
import { buildAfterHoursTriageBinding } from "../src/modules/36-messaging/afterhours-triage/binding";
import { createRoleSendService } from "../src/modules/36-messaging/oncall-directory/role-send-service";
import { buildM36AfterHoursOutcomeConsumer } from "../src/modules/36-messaging/outbox-consumers/afterhours-outcome";
import { buildUrgentDeps } from "../src/modules/36-messaging/urgent/deps";
import {
  type LiveKit,
  STAFF_KEYS,
  bootLiveKit,
  catalogOutbox,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a820001";
const ORG_B = "22222222-2222-4222-8222-22220a820002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a82a1";
const FLAGS_ON = {
  "messaging.afterhours_triage": true,
  "messaging.role_send": true,
  "messaging.ack_requests": true,
  "messaging.urgent_clinical": true,
  "messaging.sbar": true,
};
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const sbarDoc = () => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para("Uncontrolled pain nine of ten")],
        background: [para("Day three on service")],
        assessment: [para("Pain is not controlled")],
        recommendation: [para("Please review within the hour")],
      },
    ],
  },
});

describe.skipIf(!DB_URL)("M36 ADR-0082 after-hours triage send path - LIVE Postgres", () => {
  let kit: LiveKit;
  let sender: string;
  let rn: string;
  let channel: string;
  let otherChannel: string;
  let flags: Record<string, boolean> = { ...FLAGS_ON };
  let router: EscalationRouter;
  let failLink = false;
  let restricted = false;
  let restrictionLookupFails = false;
  const keysOf = new Map<string, readonly string[]>();

  const covered = (): EscalationRouter => ({
    async resolveTier(_org, request): Promise<EscalationRouteAnswer> {
      return {
        kind: "resolved",
        userIds: [rn],
        ranks: ["primary"],
        nextTier: null,
        timeZone: "America/Los_Angeles",
        shiftEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
        tier: request.tier,
        asOf: request.asOf,
        source: "m19",
      } as EscalationRouteAnswer;
    },
  });

  const wire = () => {
    const shared = {
      db: kit.handle.db,
      flags: { forOrg: async () => flags },
      outbox: catalogOutbox() as never,
      permissionsFor: async (_o: string, u: string) => new Set(keysOf.get(u) ?? []),
      part2Gate: {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) => new Set(userIds),
      },
      careTeamMembers: async () => [sender, rn],
    };
    const ack = buildAckDeps({ ...shared, messaging: kit.service });
    const afterHours = buildAfterHoursTriageBinding({
      db: kit.handle.db,
      flags: shared.flags,
      outbox: shared.outbox,
    });
    // The binding's own check reads the M5 privacy-flag seam, which this suite does not boot: the restriction is the test's variable.
    const basePort = {
      ...afterHours.urgentPort,
      isRestricted: async () => {
        if (restrictionLookupFails) throw new Error("privacy flags unreadable");
        return restricted;
      },
    };
    const port = failLink
      ? {
          ...basePort,
          requestInTx: async () => {
            throw new Error("link insert failed");
          },
        }
      : basePort;
    const urgent = buildUrgentDeps({
      ...shared,
      messaging: kit.service,
      responseTracker: ack.responseTracker,
      afterHoursTriage: port,
    });
    const roleSend = createRoleSendService({
      isEnabled: async () => flags["messaging.role_send"] === true,
      router: guardEscalationRouter(router),
      displayName: async () => "Rita RN",
      channelPatient: async (_o, ch) => (ch === channel ? PATIENT : null),
      findReplay: createDbRoleReplayLookup(kit.handle.db),
      afterHours: { enabled: afterHours.enabled },
      urgent: urgent.service,
    });
    return { afterHours, roleSend };
  };

  const send = (clientMessageId = randomUUID(), ch = channel) => {
    const { roleSend } = wire();
    return roleSend.send(
      { orgId: ORG_A, userId: sender },
      {
        channelId: ch,
        patientId: PATIENT,
        role: "rn",
        recipientUserId: rn,
        bodyDoc: sbarDoc(),
        clientMessageId,
      },
      async () => [],
    );
  };
  const counts = async () => ({
    links: await kit.count("SELECT count(*)::int AS n FROM message_afterhours_triage_link"),
    events: await kit.count(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.afterhours_triage.requested'",
    ),
    requests: await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_request"),
    messages: await kit.count("SELECT count(*)::int AS n FROM message WHERE urgency='urgent'"),
  });
  const linkOf = async (messageId: string) =>
    (
      await kit.one<{
        source_outbox_event_id: string;
        request_id: string;
        outcome: string | null;
        triage_call_id: string | null;
      }>("SELECT * FROM message_afterhours_triage_link WHERE message_id=$1", [messageId])
    )[0];

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "s3ah");
    sender = await kit.seedUser("sender", ORG_A, SEND_KEYS);
    rn = await kit.seedUser("rn", ORG_A, RECEIVE_KEYS);
    keysOf.set(sender, SEND_KEYS);
    keysOf.set(rn, RECEIVE_KEYS);
    channel = await mkChannel(kit, "care_team", PATIENT, [sender, rn]);
    otherChannel = await mkChannel(kit, "care_team", "aaaaaaaa-aaaa-4aaa-8aaa-0000000a82a2", [
      sender,
      rn,
    ]);
    router = covered();
  }, 120_000);
  afterAll(async () => {
    await kit?.close();
  });

  it("flag off: the role send is the plain ADR-0081 send (no event, no link)", async () => {
    flags = { ...FLAGS_ON, "messaging.afterhours_triage": false };
    const before = await counts();
    const res = await send();
    expect(res.created).toBe(true);
    const after = await counts();
    expect(after.links).toBe(before.links);
    expect(after.events).toBe(before.events);
    expect(after.requests).toBe(before.requests + 1);
    flags = { ...FLAGS_ON };
  });

  it("flag on: message, response request, request event and link row commit together, and the link carries the committed event's id", async () => {
    const before = await counts();
    const res = await send();
    expect(res.created).toBe(true);
    const after = await counts();
    expect(after).toEqual({
      links: before.links + 1,
      events: before.events + 1,
      requests: before.requests + 1,
      messages: before.messages + 1,
    });
    const link = await linkOf(res.message_id);
    expect(link).toMatchObject({ outcome: null, triage_call_id: null });
    const event = (
      await kit.one<{
        id: string;
        organization_id: string;
        payload: Record<string, unknown>;
        aggregate_id: string;
      }>("SELECT id, organization_id, payload, aggregate_id FROM outbox_event WHERE id=$1", [
        link.source_outbox_event_id,
      ])
    )[0];
    expect(event).toBeDefined();
    expect(event.organization_id).toBe(ORG_A);
    expect(event.aggregate_id).toBe(res.message_id);
    // Ids and one instant, nothing else: no text, no name, no organization in the payload.
    expect(Object.keys(event.payload).sort()).toEqual([
      "messageId",
      "occurredAt",
      "patientId",
      "requestId",
    ]);
    expect(event.payload).toMatchObject({
      messageId: res.message_id,
      requestId: link.request_id,
      patientId: PATIENT,
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/pain|Rita/i);
  });

  it("a restricted (Part 2) channel, or a restriction lookup that fails, still sends but requests no triage: no event, no link", async () => {
    for (const mode of ["restricted", "lookup_fails"] as const) {
      restricted = mode === "restricted";
      restrictionLookupFails = mode === "lookup_fails";
      const before = await counts();
      const res = await send();
      restricted = false;
      restrictionLookupFails = false;
      expect(res.created).toBe(true);
      const after = await counts();
      expect(after.links).toBe(before.links);
      expect(after.events).toBe(before.events);
      expect(after.messages).toBe(before.messages + 1);
      expect(after.requests).toBe(before.requests + 1);
    }
  });

  it("a replay writes no second event and no second link", async () => {
    const clientId = randomUUID();
    const first = await send(clientId);
    const before = await counts();
    const again = await send(clientId);
    expect(again).toMatchObject({ created: false, message_id: first.message_id });
    expect(await counts()).toEqual(before);
  });

  it("a failing link insert rolls the message, the request and the event back", async () => {
    failLink = true;
    const before = await counts();
    await expect(send()).rejects.toThrow(/link insert failed/);
    failLink = false;
    expect(await counts()).toEqual(before);
  });

  it("a coverage gap and the unconnected deny-stub refuse and write nothing; a router failure is lookup_failed (503), never a gap", async () => {
    const before = await counts();
    router = {
      async resolveTier(_o, r): Promise<EscalationRouteAnswer> {
        return {
          kind: "coverage_gap",
          nextTier: null,
          timeZone: "UTC",
          tier: r.tier,
          asOf: r.asOf,
          source: "m19",
        } as EscalationRouteAnswer;
      },
    };
    await expect(send()).rejects.toMatchObject({ statusCode: 422 });
    router = escalationRouterDenyStub;
    await expect(send()).rejects.toMatchObject({ statusCode: 422 });
    router = {
      async resolveTier() {
        throw new Error("store down");
      },
    };
    await expect(send()).rejects.toMatchObject({
      statusCode: 503,
      code: "ROLE_SEND_LOOKUP_FAILED",
    });
    const resolution = await wire().roleSend.resolve(
      { orgId: ORG_A, userId: sender },
      { channelId: channel, patientId: PATIENT, role: "rn" },
    );
    expect(resolution).toMatchObject({ status: "lookup_failed", afterhours_triage: true });
    router = covered();
    expect(await counts()).toEqual(before);
  });

  describe("the outcome consumer and the thread line", () => {
    const outcomeEvent = (payload: unknown, org = ORG_A) =>
      ({
        id: randomUUID(),
        organizationId: org,
        eventType: "m19.afterhours_triage.outcome",
        payload,
      }) as never;
    const consumer = () => buildM36AfterHoursOutcomeConsumer({ store: wire().afterHours.store });
    const lines = (org = ORG_A, ch = channel, ids: string[] = []) =>
      createAfterHoursLinesService({
        isEnabled: async () => flags["messaging.afterhours_triage"] === true,
        store: wire().afterHours.store,
        isRestrictedChannel: async () => restricted,
      }).forChannel(org, ch, ids);

    it("shows 'triage call not confirmed' until M19 answers, then the recorded outcome, once", async () => {
      const res = await send();
      const link = await linkOf(res.message_id);
      expect((await lines(ORG_A, channel, [res.message_id])).lines).toEqual([
        { message_id: res.message_id, state: "not_confirmed", text: "Triage call not confirmed" },
      ]);

      const call = randomUUID();
      const answer = {
        sourceOutboxEventId: link.source_outbox_event_id,
        triageCallId: call,
        outcome: "opened",
      };
      await consumer().handle(outcomeEvent(answer));
      expect(await linkOf(res.message_id)).toMatchObject({
        outcome: "opened",
        triage_call_id: call,
      });
      expect((await lines(ORG_A, channel, [res.message_id])).lines[0]).toMatchObject({
        state: "opened",
      });

      // Redelivery converges; a DIFFERENT second answer throws and changes nothing.
      await consumer().handle(outcomeEvent(answer));
      await expect(
        consumer().handle(outcomeEvent({ ...answer, triageCallId: null, outcome: "no_coverage" })),
      ).rejects.toThrow(/conflict/);
      expect(await linkOf(res.message_id)).toMatchObject({
        outcome: "opened",
        triage_call_id: call,
      });
    });

    it("an unknown source id and a malformed payload throw (dead-letter), and write nothing", async () => {
      await expect(
        consumer().handle(
          outcomeEvent({
            sourceOutboxEventId: randomUUID(),
            triageCallId: randomUUID(),
            outcome: "opened",
          }),
        ),
      ).rejects.toThrow(/unknown/);
      await expect(consumer().handle(outcomeEvent({ outcome: "opened" }))).rejects.toThrow(
        /malformed/,
      );
    });

    it("another tenant's envelope cannot fill this tenant's link", async () => {
      const res = await send();
      const link = await linkOf(res.message_id);
      await expect(
        consumer().handle(
          outcomeEvent(
            {
              sourceOutboxEventId: link.source_outbox_event_id,
              triageCallId: randomUUID(),
              outcome: "opened",
            },
            ORG_B,
          ),
        ),
      ).rejects.toThrow(/unknown/);
      expect((await linkOf(res.message_id)).outcome).toBeNull();
    });

    it("withholds the outcome wording in a restricted channel, shows nothing for another channel or tenant, and is empty with the flag off", async () => {
      const res = await send();
      const link = await linkOf(res.message_id);
      await consumer().handle(
        outcomeEvent({
          sourceOutboxEventId: link.source_outbox_event_id,
          triageCallId: null,
          outcome: "no_coverage",
        }),
      );
      const unanswered = await send();
      restricted = true;
      const both = (await lines(ORG_A, channel, [res.message_id, unanswered.message_id])).lines;
      restricted = false;
      const withheld = both.find((l) => l.message_id === res.message_id);
      expect(withheld).toMatchObject({ state: "withheld" });
      expect(withheld?.text).not.toMatch(/coverage|opened/i);
      // An unanswered request reads the same in a restricted channel: a member cannot tell that a triage request exists.
      expect(both.find((l) => l.message_id === unanswered.message_id)).toMatchObject({
        state: "withheld",
      });

      // A soft-deleted message carries no line.
      await kit.one(
        "UPDATE message_acknowledgment_request SET status='cancelled', cancelled_at=now(), version=version+1 WHERE message_id=$1 RETURNING id",
        [unanswered.message_id],
      );
      await kit.one(
        "UPDATE message SET status='deleted', deleted_at=now() WHERE id=$1 RETURNING id",
        [unanswered.message_id],
      );
      expect((await lines(ORG_A, channel, [unanswered.message_id])).lines).toEqual([]);

      expect((await lines(ORG_A, otherChannel, [res.message_id])).lines).toEqual([]);
      expect((await lines(ORG_B, channel, [res.message_id])).lines).toEqual([]);
      flags = { ...FLAGS_ON, "messaging.afterhours_triage": false };
      await expect(lines(ORG_A, channel, [res.message_id])).rejects.toMatchObject({
        statusCode: 404,
      });
      flags = { ...FLAGS_ON };
    });
  });
});
