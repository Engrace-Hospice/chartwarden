// M36 WP 2.1 - decides whether a link must show its real destination inline.
//
// The rule: EVERY link shows its destination host, unless the visible text is exactly that host (plus the port when
// it is not the protocol's default) or, for mailto:, exactly the address list. "Exactly" is a character-for-
// character comparison with the destination's canonical (lower-case ASCII) host, after one normalisation of the
// text: NFKC (so full-width forms fold to ASCII), lower case, brackets/quotes/sentence marks around the token
// trimmed, an http(s):// or // prefix stripped, and ONE trailing dot dropped. Consequences, all deliberate:
//   - a destination with any xn-- label (an internationalised host) ALWAYS shows its punycode host, even when the
//     text spells it identically: text and href made of the same look-alike letters would otherwise hide the tell;
//   - text that is not ASCII after the fold is never "exactly" a host;
//   - a '%', a second trailing dot, a path/query/fragment/userinfo, or any non-canonical IPv4 spelling is not exact;
//   - the only allowed difference is that the text may omit the DESTINATION's own leading "www." (bank.com for
//     www.bank.com); the reverse (www.bank.com for bank.com) shows the host.
// Noise is accepted by design: prose, brand names, other scripts, IPv6 literals and legitimate IDN links all show
// "(host)".
//
// All scans are linear (loops and slices, no end-anchored regex over unbounded runs).

const LEADING_PUNCTUATION = "([\"'{<";
const TRAILING_PUNCTUATION = ")],;:!\"'}>";
const DEFAULT_PORT: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/** Remove brackets/quotes/sentence marks around a token; the dot is kept (it is part of an address). */
function trimTokenPunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && LEADING_PUNCTUATION.includes(value[start] as string)) start += 1;
  while (end > start && TRAILING_PUNCTUATION.includes(value[end - 1] as string)) end -= 1;
  return value.slice(start, end);
}

/** Drop exactly one trailing dot (the root label); "bank.com.." keeps one and so cannot equal a host. */
function dropOneTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** An internationalised host: some label is punycode. */
function hasPunycodeLabel(host: string): boolean {
  return host.startsWith("xn--") || host.includes(".xn--");
}

/** The text may be the destination host, or the host without the destination's own leading "www.". */
function sameHost(textHost: string, destinationHost: string): boolean {
  return (
    textHost === destinationHost ||
    (destinationHost.startsWith("www.") && textHost === destinationHost.slice(4))
  );
}

/** True when `text` is exactly the destination's host (and port), with nothing else. */
function isExactHost(text: string, destination: URL): boolean {
  const destinationHost = dropOneTrailingDot(destination.hostname);
  // A punycode destination always shows its host; a non-ASCII or percent-escaped text is never exactly a host.
  if (hasPunycodeLabel(destinationHost) || !isAscii(text) || text.includes("%")) return false;
  const defaultPort = DEFAULT_PORT[destination.protocol] ?? "";
  let rest = text;
  // A scheme in the text must be the destination's own; "//host" is scheme-relative. Any other "x://" stays in the
  // text, where it makes the authority differ from every host.
  if (rest.startsWith("https://")) {
    if (destination.protocol !== "https:") return false;
    rest = rest.slice(8);
  } else if (rest.startsWith("http://")) {
    if (destination.protocol !== "http:") return false;
    rest = rest.slice(7);
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }
  if (rest.endsWith("/")) rest = rest.slice(0, -1); // a lone trailing slash is still "just the host"
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i] as string;
    if (char === "/" || char === "?" || char === "#" || char === "\\" || char === "@") return false;
  }
  let authority = rest;
  let port = "";
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    port = authority.slice(colon + 1);
    if (port === "" || !Array.from(port).every((char) => char >= "0" && char <= "9")) return false;
    authority = authority.slice(0, colon);
  }
  // Raw comparison with the canonical host: IPv4 shorthands (127.1, 0x7f.1, 2130706433) and every other spelling
  // that only a URL parser would normalise are not "exactly" the host.
  if (!sameHost(dropOneTrailingDot(authority), destinationHost)) return false;
  // No port in the text means the default one, so the destination must be on it; otherwise the ports must agree.
  const destinationPort = destination.port || defaultPort;
  return port === "" ? destinationPort === defaultPort : port === destinationPort;
}

export function needsDestinationSuffix(visibleText: string, href: string): boolean {
  let destination: URL;
  try {
    destination = new URL(href);
  } catch {
    return true;
  }
  const token = trimTokenPunctuation(fold(visibleText));
  if (token === "") return true;
  if (destination.protocol === "mailto:") {
    const addresses = token.startsWith("mailto:") ? token.slice(7) : token;
    return addresses !== destination.pathname.toLowerCase();
  }
  return !isExactHost(token, destination);
}
