// M36 WP 2.1 \u2014 the rich-body sanitiser, canonical form and plain-text projection (pure; shared by server + web).
import { describe, expect, it } from "vitest";
import {
  RICH_BODY_LIMITS,
  canonicalRichBodyJson,
  cleanRichText,
  linkTargetLabel,
  normalizeMentionLabel,
  parseStoredRichBody,
  richBodyClinicalLinks,
  richBodyMentions,
  richBodyToPlainText,
  safeLinkHref,
  sanitizeRichBody,
  storedBodyToPlainText,
} from "../src/messaging-rich-body";
import type { RichBody } from "../src/messaging-rich-body";
import { STRUCTURAL_CORPUS, XSS_CORPUS, nestedListDoc, wideDoc } from "../src/messaging-xss-corpus";

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

describe("WP 2.1 hardening: size, link count, expansion, invisible characters", () => {
  const linkPara = (href: string) => para(text("l", { type: "link", href }));

  it("rejects a link whose NORMALISED href is longer than the limit (percent-encoding expansion)", () => {
    const href = `https://example.com/${"\u00e9".repeat(1_500)}`;
    expect(href.length).toBeLessThan(RICH_BODY_LIMITS.maxLinkChars);
    expect(sanitizeRichBody(doc(linkPara(href))).ok).toBe(false);
    expect(safeLinkHref(href)).toBeNull();
  });

  it("caps the number of links per document", () => {
    const many = (n: number) =>
      doc(...Array.from({ length: n }, () => linkPara("https://a.example/")));
    expect(sanitizeRichBody(many(RICH_BODY_LIMITS.maxLinks)).ok).toBe(true);
    expect(sanitizeRichBody(many(RICH_BODY_LIMITS.maxLinks + 1)).ok).toBe(false);
    expect(sanitizeRichBody(many(500)).ok).toBe(false);
  });

  it("caps the canonical JSON size", () => {
    const big = `https://example.com/${"a".repeat(1_900)}`;
    const oversize = doc(...Array.from({ length: 40 }, () => linkPara(big)));
    expect(new TextEncoder().encode(JSON.stringify(oversize)).length).toBeGreaterThan(
      RICH_BODY_LIMITS.maxCanonicalBytes,
    );
    expect(sanitizeRichBody(oversize).ok).toBe(false);
    expect(sanitizeRichBody(doc(linkPara(big))).ok).toBe(true);
  });

  it("strips default-ignorable and format characters but keeps ZWJ/VS16 inside emoji sequences", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F";
    const keycap = "1\uFE0F\u20E3";
    const kept = ok(doc(para(text(`${family} ${heart} ${keycap}`))));
    expect(richBodyToPlainText(kept)).toBe(`${family} ${heart} ${keycap}`);
    const hostile =
      "a\u200Db\uFE0Fc\u3164d\u2800e\uFFA0f\u034Fg\u180Eh\u17B4i\u17B5j\u{E0041}k\u200Cl\u00ADm";
    expect(richBodyToPlainText(ok(doc(para(text(hostile)))))).toBe("abcdefghijklm");
    expect(sanitizeRichBody(doc(para(text("\u3164\u2800\uFFA0\u034F\u180E")))).ok).toBe(false);
  });

  it("refuses an invisible character anywhere in a link target", () => {
    for (const hidden of ["\u200D", "\u3164", "\u2800", "\u{E0041}", "\u034F"]) {
      expect(safeLinkHref(`https://exa${hidden}mple.com/`)).toBeNull();
    }
  });

  it("normalises a mention label under NFKC", () => {
    const value = ok(
      doc(para({ type: "mention", kind: "staff", entityId: ID, label: "\uFF22\uFF4F\uFF42" })),
    );
    expect(richBodyMentions(value)[0]?.label).toBe("Bob");
    expect(normalizeMentionLabel("@\uFF22ob\u200B")).toBe("@Bob");
  });

  it("drops the query and fragment from a mailto target", () => {
    expect(safeLinkHref("mailto:a@b.example?subject=x&cc=evil@x.example#f")).toBe(
      "mailto:a@b.example",
    );
    expect(safeLinkHref("mailto:?subject=x")).toBeNull();
  });
});

describe("M1: cleaning is idempotent, so write-time offsets index the stored body", () => {
  const REPROS = [
    "e\u200C\u0301",
    "a\u00AD\u0308b",
    "o\u202E\u0323\u200Bx",
    "\u0065\u2066\u0301\u034F\u0301",
  ];

  function alphabetSequence(seed: number): string {
    const alphabet = [
      "e",
      "a",
      "o",
      "n",
      "\u00e9",
      "\u00f1",
      "\u0301",
      "\u0308",
      "\u0323",
      "\u0327",
      "\u200B",
      "\u200C",
      "\u00AD",
      "\u202E",
      "\u2066",
      "\u034F",
      "\u3164",
      "\uFE0F",
      " ",
      "x",
      "\uFF21",
      "\u2460",
      "\u{1F600}",
    ];
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    return Array.from({ length: 4 + (next() % 12) }, () => alphabet[next() % alphabet.length]).join(
      "",
    );
  }
  const inputs = [...REPROS, ...Array.from({ length: 400 }, (_, i) => alphabetSequence(i + 1))];

  it("cleanRichText(cleanRichText(x)) === cleanRichText(x) for every form", () => {
    for (const input of inputs) {
      for (const [newlines, form] of [
        [false, "NFC"],
        [true, "NFC"],
        [false, "NFKC"],
      ] as const) {
        const once = cleanRichText(input, newlines, form);
        expect(cleanRichText(once, newlines, form)).toBe(once);
      }
    }
  });

  it("sanitizeRichBody is idempotent over text, code, mention label and link text", () => {
    for (const input of inputs) {
      const value = doc(
        para(text(`${input}x`), {
          type: "mention",
          kind: "staff",
          entityId: ID,
          label: `${input}Bob`,
        }),
        { type: "codeBlock", text: `${input}\n${input}` },
      );
      const first = sanitizeRichBody(value);
      if (!first.ok) continue;
      const second = sanitizeRichBody(JSON.parse(JSON.stringify(first.value)));
      expect(second.ok).toBe(true);
      if (second.ok)
        expect(canonicalRichBodyJson(second.value)).toBe(canonicalRichBodyJson(first.value));
    }
  });

  it("mention offsets computed at write time index the re-read body exactly", () => {
    for (const input of inputs) {
      const written = sanitizeRichBody(
        doc(
          para(text(`${input}x`), { type: "mention", kind: "staff", entityId: ID, label: "Bob" }),
        ),
      );
      if (!written.ok) continue;
      const reread = sanitizeRichBody(JSON.parse(canonicalRichBodyJson(written.value)));
      expect(reread.ok).toBe(true);
      if (!reread.ok) continue;
      const projected = richBodyToPlainText(reread.value);
      for (const span of richBodyMentions(written.value)) {
        expect(projected.slice(span.start, span.end)).toBe("@Bob");
      }
    }
  });
});

describe("L1: mailto targets are a conservative address and nothing else", () => {
  it.each([
    "mailto:%zz@evil.com",
    "mailto:%E2%80%AEmoc.live@x.com",
    "mailto:a%40b.example",
    "mailto:a@b.example%00",
    "mailto:a b@c.example",
    "mailto:\u00e9@c.example",
    "mailto:a@b",
    "mailto:,@x.example",
  ])("refuses %s", (href) => {
    expect(safeLinkHref(href)).toBeNull();
  });

  it("keeps ordinary addresses, single or comma separated", () => {
    expect(safeLinkHref("mailto:first.last+tag@example.co.uk")).toBe(
      "mailto:first.last+tag@example.co.uk",
    );
    expect(safeLinkHref("mailto:a@b.example,c@d.example")).toBe("mailto:a@b.example,c@d.example");
  });

  it("linkTargetLabel never returns an empty string", () => {
    expect(linkTargetLabel("not a url")).not.toBe("");
    expect(linkTargetLabel("mailto:")).not.toBe("");
  });
});

describe("M1: a link needs something visible to click", () => {
  it.each([
    " ",
    "\u00A0",
    "\u3000",
    " \u00A0\u3000 ",
    "\u0301",
    "\u20DD",
    "\u0E31",
    "\u1AB0",
    "\u0301\u200D", // cleans to U+0301
    "\u0301\u0301\u20DD",
  ])("rejects a link mark on text with no letter, digit, symbol or punctuation: %j", (blank) => {
    expect(
      sanitizeRichBody(doc(para(text(blank, { type: "link", href: "https://good.example/" })))).ok,
    ).toBe(false);
  });

  it("allows digit-only, symbol-only and punctuation-only link text (visible targets)", () => {
    for (const visible of ["123", "\u2192", "..."]) {
      expect(
        sanitizeRichBody(doc(para(text(visible, { type: "link", href: "https://good.example/" }))))
          .ok,
      ).toBe(true);
    }
  });

  it("still allows mark-only text WITHOUT a link, and visible text with one", () => {
    expect(sanitizeRichBody(doc(para(text(" ")))).ok).toBe(true);
    expect(sanitizeRichBody(doc(para(text("\u0301")))).ok).toBe(true);
    expect(
      sanitizeRichBody(doc(para(text("x", { type: "link", href: "https://good.example/" })))).ok,
    ).toBe(true);
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

  it("keeps mention offsets exact when the document starts with whitespace or has multiline blocks", () => {
    const value = ok(
      doc(
        para(
          text(" "),
          { type: "mention", kind: "staff", entityId: ID, label: "Bob" },
          text(" "),
          text("x", { type: "bold" }),
        ),
        { type: "codeBlock", text: "a\n\n\nb" },
        para({ type: "mention", kind: "staff", entityId: ID, label: "Bob" }),
      ),
    );
    const projected = richBodyToPlainText(value);
    const spans = richBodyMentions(value);
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(projected.slice(span.start, span.end)).toBe("@Bob");
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

describe("clinicalLink node (WP 3.2)", () => {
  const link = (extra: Record<string, unknown> = {}) => ({
    type: "clinicalLink",
    kind: "order",
    entityId: ID.toUpperCase(),
    ...extra,
  });

  it("keeps only kind and a lower-cased entityId and projects fixed text, never a label", () => {
    const value = ok(doc(para(text("see "), link())));
    expect(richBodyClinicalLinks(value)).toEqual([{ kind: "order", entityId: ID }]);
    expect(richBodyToPlainText(value)).toBe("see [linked record]");
  });

  it("refuses an unknown kind, a bad id, a label and any extra key", () => {
    for (const bad of [
      link({ kind: "patient" }),
      link({ entityId: "nope" }),
      link({ label: "Morphine 5mg" }),
      link({ href: "https://x.example" }),
    ]) {
      expect(sanitizeRichBody(doc(para(bad))).ok).toBe(false);
    }
  });

  it("caps the links in one document and dedupes repeated records", () => {
    const many = Array.from({ length: RICH_BODY_LIMITS.maxClinicalLinks + 1 }, () => link());
    expect(sanitizeRichBody(doc(para(...many))).ok).toBe(false);
    const value = ok(doc(para(link(), link(), link({ kind: "visit" }))));
    expect(richBodyClinicalLinks(value)).toHaveLength(2);
  });

  it("finds links inside lists and is a fixed point of sanitise", () => {
    const value = ok(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [para(link())] }] }),
    );
    expect(richBodyClinicalLinks(value)).toHaveLength(1);
    expect(ok(value)).toEqual(value);
  });
});
