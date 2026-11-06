// apps/backend/__tests__/bereavement-mailing-content.test.ts — ADR-0109 D10: no default wording ships, and generation refuses empty content.
import { describe, expect, it } from "vitest";
import {
  assertMailingContentComplete,
  isMailingContentComplete,
  normalizeMailingContent,
  personalizeGreeting,
} from "../src/modules/16-bereavement/mailings/content";

const GOOD = {
  en: {
    title: "A note from our team",
    greeting: "Dear {name},",
    paragraphs: ["We are thinking of you."],
    signoff: "With care",
  },
};

describe("mailing content", () => {
  it("refuses empty content: nothing written, no title, or only blank paragraphs", () => {
    for (const content of [
      {},
      { en: { ...GOOD.en, title: "   " } },
      { en: { ...GOOD.en, paragraphs: [] } },
      { en: { ...GOOD.en, paragraphs: ["  ", ""] } },
    ]) {
      expect(isMailingContentComplete(normalizeMailingContent(content))).toBe(false);
      expect(() => assertMailingContentComplete(content)).toThrowError(
        expect.objectContaining({ code: "MAILING_CONTENT_EMPTY", statusCode: 422 }),
      );
    }
  });

  it("accepts a title and one paragraph, trimmed, dropping blank paragraphs", () => {
    const en = assertMailingContentComplete({
      en: {
        title: "  Hello ",
        greeting: " Dear {name}, ",
        paragraphs: [" one ", " ", "two"],
        signoff: " Warmly ",
      },
    });
    expect(en).toEqual({
      title: "Hello",
      greeting: "Dear {name},",
      paragraphs: ["one", "two"],
      signoff: "Warmly",
    });
  });

  it("personalizes the greeting with the recipient's name, and never prints a literal token", () => {
    expect(personalizeGreeting("Dear {name},", "Ada Example")).toBe("Dear Ada Example,");
    expect(personalizeGreeting("{name}, we remember", "Ada")).toBe("Ada, we remember");
    expect(personalizeGreeting("Dear friend,", "Ada")).toBe("Dear friend,");
    expect(personalizeGreeting("", "Ada")).toBe("Ada");
    expect(personalizeGreeting("   ", "  ")).toBe("Dear family");
  });
});
