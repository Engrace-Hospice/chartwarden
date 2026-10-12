// M36 WP 2.1 - decides whether a link must show its real destination inline.
//
// A link's visible text is whatever the author typed. The rule is inverted from "does it look like an address":
// the destination is shown UNLESS the text is clearly plain prose, or names exactly the real host (and port). That
// way a dot look-alike the code does not know about (paypal<U+00B7>com) can only cost a redundant suffix, never hide
// one. Text that names a host is PARSED (scheme, userinfo, port, path, dots), not substring-matched.
//
// All scans are linear (loops and slices, no end-anchored regex over unbounded runs).
//
// Known limit (documented in the WP 2.1 note): only the directly adjacent text nodes are considered when a link
// sits inside a longer host-like token; a token spread over more nodes, or through a mention, is not reassembled.

export interface LinkNeighbours {
  /** Text of the inline node immediately before the link (or ""). */
  readonly before: string;
  /** Text of the inline node immediately after the link (or ""). */
  readonly after: string;
}

// Characters that read as a dot and that NFKC does not already map: ideographic full stop, halfwidth ideographic
// full stop, one dot leader, small full stop, fullwidth full stop. Anything else dot-like is simply "not prose".
const DOT_LOOKALIKES = /[\u3002\uFF61\u2024\uFE52\uFF0E]/g;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
const SPACE = /\s/u;
const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Han}/u,
  /\p{Script=Hiragana}/u,
  /\p{Script=Katakana}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
];
const TRAILING_PUNCTUATION = ")],;:!\"'}>";
const LEADING_PUNCTUATION = "([\"'{<";
const SENTENCE_PUNCTUATION = ",;:!?";
const INNER_PROSE_PUNCTUATION = "'\"()-";

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(DOT_LOOKALIKES, ".").trim();
}

/** Remove brackets/quotes/sentence marks around a token; the dot is kept (it is part of an address). */
function trimTokenPunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && LEADING_PUNCTUATION.includes(value[start] as string)) start += 1;
  while (end > start && TRAILING_PUNCTUATION.includes(value[end - 1] as string)) end -= 1;
  return value.slice(start, end);
}

function isWord(char: string): boolean {
  return LETTER_OR_DIGIT.test(char) || MARK.test(char);
}

/** The single script of a one-word text, or null when it mixes scripts. Digits and marks are script-neutral. */
function hasOneScript(word: string): boolean {
  const seen = new Set<number>();
  for (const char of word) {
    if (!/\p{L}/u.test(char)) continue;
    const index = SCRIPTS.findIndex((script) => script.test(char));
    seen.add(index); // -1 = a script outside the list, its own bucket
    if (seen.size > 1) return false;
  }
  return true;
}

/**
 * Clearly plain prose: letters, digits, spaces and ordinary sentence punctuation only. A lone word is prose only if
 * it is letters/digits of one script (no symbol, no dot, no hyphen). Several words may also carry sentence
 * punctuation (a mark followed by a space or the end) and inner quotes, brackets and hyphens, but never a dot, an @
 * or a slash inside a word, nor any symbol the list does not name (which is how unknown dot look-alikes fall out).
 */
function isPlainProse(text: string): boolean {
  const chars = Array.from(text);
  const multiWord = chars.some(
    (char, index) => SPACE.test(char) && index > 0 && index < chars.length - 1,
  );
  if (!multiWord) return chars.every(isWord) && hasOneScript(text);
  // Each word is one script: a look-alike letter from another script is how "paypal" gets forged.
  if (!text.split(/\s+/u).every(hasOneScript)) return false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    const next = chars[i + 1];
    const endsWord = next === undefined || SPACE.test(next);
    if (SPACE.test(char) || isWord(char) || INNER_PROSE_PUNCTUATION.includes(char)) continue;
    if (char === "." && i > 0 && endsWord) continue;
    if (SENTENCE_PUNCTUATION.includes(char) && endsWord) continue;
    return false;
  }
  return true;
}

function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") end -= 1;
  return host.slice(0, end);
}

function bareHost(host: string): string {
  const trimmed = stripTrailingDots(host);
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

/** True when `text` names exactly the destination's host and port. Only http(s):// and // schemes are stripped. */
function namesDestination(text: string, destination: URL): boolean {
  let rest = text;
  if (rest.startsWith("https://")) rest = rest.slice(8);
  else if (rest.startsWith("http://")) rest = rest.slice(7);
  else if (rest.startsWith("//")) rest = rest.slice(2);
  let cut = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i] as string;
    if (char === "/" || char === "?" || char === "#" || char === "\\") {
      cut = i;
      break;
    }
  }
  let authority = rest.slice(0, cut);
  if (authority === "" || authority.includes("@")) return false; // userinfo-looking text is never "the host"
  let port = "";
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    const digits = authority.slice(colon + 1);
    if (!Array.from(digits).every((char) => char >= "0" && char <= "9")) return false;
    port = digits;
    authority = authority.slice(0, colon);
  }
  let host: string;
  try {
    host = bareHost(new URL(`https://${authority}`).hostname);
  } catch {
    return false;
  }
  if (host !== bareHost(destination.hostname)) return false;
  // No port in the text means the default one, so the destination must be on it; otherwise the ports must agree.
  return port === "" ? destination.port === "" : port === (destination.port || "443");
}

function suffixFor(text: string, destination: URL): boolean {
  // Prose is judged on the text as typed (NFKC would turn a trademark sign into the letters "tm"); the host
  // comparison is made on the folded form.
  const typed = trimTokenPunctuation(text.normalize("NFC").trim());
  const token = trimTokenPunctuation(fold(text));
  if (token === "") return true;
  if (isPlainProse(typed)) return false;
  if (destination.protocol === "mailto:") {
    const address = token.startsWith("mailto:") ? token.slice(7) : token;
    return address !== destination.pathname.toLowerCase();
  }
  return !namesDestination(token, destination);
}

/** The non-space run that ends `value` / starts `value`, found by scanning from the edge (linear). */
function trailingRun(value: string): string {
  let start = value.length;
  while (start > 0 && !SPACE.test(value[start - 1] as string)) start -= 1;
  return value.slice(start);
}
function leadingRun(value: string): string {
  let end = 0;
  while (end < value.length && !SPACE.test(value[end] as string)) end += 1;
  return value.slice(0, end);
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
  if (visibleText.trim() === "") return true; // blank text tells the reader nothing
  const before = trailingRun(neighbours?.before ?? "");
  const after = leadingRun(neighbours?.after ?? "");
  if (suffixFor(`${before}${visibleText}${after}`, destination)) return true;
  // A neighbour may continue the token, but it must not be the one that supplies the host: the link's own text
  // has to stand on its own too.
  return before !== "" || after !== "" ? suffixFor(visibleText, destination) : false;
}
