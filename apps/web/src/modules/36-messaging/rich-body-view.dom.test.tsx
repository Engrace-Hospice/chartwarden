// M36 WP 2.1 - the safe renderer under the XSS corpus (jsdom). Every payload is rendered as message text, a code
// block, a link target, a mention label and an attachment filename; none may produce an executable DOM: no script,
// no event-handler attribute, no non-allowlisted URL in any attribute, no raw HTML node, and the page global the
// payloads would set stays unset. Hostile STRUCTURE (a document that never passed the server) is rendered too.
import { cleanup, render } from "@testing-library/react";
import type { RichBody } from "@chartwarden/types";
import { sanitizeRichBody } from "@chartwarden/types";
import { STRUCTURAL_CORPUS, XSS_CORPUS } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { MessageRow } from "./message-row";
import type { Message } from "./messaging-types";
import { RichBodyView } from "./rich-body-view";

afterEach(() => {
  cleanup();
  (window as unknown as Record<string, unknown>).__xss = undefined;
});

const ID = "11111111-1111-4111-8111-111111111111";
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, ...marks: unknown[]) =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };
const docOf = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

function sanitized(input: unknown): RichBody {
  const result = sanitizeRichBody(input);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const FORBIDDEN =
  "script,iframe,object,embed,img,style,form,input,link,meta,base,math,template,foreignObject";
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "srcdoc", "data"];

/** Fails when the subtree contains anything that could execute or load. */
function expectInert(root: HTMLElement): void {
  expect(root.querySelectorAll(FORBIDDEN)).toHaveLength(0);
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
      // Text-bearing attributes (title, aria-label) may echo a payload as text; only URL-bearing ones are checked.
      if (attribute.name.toLowerCase() === "style")
        expect(attribute.value).not.toMatch(/url\(|expression\(/i);
      if (URL_ATTRS.includes(attribute.name.toLowerCase())) {
        const value = attribute.value;
        // The only URLs a message may render: allowlisted links, and in-app patient routes from <Link>.
        expect(value).toMatch(/^(https:\/\/|mailto:|\/patients\/)/);
      }
    }
  }
  expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
}

function view(body: unknown, references: Message["references"] = []) {
  return render(
    <MemoryRouter>
      <RichBodyView bodyDoc={body as RichBody} references={references} fallbackText="fallback" />
    </MemoryRouter>,
  );
}

describe("S1: a link never hides where it goes", () => {
  const linkDoc = (label: string, href: string) =>
    sanitized(docOf(para(text(label, { type: "link", href }))));
  const anchor = (label: string, href: string) => {
    const { container } = view(linkDoc(label, href));
    return container.querySelector("a") as HTMLAnchorElement;
  };

  it("shows the real host inline when the visible text looks like another address", () => {
    for (const label of [
      "intranet.example",
      "https://intranet.example/login",
      "ceo@intranet.example",
    ]) {
      const a = anchor(label, "https://evil.example/phish");
      expect(a.textContent).toContain(label);
      expect(a.textContent).toContain("(evil.example)");
    }
  });

  it("shows the host for plain words too, and stays quiet only when the text is exactly the host", () => {
    expect(anchor("the guide", "https://good.example/g").textContent).toBe(
      "the guide (good.example) (opens in new tab)",
    );
    expect(anchor("good.example", "https://good.example/g").textContent).toBe(
      "good.example (opens in new tab)",
    );
    expect(anchor("https://GOOD.example", "https://good.example/y").textContent).not.toContain(
      "(good.example)",
    );
  });

  it("shows punycode for an internationalised host, and compares hosts under NFKC", () => {
    const a = anchor("b\u00fccher.example", "https://b\u00fccher.example/");
    expect(a.textContent).toContain("b\u00fccher.example");
    const spoof = anchor("apple.com", "https://xn--pple-43d.com/");
    expect(spoof.textContent).toContain("(xn--pple-43d.com)");
    const fullwidth = anchor("\uFF47ood.example", "https://good.example/");
    expect(fullwidth.textContent).not.toContain("(good.example)");
  });

  it("announces the new tab to screen readers", () => {
    const a = anchor("the guide", "https://good.example/g");
    const hint = a.querySelector(".sr-only");
    expect(hint?.textContent).toBe(" (opens in new tab)");
  });

  it("a mailto link does not open a tab, and shows the address when the text names another", () => {
    const a = anchor("write to hr@corp.example", "mailto:evil@evil.example");
    expect(a.getAttribute("target")).toBeNull();
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.querySelector(".sr-only")).toBeNull();
    expect(a.textContent).toContain("(evil@evil.example)");
  });
});

describe("a link that is only part of a host-like token shows its destination", () => {
  it("[bank] + .com/login linking elsewhere", () => {
    const { container } = view(
      sanitized(
        docOf(para(text("bank", { type: "link", href: "https://evil.net/x" }), text(".com/login"))),
      ),
    );
    expect(container.querySelector("a")?.textContent).toContain("(evil.net)");
  });
});

describe("RichBodyView renders the closed node set", () => {
  it("builds elements for every node and marks, links open safely", () => {
    const { container } = view(
      sanitized(
        docOf(
          para(
            text("bold", { type: "bold" }),
            text(" "),
            text("it", { type: "italic" }),
            text(" "),
            text("code", { type: "code" }),
            { type: "hardBreak" },
            text("docs", { type: "link", href: "https://Example.com/guide" }),
          ),
          {
            type: "orderedList",
            content: [{ type: "listItem", content: [para(text("first"))] }],
          },
          { type: "codeBlock", text: "a < b && c" },
        ),
      ),
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("it");
    expect(container.querySelector("ol > li")?.textContent).toBe("first");
    expect(container.querySelector("pre code")?.textContent).toBe("a < b && c");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/guide");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("title")).toBe("Opens example.com");
    expectInert(container);
  });

  it("shows the server's mention label, not the one frozen in the document", () => {
    const { container } = view(
      sanitized(docOf(para({ type: "mention", kind: "staff", entityId: ID, label: "Old Name" }))),
      [
        {
          kind: "staff",
          entityId: ID,
          start: 0,
          end: 9,
          displayLabel: "New Name",
          navigable: false,
        },
      ],
    );
    expect(container.textContent).toBe("@New Name");
  });

  it("falls back to the plain-text projection when the document is not valid", () => {
    const { container } = view({
      schemaVersion: 1,
      doc: { type: "doc", content: [{ type: "html" }] },
    });
    expect(container.textContent).toBe("fallback");
  });
});

describe.each(XSS_CORPUS)("corpus $id", ({ payload }) => {
  it("renders as inert text in a text node, a code block and a mention label", () => {
    const body = sanitized(
      docOf(
        para(text(payload)),
        { type: "codeBlock", text: payload },
        para({ type: "mention", kind: "staff", entityId: ID, label: payload.slice(0, 100) }),
      ),
    );
    const { container } = view(body, [
      {
        kind: "staff",
        entityId: ID,
        start: 0,
        end: 1,
        displayLabel: payload.slice(0, 100),
        navigable: false,
      },
    ]);
    expectInert(container);
  });

  it("never becomes a live link target, even when the document skipped the server", () => {
    // Hostile input straight into the renderer (a compromised or stale payload): it must degrade to text.
    const { container } = view(docOf(para(text("go", { type: "link", href: payload }))));
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href")).toMatch(/^(https:\/\/|mailto:)/);
    }
    expectInert(container);
  });

  it("is inert as a legacy plain/markdown body and as an attachment filename", () => {
    const message: Message = {
      messageId: "m1",
      channelId: "c1",
      authorUserId: ID,
      authorDisplayName: payload.slice(0, 40),
      body: payload,
      bodyKind: "markdown",
      createdAt: "2026-10-10T10:00:00.000Z",
      parentMessageId: null,
      references: [],
      attachments: [
        {
          attachmentId: "a1",
          fileName: payload.slice(0, 200),
          mimeType: "application/pdf",
          byteSize: 10,
          availability: "available",
        },
      ],
    };
    const { container } = render(
      <MemoryRouter>
        <ApiClientProvider client={{} as unknown as ApiClient}>
          <MessageRow
            message={message}
            previous={undefined}
            meId="someone-else"
            anchorMessageId={null}
          />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    expectInert(container);
  });
});

describe("hostile structure never reaches the DOM", () => {
  it.each(STRUCTURAL_CORPUS.map((entry) => [entry.id, entry.value] as const))(
    "%s",
    (_id, value) => {
      const { container } = view(value);
      expect(container.textContent).toBe("fallback");
      expectInert(container);
    },
  );
});

describe("SbarBlock", () => {
  const section = (value: string) => [para(text(value))];
  const sbar = (urgencyHint: string) =>
    docOf({
      type: "sbar",
      urgencyHint,
      situation: section("Pain uncontrolled"),
      background: section("Day 3 of care"),
      assessment: section("Breakthrough pain"),
      recommendation: section("Call me"),
    });

  it("renders a labelled section with a definition list, S/B/A/R as terms", () => {
    const { getByRole, container } = view(sanitized(sbar("routine")));
    const region = getByRole("region", { name: "SBAR" });
    expect(region.querySelector("dl")).not.toBeNull();
    expect(Array.from(region.querySelectorAll("dt")).map((n) => n.textContent)).toEqual([
      "Situation",
      "Background",
      "Assessment",
      "Recommendation",
    ]);
    expect(region.querySelectorAll("dd")[2]?.textContent).toBe("Breakthrough pain");
    expect(container.textContent).not.toContain("Sender marked");
    expectInert(container);
  });

  it.each(["important", "urgent"])("states the sender's %s label in words", (hint) => {
    const { getByText } = view(sanitized(sbar(hint)));
    expect(getByText(`Sender marked: ${hint}`)).toBeTruthy();
  });

  it("falls back to the projection when the sbar block is malformed", () => {
    const { container } = view({
      schemaVersion: 1,
      doc: { type: "doc", content: [{ type: "sbar", urgencyHint: "routine" }] },
    });
    expect(container.textContent).toBe("fallback");
  });
});

describe("the renderer's source", () => {
  it("never uses innerHTML or dangerouslySetInnerHTML", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      `${process.cwd()}/apps/web/src/modules/36-messaging/rich-body-view.tsx`,
      "utf8",
    );
    // Strip comments first: the file explains that it does not use these APIs.
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(
      /innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/,
    );
  });
});
