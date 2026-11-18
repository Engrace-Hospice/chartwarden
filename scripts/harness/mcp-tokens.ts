/**
 * The words inside one line of an MCP tool's input that could be a path (2026-11-10 review, ADV-L2). Codex hands
 * an MCP tool arbitrary JSON, so the guard judges every string in it; a line that IS a path was always judged, but
 * `a.txt, scripts/harness/x`, `a;b`, `a|b`, `a:b`, a `file://` URL, a quoted or percent-encoded path, and a path
 * inside a JSON string value (`{"path":"..."}`) were not. Each is split into the tokens a tool could read as a
 * path, and each token is judged exactly as a whole line is. A string that merely MENTIONS a protected or secret
 * path in prose is therefore refused too: the guard cannot tell prose from a path the tool will open, and a
 * refusal there costs a rephrase.
 */

/** Characters a tool may take as a line break: CR, LF, NUL, VT, FF, FS, GS, RS, NEL, U+2028, U+2029. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the point
export const LINE_BREAKS = /[\r\n\0\v\f\u001c-\u001e\u0085\u2028\u2029]/;

/** Separators between paths in a list: whitespace, `,` `;` `|` `:`, and the brackets and quotes JSON puts around one. */
const SEPARATORS = /[\s,;|:\u0085\u2028\u2029]+/;
const EDGE_PUNCTUATION = /^[\s"'`()[\]{}<>]+|[\s"'`()[\]{}<>]+$/g;
/** A `file://` URL prefix. Global: use it with `replace`, never `test` (a global regex keeps its position). */
export const FILE_URL = /file:\/\/(?:localhost)?/gi;
/** A line this long is not a path (PATH_MAX is 4096): it is matched as written and never resolved on disk. */
export const MAX_PATH_CHARS = 4096;
/** Tokens taken from one line; the rest of an enormous line is still judged as a whole. */
const MAX_TOKENS_PER_LINE = 512;

/** The text with `%2F`-style escapes undone; as written when it is not valid percent-encoding. */
export function percentDecoded(text: string): string {
  if (!text.includes("%")) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The words of `text` that a tool could open as a path: split, de-quoted, `file://` stripped, percent-decoded. */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(FILE_URL, " ").split(SEPARATORS)) {
    const token = percentDecoded(raw.replace(EDGE_PUNCTUATION, ""));
    if (token.length >= 2 && token.length <= MAX_PATH_CHARS) out.push(token);
    if (out.length >= MAX_TOKENS_PER_LINE) break;
  }
  return out;
}

/**
 * The extra candidates to judge for one trimmed `line`: the line percent-decoded, and its tokens. The line as
 * written is the caller's own candidate; nothing here repeats it.
 */
export function mcpPathCandidates(line: string): string[] {
  const candidates = new Set<string>();
  const decoded = percentDecoded(line.replace(FILE_URL, ""));
  if (decoded !== line && decoded.length <= MAX_PATH_CHARS) candidates.add(decoded.trim());
  for (const token of [...tokensOf(line), ...(decoded === line ? [] : tokensOf(decoded))]) {
    candidates.add(token);
  }
  candidates.delete(line);
  candidates.delete("");
  return [...candidates];
}
