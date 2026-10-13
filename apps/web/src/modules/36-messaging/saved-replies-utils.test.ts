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
