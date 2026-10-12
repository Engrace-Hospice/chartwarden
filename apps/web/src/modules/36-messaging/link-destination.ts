// M36 WP 2.1 - decides whether a link must show its real destination inline.
//
// A link's visible text is whatever the author typed. If that text looks like an address (a dot, an @, a scheme
// separator) it is PARSED to the host a reader would take it for and compared with the real destination host;
// a substring test is not enough (`evil.net.bank.com`, `bank.com/evil.net`, `bank.com@evil.net` all contain
// `evil.net`). Plain words ("the guide") never need the suffix.
//
// Known limit (documented in the WP 2.1 note): only the directly adjacent text nodes are considered when a link
// sits inside a longer host-like token; a token split across more than one neighbouring node is not reassembled.

export interface LinkNeighbours {
  /** Text of the inline node immediately before the link (or ""). */
  readonly before: string;
  /** Text of the inline node immediately after the link (or ""). */
  readonly after: string;
}

// Characters that read as a dot: ideographic full stop, halfwidth ideographic full stop, one dot leader, small
// full stop, fullwidth full stop. Folded to "." after NFKC, before the dot test.
const DOT_LOOKALIKES = /[\u3002\uFF61\u2024\uFE52\uFF0E]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(DOT_LOOKALIKES, ".").trim();
}

function looksLikeAddress(folded: string): boolean {
  return /[.@]|:\/\//.test(folded);
}

function bareHost(host: string): string {
  return host.replace(/\.+$/, "").replace(/^www\./, "");
}

/** The host the visible text names, in punycode, or null when it names none that can be parsed. */
function hostNamedBy(folded: string): string | null {
  const authority = (folded.replace(SCHEME, "").split(/[/?#\\]/)[0] ?? "").replace(/:\d*$/, "");
  if (authority === "" || authority.includes("@")) return null; // userinfo-looking text is never "the host"
  try {
    return bareHost(new URL(`https://${authority}`).hostname);
  } catch {
    return null;
  }
}

export function needsDestinationSuffix(
  visibleText: string,
  href: string,
  neighbours?: LinkNeighbours,
): boolean {
  let destination: URL;
  try {
    destination = new URL(href);
  } catch {
    return true;
  }
  const before = /\S*$/.exec(neighbours?.before ?? "")?.[0] ?? "";
  const after = /^\S*/.exec(neighbours?.after ?? "")?.[0] ?? "";
  const folded = fold(`${before}${visibleText}${after}`);
  if (!looksLikeAddress(folded)) return false;

  if (destination.protocol === "mailto:") {
    const address = destination.pathname.toLowerCase();
    return folded.replace(/^mailto:/, "") !== address;
  }
  const named = hostNamedBy(folded);
  return named === null || named !== bareHost(destination.hostname);
}
