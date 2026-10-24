// WP 4.1 - the urgent service over a fake send core with the real contract (the hook runs inside the "transaction", not on a
// replay). Proves every refusal writes nothing, the recipient answer is one uniform code, a replay publishes nothing, the
// event carries ids only, and the SBAR urgency hint and the message text never decide anything.
import type { MessagingRouteService, ValidatedClinicalLinkInput } from "@chartwarden/messaging";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type UrgentServiceDeps, type ValidateLinks, createUrgentService } from "./urgent-service";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CH = "00000000-0000-4000-8000-0000000000c1";
const PAT = "00000000-0000-4000-8000-0000000000e1";
const AIDE = "00000000-0000-4000-8000-00000000aaa1";
const RN = "00000000-0000-4000-8000-00000000bbb1";
const RN2 = "00000000-0000-4000-8000-00000000bbb2";
const OUTSIDER = "00000000-0000-4000-8000-00000000ddd1";
const CLIENT_MSG = "00000000-0000-4000-8000-0000000000b1";

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const sbarDoc = (hint = "routine", situation = "Uncontrolled pain") => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: hint,
        situation: [para(situation)],
        background: [para("Day 3 on service")],
        assessment: [para("Pain 9 of 10")],
        recommendation: [para("Please review now")],
      },
    ],
  },
});
const plainDoc = { schemaVersion: 1, doc: { type: "doc", content: [para("hello")] } };

const actor = { orgId: ORG, userId: AIDE };
const noLinks: ValidateLinks = async () => [];
const input = (over: Record<string, unknown> = {}) => ({
  channelId: CH,
  bodyDoc: sbarDoc(),
  recipientUserId: RN,
  clientMessageId: CLIENT_MSG,
  ...over,
});

function setup(
  over: {
    kind?: string;
    team?: string[];
    unqualified?: string[];
    viewers?: string[];
    enabled?: boolean;
    sendFails?: boolean;
    tracker?: UrgentServiceDeps["responseTracker"];
    afterHours?: UrgentServiceDeps["afterHoursTriage"];
  } = {},
) {
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const sends: Array<Record<string, unknown>> = [];
  const byClient = new Map<string, string>();
  const recipientOf = new Map<string, string>();
  const state = { unqualified: new Set(over.unqualified ?? []) };
  const viewers = new Set(over.viewers ?? [AIDE, RN, RN2]);
  const sendMessage = (async (_org: string, i: Record<string, unknown>) => {
    if (over.sendFails) throw new Error("db down");
    const key = String(i.clientMessageId);
    const prior = byClient.get(key);
    if (prior) return { messageId: prior, channelId: CH, createdAt: "t" };
    const messageId = "00000000-0000-4000-8000-000000000091";
    sends.push(i);
    recipientOf.set(key, String(i.urgentRecipientUserId));
    await (i.inTransaction as (tx: unknown, s: unknown) => Promise<void>)(null, {
      messageId,
      createdAt: "t",
    });
    byClient.set(key, messageId);
    return { messageId, channelId: CH, createdAt: "t" };
  }) as unknown as MessagingRouteService["sendMessage"];
  const deps: UrgentServiceDeps = {
    isEnabled: async () => over.enabled !== false,
    outbox: {
      publish: async (_t, e) => void published.push({ eventName: e.eventName, payload: e.payload }),
    },
    messaging: { canViewChannel: async (_o, u) => viewers.has(u), sendMessage },
    channelFacts: async () => ({ kind: over.kind ?? "care_team", subjectId: PAT }),
    careTeamMembers: async () => over.team ?? [RN, RN2, AIDE],
    isQualified: async (_o, u) => !state.unqualified.has(u) && u !== AIDE,
    findReplayRecipient: async (_o, _a, _c, clientId) => recipientOf.get(clientId) ?? null,
    displayName: async (_o, u) => (u === RN ? "Rita RN" : u === RN2 ? "Al RN" : null),
    ...(over.tracker ? { responseTracker: over.tracker } : {}),
    ...(over.afterHours ? { afterHoursTriage: over.afterHours } : {}),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  };
  return { service: createUrgentService(deps), published, sends, state };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChartWardenError) return `${e.statusCode}:${e.code}`;
    throw e;
  }
  return "no-error";
};

describe("send: refusals write nothing", () => {
  it("is the uniform 404 while the flag is off", async () => {
    const { service, sends } = setup({ enabled: false });
    expect(await code(service.send(actor, input(), noLinks))).toBe("404:NOT_FOUND");
    expect(sends).toHaveLength(0);
  });

  it("is the same 404 for a caller who cannot see the channel", async () => {
    const { service } = setup({ viewers: [RN] });
    expect(await code(service.send(actor, input(), noLinks))).toBe("404:NOT_FOUND");
  });

  it("refuses a channel that is not a patient care-team conversation", async () => {
    const { service, sends } = setup({ kind: "location" });
    expect(await code(service.send(actor, input(), noLinks))).toBe(
      "422:URGENT_NOT_PATIENT_CHANNEL",
    );
    expect(sends).toHaveLength(0);
  });

  it.each([
    ["the author", AIDE],
    ["someone off the care team", OUTSIDER],
    ["a colleague who is not qualified", RN2],
  ])("refuses %s as the recipient with one uniform code", async (_n, recipient) => {
    const { service, sends } = setup({ unqualified: [RN2], viewers: [AIDE, RN, RN2, OUTSIDER] });
    expect(await code(service.send(actor, input({ recipientUserId: recipient }), noLinks))).toBe(
      "422:URGENT_RECIPIENT_INVALID",
    );
    expect(sends).toHaveLength(0);
  });

  it("refuses a recipient who is on the care team but cannot view the channel", async () => {
    const { service } = setup({ viewers: [AIDE] });
    expect(await code(service.send(actor, input(), noLinks))).toBe("422:URGENT_RECIPIENT_INVALID");
  });

  it("refuses a link that belongs to another patient with the one link refusal", async () => {
    const { service, sends } = setup();
    const link: ValidatedClinicalLinkInput = {
      kind: "medication",
      sourceId: "00000000-0000-4000-8000-0000000000f1",
      patientId: "00000000-0000-4000-8000-0000000000f9",
    };
    expect(await code(service.send(actor, input(), async () => [link]))).toBe(
      "422:CLINICAL_LINK_NOT_AVAILABLE",
    );
    expect(sends).toHaveLength(0);
  });
});

describe("send: happy path and replay", () => {
  it("stores one urgent message to the named recipient and publishes one id-only event", async () => {
    const { service, sends, published } = setup();
    const res = await service.send(actor, input(), noLinks);
    expect(res).toMatchObject({
      channel_id: CH,
      patient_id: PAT,
      recipient_user_id: RN,
      created: true,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ urgentRecipientUserId: RN, bodyKind: "rich" });
    expect(published).toEqual([
      {
        eventName: "m36.message.urgent_sent",
        payload: {
          organizationId: ORG,
          channelId: CH,
          messageId: "00000000-0000-4000-8000-000000000091",
          authorUserId: AIDE,
          recipientUserId: RN,
          at: "2026-10-14T12:00:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(published)).not.toMatch(/Uncontrolled|pain|Pain/);
  });

  it("is idempotent: the same client_message_id returns the original and publishes nothing more", async () => {
    const { service, sends, published } = setup();
    await service.send(actor, input(), noLinks);
    const again = await service.send(actor, input(), noLinks);
    expect(again.created).toBe(false);
    expect(sends).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("replays a committed send even after the recipient lost access (200, not a confusing 422), and publishes nothing", async () => {
    const { service, sends, published, state } = setup();
    await service.send(actor, input(), noLinks);
    state.unqualified.add(RN);
    const again = await service.send(actor, input(), noLinks);
    expect(again).toMatchObject({ created: false, recipient_user_id: RN });
    expect(sends).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("does not skip the eligibility check when the reused id names a different recipient", async () => {
    const { service, state } = setup();
    await service.send(actor, input(), noLinks);
    state.unqualified.add(RN2);
    expect(await code(service.send(actor, input({ recipientUserId: RN2 }), noLinks))).toBe(
      "422:URGENT_RECIPIENT_INVALID",
    );
  });

  it("does not read the SBAR urgency hint or the text: a 'routine' hint with calm text is still urgent", async () => {
    const { service, sends } = setup();
    await service.send(actor, input({ bodyDoc: sbarDoc("routine", "all calm today") }), noLinks);
    expect(sends[0]).toMatchObject({ urgentRecipientUserId: RN });
  });

  it("lets the send core refuse a non-SBAR body (the core owns the SBAR rule) without publishing", async () => {
    const { service, published } = setup({ sendFails: true });
    await expect(service.send(actor, input({ bodyDoc: plainDoc }), noLinks)).rejects.toThrow();
    expect(published).toHaveLength(0);
  });
});

describe("options", () => {
  it("examines at most URGENT_CANDIDATE_CAP care-team members", async () => {
    const many = Array.from(
      { length: 250 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    const seen: string[] = [];
    const { service } = setup({ team: many, viewers: [AIDE, ...many] });
    const deps = service as unknown as object;
    expect(deps).toBeDefined();
    const counted = createUrgentService({
      isEnabled: async () => true,
      outbox: undefined,
      messaging: { canViewChannel: async () => true, sendMessage: (async () => ({})) as never },
      channelFacts: async () => ({ kind: "care_team", subjectId: PAT }),
      careTeamMembers: async () => many,
      isQualified: async (_o, u) => {
        seen.push(u);
        return false;
      },
      displayName: async () => null,
    });
    await counted.options(actor, CH);
    expect(seen.length).toBe(100);
  });

  it("answers disabled while the flag is off", async () => {
    const { service } = setup({ enabled: false });
    expect(await service.options(actor, CH)).toEqual({ enabled: false });
  });

  it("lists only qualified care-team colleagues who can see the channel, never the caller", async () => {
    const { service } = setup({ unqualified: [RN2] });
    expect(await service.options(actor, CH)).toEqual({
      enabled: true,
      patient_linked: true,
      patient_id: PAT,
      recipients: [{ user_id: RN, display_name: "Rita RN" }],
    });
  });

  it("offers nobody on a channel without a patient", async () => {
    const { service } = setup({ kind: "location" });
    expect(await service.options(actor, CH)).toEqual({
      enabled: true,
      patient_linked: false,
      patient_id: null,
      recipients: [],
    });
  });
});

describe("the response tracker hook (WP 4.2)", () => {
  type Tracker = NonNullable<UrgentServiceDeps["responseTracker"]>;
  const tracker = (enabled: () => Promise<boolean>, calls: unknown[][] = []): Tracker => ({
    enabled,
    createInTx: async (...args) => void calls.push(args),
  });

  it("creates the request inside the send transaction, naming the author, the recipient and the patient", async () => {
    const calls: unknown[][] = [];
    const { service } = setup({ tracker: tracker(async () => true, calls) });

    await service.send(actor, input(), noLinks);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({
      orgId: ORG,
      messageId: "00000000-0000-4000-8000-000000000091",
      channelId: CH,
      patientId: PAT,
      requesterUserId: AIDE,
      assigneeUserId: RN,
    });
  });

  it("does nothing while its flag is off, and the urgent send still works", async () => {
    const calls: unknown[][] = [];
    const { service, sends } = setup({ tracker: tracker(async () => false, calls) });

    const res = await service.send(actor, input(), noLinks);

    expect(res.created).toBe(true);
    expect(sends).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("a role send needs tracking: refused with 503 and nothing stored while it is off (ADR-0081)", async () => {
    const { service, sends } = setup({ tracker: tracker(async () => false) });
    expect(await code(service.send(actor, input({ roleAddressed: "rn" }), noLinks))).toBe(
      "503:ROLE_SEND_UNAVAILABLE",
    );
    expect(sends).toHaveLength(0);
  });

  it("stores the role on the request, and a REPLAY of a committed role send still answers after tracking was turned off", async () => {
    const calls: unknown[][] = [];
    let on = true;
    const { service, sends } = setup({
      tracker: tracker(async () => on, calls),
    });
    const first = await service.send(actor, input({ roleAddressed: "rn" }), noLinks);
    expect(first.created).toBe(true);
    expect(calls[0]?.[1]).toMatchObject({ assigneeUserId: RN, addressedRole: "rn" });
    on = false;
    const again = await service.send(actor, input({ roleAddressed: "rn" }), noLinks);
    expect(again).toMatchObject({ created: false, message_id: first.message_id });
    expect(sends).toHaveLength(1);
  });

  it("fails the send when its flag cannot be read (never silently untracked)", async () => {
    const { service, sends } = setup({
      tracker: tracker(async () => Promise.reject(new Error("flags down"))),
    });

    await expect(service.send(actor, input(), noLinks)).rejects.toThrow("flags down");
    expect(sends).toHaveLength(0);
  });

  it("is not called again on a replay (the hook runs only for a new message)", async () => {
    const calls: unknown[][] = [];
    const { service } = setup({ tracker: tracker(async () => true, calls) });

    await service.send(actor, input(), noLinks);
    const again = await service.send(actor, input(), noLinks);

    expect(again.created).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("fails the whole send when the tracker fails, so the message cannot exist without its request", async () => {
    const { service } = setup({
      tracker: {
        enabled: async () => true,
        createInTx: async () => {
          throw new Error("insert failed");
        },
      },
    });

    await expect(service.send(actor, input(), noLinks)).rejects.toThrow("insert failed");
  });
});

describe("the after-hours request hook (ADR-0082)", () => {
  const REQ_ID = "00000000-0000-4000-8000-0000000000f7";
  const tracked = {
    enabled: async () => true,
    createInTx: async () => ({ requestId: REQ_ID }),
  };
  const port = (enabled: () => Promise<boolean>, calls: unknown[][] = []) => ({
    enabled,
    requestInTx: async (...args: unknown[]) => void calls.push(args),
  });

  it("writes the request in the send transaction, naming the message, its response request, the patient and an instant", async () => {
    const calls: unknown[][] = [];
    const { service } = setup({ tracker: tracked, afterHours: port(async () => true, calls) });

    await service.send(actor, input({ roleAddressed: "rn", requestTriageCall: true }), noLinks);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({
      orgId: ORG,
      messageId: "00000000-0000-4000-8000-000000000091",
      requestId: REQ_ID,
      patientId: PAT,
      at: new Date("2026-10-14T12:00:00.000Z"),
    });
  });

  it("does nothing unless the caller asked (an ordinary role send or urgent send)", async () => {
    const calls: unknown[][] = [];
    const { service } = setup({ tracker: tracked, afterHours: port(async () => true, calls) });
    await service.send(actor, input({ roleAddressed: "rn" }), noLinks);
    expect(calls).toEqual([]);
  });

  it("does nothing while its flag is off, and the send still goes", async () => {
    const calls: unknown[][] = [];
    const { service, sends } = setup({ tracker: tracked, afterHours: port(async () => false, calls) });
    const res = await service.send(
      actor,
      input({ roleAddressed: "rn", requestTriageCall: true }),
      noLinks,
    );
    expect(res.created).toBe(true);
    expect(sends).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("fails the send when its flag cannot be read (an after-hours send never silently loses its request)", async () => {
    const { service, sends } = setup({
      tracker: tracked,
      afterHours: port(async () => Promise.reject(new Error("flags down"))),
    });
    await expect(
      service.send(actor, input({ roleAddressed: "rn", requestTriageCall: true }), noLinks),
    ).rejects.toThrow("flags down");
    expect(sends).toHaveLength(0);
  });

  it("a replay writes no second request", async () => {
    const calls: unknown[][] = [];
    const { service } = setup({ tracker: tracked, afterHours: port(async () => true, calls) });
    const body = input({ roleAddressed: "rn", requestTriageCall: true });
    await service.send(actor, body, noLinks);
    const again = await service.send(actor, body, noLinks);
    expect(again.created).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("fails the whole send when the request cannot be written (the message cannot exist without its link)", async () => {
    const { service } = setup({
      tracker: tracked,
      afterHours: {
        enabled: async () => true,
        requestInTx: async () => {
          throw new Error("link insert failed");
        },
      },
    });
    await expect(
      service.send(actor, input({ roleAddressed: "rn", requestTriageCall: true }), noLinks),
    ).rejects.toThrow("link insert failed");
  });
});
