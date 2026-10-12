// M36 WP 2.1 - when must a link show where it really goes (pure). The visible text is parsed, not substring-matched.
import { describe, expect, it } from "vitest";
import { needsDestinationSuffix } from "./link-destination";

const EVIL = "https://evil.net/x";

describe("needsDestinationSuffix (M2)", () => {
  it.each([
    "evil.net.bank.com",
    "bank.com/evil.net",
    "https://bank.com?x=evil.net",
    "bank.com@evil.net",
    "bank.com#evil.net",
    "https://bank.com:443/evil.net",
    "bank.com/\\evil.net",
    "https://bank.com\\@evil.net",
  ])("shows the destination for %s linking to evil.net", (text) => {
    expect(needsDestinationSuffix(text, EVIL)).toBe(true);
  });

  it.each([
    "evil.net",
    "EVIL.NET",
    "www.evil.net",
    "https://evil.net/",
    "https://www.evil.net/some/path?q=1#h",
    "evil.net/x",
    "evil.net.",
    "ｅvil.net",
    "evil。net",
  ])("stays quiet for %s linking to evil.net", (text) => {
    expect(needsDestinationSuffix(text, EVIL)).toBe(false);
  });

  it("stays quiet for words with no address-like shape", () => {
    expect(needsDestinationSuffix("the guide", EVIL)).toBe(false);
    expect(needsDestinationSuffix("click here", EVIL)).toBe(false);
  });

  it("folds dot look-alikes before looking for an address shape", () => {
    expect(needsDestinationSuffix("bank。com", EVIL)).toBe(true);
    expect(needsDestinationSuffix("bank．com", EVIL)).toBe(true);
    expect(needsDestinationSuffix("bank｡com", EVIL)).toBe(true);
    expect(needsDestinationSuffix("bank․com", EVIL)).toBe(true);
  });

  it("compares internationalised hosts by their punycode form", () => {
    expect(needsDestinationSuffix("bücher.example", "https://xn--bcher-kva.example/")).toBe(false);
    expect(needsDestinationSuffix("apple.com", "https://xn--pple-43d.com/")).toBe(true);
  });

  it("mailto: is quiet only when the text is that address", () => {
    expect(needsDestinationSuffix("hr@corp.example", "mailto:hr@corp.example")).toBe(false);
    expect(needsDestinationSuffix("mailto:hr@corp.example", "mailto:hr@corp.example")).toBe(false);
    expect(needsDestinationSuffix("hr@corp.example", "mailto:evil@evil.example")).toBe(true);
    expect(needsDestinationSuffix("write to us", "mailto:evil@evil.example")).toBe(false);
  });

  it("an unparseable destination always needs the suffix", () => {
    expect(needsDestinationSuffix("the guide", "not a url")).toBe(true);
  });

  it("neighbouring plain text that continues a host-like token counts (L2)", () => {
    // [bank] + ".com/login" reads as bank.com/login but the link goes to evil.net
    expect(needsDestinationSuffix("bank", EVIL, { before: "", after: ".com/login" })).toBe(true);
    expect(needsDestinationSuffix("login", EVIL, { before: "https://bank.com/", after: "" })).toBe(
      true,
    );
    expect(needsDestinationSuffix("guide", EVIL, { before: "the ", after: " now" })).toBe(false);
    expect(needsDestinationSuffix("evil", EVIL, { before: "", after: ".net" })).toBe(false);
  });
});

describe("final review: scheme decoys (M1)", () => {
  it.each(["paypal.com://evil.net/login", "bank.com+x://evil.net", "bank.com-x://evil.net/"])(
    "shows the destination for %s",
    (text) => {
      expect(needsDestinationSuffix(text, "https://evil.net/login")).toBe(true);
    },
  );

  it.each([
    "https://evil.net/login",
    "http://evil.net/login",
    "//evil.net/login",
    "HTTPS://EVIL.NET",
  ])("stays quiet for %s", (text) => {
    expect(needsDestinationSuffix(text, "https://evil.net/login")).toBe(false);
  });
});

describe("final review: dot look-alikes and prose (M2)", () => {
  const lookalikes = [
    0x00b7, 0x2027, 0xa4f8, 0x06d4, 0x0589, 0x2219, 0x22c5, 0x16eb, 0x2022, 0x30fb, 0x0387, 0x1427,
  ];
  it.each(lookalikes)("shows the destination for paypal<U+%s>com", (cp) => {
    expect(
      needsDestinationSuffix(`paypal${String.fromCodePoint(cp)}com`, "https://evil.net/"),
    ).toBe(true);
    expect(
      needsDestinationSuffix(
        `log in at paypal${String.fromCodePoint(cp)}com now`,
        "https://evil.net/",
      ),
    ).toBe(true);
  });

  it.each([
    "click",
    "see the guide",
    "Open chart",
    "Open chart.",
    "Note: see the guide, now!",
    "Dr. Smith's plan (draft)",
  ])("keeps ordinary prose quiet: %s", (text) => {
    expect(needsDestinationSuffix(text, "https://evil.net/")).toBe(false);
  });

  it("a single token with a symbol, or mixed scripts, shows the destination", () => {
    expect(needsDestinationSuffix("paypal\u2122", "https://evil.net/")).toBe(true);
    expect(needsDestinationSuffix("pay-pal", "https://evil.net/")).toBe(true);
    expect(needsDestinationSuffix("\u0440aypal", "https://evil.net/")).toBe(true); // Cyrillic r + Latin
    expect(needsDestinationSuffix("slash/word", "https://evil.net/")).toBe(true);
  });

  it("text that equals the destination host stays quiet even when it is not prose", () => {
    expect(needsDestinationSuffix("evil.net", "https://evil.net/")).toBe(false);
  });
});

describe("final review: ports (M3)", () => {
  it.each([
    ["bank.com:443", "https://bank.com:8443/", true],
    ["bank.com:8443", "https://bank.com:8443/", false],
    ["bank.com:443", "https://bank.com/", false],
    ["bank.com", "https://bank.com:8443/", true],
    ["https://bank.com:8443/x", "https://bank.com:8443/", false],
    ["https://bank.com:444/x", "https://bank.com:8443/", true],
    ["http://evil.net:8443/x", "https://evil.net/", true],
  ])("%s -> %s shows destination: %s", (text, href, shows) => {
    expect(needsDestinationSuffix(text, href)).toBe(shows);
  });
});

describe("final review: blank link text (L1)", () => {
  it.each([" ", "\u00A0", "\u3000", " \u00A0 "])("always shows the destination for %j", (text) => {
    expect(needsDestinationSuffix(text, "https://good.example/")).toBe(true);
  });
});

describe("final review: adjacent-token false positives and host smuggling (L2, L3)", () => {
  it("trailing punctuation does not make a correct link look wrong", () => {
    expect(needsDestinationSuffix("bank.com,", "https://bank.com/")).toBe(false);
    expect(
      needsDestinationSuffix("bank.com", "https://bank.com/", { before: "(", after: ")," }),
    ).toBe(false);
    expect(needsDestinationSuffix("(bank.com)", "https://bank.com/")).toBe(false);
    expect(needsDestinationSuffix("bank.com!", "https://evil.net/")).toBe(true);
  });

  it("a neighbour cannot supply the host that the link text itself does not name", () => {
    expect(needsDestinationSuffix("bank.com", EVIL, { before: "evil.net/", after: "" })).toBe(true);
    expect(needsDestinationSuffix("login", EVIL, { before: "evil.net/", after: "" })).toBe(false);
  });
});

describe("final review: linear time (L4)", () => {
  it("handles long dot runs and long non-space runs quickly", () => {
    const start = performance.now();
    needsDestinationSuffix(".".repeat(10_000), EVIL);
    needsDestinationSuffix(`${"a".repeat(10_000)}!`, EVIL, {
      before: "x".repeat(10_000),
      after: "y".repeat(10_000),
    });
    needsDestinationSuffix(`${"x.".repeat(5_000)}com:`, EVIL);
    needsDestinationSuffix(`${":1".repeat(5_000)}x`, EVIL);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
