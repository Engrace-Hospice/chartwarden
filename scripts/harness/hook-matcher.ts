/**
 * Which tool names reach Claude Code's PreToolUse guard, and the one matcher that sends it the MCP tools that
 * can name a path or carry a payload out (wave 5, M1). Pure data and pure functions, shared by the gate
 * (`arch:compliance`) and the tests.
 *
 * Claude Code reads a hook `matcher` as an exact list of names when it holds only letters, digits, `_` and `|`
 * (checked against the 2.1.317 binary: `^[a-zA-Z0-9_|]+$`), as a regular expression otherwise, and `*` or an
 * empty one as every tool. The MCP matcher is a regular expression (the server names hold `-`), so it is
 * anchored on both sides.
 *
 * Not `mcp__.*`: that would hand every connector (Gmail, Drive, Calendar) to a guard that reads path words,
 * and a message that merely names `.env` would be stopped. The tools below are the ones whose schema carries
 * a path, a URL or code (verified against the tool list of a real session, and against 3,359 real calls):
 * they read a local file into a page (`file_upload`, `upload_image`, `upload_file`, `navigate` to a
 * `file://` URL, `javascript_tool`, `evaluate_script`, `new_page`), run a batch of those (`browser_batch`
 * carries `{name, input}` items for `navigate`, `javascript_tool` and `file_upload`), or write a file the
 * agent names (`take_screenshot`, `take_snapshot`, `take_heapsnapshot`, the two trace tools,
 * `get_network_request`, `lighthouse_audit`, `evaluate_script`'s `filePath`).
 */

/** Tools with a path, URL or code in their input that the guard judges in Claude mode, ask-only. */
export const CLAUDE_MCP_GUARDED_TOOLS: readonly string[] = [
  "mcp__claude-in-chrome__file_upload",
  "mcp__claude-in-chrome__upload_image",
  "mcp__claude-in-chrome__javascript_tool",
  "mcp__claude-in-chrome__navigate",
  "mcp__claude-in-chrome__browser_batch",
  "mcp__plugin_ecc_chrome-devtools__upload_file",
  "mcp__plugin_ecc_chrome-devtools__evaluate_script",
  "mcp__plugin_ecc_chrome-devtools__navigate_page",
  "mcp__plugin_ecc_chrome-devtools__new_page",
  "mcp__plugin_ecc_chrome-devtools__take_screenshot",
  "mcp__plugin_ecc_chrome-devtools__take_snapshot",
  "mcp__plugin_ecc_chrome-devtools__take_heapsnapshot",
  "mcp__plugin_ecc_chrome-devtools__performance_start_trace",
  "mcp__plugin_ecc_chrome-devtools__performance_stop_trace",
  "mcp__plugin_ecc_chrome-devtools__get_network_request",
  "mcp__plugin_ecc_chrome-devtools__lighthouse_audit",
];

/** The second `PreToolUse` group's matcher in `.claude/settings.json`, pinned byte for byte by `arch:compliance`. */
export const CLAUDE_MCP_GUARD_MATCHER =
  "^mcp__claude-in-chrome__(file_upload|upload_image|javascript_tool|navigate|browser_batch)$|^mcp__plugin_ecc_chrome-devtools__(upload_file|evaluate_script|navigate_page|new_page|take_screenshot|take_snapshot|take_heapsnapshot|performance_start_trace|performance_stop_trace|get_network_request|lighthouse_audit)$";

/**
 * Real tools that must NOT reach the guard: they carry coordinates, element references, prose or a message
 * body, not a path. A matcher that covers one of them (`mcp__.*`, `*`, an empty matcher) fails the gate.
 */
export const CLAUDE_MCP_TOOLS_NOT_GUARDED: readonly string[] = [
  "mcp__claude-in-chrome__computer",
  "mcp__claude-in-chrome__find",
  "mcp__claude-in-chrome__read_page",
  "mcp__claude-in-chrome__get_page_text",
  "mcp__claude-in-chrome__form_input",
  "mcp__claude-in-chrome__read_network_requests",
  "mcp__claude-in-chrome__tabs_context_mcp",
  "mcp__plugin_ecc_chrome-devtools__click",
  "mcp__plugin_ecc_chrome-devtools__fill",
  "mcp__plugin_ecc_chrome-devtools__type_text",
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Google_Drive__create_file",
];

const EXACT_NAMES = /^[a-zA-Z0-9_|]+$/;

/** Whether Claude Code runs a hook with this `matcher` for the tool `tool`. */
export function matcherCovers(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (EXACT_NAMES.test(matcher)) {
    return matcher
      .split("|")
      .map((name) => name.trim())
      .includes(tool);
  }
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

/**
 * PURE. `matchers` are the matchers of the PreToolUse groups that run the guard. The MCP matcher must be there
 * byte for byte (a dropped, narrowed or edited one leaves a path-capable tool unjudged), every guarded tool
 * must be covered, and no group may also cover a tool that carries no path.
 */
export function claudeGuardMatcherViolations(matchers: readonly string[]): string[] {
  const v: string[] = [];
  if (!matchers.includes(CLAUDE_MCP_GUARD_MATCHER)) {
    v.push(
      `.claude/settings.json: no PreToolUse guard group has the pinned MCP matcher CLAUDE_MCP_GUARD_MATCHER from scripts/harness/hook-matcher.ts, so the path- and exfil-capable MCP tools (file uploads, navigate, javascript) run unjudged`,
    );
  }
  for (const tool of CLAUDE_MCP_GUARDED_TOOLS) {
    if (!matchers.some((m) => matcherCovers(m, tool))) {
      v.push(`.claude/settings.json: no PreToolUse guard matcher covers \`${tool}\``);
    }
  }
  for (const matcher of matchers) {
    const wide = CLAUDE_MCP_TOOLS_NOT_GUARDED.find((tool) => matcherCovers(matcher, tool));
    if (wide) {
      v.push(
        `.claude/settings.json: the PreToolUse guard matcher \`${matcher}\` also matches \`${wide}\`, a tool with no path in its input: list the path-capable MCP tools (CLAUDE_MCP_GUARD_MATCHER) instead of a blanket \`mcp__.*\` or \`*\`, which would stop free-text connectors for prose that merely names a file`,
      );
    }
  }
  return v;
}
