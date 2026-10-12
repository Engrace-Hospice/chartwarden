// M36 WP 2.1 - the composer's markdown shortcuts and format keys (pure).
import { richBodyToPlainText } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { XSS_CORPUS } from "../../../../../packages/types/__tests__/fixtures/xss-corpus";
import { formatShortcutMarker, toggleWrap } from "./composer-format";
import { draftToRichBody } from "./draft-to-rich-body";

const ID = "22222222-2222-4222-8222-222222222222";
const blocks = (draft: string, references = [] as Parameters<typeof draftToRichBody>[1]) =>
  draftToRichBody(draft, references)?.doc.content;

describe("draftToRichBody", () => {
  it("returns null for an unformatted draft so it keeps going out as plain text", () => {
    expect(draftToRichBody("just words, 2 * 3 * 4 and snake_case_name", [])).toBeNull();
    expect(
      draftToRichBody("@Nurse Two hello", [
        { kind: "staff", entityId: ID, start: 0, end: 10, displayLabel: "Nurse Two" },
      ]),
    ).toBeNull();
  });

  it("turns **bold**, *italic*, _italic_ and `code` into marks", () => {
    expect(blocks("**b** *i* _u_ `c`")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "b", marks: [{ type: "bold" }] },
          { type: "text", text: " " },
          { type: "text", text: "i", marks: [{ type: "italic" }] },
          { type: "text", text: " " },
          { type: "text", text: "u", marks: [{ type: "italic" }] },
          { type: "text", text: " " },
          { type: "text", text: "c", marks: [{ type: "code" }] },
        ],
      },
    ]);
  });

  it("nests bold and italic and leaves unmatched delimiters literal", () => {
    const body = draftToRichBody("**a *b* c** and **open", []);
    const plain = richBodyToPlainText(body!);
    expect(plain).toBe("a b c and **open");
  });

  it("builds bullet and ordered lists and fenced code, keeps line breaks in a paragraph", () => {
    const body = draftToRichBody(
      "intro\nline two\n\n- a\n- b\n\n1. x\n2) y\n\n```\n**not bold**\n```",
      [],
    );
    expect(body?.doc.content.map((block) => block.type)).toEqual([
      "paragraph",
      "bulletList",
      "orderedList",
      "codeBlock",
    ]);
    expect(richBodyToPlainText(body!)).toBe("intro\nline two\n- a\n- b\n1. x\n2. y\n**not bold**");
  });

  it("keeps a mention as an atom, at its node position, inside formatted text", () => {
    const draft = "**hi** @Nurse Two thanks";
    const body = draftToRichBody(draft, [
      { kind: "staff", entityId: ID, start: 7, end: 17, displayLabel: "Nurse Two" },
    ]);
    expect(body?.doc.content[0]).toMatchObject({
      content: [
        { type: "text", text: "hi", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "mention", kind: "staff", entityId: ID, label: "Nurse Two" },
        { type: "text", text: " thanks" },
      ],
    });
  });

  it("falls back to plain when the structured body would not pass the shared sanitiser", () => {
    // A mention whose id is not a uuid cannot be a mention node; the plain path (with references) applies instead.
    expect(
      draftToRichBody("**x** @Bob", [
        { kind: "staff", entityId: "not-a-uuid", start: 4, end: 8, displayLabel: "Bob" },
      ]),
    ).toBeNull();
    expect(draftToRichBody(`**x** ${"a".repeat(10_001)}`, [])).toBeNull();
  });

  it("only links https and mailto targets; any other target stays literal text", () => {
    expect(richBodyToPlainText(draftToRichBody("[docs](https://example.com/a) **x**", [])!)).toBe(
      "docs x",
    );
    const unsafe = draftToRichBody("[x](javascript:alert(1)) **y**", [])!;
    expect(JSON.stringify(unsafe)).not.toContain("href");
    expect(richBodyToPlainText(unsafe)).toBe("[x](javascript:alert(1)) y");
  });

  describe.each(XSS_CORPUS)("corpus $id", ({ payload }) => {
    it("never yields a link target outside the allowlist or a node outside the closed set", () => {
      for (const draft of [
        `**${payload}**`,
        `[x](${payload})`,
        `\`${payload}\``,
        `- ${payload}`,
        `**a** ${payload}`,
      ]) {
        const body = draftToRichBody(draft, []);
        if (!body) continue;
        const json = JSON.stringify(body);
        for (const match of json.matchAll(/"href":"([^"]*)"/g)) {
          expect(match[1]).toMatch(/^(https:\/\/|mailto:)/);
        }
        expect(json).not.toMatch(/"type":"(html|image|script|iframe)"/);
      }
    });
  });
});

describe("composer format shortcuts", () => {
  const key = (k: string, extra = {}) => ({
    key: k,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  it("maps Ctrl/Cmd+B, I and E only, without Alt or Shift", () => {
    expect(formatShortcutMarker(key("b"))).toBe("**");
    expect(formatShortcutMarker(key("I"))).toBe("*");
    expect(formatShortcutMarker(key("e", { ctrlKey: false, metaKey: true }))).toBe("`");
    expect(formatShortcutMarker(key("b", { shiftKey: true }))).toBeNull();
    expect(formatShortcutMarker(key("b", { altKey: true }))).toBeNull();
    expect(formatShortcutMarker(key("b", { ctrlKey: false }))).toBeNull();
    expect(formatShortcutMarker(key("x"))).toBeNull();
  });

  it("wraps a selection, unwraps it again, and inserts a pair around an empty caret", () => {
    const wrapped = toggleWrap("say hello now", 4, 9, "**");
    expect(wrapped).toEqual({ value: "say **hello** now", selectionStart: 6, selectionEnd: 11 });
    expect(
      toggleWrap(wrapped.value, wrapped.selectionStart, wrapped.selectionEnd, "**").value,
    ).toBe("say hello now");
    expect(toggleWrap("**hello**", 0, 9, "**").value).toBe("hello");
    expect(toggleWrap("ab", 1, 1, "*")).toEqual({
      value: "a**b",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });
});
