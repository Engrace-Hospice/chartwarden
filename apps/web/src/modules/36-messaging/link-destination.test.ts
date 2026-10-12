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
    "http://evil.net:8443/x",
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
