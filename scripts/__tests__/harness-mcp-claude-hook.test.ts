/**
 * Claude Code MCP tools through the REAL pinned hook command (wave 5, M3): the command from
 * `.claude/settings.json` is spawned with a PreToolUse payload on stdin, as Claude Code does, and the answer is
 * read from its stdout. Which tools reach the hook at all is proved through the committed matchers against the
 * real tool names (36 of them, taken from this repo's sessions); no Claude Code run is needed for that.
 * Payloads are only judged, never executed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_GUARDED_TOOLS, matcherCovers } from "../harness/hook-matcher";

const ROOT = join(__dirname, "../..");
const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
const groups: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
  settings.hooks.PreToolUse;
const codexCommand: string = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8")).hooks
  .PreToolUse[0].hooks[0].command;

/** Built from parts: the repo's own guard refuses a shell command whose text names a live env file. */
const LIVE_ENV = ["apps/backend/", ".", "env"].join("");
const CHROME = "mcp__claude-in-chrome__";
const DEVTOOLS = "mcp__plugin_ecc_chrome-devtools__";

/** What Claude Code does for a tool name: the groups whose matcher covers it run their hooks. */
const hooksFor = (tool: string): string[] =>
  groups
    .filter((g) => matcherCovers(g.matcher, tool))
    .flatMap((g) => g.hooks.map((h) => h.command));

const hookEnv = (): Record<string, string> => ({
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && !["CW_HARNESS_FAIL_OPEN", "CW_HARNESS_ROOT_FOR_TESTS"].includes(e[0]),
    ),
  ) as Record<string, string>),
  CW_AGENT_LEDGER: "off",
  CLAUDE_PROJECT_DIR: ROOT,
});

interface Answer {
  readonly decision: string;
  readonly reason: string;
  readonly status: number | null;
  readonly ms: number;
}

/** Spawn every hook command Claude Code would run for `tool`, the strictest answer wins. */
function claudeAnswer(tool: string, input: Record<string, unknown>): Answer {
  const commands = hooksFor(tool);
  expect(commands.length, `a hook runs for ${tool}`).toBeGreaterThan(0);
  const answers = commands.map((command) => spawnHook(command, tool, input));
  const rank = (a: Answer): number => ["allow", "ask", "deny"].indexOf(a.decision);
  return answers.reduce((worst, a) => (rank(a) > rank(worst) ? a : worst));
}

function spawnHook(command: string, tool: string, input: Record<string, unknown>): Answer {
  const started = performance.now();
  const r = spawnSync("/bin/sh", ["-c", command], {
    cwd: ROOT,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "mcp-claude-hook",
      tool_name: tool,
      tool_input: input,
      cwd: ROOT,
    }),
    encoding: "utf8",
    env: hookEnv(),
    timeout: 20_000,
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : undefined;
  return {
    decision: out?.permissionDecision ?? (r.status === 2 ? "deny" : "allow"),
    reason: out?.permissionDecisionReason ?? "",
    status: r.status,
    ms: performance.now() - started,
  };
}

describe("the committed matchers send exactly the path-capable MCP tools to the guard", () => {
  /** The tool names seen in this repo's Claude sessions (3,359 calls), plus the core tools. */
  const REAL_TOOLS = [
    "computer",
    "javascript_tool",
    "browser_batch",
    "navigate",
    "find",
    "read_network_requests",
    "tabs_context_mcp",
    "form_input",
    "resize_window",
    "tabs_close_mcp",
    "read_page",
    "get_page_text",
    "read_console_messages",
    "tabs_create_mcp",
    "gif_creator",
    "list_connected_browsers",
    "file_upload",
    "upload_image",
  ]
    .map((n) => `${CHROME}${n}`)
    .concat(
      [
        "take_screenshot",
        "evaluate_script",
        "navigate_page",
        "emulate",
        "fill",
        "new_page",
        "click",
        "take_snapshot",
        "resize_page",
        "list_network_requests",
        "list_console_messages",
        "close_page",
        "upload_file",
        "type_text",
        "fill_form",
        "take_heapsnapshot",
        "performance_start_trace",
        "performance_stop_trace",
        "get_network_request",
        "lighthouse_audit",
        "get_console_message",
      ].map((n) => `${DEVTOOLS}${n}`),
      ["mcp__pencil__execute", "mcp__pencil__get_app_state", "mcp__rea__binary_session"],
      ["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Google_Drive__create_file"],
    );

  it.each(REAL_TOOLS)("%s", (tool) => {
    const reaches = hooksFor(tool).length > 0;
    expect(reaches).toBe(CLAUDE_MCP_GUARDED_TOOLS.includes(tool));
  });
  it("never sends computer, find, read_page or a free-text connector to the guard", () => {
    for (const tool of [
      `${CHROME}computer`,
      `${CHROME}find`,
      `${CHROME}read_page`,
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Google_Drive__create_file",
    ]) {
      expect(hooksFor(tool), tool).toEqual([]);
    }
  });
  it("still sends the core tools to the guard, once each", () => {
    for (const tool of [
      "Bash",
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
    ]) {
      expect(hooksFor(tool), tool).toHaveLength(1);
    }
    for (const tool of CLAUDE_MCP_GUARDED_TOOLS) expect(hooksFor(tool), tool).toHaveLength(1);
  });
});

describe("the real pinned Claude hook asks about a path the MCP tool would open or write", () => {
  const asks: Array<[string, string, Record<string, unknown>, RegExp]> = [
    [
      "file_upload of a live env file",
      `${CHROME}file_upload`,
      { paths: [`${ROOT}/${LIVE_ENV}`], ref: "ref_1", tabId: 1 },
      /secret path/,
    ],
    [
      "file_upload of a relative live env file",
      `${CHROME}file_upload`,
      { paths: [LIVE_ENV], ref: "ref_1", tabId: 1 },
      /secret path/,
    ],
    [
      "file_upload of an SSH key",
      `${CHROME}file_upload`,
      { paths: ["~/.ssh/id_rsa"], ref: "ref_1", tabId: 1 },
      /secret path/,
    ],
    [
      "upload_file of a guard file",
      `${DEVTOOLS}upload_file`,
      { pageId: 1, uid: "1_1", filePaths: ["scripts/harness/pre-tool-guard.ts"] },
      /agent harness/,
    ],
    [
      "upload_file of a hook file",
      `${DEVTOOLS}upload_file`,
      { pageId: 1, uid: "1_1", filePaths: [".claude/hooks/x"] },
      /agent harness/,
    ],
    [
      "navigate to a file:// URL of a live env file",
      `${CHROME}navigate`,
      { url: `file://${ROOT}/${LIVE_ENV}`, tabId: 1 },
      /secret path/,
    ],
    [
      "javascript_tool code that names a secret path",
      `${CHROME}javascript_tool`,
      {
        action: "javascript_exec",
        tabId: 1,
        text: `fetch("file://${ROOT}/${LIVE_ENV}").then(r => r.text())`,
      },
      /secret path/,
    ],
    [
      "take_screenshot written over a guard file",
      `${DEVTOOLS}take_screenshot`,
      { pageId: 1, filePath: "scripts/harness/guard-judge.ts" },
      /agent harness/,
    ],
    [
      "browser_batch with a navigate to a live env file",
      `${CHROME}browser_batch`,
      {
        actions: [
          { name: "computer", input: { action: "screenshot", tabId: 1 } },
          { name: "navigate", input: { url: `file://${ROOT}/${LIVE_ENV}`, tabId: 1 } },
        ],
      },
      /secret path/,
    ],
  ];
  it.each(asks)("%s", (_name, tool, input, reason) => {
    const a = claudeAnswer(tool, input);
    expect(a.decision, a.reason).toBe("ask");
    expect(a.status).toBe(0);
    expect(a.reason).toContain(tool);
    expect(a.reason).toMatch(reason);
    // The reason never echoes the path it is about.
    expect(a.reason).not.toContain("id_rsa");
    expect(a.reason).not.toContain("pre-tool-guard");
    expect(a.reason).not.toContain(LIVE_ENV);
  });
});

describe("the real pinned Claude hook allows everyday MCP calls and keeps its other answers", () => {
  const allows: Array<[string, string, Record<string, unknown>]> = [
    [
      "navigate to localhost",
      `${CHROME}navigate`,
      { url: "https://localhost:3000/login", tabId: 1 },
    ],
    [
      "javascript_tool reading the title",
      `${CHROME}javascript_tool`,
      { action: "javascript_exec", tabId: 1, text: "document.title" },
    ],
    [
      "file_upload of a screenshot in /tmp",
      `${CHROME}file_upload`,
      { paths: ["/tmp/screenshot.png"], ref: "ref_1", tabId: 1 },
    ],
    [
      "upload_image of a docs path",
      `${CHROME}upload_image`,
      { imageId: "ss_1", filename: "docs/design/screens/login.png", tabId: 1 },
    ],
    [
      "evaluate_script reading the title",
      `${DEVTOOLS}evaluate_script`,
      { pageId: 1, function: "() => document.title" },
    ],
    [
      "take_screenshot into audit/",
      `${DEVTOOLS}take_screenshot`,
      { pageId: 1, filePath: "audit/shot.png" },
    ],
  ];
  it.each(allows)("%s", (_name, tool, input) => {
    const a = claudeAnswer(tool, input);
    expect(a.decision, a.reason).toBe("allow");
    expect(a.status).toBe(0);
  });
  it("answers the shell and read controls as before", () => {
    expect(claudeAnswer("Bash", { command: "git status --short" }).decision).toBe("allow");
    expect(claudeAnswer("Bash", { command: "bun run test" }).decision).toBe("allow");
    expect(claudeAnswer("Bash", { command: "rg foo scripts" }).decision).toBe("allow");
    expect(claudeAnswer("Bash", { command: 'git commit -m "x"' }).decision).toBe("allow");
    expect(claudeAnswer("Read", { file_path: `${ROOT}/${LIVE_ENV}` }).decision).toBe("deny");
  });
  it("answers each MCP call well inside the hook's budget", () => {
    const a = claudeAnswer(`${CHROME}navigate`, { url: "https://localhost:3000/login", tabId: 1 });
    // Loose on purpose (a loaded CI box): the guard has a hard 10 s deadline, a normal call takes ~100 ms.
    expect(a.ms).toBeLessThan(5000);
  });
});

describe("the real pinned Codex hook is unchanged: it still denies, never asks", () => {
  const run = (tool: string, input: Record<string, unknown>) =>
    spawnHook(codexCommand, tool, input);
  it("denies a live env file in a file upload, and allows localhost", () => {
    const denied = run(`${CHROME}file_upload`, { paths: [LIVE_ENV], ref: "r", tabId: 1 });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/is a live environment file/);
    expect(
      run(`${CHROME}navigate`, { url: "https://localhost:3000/login", tabId: 1 }).decision,
    ).toBe("allow");
  });
  it("judges a tool Claude's matcher never sends, as it always did", () => {
    expect(
      run("mcp__claude_ai_Gmail__send_message", { body: "see compliance/controls.yaml" }).decision,
    ).toBe("deny");
  });
});
