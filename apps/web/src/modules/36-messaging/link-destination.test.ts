// M36 WP 2.1 - when must a link show where it really goes (pure). Rule: ALWAYS, unless the visible text is exactly
// the destination host (plus the port when it is not the default) or, for mailto:, exactly the address list.
// Noise is accepted by design: a link whose text is "the guide" shows "(host)" too.
import { describe, expect, it } from "vitest";
import { needsDestinationSuffix } from "./link-destination";

const EVIL = "https://evil.net/x";

describe("every link shows its host unless the text is exactly that host", () => {
  it.each([
    // the earlier bypasses
    "evil.net.bank.com",
    "bank.com/evil.net",
    "https://bank.com?x=evil.net",
    "bank.com@evil.net",
    "bank.com#evil.net",
    "https://bank.com:443/evil.net",
    "bank.com/\\evil.net",
    "https://bank.com\\@evil.net",
    "paypal.com://evil.net/login",
    "bank.com+x://evil.net",
    "bank.com-x://evil.net/",
    // prose and brand words: no longer exempt
    "the guide",
    "click here",
    "login",
    "PayPal",
    "chartwarden",
    "Sign in to ChartWarden",
    "paypal dot com",
    "paypal . com",
    "Open chart",
    "Open chart.",
    "Note: see the guide, now!",
    // look-alike scripts and widths
    "\u0440\u0430\u0443\u0440\u0430l", // Cyrillic r a u r a + Latin l
    "\u0440\u0430\u0443\u0440\u0430\u04cf",
    "\u0412\u0422\u0412", // Cyrillic capitals
    "\u03b1\u03c1\u03c1\u03bb\u03b5", // Greek
    "\uFF50\uFF41\uFF59\uFF50\uFF41\uFF4C", // fullwidth "paypal"
    // dot look-alikes, whatever they are
    "paypal\u00b7com",
    "paypal\u2027com",
    "paypal\ua4f8com",
    "paypal\u06d4com",
    "paypal\u0589com",
    "paypal\u2219com",
    "paypal\u22c5com",
    "paypal\u16ebcom",
    "paypal\u3002com",
    "paypal\u2122",
    // other shapes
    "",
    " ",
    "\u00A0",
    "\u0301",
    "\u20DD",
    "123456",
    "[::1]",
  ])("shows the destination for %j", (text) => {
    expect(needsDestinationSuffix(text, EVIL)).toBe(true);
  });

  it.each([
    "evil.net",
    "EVIL.NET",
    "evil.net.",
    "Evil.Net",
    "https://evil.net",
    "https://evil.net/",
    "HTTPS://EVIL.NET",
    "//evil.net",
    "(evil.net)",
    "evil.net,",
    "\uFF45vil.net", // fullwidth e
    "\uFF45\uFF56\uFF49\uFF4C\uFF0E\uFF4E\uFF45\uFF54", // fully fullwidth, fullwidth dot
  ])("stays quiet for the exact host %j", (text) => {
    expect(needsDestinationSuffix(text, EVIL)).toBe(false);
  });

  it("a path, query or fragment in the text is not 'exactly the host'", () => {
    for (const text of ["evil.net/x", "https://evil.net/x", "evil.net?x=1", "evil.net#top"]) {
      expect(needsDestinationSuffix(text, EVIL)).toBe(true);
    }
  });

  it("any destination with an xn-- label always shows the host (homograph on homograph)", () => {
    // Cyrillic a in both the text and the href: they parse to the same punycode host, which used to look "exact".
    expect(needsDestinationSuffix("b\u0430nk.com", "https://b\u0430nk.com/")).toBe(true);
    expect(needsDestinationSuffix("ex\u0430mple.com", "https://xn--exmple-4nf.com/")).toBe(true);
    // A legitimate IDN destination gets the (redundant) punycode suffix; accepted.
    expect(needsDestinationSuffix("b\u00fccher.example", "https://xn--bcher-kva.example/")).toBe(
      true,
    );
    expect(needsDestinationSuffix("xn--bcher-kva.example", "https://b\u00fccher.example/")).toBe(
      true,
    );
    expect(needsDestinationSuffix("apple.com", "https://xn--pple-43d.com/")).toBe(true);
    // ASCII destinations stay exact-quiet; non-ASCII text is never "exactly" an ASCII host.
    expect(needsDestinationSuffix("bank.com", "https://bank.com/")).toBe(false);
    expect(needsDestinationSuffix("b\u0430nk.com", "https://bank.com/")).toBe(true);
    expect(needsDestinationSuffix("bank.com\u00b7", "https://bank.com/")).toBe(true);
  });

  it("www.: only the destination's own leading www. may be left out of the text", () => {
    expect(needsDestinationSuffix("bank.com", "https://www.bank.com/")).toBe(false);
    expect(needsDestinationSuffix("www.bank.com", "https://www.bank.com/")).toBe(false);
    expect(needsDestinationSuffix("www.bank.com", "https://bank.com/")).toBe(true);
    expect(needsDestinationSuffix("www.www.bank.com", "https://www.bank.com/")).toBe(true);
    expect(needsDestinationSuffix("web.bank.com", "https://www.bank.com/")).toBe(true);
    expect(needsDestinationSuffix("evil.net", "https://sub.evil.net/")).toBe(true);
  });

  it("a percent sign, or any IPv4 spelling other than the canonical one, is not exact", () => {
    expect(needsDestinationSuffix("bank%2Ecom", "https://bank.com/")).toBe(true);
    expect(needsDestinationSuffix("bank.com%", "https://bank.com/")).toBe(true);
    for (const text of ["127.1", "0x7f.1", "2130706433", "127.000.000.001", "0177.0.0.1"]) {
      expect(needsDestinationSuffix(text, "https://127.0.0.1/")).toBe(true);
    }
    expect(needsDestinationSuffix("127.0.0.1", "https://127.0.0.1/")).toBe(false);
    expect(needsDestinationSuffix("127.0.0.1:8443", "https://127.0.0.1:8443/")).toBe(false);
  });

  it("only a single trailing dot is exact", () => {
    expect(needsDestinationSuffix("bank.com.", "https://bank.com/")).toBe(false);
    expect(needsDestinationSuffix("bank.com..", "https://bank.com/")).toBe(true);
    expect(needsDestinationSuffix("bank.com...", "https://bank.com/")).toBe(true);
    expect(needsDestinationSuffix("bank.com\u2026", "https://bank.com/")).toBe(true);
  });

  it.each([
    ["bank.com:443", "https://bank.com:8443/", true],
    ["bank.com:8443", "https://bank.com:8443/", false],
    ["https://bank.com:8443", "https://bank.com:8443/", false],
    ["bank.com:443", "https://bank.com/", false],
    ["bank.com", "https://bank.com:8443/", true],
    // L1: the default port follows the destination's protocol, and a scheme in the text must match it
    ["evil.example:443", "http://evil.example/", true],
    ["evil.example:80", "http://evil.example/", false],
    ["evil.example", "http://evil.example/", false],
    ["https://evil.example", "http://evil.example/", true],
    ["http://evil.example", "http://evil.example/", false],
    ["http://evil.example", "https://evil.example/", true],
    ["evil.example:80", "https://evil.example/", true],
  ])("ports and schemes: %s -> %s shows destination: %s", (text, href, shows) => {
    expect(needsDestinationSuffix(text, href)).toBe(shows);
  });

  it("mailto: is quiet only when the text is exactly the address list", () => {
    expect(needsDestinationSuffix("hr@corp.example", "mailto:hr@corp.example")).toBe(false);
    expect(needsDestinationSuffix("HR@Corp.Example", "mailto:hr@corp.example")).toBe(false);
    expect(needsDestinationSuffix("mailto:hr@corp.example", "mailto:hr@corp.example")).toBe(false);
    expect(
      needsDestinationSuffix("a@b.example,c@d.example", "mailto:a@b.example,c@d.example"),
    ).toBe(false);
    expect(needsDestinationSuffix("hr@corp.example", "mailto:evil@evil.example")).toBe(true);
    expect(needsDestinationSuffix("write to us", "mailto:evil@evil.example")).toBe(true);
  });

  it("an unparseable destination always needs the suffix", () => {
    expect(needsDestinationSuffix("evil.net", "not a url")).toBe(true);
  });

  it("is linear time on hostile input", () => {
    const start = performance.now();
    needsDestinationSuffix(".".repeat(10_000), EVIL);
    needsDestinationSuffix(`${"a".repeat(10_000)}!`, EVIL);
    needsDestinationSuffix(`${"x.".repeat(5_000)}com:`, EVIL);
    needsDestinationSuffix(`${":1".repeat(5_000)}x`, EVIL);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
