/**
 * Claude Code's MCP tools through the guard (wave 5, M2). The PreToolUse matcher in `.claude/settings.json`
 * hands the guard only the MCP tools whose input can name a path (file uploads, `navigate` to a `file://`
 * URL, page JavaScript, the screenshot and trace tools that write a path: `hook-matcher.ts`). For one of them
 * every string value AND key of the input is split on every Unicode line break and into the words a tool could
 * open as a path (`mcp-tokens.ts`, shared with Codex), and each word is judged as a secret path and as a
 * protected path, as written and resolved from the session directory with symlinks followed.
 *
 * The answer is an ASK that names the tool and the category, never the value (a value may be a patient name in
 * a URL). Two differences from Codex, which judges every MCP tool and cannot ask: no PHI/credential text scan
 * here (the tools are chosen for their paths, and free text is not their concern), and an input too big, too
 * deep or not an object is an ask too, never a deny: a human decides, and a cap never turns a deny into an ask
 * because a deny is never reached in this mode.
 */
import { mcpStrings, withoutOddChars } from "./codex-patch";
import { FILE_URL, LINE_BREAKS, mcpPathCandidates, percentDecoded } from "./mcp-tokens";
import { secretPathReason } from "./patterns";
import { isProtectedPath } from "./protected-paths";

export type McpCategory = "secret path" | "harness path" | "hidden path" | "unjudgeable";

export interface McpFinding {
  readonly category: McpCategory;
  /** Names the tool and the category. Never a value from the input. */
  readonly reason: string;
}

/** A line this long is not a path (PATH_MAX is 4096): it is matched as written and never resolved on disk. */
const MAX_PATH_CHARS = 4096;
/** Paths resolved on disk in one call; past it the call is asked about (the work must fit the hook's timeout). */
const MAX_RESOLUTIONS = 20_000;
const MAX_TOOL_NAME_CHARS = 120;

const HARNESS_WHY = "part of the agent harness or the compliance record";

/** A path as the repo sees it: real paths on both sides, relative paths resolved from the session directory. */
export type ResolvePath = (path: string) => string;

class OverBudget extends Error {}

interface Hit {
  readonly category: McpCategory;
  /** A fixed description of the category. Never a value from the input. */
  readonly why: string;
}

const HIDDEN_WHY =
  "a value that becomes a secret or protected path once control or non-ASCII-space characters are removed, which a tool may strip";

/** Why `target` is off-limits, or undefined: a secret path first, then a path the harness protects. */
function sensitivity(target: string): Hit | undefined {
  const secret = secretPathReason(target);
  if (secret) return { category: "secret path", why: secret };
  if (isProtectedPath(target)) return { category: "harness path", why: HARNESS_WHY };
  return undefined;
}

function finding(tool: string, category: McpCategory, why: string): McpFinding {
  const name = tool.length > MAX_TOOL_NAME_CHARS ? `${tool.slice(0, MAX_TOOL_NAME_CHARS)}…` : tool;
  const named =
    category === "unjudgeable"
      ? `The MCP tool \`${name}\` has an input the guard could not judge (${why}).`
      : `The MCP tool \`${name}\` has a ${category} in its input (${why}).`;
  return { category, reason: `${named} Approve only if you meant the tool to open or write it.` };
}

/**
 * What separates words in code and in a URL query: whitespace, quotes, brackets, `< >`, `, ; | :`, `=`, `+`,
 * `!`, `&` and `?`. The Codex word split stops at whitespace and `, ; | :` and trims quotes and brackets only at
 * a word's edges, so a `fetch("file:///x/y").then(r)` call stays one word that does not end in the file's
 * name; page JavaScript is the tool's input here, so a path inside a call is a word of its own.
 */
const CODE_DELIMITERS = /[\s"'`()[\]{}<>,;|:=+!&?\u0085\u2028\u2029]+/;

/** The words of one line split at {@link CODE_DELIMITERS}, `file://` removed and percent-decoded. */
function codeWords(written: string): string[] {
  return written
    .replace(FILE_URL, " ")
    .split(CODE_DELIMITERS)
    .map(percentDecoded)
    .filter((word) => word.length >= 2 && word.length <= MAX_PATH_CHARS);
}

/** The candidate paths of one trimmed line: as written, resolved, and each word of it, as written and resolved. */
function* pathWords(written: string, resolve: ResolvePath): Generator<string> {
  yield written;
  if (written.length <= MAX_PATH_CHARS) yield resolve(written);
  for (const token of [...mcpPathCandidates(written), ...codeWords(written)]) {
    yield token;
    if (token.includes("/")) yield resolve(token);
  }
}

/** A line that reads as a secret or protected path only once control, format and non-ASCII-space characters are removed. */
function hiddenPath(line: string, written: string, resolve: ResolvePath): boolean {
  const bare = withoutOddChars(line).trim();
  if (!bare || bare === written || bare.length > MAX_PATH_CHARS) return false;
  return [bare, resolve(bare)].some((target) => sensitivity(target) !== undefined);
}

function judgeLine(line: string, resolve: ResolvePath): Hit | undefined {
  const written = line.trim();
  if (!written) return undefined;
  for (const target of pathWords(written, resolve)) {
    const hit = sensitivity(target);
    if (hit) return hit;
  }
  return hiddenPath(line, written, resolve)
    ? { category: "hidden path", why: HIDDEN_WHY }
    : undefined;
}

/**
 * The first secret or protected path word in an MCP tool's input, as an ask-worthy finding; undefined when there
 * is none. `resolve` turns a path into the repo-relative real path (symlinks followed) the session would open.
 */
export function claudeMcpFinding(
  tool: string,
  input: unknown,
  resolve: ResolvePath,
): McpFinding | undefined {
  const got = mcpStrings(input);
  if (!got.ok) return finding(tool, "unjudgeable", got.reason);
  let resolved = 0;
  const counted: ResolvePath = (path) => {
    if (++resolved > MAX_RESOLUTIONS) throw new OverBudget();
    return resolve(path);
  };
  try {
    for (const value of got.strings) {
      for (const line of value.split(LINE_BREAKS)) {
        const hit = judgeLine(line, counted);
        if (hit) return finding(tool, hit.category, hit.why);
      }
    }
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    return finding(
      tool,
      "unjudgeable",
      `more than ${MAX_RESOLUTIONS} path-like words to resolve, past what the guard can resolve inside its timeout`,
    );
  }
  return undefined;
}
