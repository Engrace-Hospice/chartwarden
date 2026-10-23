// M36 WP 2.8 - the pure pieces behind the saved-reply UI.
import { describe, expect, it } from "vitest";
import { insertText } from "./composer-format";
import { savedReplyErrorText } from "./saved-replies-types";
import { matchesQuery } from "./template-picker";

describe("insertText", () => {
  it("inserts at a caret and leaves the caret after the text", () => {
    expect(insertText("Hi !", 3, 3, "Sam")).toEqual({
      value: "Hi Sam!",
      selectionStart: 6,
      selectionEnd: 6,
      replaceStart: 3,
      replaceEnd: 3,
      replacement: "Sam",
    });
  });
  it("replaces a selection", () => {
    expect(insertText("abcdef", 1, 4, "X").value).toBe("aXef");
  });
  it("into an empty draft", () => {
    expect(insertText("", 0, 0, "Thanks").value).toBe("Thanks");
  });
});

describe("matchesQuery", () => {
  const reply = {
    id: "1",
    scope: "org",
    templateKey: null,
    category: "scheduling",
    title: "Running late",
    body: "I will arrive soon.",
    customized: false,
  } as const;
  it("matches title, body and category label, case-insensitively; blank matches all", () => {
    expect(matchesQuery(reply, "")).toBe(true);
    expect(matchesQuery(reply, "  LATE ")).toBe(true);
    expect(matchesQuery(reply, "arrive")).toBe(true);
    expect(matchesQuery(reply, "sched")).toBe(true);
    expect(matchesQuery(reply, "billing")).toBe(false);
  });
});

describe("matchesQuery with a translated display", () => {
  const platform = {
    id: "2",
    scope: "platform",
    templateKey: "scheduling.running_late",
    category: "scheduling",
    title: "Running late",
    body: "I will arrive soon.",
    customized: false,
  } as const;
  const es = [
    {
      templateKey: "scheduling.running_late",
      locale: "es",
      title: "Llego tarde",
      body: "Voy retrasado.",
      review: { state: "clinician_reviewed" },
    },
  ] as unknown as Parameters<typeof matchesQuery>[3];
  it("matches the text the user sees as well as the English source", () => {
    expect(matchesQuery(platform, "llego", "es", es)).toBe(true);
    expect(matchesQuery(platform, "late", "es", es)).toBe(true);
    expect(matchesQuery(platform, "llego", "en", es)).toBe(false);
  });
});

describe("savedReplyErrorText", () => {
  it("joins the server's reasons after its message", () => {
    expect(
      savedReplyErrorText(
        {
          error: {
            message: "Refused.",
            details: [{ field: "body", message: "looks like a date" }],
          },
        },
        "fallback",
      ),
    ).toBe("Refused. (body looks like a date)");
  });
  it("falls back when the error has no usable shape", () => {
    expect(savedReplyErrorText(undefined, "fallback")).toBe("fallback");
    expect(savedReplyErrorText({ error: {} }, "fallback")).toBe("fallback");
  });
});
