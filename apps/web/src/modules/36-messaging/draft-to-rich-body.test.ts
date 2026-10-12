// M36 WP 2.1 - the composer's markdown shortcuts and format keys (pure).
import { richBodyToPlainText } from "@wardenx/types";
import { XSS_CORPUS } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { formatShortcutMarker, isMacPlatform, toggleWrap } from "./composer-format";
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

describe("markdown subset edge cases (W4)", () => {
  it("a code fence is only a block when the whole trimmed line is the fence", () => {
    const inline = draftToRichBody("see ```foo``` and **x**", [])!;
    expect(inline.doc.content.map((block) => block.type)).toEqual(["paragraph"]);
    expect(JSON.stringify(inline)).not.toContain("codeBlock");
    const fenced = draftToRichBody("```js\nlet a = 1;\n```\nafter **x**", [])!;
    expect(fenced.doc.content.map((block) => block.type)).toEqual(["codeBlock", "paragraph"]);
    expect(richBodyToPlainText(fenced)).toBe("let a = 1;\nafter x");
  });

  it("only an ordered run that starts at 1 becomes a list", () => {
    expect(draftToRichBody("3. three\n4. four", [])).toBeNull();
    const body = draftToRichBody("1. one\n2. two\n7. seven", [])!;
    expect(body.doc.content.map((block) => block.type)).toEqual(["orderedList"]);
    const mixed = draftToRichBody("intro\n5. five\n\n1. one", [])!;
    expect(mixed.doc.content.map((block) => block.type)).toEqual(["paragraph", "orderedList"]);
    expect(richBodyToPlainText(mixed)).toBe("intro\n5. five\n1. one");
  });

  it("markers around a mention format the text on both sides without stray literal markers", () => {
    const draft = "**see @Nurse Two now**";
    const body = draftToRichBody(draft, [
      { kind: "staff", entityId: ID, start: 6, end: 16, displayLabel: "Nurse Two" },
    ])!;
    const plain = richBodyToPlainText(body);
    expect(plain).toBe("see @Nurse Two now");
    expect(plain).not.toContain("*");
    expect(body.doc.content[0]).toMatchObject({
      content: [
        { type: "text", text: "see ", marks: [{ type: "bold" }] },
        { type: "mention", entityId: ID },
        { type: "text", text: " now", marks: [{ type: "bold" }] },
      ],
    });
  });

  it("a private-use placeholder typed by the user cannot forge a mention", () => {
    const body = draftToRichBody("**a\uE000b**", [])!;
    expect(JSON.stringify(body)).not.toContain("mention");
  });

  it("a mention inside a fenced block stays literal text", () => {
    const body = draftToRichBody("```\n@Nurse Two\n```", [
      { kind: "staff", entityId: ID, start: 4, end: 14, displayLabel: "Nurse Two" },
    ])!;
    expect(body.doc.content).toEqual([{ type: "codeBlock", text: "@Nurse Two" }]);
  });
});

describe("composer format shortcuts", () => {
  const key = (code: string, extra = {}) => ({
    code,
    key: "x",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  it("maps Ctrl+B, I and E on non-Mac and uses the physical key, so non-Latin layouts work", () => {
    expect(formatShortcutMarker(key("KeyB"), false)).toBe("**");
    expect(formatShortcutMarker(key("KeyI", { key: "\u0448" }), false)).toBe("*");
    expect(formatShortcutMarker(key("KeyE"), false)).toBe("`");
    expect(formatShortcutMarker(key("KeyB", { shiftKey: true }), false)).toBeNull();
    expect(formatShortcutMarker(key("KeyB", { altKey: true }), false)).toBeNull();
    expect(formatShortcutMarker(key("KeyX"), false)).toBeNull();
  });

  it("uses Cmd only on macOS and Ctrl only elsewhere", () => {
    expect(formatShortcutMarker(key("KeyB", { ctrlKey: false, metaKey: true }), false)).toBeNull();
    expect(formatShortcutMarker(key("KeyB", { ctrlKey: true, metaKey: false }), true)).toBeNull();
    expect(formatShortcutMarker(key("KeyB", { ctrlKey: false, metaKey: true }), true)).toBe("**");
    expect(formatShortcutMarker(key("KeyB", { metaKey: true }), false)).toBeNull();
  });

  it("detects macOS from one helper", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "iPhone" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ platform: "", userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMacPlatform(undefined)).toBe(false);
  });

  it("wraps a selection, unwraps it again, and inserts a pair around an empty caret", () => {
    const wrapped = toggleWrap("say hello now", 4, 9, "**");
    expect(wrapped).toMatchObject({
      value: "say **hello** now",
      selectionStart: 6,
      selectionEnd: 11,
      replaceStart: 4,
      replaceEnd: 9,
      replacement: "**hello**",
    });
    expect(
      toggleWrap(wrapped.value, wrapped.selectionStart, wrapped.selectionEnd, "**").value,
    ).toBe("say hello now");
    expect(toggleWrap("**hello**", 0, 9, "**").value).toBe("hello");
    expect(toggleWrap("**bold**", 2, 6, "*").value).toBe("***bold***");
    expect(toggleWrap("ab", 1, 1, "*")).toMatchObject({
      value: "a**b",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });
});
