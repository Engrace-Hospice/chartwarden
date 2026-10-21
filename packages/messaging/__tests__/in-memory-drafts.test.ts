import { SBAR_MAX_SECTION_CHARS } from "@chartwarden/types";
/**
 * WP 2.5 on the in-memory draft service (the dev/slice twin of the DB service): one private draft per
 * user + channel (+ thread root), revision-checked saves, last-writer per device, merge prompt across devices.
 */
import { describe, expect, it } from "vitest";
import {
  assertDraftWithinLimits,
  createInMemoryDraftService,
  decideDraftSave,
  isEmptyDraft,
} from "../src/drafts";

const ORG = "org_1";
const CH = "ch_1";
const base = { channelId: CH, deviceId: "dev_a", baseRevision: 0 };

describe("decideDraftSave", () => {
  it("creates when there is no draft", () => {
    expect(decideDraftSave(null, { baseRevision: 0, deviceId: "a" })).toBe("write");
  });
  it("writes when the client saw the current revision", () => {
    expect(
      decideDraftSave({ revision: 3, deviceId: "b" }, { baseRevision: 3, deviceId: "a" }),
    ).toBe("write");
  });
  it("lets the same device overwrite itself even from a stale revision", () => {
    expect(
      decideDraftSave({ revision: 3, deviceId: "a" }, { baseRevision: 1, deviceId: "a" }),
    ).toBe("write");
  });
  it("conflicts when another device wrote since the client last saw it", () => {
    expect(
      decideDraftSave({ revision: 3, deviceId: "b" }, { baseRevision: 1, deviceId: "a" }),
    ).toBe("conflict");
  });
});

describe("in-memory draft service", () => {
  it("saves and reads back a draft with a bumped revision", async () => {
    const s = createInMemoryDraftService();
    const first = await s.saveDraft(ORG, { userId: "u1", ...base, body: "hello" });
    expect(first?.revision).toBe(1);
    const second = await s.saveDraft(ORG, {
      userId: "u1",
      ...base,
      baseRevision: 1,
      body: "hello there",
    });
    expect(second?.revision).toBe(2);
    const read = await s.getDraft(ORG, { userId: "u1", channelId: CH });
    expect(read?.body).toBe("hello there");
    expect(read?.parentMessageId).toBeNull();
  });

  it("never shows a draft to another user or another tenant", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "private" });
    expect(await s.getDraft(ORG, { userId: "u2", channelId: CH })).toBeNull();
    expect(await s.getDraft("org_2", { userId: "u1", channelId: CH })).toBeNull();
  });

  it("keeps the channel draft and a thread-root draft apart", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "channel text" });
    await s.saveDraft(ORG, { userId: "u1", ...base, parentMessageId: "m_1", body: "reply text" });
    expect((await s.getDraft(ORG, { userId: "u1", channelId: CH }))?.body).toBe("channel text");
    expect(
      (await s.getDraft(ORG, { userId: "u1", channelId: CH, parentMessageId: "m_1" }))?.body,
    ).toBe("reply text");
  });

  it("rejects a save from another device that has not seen the latest revision (409 DRAFT_CONFLICT)", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "from a" });
    await expect(
      s.saveDraft(ORG, {
        userId: "u1",
        channelId: CH,
        deviceId: "dev_b",
        baseRevision: 0,
        body: "from b",
      }),
    ).rejects.toMatchObject({ code: "DRAFT_CONFLICT", statusCode: 409 });
    expect((await s.getDraft(ORG, { userId: "u1", channelId: CH }))?.body).toBe("from a");
  });

  it("lets the other device overwrite once it re-bases on the server revision", async () => {
    const s = createInMemoryDraftService();
    const a = await s.saveDraft(ORG, { userId: "u1", ...base, body: "from a" });
    const b = await s.saveDraft(ORG, {
      userId: "u1",
      channelId: CH,
      deviceId: "dev_b",
      baseRevision: a?.revision ?? 0,
      body: "merged",
    });
    expect(b?.body).toBe("merged");
    expect(b?.deviceId).toBe("dev_b");
  });

  it("treats an empty save as a discard", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "x" });
    expect(
      await s.saveDraft(ORG, { userId: "u1", ...base, baseRevision: 1, body: "  " }),
    ).toBeNull();
    expect(await s.getDraft(ORG, { userId: "u1", channelId: CH })).toBeNull();
  });

  it("B5: a blank save from a stale device is a conflict and keeps the newer draft; delete discards", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "from A" });
    await s.saveDraft(ORG, {
      userId: "u1",
      ...base,
      deviceId: "dev_b",
      baseRevision: 1,
      body: "from B",
    });
    await expect(
      s.saveDraft(ORG, { userId: "u1", ...base, baseRevision: 1, body: "   " }),
    ).rejects.toMatchObject({ code: "DRAFT_CONFLICT", statusCode: 409 });
    expect((await s.getDraft(ORG, { userId: "u1", channelId: CH }))?.body).toBe("from B");
    await s.deleteDraft(ORG, { userId: "u1", channelId: CH });
    expect(await s.getDraft(ORG, { userId: "u1", channelId: CH })).toBeNull();
  });

  it("rejects a reference whose span is empty, reversed or beyond the text (422)", async () => {
    const s = createInMemoryDraftService();
    for (const [start, end] of [
      [3, 3],
      [5, 2],
      [0, 99],
    ] as const) {
      await expect(
        s.saveDraft(ORG, {
          userId: "u1",
          ...base,
          body: "hi @Ann",
          references: [{ kind: "staff", entityId: "a", start, end }],
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it("deletes idempotently", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "x" });
    await s.deleteDraft(ORG, { userId: "u1", channelId: CH });
    await s.deleteDraft(ORG, { userId: "u1", channelId: CH });
    expect(await s.getDraft(ORG, { userId: "u1", channelId: CH })).toBeNull();
  });

  it("refuses a draft past the body limit", async () => {
    const s = createInMemoryDraftService();
    await expect(
      s.saveDraft(ORG, { userId: "u1", ...base, body: "x".repeat(8001) }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("draft sbar (plain section text sealed with the body)", () => {
  const sections = { situation: "s", background: "", assessment: "", recommendation: "" };
  const sbar = { urgencyHint: "urgent", sections } as const;
  const blank = {
    urgencyHint: "important",
    sections: { situation: " ", background: "\n", assessment: "", recommendation: "" },
  } as const;

  it("treats an all-blank sbar as empty and an sbar-only draft as non-empty", () => {
    expect(isEmptyDraft({ body: "", sbar: blank })).toBe(true);
    expect(isEmptyDraft({ body: "  ", sbar: null })).toBe(true);
    expect(isEmptyDraft({ body: "", sbar })).toBe(false);
    expect(isEmptyDraft({ body: "hi", sbar: blank })).toBe(false);
  });

  it("bounds each section and validates the hint", () => {
    const long = "x".repeat(SBAR_MAX_SECTION_CHARS);
    expect(() =>
      assertDraftWithinLimits({
        body: "",
        sbar: { urgencyHint: "routine", sections: { ...sections, situation: long } },
      }),
    ).not.toThrow();
    expect(() =>
      assertDraftWithinLimits({
        body: "",
        sbar: { urgencyHint: "routine", sections: { ...sections, assessment: `${long}x` } },
      }),
    ).toThrow(/too long/);
    expect(() =>
      assertDraftWithinLimits({
        body: "",
        sbar: { urgencyHint: "panic" as never, sections },
      }),
    ).toThrow(/invalid sbar/);
  });

  it("round-trips an sbar-only draft and keeps it next to the text", async () => {
    const s = createInMemoryDraftService();
    const only = await s.saveDraft(ORG, { userId: "u1", ...base, body: "", sbar });
    expect(only?.sbar).toEqual(sbar);
    const both = await s.saveDraft(ORG, {
      userId: "u1",
      ...base,
      baseRevision: 1,
      body: "text",
      sbar,
    });
    expect(both).toMatchObject({ body: "text", sbar, revision: 2 });
    const textOnly = await s.saveDraft(ORG, {
      userId: "u1",
      ...base,
      baseRevision: 2,
      body: "text",
    });
    expect(textOnly?.sbar).toBeUndefined();
  });

  it("discards when text and sbar are both blank", async () => {
    const s = createInMemoryDraftService();
    await s.saveDraft(ORG, { userId: "u1", ...base, body: "", sbar });
    const gone = await s.saveDraft(ORG, {
      userId: "u1",
      ...base,
      baseRevision: 1,
      body: "",
      sbar: blank,
    });
    expect(gone).toBeNull();
    expect(await s.getDraft(ORG, { userId: "u1", channelId: CH })).toBeNull();
  });
});
