// WP 3.10 - the medication-question service over an in-memory task store and a fake send core with the real contract:
// the hook runs inside the "transaction" and not on a replay, and a hook throw removes the message again. Proves routing,
// the no-write-on-refusal rule, idempotent replay, unrouted handling and that the question text is never read.
import type { MessagingRouteService, ValidatedClinicalLinkInput } from "@chartwarden/messaging";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createMemoryTaskStore } from "../tasks/task-store-memory";
import {
  type MedicationQuestionAsk,
  type MedicationQuestionServiceDeps,
  type ValidateLinks,
  createMedicationQuestionService,
} from "./medication-question-service";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CH = "00000000-0000-4000-8000-0000000000c1";
const PAT = "00000000-0000-4000-8000-0000000000e1";
const MED = "00000000-0000-4000-8000-0000000000f1";
const AIDE = "00000000-0000-4000-8000-00000000aaa1";
const RN = "00000000-0000-4000-8000-00000000bbb1";
const COLLEAGUE = "00000000-0000-4000-8000-00000000ccc1";
const OUTSIDER = "00000000-0000-4000-8000-00000000ddd1";
const CLIENT_MSG = "00000000-0000-4000-8000-0000000000b1";
const ORDER_TEXT = "increase morphine to 10 mg q2h";

const actor = { orgId: ORG, userId: AIDE };
const noLinks: ValidateLinks = async () => [];
const ask = (over: Partial<MedicationQuestionAsk> = {}): MedicationQuestionAsk => ({
  channelId: CH,
  text: "Is this dose right?",
  allowUnrouted: false,
  clientMessageId: CLIENT_MSG,
  ...over,
});

interface Sent {
  messageId: string;
  richBody: unknown;
  body: string;
  clinicalLinks: readonly ValidatedClinicalLinkInput[] | undefined;
}

function setup(
  over: {
    primaryRn?: string | null;
    team?: string[];
    ineligible?: string[];
    kind?: string;
    enabled?: boolean;
    viewers?: string[];
    store?: ReturnType<typeof createMemoryTaskStore>;
    taskStoreOverride?: Partial<MedicationQuestionServiceDeps["taskStore"]>;
  } = {},
) {
  const store = over.store ?? createMemoryTaskStore();
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const messages: Sent[] = [];
  const byClientId = new Map<string, { messageId: string }>();
  const viewers = new Set(over.viewers ?? [AIDE, RN, COLLEAGUE]);
  let seq = 0;
  const sendMessage = (async (_org: string, input: Record<string, unknown>) => {
    const key = String(input.clientMessageId);
    const prior = byClientId.get(key);
    if (prior) return { messageId: prior.messageId, channelId: CH, createdAt: "t" };
    const messageId = `00000000-0000-4000-8000-0000000000${String(++seq).padStart(2, "9")}`;
    const publishedBefore = published.length;
    messages.push({
      messageId,
      richBody: input.richBody,
      body: String(input.body),
      clinicalLinks: input.clinicalLinks as Sent["clinicalLinks"],
    });
    try {
      await (input.inTransaction as (tx: unknown, s: unknown) => Promise<void>)(null, {
        messageId,
        createdAt: "t",
      });
    } catch (err) {
      messages.pop();
      published.length = publishedBefore;
      throw err;
    }
    byClientId.set(key, { messageId });
    return { messageId, channelId: CH, createdAt: "t" };
  }) as unknown as MessagingRouteService["sendMessage"];
  const deps: MedicationQuestionServiceDeps = {
    isEnabled: async () => over.enabled !== false,
    linksEnabled: async () => true,
    outbox: {
      publish: async (_t, e) => void published.push({ eventName: e.eventName, payload: e.payload }),
    },
    messaging: { canViewChannel: async (_o, u) => viewers.has(u), sendMessage },
    channelFacts: async () => ({ kind: over.kind ?? "care_team", subjectId: PAT }),
    careTeamMembers: async () => over.team ?? [RN, COLLEAGUE, AIDE],
    primaryRn: async () => (over.primaryRn === undefined ? RN : over.primaryRn),
    isEligible: async (_o, u) => !(over.ineligible ?? []).includes(u),
    displayName: async (_o, u) => (u === RN ? "Rita RN" : u === COLLEAGUE ? "Carl" : null),
    taskStore: over.taskStoreOverride ? { ...store, ...over.taskStoreOverride } : store,
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  };
  return { service: createMedicationQuestionService(deps), store, published, messages };
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

describe("ask: the linked medication must belong to the channel's patient", () => {
  it.each([
    ["another patient", "00000000-0000-4000-8000-0000000000f9"],
    ["no patient", null],
  ])(
    "refuses a medication of %s with the one link refusal and writes nothing",
    async (_n, other) => {
      const { service, store, messages } = setup();
      const link: ValidatedClinicalLinkInput = {
        kind: "medication",
        sourceId: MED,
        patientId: other,
      };
      expect(await code(service.ask(actor, ask({ medicationId: MED }), async () => [link]))).toBe(
        "422:CLINICAL_LINK_NOT_AVAILABLE",
      );
      expect(messages).toHaveLength(0);
      expect(store.tasks.size).toBe(0);
    },
  );
});

describe("ask: happy path", () => {
  it("creates one message, one medication link, and one clinical task for the primary RN", async () => {
    const { service, store, published, messages } = setup();
    const link: ValidatedClinicalLinkInput = {
      kind: "medication",
      sourceId: MED,
      patientId: PAT,
    };
    const r = await service.ask(actor, ask({ medicationId: MED }), async () => [link]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.clinicalLinks).toEqual([link]);
    expect(JSON.stringify(messages[0]?.richBody)).toContain('"kind":"medication"');
    expect(store.tasks.size).toBe(1);
    expect(r).toMatchObject({ routed: true, created: true, patient_id: PAT });
    expect(r.task).toMatchObject({
      assignee_id: RN,
      created_by: AIDE,
      source_kind: "medication_question",
      clinical_concern: true,
      patient_id: PAT,
      assignee_display_name: "Rita RN",
    });
    expect(published.map((e) => e.eventName)).toEqual(["m36.task.created"]);
  });

  it("derives the patient from the channel and sends the text verbatim, even when it reads like an order", async () => {
    const { service, messages } = setup();
    await service.ask(actor, ask({ text: ORDER_TEXT }), noLinks);
    expect(messages[0]?.body).toBe(ORDER_TEXT);
  });

  it("routes to a chosen care-team colleague", async () => {
    const { service } = setup();
    const r = await service.ask(actor, ask({ assigneeUserId: COLLEAGUE }), noLinks);
    expect(r.task?.assignee_id).toBe(COLLEAGUE);
  });
});

describe("ask: refusals write nothing", () => {
  const nothingWritten = (s: ReturnType<typeof setup>) => {
    expect(s.messages).toHaveLength(0);
    expect(s.store.tasks.size).toBe(0);
    expect(s.published).toEqual([]);
  };

  it("no nurse and not allowed: 422 MEDICATION_QUESTION_NO_NURSE", async () => {
    const s = setup({ primaryRn: null });
    expect(await code(s.service.ask(actor, ask(), noLinks))).toBe(
      "422:MEDICATION_QUESTION_NO_NURSE",
    );
    nothingWritten(s);
  });

  it("the asker is the primary RN: no nurse (never routed to self)", async () => {
    const s = setup({ primaryRn: AIDE });
    expect(await code(s.service.ask(actor, ask(), noLinks))).toBe(
      "422:MEDICATION_QUESTION_NO_NURSE",
    );
    nothingWritten(s);
  });

  it("an ineligible primary RN is no nurse", async () => {
    const s = setup({ ineligible: [RN] });
    expect(await code(s.service.ask(actor, ask(), noLinks))).toBe(
      "422:MEDICATION_QUESTION_NO_NURSE",
    );
    nothingWritten(s);
  });

  it.each([
    ["the asker", AIDE],
    ["a user off the care team", OUTSIDER],
  ])("a chosen assignee that is %s: 422 MEDICATION_QUESTION_ASSIGNEE_INVALID", async (_n, id) => {
    const s = setup({ viewers: [AIDE, RN, COLLEAGUE, OUTSIDER] });
    expect(await code(s.service.ask(actor, ask({ assigneeUserId: id }), noLinks))).toBe(
      "422:MEDICATION_QUESTION_ASSIGNEE_INVALID",
    );
    nothingWritten(s);
  });

  it("a chosen assignee who cannot view the channel is invalid", async () => {
    const s = setup({ viewers: [AIDE, RN] });
    expect(await code(s.service.ask(actor, ask({ assigneeUserId: COLLEAGUE }), noLinks))).toBe(
      "422:MEDICATION_QUESTION_ASSIGNEE_INVALID",
    );
    nothingWritten(s);
  });

  it("a link the caller may not make fails before anything is written", async () => {
    const s = setup();
    const refuse: ValidateLinks = async () => {
      throw new ChartWardenError("CLINICAL_LINK_NOT_AVAILABLE", "not available", 422);
    };
    expect(await code(s.service.ask(actor, ask({ medicationId: MED }), refuse))).toBe(
      "422:CLINICAL_LINK_NOT_AVAILABLE",
    );
    nothingWritten(s);
  });

  it("a channel that is not a patient care-team conversation: 422 NOT_PATIENT_CHANNEL", async () => {
    const s = setup({ kind: "group" });
    expect(await code(s.service.ask(actor, ask(), noLinks))).toBe(
      "422:MEDICATION_QUESTION_NOT_PATIENT_CHANNEL",
    );
    nothingWritten(s);
  });

  it("flag off or channel hidden: the uniform 404", async () => {
    expect(await code(setup({ enabled: false }).service.ask(actor, ask(), noLinks))).toBe(
      "404:NOT_FOUND",
    );
    expect(await code(setup({ viewers: [RN] }).service.ask(actor, ask(), noLinks))).toBe(
      "404:NOT_FOUND",
    );
  });

  it("blank text: 422 VALIDATION_FAILED", async () => {
    const s = setup();
    expect(await code(s.service.ask(actor, ask({ text: "  " }), noLinks))).toBe(
      "422:VALIDATION_FAILED",
    );
    nothingWritten(s);
  });

  it("a seam that throws reads as no nurse, never a guess", async () => {
    const s = setup();
    const broken = createMedicationQuestionService({
      ...({} as MedicationQuestionServiceDeps),
      isEnabled: async () => true,
      linksEnabled: async () => true,
      outbox: undefined,
      messaging: {
        canViewChannel: async () => true,
        sendMessage: (async () => {
          throw new Error("must not send");
        }) as never,
      },
      channelFacts: async () => ({ kind: "care_team", subjectId: PAT }),
      careTeamMembers: async () => {
        throw new Error("seam down");
      },
      primaryRn: async () => {
        throw new Error("seam down");
      },
      isEligible: async () => true,
      displayName: async () => null,
      taskStore: s.store,
    });
    expect(await code(broken.ask(actor, ask(), noLinks))).toBe("422:MEDICATION_QUESTION_NO_NURSE");
  });
});

describe("ask: rollback and replay", () => {
  it("a task store failure inside the hook leaves no message, no task and no event", async () => {
    const s = setup({
      taskStoreOverride: {
        createOrGetActive: async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(s.service.ask(actor, ask(), noLinks)).rejects.toThrow("db down");
    expect(s.messages).toHaveLength(0);
    expect(s.store.tasks.size).toBe(0);
    expect(s.published).toEqual([]);
  });

  it("a replay of the same client message id returns the stored task and writes nothing again", async () => {
    const s = setup();
    const first = await s.service.ask(actor, ask(), noLinks);
    const second = await s.service.ask(actor, ask(), noLinks);
    expect(s.messages).toHaveLength(1);
    expect(s.store.tasks.size).toBe(1);
    expect(s.published).toHaveLength(1);
    expect(second).toMatchObject({ routed: true, created: false, message_id: first.message_id });
    expect(second.task?.id).toBe(first.task?.id);
  });
});

describe("ask: unrouted", () => {
  it("allow_unrouted sends the message with no task and publishes one PHI-free unrouted event", async () => {
    const s = setup({ primaryRn: null });
    const r = await s.service.ask(actor, ask({ allowUnrouted: true, text: ORDER_TEXT }), noLinks);
    expect(r).toMatchObject({ routed: false, task: null, created: true });
    expect(s.messages).toHaveLength(1);
    expect(s.store.tasks.size).toBe(0);
    expect(s.published).toHaveLength(1);
    const event = s.published[0];
    expect(event?.eventName).toBe("m36.medication_question.unrouted");
    expect(event?.payload).toEqual({
      organizationId: ORG,
      channelId: CH,
      messageId: s.messages[0]?.messageId,
      askedByUserId: AIDE,
      reason: "no_nurse",
      at: "2026-10-14T12:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("morphine");
    expect(JSON.stringify(event)).not.toContain(PAT);
  });

  it("a replay of an unrouted question publishes nothing again", async () => {
    const s = setup({ primaryRn: null });
    await s.service.ask(actor, ask({ allowUnrouted: true }), noLinks);
    const again = await s.service.ask(actor, ask({ allowUnrouted: true }), noLinks);
    expect(again.routed).toBe(false);
    expect(s.published).toHaveLength(1);
    expect(s.messages).toHaveLength(1);
  });
});

describe("options", () => {
  it("is disabled, without naming anything, when the flag is off", async () => {
    expect(await setup({ enabled: false }).service.options(actor, CH)).toEqual({ enabled: false });
  });

  it("is the uniform 404 for a hidden channel", async () => {
    expect(await code(setup({ viewers: [RN] }).service.options(actor, CH))).toBe("404:NOT_FOUND");
  });

  it("names the nurse and eligible colleagues, never the caller", async () => {
    const out = await setup().service.options(actor, CH);
    expect(out).toEqual({
      enabled: true,
      patient_linked: true,
      patient_id: PAT,
      nurse: { user_id: RN, display_name: "Rita RN" },
      colleagues: [
        { user_id: COLLEAGUE, display_name: "Carl" },
        { user_id: RN, display_name: "Rita RN" },
      ],
      links_enabled: true,
    });
  });

  it("offers no nurse when the caller is the primary RN or the nurse is ineligible", async () => {
    expect(await setup({ primaryRn: AIDE }).service.options(actor, CH)).toMatchObject({
      nurse: null,
    });
    expect(await setup({ ineligible: [RN] }).service.options(actor, CH)).toMatchObject({
      nurse: null,
    });
  });

  it("reports a non-patient channel as not patient-linked", async () => {
    expect(await setup({ kind: "group" }).service.options(actor, CH)).toMatchObject({
      enabled: true,
      patient_linked: false,
      nurse: null,
      colleagues: [],
    });
  });
});
