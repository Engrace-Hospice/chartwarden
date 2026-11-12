/**
 * Which tool names reach Claude Code's PreToolUse guard (wave 5, M1). Claude Code reads a hook `matcher` as an
 * exact list of names when it holds only letters, digits, `_` and `|` (checked against the 2.1.317 binary: the
 * test is `^[a-zA-Z0-9_|]+$`), as a regular expression otherwise, and `*` or an empty one as every tool. An MCP
 * tool is `mcp__<server>__<tool>`, so the targeted matcher is a regular expression and is anchored on both
 * sides: an unanchored one would also hand `mcp__x__navigate_xyz` to the guard. No run of Claude Code is needed
 * to prove coverage: the matcher is evaluated here against the tool names taken from real sessions.
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_MCP_GUARDED_TOOLS,
  CLAUDE_MCP_GUARD_MATCHER,
  CLAUDE_MCP_TOOLS_NOT_GUARDED,
  claudeGuardMatcherViolations,
  matcherCovers,
} from "../harness/hook-matcher";

const CORE = "Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit";

describe("matcherCovers: Claude Code's matcher semantics", () => {
  it("reads letters, digits, underscore and `|` as an exact list of names", () => {
    expect(matcherCovers(CORE, "Bash")).toBe(true);
    expect(matcherCovers(CORE, "NotebookEdit")).toBe(true);
    expect(matcherCovers(CORE, "Bas")).toBe(false);
    expect(matcherCovers(CORE, "BashOutput")).toBe(false);
    expect(matcherCovers(CORE, "mcp__claude-in-chrome__navigate")).toBe(false);
  });
  it("reads `*`, an empty matcher and a missing one as every tool", () => {
    for (const m of ["*", "", undefined])
      expect(matcherCovers(m, "mcp__x__y"), String(m)).toBe(true);
  });
  it("reads anything else as a regular expression, and an invalid one as matching nothing", () => {
    expect(matcherCovers("mcp__.*", "mcp__claude-in-chrome__computer")).toBe(true);
    expect(matcherCovers("^mcp__a$", "mcp__a")).toBe(true);
    expect(matcherCovers("^mcp__a$", "mcp__ab")).toBe(false);
    expect(matcherCovers("(unclosed", "(unclosed")).toBe(false);
  });
});

describe("the targeted MCP matcher", () => {
  it("is pinned to this literal", () => {
    expect(CLAUDE_MCP_GUARD_MATCHER).toBe(
      "^mcp__claude-in-chrome__(file_upload|upload_image|javascript_tool|navigate|browser_batch)$|^mcp__plugin_ecc_chrome-devtools__(upload_file|evaluate_script|navigate_page|new_page|take_screenshot|take_snapshot|take_heapsnapshot|performance_start_trace|performance_stop_trace|get_network_request|lighthouse_audit)$",
    );
  });
  it("covers every path- or exfil-capable tool, and only those, by their real names", () => {
    for (const tool of CLAUDE_MCP_GUARDED_TOOLS) {
      expect(matcherCovers(CLAUDE_MCP_GUARD_MATCHER, tool), tool).toBe(true);
      // Anchored: neither a longer name nor a prefixed one reaches the guard.
      expect(matcherCovers(CLAUDE_MCP_GUARD_MATCHER, `${tool}_x`), `${tool}_x`).toBe(false);
      expect(matcherCovers(CLAUDE_MCP_GUARD_MATCHER, `x${tool}`), `x${tool}`).toBe(false);
    }
    // The tools the brief names, spelled as the session's tool list spells them.
    for (const tool of [
      "mcp__claude-in-chrome__file_upload",
      "mcp__claude-in-chrome__upload_image",
      "mcp__claude-in-chrome__javascript_tool",
      "mcp__claude-in-chrome__navigate",
      "mcp__claude-in-chrome__browser_batch",
      "mcp__plugin_ecc_chrome-devtools__upload_file",
      "mcp__plugin_ecc_chrome-devtools__evaluate_script",
      "mcp__plugin_ecc_chrome-devtools__navigate_page",
    ]) {
      expect(matcherCovers(CLAUDE_MCP_GUARD_MATCHER, tool), tool).toBe(true);
    }
  });
  it("does not reach the tools that carry no path: the hook is never run for them", () => {
    for (const tool of [
      ...CLAUDE_MCP_TOOLS_NOT_GUARDED,
      "mcp__claude-in-chrome__computer",
      "mcp__claude-in-chrome__find",
      "mcp__claude-in-chrome__read_page",
      "mcp__claude-in-chrome__get_page_text",
      "mcp__claude-in-chrome__gif_creator",
      "mcp__plugin_ecc_chrome-devtools__click",
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Google_Drive__create_file",
      "Bash",
      "Read",
    ]) {
      expect(matcherCovers(CLAUDE_MCP_GUARD_MATCHER, tool), tool).toBe(false);
    }
  });
});

describe("claudeGuardMatcherViolations", () => {
  const good = [CORE, CLAUDE_MCP_GUARD_MATCHER];
  it("is green on the committed pair", () => {
    expect(claudeGuardMatcherViolations(good)).toEqual([]);
  });
  it("fails when the MCP group is dropped", () => {
    expect(claudeGuardMatcherViolations([CORE]).join("\n")).toMatch(/pinned MCP matcher/);
  });
  it("fails when a tool is removed from, or added to, the pinned matcher", () => {
    const fewer = CLAUDE_MCP_GUARD_MATCHER.replace("|navigate", "");
    const more = CLAUDE_MCP_GUARD_MATCHER.replace("|navigate", "|navigate|computer");
    expect(claudeGuardMatcherViolations([CORE, fewer]).join("\n")).toMatch(/pinned MCP matcher/);
    expect(claudeGuardMatcherViolations([CORE, more]).join("\n")).toMatch(/pinned MCP matcher/);
  });
  it("fails when any group is widened to every MCP tool, to every tool, or to none in particular", () => {
    for (const wide of ["mcp__.*", "*", "", ".*", "mcp__claude-in-chrome__.*", "^mcp__"]) {
      const v = claudeGuardMatcherViolations([CORE, CLAUDE_MCP_GUARD_MATCHER, wide]).join("\n");
      expect(v, JSON.stringify(wide)).toMatch(/also matches `mcp__[^`]+`/);
    }
    // Widening the core matcher to `*` used to pass; it would now hand every connector's prose to the guard.
    expect(claudeGuardMatcherViolations(["*", CLAUDE_MCP_GUARD_MATCHER]).join("\n")).toMatch(
      /also matches/,
    );
  });
  it("reports a guarded tool that no group covers", () => {
    const broken = "^mcp__claude-in-chrome__(file_upload$";
    expect(claudeGuardMatcherViolations([CORE, broken]).join("\n")).toMatch(/pinned MCP matcher/);
  });
});
