// M36 WP 2.1 \u2014 the rich-body sanitiser, canonical form and plain-text projection (pure; shared by server + web).
import { describe, expect, it } from "vitest";
import {
  RICH_BODY_LIMITS,
  canonicalRichBodyJson,
  linkTargetLabel,
  parseStoredRichBody,
  richBodyMentions,
  richBodyToPlainText,
  safeLinkHref,
  sanitizeRichBody,
  storedBodyToPlainText,
} from "../src/messaging-rich-body";
import type { RichBody } from "../src/messaging-rich-body";
import { STRUCTURAL_CORPUS, XSS_CORPUS, nestedListDoc, wideDoc } from "./fixtures/xss-corpus";

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
const HAZARDOUS_CHARS = /[\u0000-\u0008\u000B-\u001F\u202A-\u202E\u2066-\u2069\uFEFF\u200B]/;
const ID = "11111111-1111-4111-8111-111111111111";
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, ...marks: unknown[]) =>
  marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };

function ok(input: unknown): RichBody {
  const result = sanitizeRichBody(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

describe("sanitizeRichBody", () => {
  it("accepts every allowed node and returns a canonical copy", () => {
    const input = doc(
      para(
        text("bold", { type: "bold" }),
        text(" and "),
        text("it", { type: "italic" }),
        { type: "hardBreak" },
        text("code", { type: "code" }),
        text("link", { type: "link", href: "https://example.com/a?b=1" }),
        { type: "mention", kind: "staff", entityId: ID, label: "Ann Lee" },
      ),
      { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [para(text("two"))] }] },
      { type: "codeBlock", text: "a\nb" },
    );
    const value = ok(input);
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
    expect(canonicalRichBodyJson(value)).toBe(
      canonicalRichBodyJson(ok(JSON.parse(JSON.stringify(input)))),
    );
  });

  it("makes key order irrelevant (deterministic hash input)", () => {
    const a = ok({
      doc: {
        content: [{ content: [{ text: "x", type: "text" }], type: "paragraph" }],
        type: "doc",
      },
      schemaVersion: 1,
    });
    const b = ok(doc(para(text("x"))));
    expect(canonicalRichBodyJson(a)).toBe(canonicalRichBodyJson(b));
  });

  it.each(STRUCTURAL_CORPUS.map((c) => [c.id, c.value] as const))(
    "rejects structural payload %s",
    (_id, value) => {
      expect(sanitizeRichBody(value).ok).toBe(false);
    },
  );

  it("rejects nesting deeper than the limit and accepts the limit itself", () => {
    // doc(1) > list(2) > item(3) > list(4) > item(5) > list(6) > item(7) > paragraph(8) > text(9) is over; find the edge.
    expect(sanitizeRichBody(nestedListDoc(1)).ok).toBe(true);
    expect(sanitizeRichBody(nestedListDoc(2)).ok).toBe(true);
    expect(sanitizeRichBody(nestedListDoc(3)).ok).toBe(false);
    expect(sanitizeRichBody(nestedListDoc(500)).ok).toBe(false);
  });

  it("rejects more nodes than the limit", () => {
    expect(sanitizeRichBody(wideDoc(RICH_BODY_LIMITS.maxNodes - 2)).ok).toBe(true);
    expect(sanitizeRichBody(wideDoc(RICH_BODY_LIMITS.maxNodes)).ok).toBe(false);
  });

  it("rejects more visible text than the limit", () => {
    expect(sanitizeRichBody(doc(para(text("a".repeat(RICH_BODY_LIMITS.maxTextChars))))).ok).toBe(
      true,
    );
    expect(
      sanitizeRichBody(doc(para(text("a".repeat(RICH_BODY_LIMITS.maxTextChars + 1))))).ok,
    ).toBe(false);
  });

  it("strips controls, bidi overrides and zero-width characters from text", () => {
    const value = ok(doc(para(text("a\u202Eb\u200Bc\u0000d\u2066e\uFEFFf\nG"))));
    expect(richBodyToPlainText(value)).toBe("abcdef G");
  });

  it("rejects a text node that is empty after cleaning", () => {
    expect(sanitizeRichBody(doc(para(text("\u202E\u200B")))).ok).toBe(false);
  });

  it("limits marks per text node and rejects duplicates", () => {
    expect(sanitizeRichBody(doc(para(text("x", { type: "bold" }, { type: "bold" })))).ok).toBe(
      false,
    );
    const five = [
      { type: "bold" },
      { type: "italic" },
      { type: "code" },
      { type: "link", href: "https://a.example" },
      { type: "bold" },
    ];
    expect(sanitizeRichBody(doc(para(text("x", ...five)))).ok).toBe(false);
  });

  it("canonicalises a mention id to lower case and trims its label", () => {
    const value = ok(
      doc(
        para({ type: "mention", kind: "patient", entityId: ID.toUpperCase(), label: "  Pat Q  " }),
      ),
    );
    expect(richBodyMentions(value)).toEqual([
      { kind: "patient", entityId: ID, label: "Pat Q", start: 0, end: 6 },
    ]);
  });

  describe.each(XSS_CORPUS)("corpus payload $id", ({ payload }) => {
    it("never survives as a link target", () => {
      const result = sanitizeRichBody(doc(para(text("x", { type: "link", href: payload }))));
      if (result.ok) {
        const json = canonicalRichBodyJson(result.value);
        const href = /"href":"([^"]*)"/.exec(json)?.[1] ?? "";
        expect(href).toMatch(/^(https:|mailto:)/);
        expect(href).not.toMatch(/javascript|data:|vbscript|@evil/i);
      }
    });

    it("stays inert text in a text node, a code block and a mention label", () => {
      for (const content of [
        para(text(payload)),
        { type: "codeBlock", text: payload },
        para({ type: "mention", kind: "staff", entityId: ID, label: payload.slice(0, 100) }),
      ]) {
        const result = sanitizeRichBody(doc(content));
        if (!result.ok) continue; // rejection is also safe
        const projected = richBodyToPlainText(result.value);
        expect(projected).not.toMatch(HAZARDOUS_CHARS);
        expect(projected).not.toContain('"schemaVersion"');
      }
    });
  });
});

describe("safeLinkHref", () => {
  it.each([
    ["https://example.com/path?q=1#h", "https://example.com/path?q=1#h"],
    ["mailto:care@example.com", "mailto:care@example.com"],
    ["HTTPS://Example.COM", "https://example.com/"],
  ])("allows %s", (raw, expected) => {
    expect(safeLinkHref(raw)).toBe(expected);
  });

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "//example.com",
    "https://user:pw@example.com",
    "https://trusted.example@evil.example/",
    "https://exa mple.com",
    "https://example.com/\u202E",
    "mailto:",
    "",
    "not a url",
  ])("refuses %j", (raw) => {
    expect(safeLinkHref(raw)).toBeNull();
  });

  it("refuses non-strings and over-long links", () => {
    expect(safeLinkHref(42)).toBeNull();
    expect(
      safeLinkHref(`https://example.com/${"a".repeat(RICH_BODY_LIMITS.maxLinkChars)}`),
    ).toBeNull();
  });

  it("labels the real destination", () => {
    expect(linkTargetLabel("https://sub.example.com:8443/x")).toBe("sub.example.com:8443");
    expect(linkTargetLabel("mailto:a@b.example")).toBe("a@b.example");
  });
});

describe("richBodyToPlainText", () => {
  it("projects visible text only: no link targets, no marks, lists as lines", () => {
    const value = ok(
      doc(
        para(
          text("See "),
          text("the guide", { type: "link", href: "https://hidden.example/secret?t=1" }),
          { type: "hardBreak" },
          text("now", { type: "bold" }),
        ),
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                para(text("a")),
                {
                  type: "orderedList",
                  content: [{ type: "listItem", content: [para(text("b"))] }],
                },
              ],
            },
          ],
        },
        { type: "codeBlock", text: "x = 1" },
      ),
    );
    const projected = richBodyToPlainText(value);
    expect(projected).toBe("See the guide\nnow\n- a\n  1. b\nx = 1");
    expect(projected).not.toContain("hidden.example");
    expect(projected).not.toContain("**");
  });

  it("is deterministic", () => {
    const value = ok(
      doc(para(text("a"), { type: "mention", kind: "staff", entityId: ID, label: "Ann" })),
    );
    expect(richBodyToPlainText(value)).toBe(
      richBodyToPlainText(ok(JSON.parse(canonicalRichBodyJson(value)))),
    );
    expect(richBodyToPlainText(value)).toBe("a@Ann");
  });

  it("offsets mentions into the projection", () => {
    const value = ok(
      doc(
        para(text("hi ")),
        para(text("@Ann is not a mention "), {
          type: "mention",
          kind: "staff",
          entityId: ID,
          label: "Ann",
        }),
      ),
    );
    const projected = richBodyToPlainText(value);
    const [span] = richBodyMentions(value);
    expect(projected.slice(span!.start, span!.end)).toBe("@Ann");
    expect(span!.start).toBe(projected.lastIndexOf("@Ann"));
  });
});

describe("storedBodyToPlainText / parseStoredRichBody", () => {
  it("passes plain, markdown and system bodies through unchanged (legacy rows)", () => {
    for (const kind of ["plain", "markdown", "system"]) {
      expect(storedBodyToPlainText(kind, "**hi** <b>x</b> [a](javascript:1)")).toBe(
        "**hi** <b>x</b> [a](javascript:1)",
      );
    }
  });

  it("projects a rich body and never returns its JSON", () => {
    const stored = canonicalRichBodyJson(ok(doc(para(text("hello")))));
    expect(storedBodyToPlainText("rich", stored)).toBe("hello");
  });

  it("returns empty text for a corrupt or hostile stored rich body", () => {
    expect(storedBodyToPlainText("rich", "not json")).toBe("");
    expect(
      storedBodyToPlainText("rich", JSON.stringify(doc({ type: "html", html: "<script>" }))),
    ).toBe("");
    expect(parseStoredRichBody("{").ok).toBe(false);
  });
});
