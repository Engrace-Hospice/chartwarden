/**
 * Claude Code MCP tools reach the guard (wave 5, M2). For a tool the PreToolUse matcher hands over (file
 * uploads, `navigate`, page JavaScript, the screenshot and trace tools that write a path) the guard splits every
 * string value AND key of the input on every Unicode line break and into path-like words, judges each word as a
 * secret path and as a protected path (as written, and resolved from the session directory with symlinks
 * followed, like Codex), and ASKS, naming the tool and the category, never the value. No PHI/credential text
 * scan in Claude mode. Codex is unchanged: it still scans text and still turns every ask into a deny.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeHook } from "../harness/guard-judge";
import { claudeMcpFinding } from "../harness/mcp-claude";
import { ISSUED_SSN } from "./_fixtures";

const ROOT = join(__dirname, "../..");
/** Built from parts: the repo's own guard refuses a shell command whose text names a live env file. */
const LIVE_ENV = ["apps/backend/", ".", "env"].join("");
const ABSOLUTE_LIVE_ENV = `${ROOT}/${LIVE_ENV}`;
const CHROME = "mcp__claude-in-chrome__";
const DEVTOOLS = "mcp__plugin_ecc_chrome-devtools__";

type Hook = Parameters<typeof judgeHook>[0];
const hook = (tool: string, input: Record<string, unknown>, cwd = ROOT): Hook => ({
  hook_event_name: "PreToolUse",
  session_id: "mcp-claude",
  tool_name: tool,
  tool_input: input,
  cwd,
});

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.CW_AGENT_LEDGER = "off";
  process.env.CLAUDE_PROJECT_DIR = ROOT;
  process.env.CW_HARNESS_FAIL_OPEN = "";
});
afterAll(() => {
  process.env = savedEnv;
});

const claude = (tool: string, input: Record<string, unknown>, cwd?: string) =>
  judgeHook(hook(tool, input, cwd), false);
const codex = (tool: string, input: Record<string, unknown>) => judgeHook(hook(tool, input), true);

describe("Claude mode asks for a path word that is secret or protected", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    [
      "file_upload of a live env file",
      `${CHROME}file_upload`,
      { paths: [ABSOLUTE_LIVE_ENV], ref: "ref_1", tabId: 1 },
    ],
    [
      "file_upload of a relative live env file",
      `${CHROME}file_upload`,
      { paths: [LIVE_ENV], ref: "ref_1", tabId: 1 },
    ],
    [
      "file_upload of an SSH key",
      `${CHROME}file_upload`,
      { paths: ["~/.ssh/id_rsa"], ref: "ref_1", tabId: 1 },
    ],
    [
      "upload_file of a protected harness file",
      `${DEVTOOLS}upload_file`,
      { filePaths: ["scripts/harness/pre-tool-guard.ts"], pageId: 1, uid: "1_1" },
    ],
    [
      "upload_file of .claude/hooks/x",
      `${DEVTOOLS}upload_file`,
      { filePaths: [".claude/hooks/x"], pageId: 1, uid: "1_1" },
    ],
    [
      "navigate to a file:// URL of a live env file",
      `${CHROME}navigate`,
      { url: `file://${ABSOLUTE_LIVE_ENV}`, tabId: 1 },
    ],
    [
      "navigate to a percent-encoded file:// URL",
      `${CHROME}navigate`,
      { url: `file://${ROOT}/apps/backend/%2Eenv`, tabId: 1 },
    ],
    [
      "javascript_tool code that names a secret path",
      `${CHROME}javascript_tool`,
      {
        action: "javascript_exec",
        tabId: 1,
        text: `await fetch("file://${ABSOLUTE_LIVE_ENV}").then(r => r.text())`,
      },
    ],
    [
      "evaluate_script that writes its output to a protected path",
      `${DEVTOOLS}evaluate_script`,
      {
        pageId: 1,
        function: "() => document.title",
        filePath: "scripts/harness/pre-tool-guard.ts",
      },
    ],
    [
      "take_screenshot written over a guard file",
      `${DEVTOOLS}take_screenshot`,
      { pageId: 1, filePath: `${ROOT}/scripts/harness/guard-judge.ts` },
    ],
    [
      "browser_batch whose inner navigate opens a live env file",
      `${CHROME}browser_batch`,
      { actions: [{ name: "navigate", input: { url: `file://${ABSOLUTE_LIVE_ENV}`, tabId: 1 } }] },
    ],
    ["a key (not a value) that is a secret path", `${CHROME}javascript_tool`, { [LIVE_ENV]: "x" }],
    [
      "a path on one line of several",
      `${CHROME}javascript_tool`,
      { text: `const a = 1;\n${LIVE_ENV}\nconst b = 2;` },
    ],
    [
      "a bare dotfile name among other words of a list",
      `${CHROME}javascript_tool`,
      { text: "upload a.txt, .npmrc now" },
    ],
    [
      "a single percent-encoded name that is a database dump",
      `${CHROME}file_upload`,
      { paths: ["backup%2Edump"], ref: "r", tabId: 1 },
    ],
    [
      "a path with spaces in it, judged whole",
      `${CHROME}file_upload`,
      { paths: ["/Users/me/My Docs/server key.pem"], ref: "r", tabId: 1 },
    ],
    [
      "a path with a slash inside code, even one that ends like a property",
      `${CHROME}javascript_tool`,
      { text: "const k = await fetch('/srv/certs/server.pem')" },
    ],
    [
      "a path after a Unicode line break (U+2028)",
      `${CHROME}javascript_tool`,
      { text: `ok\u2028${LIVE_ENV}` },
    ],
    [
      "a secret path behind a trailing NEL",
      `${CHROME}file_upload`,
      { paths: [`${LIVE_ENV}\u0085`], ref: "r", tabId: 1 },
    ],
    [
      "a secret path with a zero-width space in its name, which a tool may strip",
      `${CHROME}file_upload`,
      { paths: [LIVE_ENV.replace("/.", "/.\u200b")], ref: "r", tabId: 1 },
    ],
    [
      "a protected path with a soft hyphen in it",
      `${CHROME}file_upload`,
      { paths: ["scripts/har\u00adness/guard-judge.ts"], ref: "r", tabId: 1 },
    ],
  ];
  it.each(cases)("%s", (_name, tool, input) => {
    const a = claude(tool, input);
    expect(a.decision).toBe("ask");
    // The reason names the tool and the category, never the value.
    expect(a.reason).toContain(tool);
    expect(a.reason).not.toContain(LIVE_ENV);
    expect(a.reason).not.toContain("id_rsa");
    expect(a.reason).not.toContain("pre-tool-guard");
  });
  it("names the category: secret path against harness path", () => {
    expect(claude(`${CHROME}file_upload`, { paths: [LIVE_ENV] }).reason).toMatch(/secret path/);
    expect(claude(`${CHROME}file_upload`, { paths: [".claude/hooks/x"] }).reason).toMatch(
      /agent harness or the compliance record/,
    );
  });
  it("resolves a symlink from the session directory, as Codex does: a whole line and a word in a list", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-claude-")));
    try {
      mkdirSync(join(dir, "scripts/harness"), { recursive: true });
      mkdirSync(join(dir, "apps/backend"), { recursive: true });
      writeFileSync(join(dir, "scripts/harness/guard.ts"), "x\n");
      writeFileSync(join(dir, LIVE_ENV), "x\n");
      // Innocent names that point at a protected directory and at a live env file.
      symlinkSync(join(dir, "scripts/harness"), join(dir, "shots"));
      symlinkSync(join(dir, LIVE_ENV), join(dir, "photo.png"));
      process.env.CLAUDE_PROJECT_DIR = dir;
      const ask = (paths: string[]) =>
        judgeHook(hook(`${CHROME}file_upload`, { paths }, dir), false);
      expect(ask(["shots/guard.ts"]).reason).toMatch(/agent harness or the compliance record/);
      expect(ask(["a.txt, shots/guard.ts"]).reason).toMatch(
        /agent harness or the compliance record/,
      );
      expect(ask(["photo.png"]).reason).toMatch(/secret path/);
      // Next to them, an ordinary path in the same session is fine.
      expect(ask(["docs/readme.png"]).decision).toBe("allow");
    } finally {
      process.env.CLAUDE_PROJECT_DIR = ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude mode allows everyday MCP calls", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    [
      "navigate to localhost",
      `${CHROME}navigate`,
      { url: "https://localhost:3000/login", tabId: 1 },
    ],
    [
      "navigate to a public page",
      `${CHROME}navigate`,
      { url: "https://example.com/docs/guide?x=1", tabId: 1 },
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
      { imageId: "ss_1", filename: "docs/design/screens/x.png", tabId: 1 },
    ],
    [
      "file_upload of the committed env template",
      `${CHROME}file_upload`,
      { paths: ["apps/backend/.env.example"], ref: "r", tabId: 1 },
    ],
    [
      "take_screenshot into the repo's audit directory",
      `${DEVTOOLS}take_screenshot`,
      { pageId: 1, filePath: `${ROOT}/audit/shot.png` },
    ],
    [
      "a batch of ordinary browser steps",
      `${CHROME}browser_batch`,
      {
        actions: [
          { name: "navigate", input: { url: "http://localhost:5173/patients", tabId: 7 } },
          { name: "computer", input: { action: "screenshot", tabId: 7 } },
        ],
      },
    ],
    [
      "prose that mentions PHI-shaped numbers is no concern of the path judge",
      `${CHROME}javascript_tool`,
      { text: `document.body.innerText = 'SSN ${ISSUED_SSN}'` },
    ],
    ["an empty input", `${CHROME}navigate`, {}],
    [
      "a property access that ends like a key file (the one real false positive in 1,268 calls)",
      `${CHROME}browser_batch`,
      {
        actions: [
          {
            name: "javascript_tool",
            input: {
              text: "document.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })",
            },
          },
        ],
      },
    ],
    [
      "dotted identifiers that end like a live env file, a dump or a backup",
      `${CHROME}javascript_tool`,
      { text: "const mode = process.env\nconsole.log(config.env, row.dump, backup.bak)" },
    ],
  ];
  it.each(cases)("%s", (_name, tool, input) => {
    expect(claude(tool, input)).toEqual({ decision: "allow", reason: "" });
  });
});

describe("a tool that is not an MCP tool does not take this path", () => {
  it("leaves Read, Edit and Bash to their own judgement", () => {
    // The same live-env word in a non-MCP tool's unrelated field is not judged by the MCP path judge.
    expect(claude("Bash", { command: "echo hello" }).decision).toBe("allow");
    expect(claude("Read", { file_path: `${ROOT}/package.json` }).decision).toBe("allow");
    expect(claude("Read", { file_path: ABSOLUTE_LIVE_ENV }).decision).toBe("deny");
    expect(claude("Task", { prompt: `look at ${LIVE_ENV}` }).decision).toBe("allow");
  });
  it("does not run the PHI/credential text scan in Claude mode", () => {
    const input = { text: `SSN ${ISSUED_SSN}` };
    expect(claude(`${CHROME}javascript_tool`, input).decision).toBe("allow");
  });
});

describe("Claude mode never denies an MCP call, and fails toward asking", () => {
  it("asks about an input too deep or too large to judge", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 40; i++) deep = { a: deep };
    const a = claude(`${CHROME}browser_batch`, deep as Record<string, unknown>);
    expect(a.decision).toBe("ask");
    expect(a.reason).toContain(`${CHROME}browser_batch`);
    const big = claude(`${CHROME}javascript_tool`, { text: "a".repeat(300_000) });
    expect(big.decision).toBe("ask");
  });
  it("asks about an input that is not an object", () => {
    const a = judgeHook(
      {
        ...hook(`${CHROME}navigate`, {}),
        tool_input: "nope" as unknown as Record<string, unknown>,
      },
      false,
    );
    expect(a.decision).toBe("ask");
  });
  it("is not a deny when the live env file is named inside a large batch", () => {
    const actions = Array.from({ length: 300 }, (_, i) => ({
      name: "navigate",
      input: { url: `http://localhost:3000/p/${i}`, tabId: 1 },
    }));
    actions.push({ name: "navigate", input: { url: `file://${ABSOLUTE_LIVE_ENV}`, tabId: 1 } });
    expect(claude(`${CHROME}browser_batch`, { actions }).decision).toBe("ask");
  });
});

describe("claudeMcpFinding (pure)", () => {
  const rel = (p: string): string => p;
  it("finds nothing in ordinary input", () => {
    expect(
      claudeMcpFinding(`${CHROME}navigate`, { url: "http://localhost:3000/", tabId: 1 }, rel),
    ).toBeUndefined();
  });
  it("reports the first sensitive word with its category and no value", () => {
    const f = claudeMcpFinding(
      `${CHROME}file_upload`,
      { paths: ["a.txt, scripts/harness/x"] },
      rel,
    );
    expect(f?.category).toBe("harness path");
    expect(f?.reason).not.toContain("scripts/harness/x");
  });
  it("caps the paths it resolves and asks instead of resolving without end", () => {
    const text = Array.from({ length: 30_000 }, (_, i) => `a${i}/b`).join("\n");
    const f = claudeMcpFinding(`${CHROME}javascript_tool`, { text }, rel);
    expect(f?.category).toBe("unjudgeable");
  });
});

describe("Codex is exactly as before", () => {
  const pinned: Array<[string, string, Record<string, unknown>, "deny" | "allow", RegExp | null]> =
    [
      [
        "a live env file path",
        `${CHROME}file_upload`,
        { paths: [LIVE_ENV] },
        "deny",
        /is a live environment file/,
      ],
      [
        "a harness path",
        `${CHROME}file_upload`,
        { paths: ["scripts/harness/pre-tool-guard.ts"] },
        "deny",
        /agent harness or the compliance record/,
      ],
      [
        "a file:// URL of a live env file",
        `${CHROME}navigate`,
        { url: `file://${ABSOLUTE_LIVE_ENV}` },
        "deny",
        /is a live environment file/,
      ],
      [
        "PHI-shaped text (the SSN scan)",
        `${CHROME}javascript_tool`,
        { text: `x = '${ISSUED_SSN}'` },
        "deny",
        /an MCP tool argument/,
      ],
      [
        "an everyday call",
        `${CHROME}navigate`,
        { url: "http://localhost:3000/login" },
        "allow",
        null,
      ],
      [
        "a tool Claude's matcher never sends",
        "mcp__claude-in-chrome__computer",
        { action: "screenshot", tabId: 1 },
        "allow",
        null,
      ],
      [
        "free text naming a protected path",
        "mcp__claude_ai_Gmail__send_message",
        { body: "see compliance/controls.yaml" },
        "deny",
        /agent harness or the compliance record/,
      ],
    ];
  it.each(pinned)("%s", (_name, tool, input, decision, reason) => {
    const a = codex(tool, input);
    expect(a.decision).toBe(decision);
    if (reason) expect(a.reason).toMatch(reason);
    // Codex has no ask: the notice that every ask is refused is added only to what Claude would have asked.
    if (decision === "deny") expect(a.reason).toContain("[chartwarden-harness]");
  });
  it("answers deny wherever Claude answers ask, for the same path word", () => {
    for (const [, tool, input] of cases()) {
      const c = claude(tool, input);
      const x = codex(tool, input);
      expect(c.decision, tool).toBe("ask");
      expect(x.decision, tool).toBe("deny");
    }
  });
  it("still scans PHI text in Codex while Claude lets the same text through", () => {
    const input = { text: `patient SSN ${ISSUED_SSN}` };
    expect(codex(`${CHROME}javascript_tool`, input).decision).toBe("deny");
    expect(claude(`${CHROME}javascript_tool`, input).decision).toBe("allow");
  });
});

function cases(): Array<[string, string, Record<string, unknown>]> {
  return [
    ["env", `${CHROME}file_upload`, { paths: [LIVE_ENV] }],
    ["ssh", `${CHROME}file_upload`, { paths: ["~/.ssh/id_rsa"] }],
    ["harness", `${DEVTOOLS}upload_file`, { filePaths: ["scripts/harness/pre-tool-guard.ts"] }],
    ["url", `${CHROME}navigate`, { url: `file://${ABSOLUTE_LIVE_ENV}` }],
    ["code", `${CHROME}javascript_tool`, { text: `fetch('file://${ABSOLUTE_LIVE_ENV}')` }],
  ];
}
