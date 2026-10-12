// M36 WP 2.1 - decides whether a link must show its real destination inline.
//
// The rule is the simplest strong one: EVERY link shows its destination host, unless the visible text is exactly
// that host (plus the port when it is not the protocol's default) or, for mailto:, exactly the address list.
// "Exactly" is judged after one normalisation (NFKC, lower case, brackets/quotes/sentence marks around the token
// trimmed, scheme stripped, trailing dot dropped, punycode, leading www. on one side). Prose, brand names,
// look-alike scripts and unknown dot look-alikes all fall out the same way: they are not the host, so the host is
// shown. Noise is accepted by design (a link reading "the guide" shows "(host)" too; so does an IPv6 literal).
//
// Accepted equivalence: the text and the destination may differ by ONE leading "www." (evil.net vs www.evil.net).
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

function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") end -= 1;
  return host.slice(0, end);
}

/** The host equals the destination's, or differs from it by exactly one leading "www.". */
function sameHost(textHost: string, destinationHost: string): boolean {
  return (
    textHost === destinationHost ||
    `www.${textHost}` === destinationHost ||
    textHost === `www.${destinationHost}`
  );
}

/** True when `text` is exactly the destination's host (and port), with nothing else. */
function isExactHost(text: string, destination: URL): boolean {
  let rest = text;
  const defaultPort = DEFAULT_PORT[destination.protocol] ?? "";
  // A scheme in the text must be the destination's own; "//host" is scheme-relative. Any other "x://" stays in the
  // text, where it makes the authority unparseable.
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
  if (authority === "") return false;
  let host: string;
  try {
    host = stripTrailingDots(new URL(`${destination.protocol}//${authority}`).hostname);
  } catch {
    return false;
  }
  if (!sameHost(host, stripTrailingDots(destination.hostname))) return false;
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
