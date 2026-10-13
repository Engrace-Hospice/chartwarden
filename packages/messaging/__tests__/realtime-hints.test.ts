import { describe, expect, it } from "vitest";
import { buildMessageHint, isMessageHintOutboxEvent } from "../src/realtime/hints";

const facts = { channelId: "ch_1", messageId: "msg_1", at: "2026-10-12T10:00:00.000Z" };

describe("realtime hints (ADR-0054: hints only, no PHI)", () => {
  it("maps each outbox event to its server event kind", () => {
    expect(buildMessageHint("m36.message.sent", facts).kind).toBe("message.new");
    expect(buildMessageHint("m36.message.edited", facts).kind).toBe("message.edited");
    expect(buildMessageHint("m36.message.deleted", facts).kind).toBe("message.deleted");
    // WP 2.4: a reaction or pin change; the hint says only THAT something changed, never which emoji or who
    expect(buildMessageHint("m36.message.annotated", facts).kind).toBe("message.annotated");
    expect(isMessageHintOutboxEvent("m36.message.annotated")).toBe(true);
  });

  it("carries only kind, cursor and the two ids - no body or PHI field can appear", () => {
    const hint = buildMessageHint("m36.message.sent", {
      ...facts,
      // a caller smuggling extra fields in must not see them on the wire
      ...({ body: "patient has cancer", patientName: "Jane Doe" } as object),
    } as typeof facts);
    expect(Object.keys(hint).sort()).toEqual(["cursor", "ids", "kind"]);
    expect(Object.keys(hint.ids).sort()).toEqual(["channelId", "messageId"]);
    expect(JSON.stringify(hint)).not.toMatch(/cancer|Jane/);
  });

  it("a thread reply's hint adds the parent id (an id, never content); a top-level hint has none", () => {
    const reply = buildMessageHint("m36.message.sent", { ...facts, parentMessageId: "msg_root" });
    expect(reply.ids).toEqual({
      channelId: "ch_1",
      messageId: "msg_1",
      parentMessageId: "msg_root",
    });
    expect(Object.keys(reply).sort()).toEqual(["cursor", "ids", "kind"]);
    expect(buildMessageHint("m36.message.sent", facts).ids).not.toHaveProperty("parentMessageId");
  });

  it("is deterministic, so a redelivered event yields the same cursor", () => {
    expect(buildMessageHint("m36.message.sent", facts).cursor).toBe(
      buildMessageHint("m36.message.sent", facts).cursor,
    );
    expect(buildMessageHint("m36.message.edited", facts).cursor).not.toBe(
      buildMessageHint("m36.message.sent", facts).cursor,
    );
  });

  it("recognises only the three hint events", () => {
    expect(isMessageHintOutboxEvent("m36.message.sent")).toBe(true);
    expect(isMessageHintOutboxEvent("m36.message.mentioned")).toBe(false);
  });
});
