// WP 4.1 - the pure write rules of an urgent clinical message, and their in-memory twin wiring.
import { type RichBody, WardenXError, sanitizeRichBody } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";
import { assertUrgencyEditable, assertUrgentSend } from "../src/urgent/urgent-rules";

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const rich = (doc: unknown): RichBody => {
  const checked = sanitizeRichBody(doc);
  if (!checked.ok) throw new Error("fixture invalid");
  return checked.value;
};
const SBAR: unknown = {
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para("Pain")],
        background: [para("Day 3")],
        assessment: [para("9 of 10")],
        recommendation: [para("Review now")],
      },
    ],
  },
};
const PLAIN: unknown = { schemaVersion: 1, doc: { type: "doc", content: [para("hello")] } };

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof WardenXError ? e.code : "other";
  }
  return "none";
};

describe("assertUrgentSend", () => {
  const ok = {
    channelKind: "care_team",
    richBody: undefined as RichBody | undefined,
    authorUserId: "a",
    recipientUserId: "r",
    recipientIsActiveMember: true,
  };

  it("passes a care-team channel, an SBAR body and a different active member", () => {
    expect(codeOf(() => assertUrgentSend({ ...ok, richBody: rich(SBAR) }))).toBe("none");
  });

  it("refuses a channel that is not a patient care-team conversation first", () => {
    expect(codeOf(() => assertUrgentSend({ ...ok, channelKind: "location" }))).toBe(
      "URGENT_NOT_PATIENT_CHANNEL",
    );
  });

  it("refuses a body without an SBAR block", () => {
    expect(codeOf(() => assertUrgentSend({ ...ok, richBody: rich(PLAIN) }))).toBe(
      "URGENT_SBAR_REQUIRED",
    );
    expect(codeOf(() => assertUrgentSend({ ...ok }))).toBe("URGENT_SBAR_REQUIRED");
  });

  it.each([
    ["is the author", { recipientUserId: "a" }],
    ["is not an active member", { recipientIsActiveMember: false }],
  ])("refuses a recipient who %s with one code", (_n, over) => {
    expect(codeOf(() => assertUrgentSend({ ...ok, richBody: rich(SBAR), ...over }))).toBe(
      "URGENT_RECIPIENT_INVALID",
    );
  });
});

describe("assertUrgencyEditable", () => {
  it("refuses an urgent message and lets a routine one through", () => {
    expect(codeOf(() => assertUrgencyEditable("urgent"))).toBe("URGENT_MESSAGE_NOT_EDITABLE");
    expect(codeOf(() => assertUrgencyEditable("routine"))).toBe("none");
  });
});

describe("in-memory twin", () => {
  const seed = () =>
    createInMemoryMessagingService({
      seed: {
        eligibleStaff: ["a", "r"].map((userId) => ({
          orgId: "o",
          userId,
          displayName: userId,
          roles: ["RN"],
        })),
        channels: [
          {
            channelId: "ch",
            orgId: "o",
            kind: "care_team" as const,
            subjectId: "p",
            members: [{ userId: "a" }, { userId: "r" }],
          },
        ],
      },
    });

  it("marks an urgent message, refuses to edit it, and shows routine messages unmarked", async () => {
    const svc = seed();
    const sent = await svc.sendMessage("o", {
      channelId: "ch",
      authorUserId: "a",
      body: "x",
      richBody: rich(SBAR),
      urgentRecipientUserId: "r",
    });
    const plain = await svc.sendMessage("o", { channelId: "ch", authorUserId: "a", body: "hi" });
    await expect(
      svc.editMessage("o", { userId: "a", messageId: sent.messageId, body: "y" }),
    ).rejects.toMatchObject({ code: "URGENT_MESSAGE_NOT_EDITABLE" });
    const page = await svc.listMessages("o", { channelId: "ch", userId: "a" });
    const byId = new Map(page.messages.map((m) => [m.messageId, m]));
    expect(byId.get(sent.messageId)?.urgency).toBe("urgent");
    expect(byId.get(plain.messageId)?.urgency).toBeUndefined();
  });

  it("refuses an urgent send to a non-member", async () => {
    const svc = seed();
    await expect(
      svc.sendMessage("o", {
        channelId: "ch",
        authorUserId: "a",
        body: "x",
        richBody: rich(SBAR),
        urgentRecipientUserId: "nobody",
      }),
    ).rejects.toMatchObject({ code: "URGENT_RECIPIENT_INVALID" });
  });
});
