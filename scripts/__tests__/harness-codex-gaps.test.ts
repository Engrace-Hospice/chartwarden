/**
 * Three small gaps from the 2026-11-10 adversarial review: ADV-L2 (an MCP string that holds a path among other
 * words, behind a `file://` URL, quotes, or percent-encoding, or after any Unicode line break), ADV-L4 (a NUL
 * byte in a shell command) and ADV-L5 (obfuscated spellings of `apply_patch` in a Codex shell command). Each
 * refusal is judged through the real hook; each has everyday input next to it that must stay allowed (exit 0,
 * nothing on stdout, nothing on stderr).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shellPatch } from "../harness/codex-patch";
import { LINE_BREAKS, mcpPathCandidates, percentDecoded } from "../harness/mcp-tokens";

const GUARD = join(__dirname, "../../scripts/harness/pre-tool-guard.ts");
const made: string[] = [];
const scratchRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-gaps-")));
  made.push(dir);
  for (const d of ["scripts/harness", "compliance", "apps/backend"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, "apps/backend/package.json"), "{}");
  return dir;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "CW_AGENT_LEDGER" && e[0] !== "CW_HARNESS_FAIL_OPEN",
    ),
  );

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  decision: string | undefined;
}
function hook(
  args: string[],
  payload: Record<string, unknown>,
  env: Record<string, string>,
): Result {
  const r = spawnSync("bun", [GUARD, ...args], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "gaps", ...payload }),
    encoding: "utf8",
    env,
  });
  const decision = r.stdout.trim()
    ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision
    : undefined;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, decision };
}
const codexIn = (root: string, payload: Record<string, unknown>): Result =>
  hook(["--codex"], { cwd: root, ...payload }, { ...baseEnv(), CW_HARNESS_ROOT_FOR_TESTS: root });
const claudeIn = (root: string, payload: Record<string, unknown>): Result =>
  hook([], { cwd: root, ...payload }, { ...baseEnv(), CLAUDE_PROJECT_DIR: root });

const expectAllowed = (r: Result, label: string): void => {
  expect(r.status, `${label}: ${r.stderr}`).toBe(0);
  expect(r.stdout, label).toBe("");
  expect(r.stderr, label).toBe("");
};

describe("ADV-L2: MCP strings are split into the words a tool could open as a path", () => {
  const root = scratchRepo();
  const mcp = (input: Record<string, unknown>) =>
    codexIn(root, { tool_name: "mcp__files__read", tool_input: input });

  describe("mcpPathCandidates", () => {
    it.each([
      ["a.txt, scripts/harness/x.ts", "scripts/harness/x.ts"],
      ["a.txt;scripts/harness/x.ts", "scripts/harness/x.ts"],
      ["a.txt|scripts/harness/x.ts", "scripts/harness/x.ts"],
      ["a.txt:scripts/harness/x.ts", "scripts/harness/x.ts"],
      ["a.txt \tscripts/harness/x.ts", "scripts/harness/x.ts"],
      ["file:///repo/scripts/harness/x.ts", "/repo/scripts/harness/x.ts"],
      ["file://localhost/repo/scripts/harness/x.ts", "/repo/scripts/harness/x.ts"],
      ['"scripts/harness/x.ts"', "scripts/harness/x.ts"],
      ["'scripts/harness/x.ts'", "scripts/harness/x.ts"],
      ['{"path":"scripts/harness/x.ts"}', "scripts/harness/x.ts"],
      ["scripts%2Fharness%2Fx.ts", "scripts/harness/x.ts"],
      ["file:///repo/scripts%2Fharness/x%2Ets", "/repo/scripts/harness/x.ts"],
      ["[scripts/harness/x.ts]", "scripts/harness/x.ts"],
    ])("finds the path in %j", (line, token) => {
      expect(mcpPathCandidates(line)).toContain(token);
    });
    it("does not repeat the line itself, and leaves a bad escape alone", () => {
      expect(mcpPathCandidates("scripts/harness/x.ts")).not.toContain("scripts/harness/x.ts");
      expect(percentDecoded("100%")).toBe("100%");
      expect(percentDecoded("a%2Fb")).toBe("a/b");
    });
    it("bounds the tokens taken from one line", () => {
      expect(
        mcpPathCandidates(Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ")).length,
      ).toBeLessThanOrEqual(512);
    });
    it.each([
      "\r",
      "\n",
      "\0",
      "\v",
      "\f",
      "\u001c",
      "\u001d",
      "\u001e",
      "\u0085",
      "\u2028",
      "\u2029",
    ])("treats U+%s as a line break", (ch) => expect(LINE_BREAKS.test(`a${ch}b`)).toBe(true));
  });

  it.each([
    ["a list separated by a comma", "a.txt, scripts/harness/pre-tool-guard.ts"],
    ["a semicolon", "a.txt;scripts/harness/pre-tool-guard.ts"],
    ["a pipe", "a.txt|scripts/harness/pre-tool-guard.ts"],
    ["a colon", "a.txt:scripts/harness/pre-tool-guard.ts"],
    ["whitespace", "a.txt scripts/harness/pre-tool-guard.ts"],
    ["a relative file URL", "file://scripts/harness/pre-tool-guard.ts"],
    ["quotes", '"compliance/controls.yaml"'],
    ["a JSON object in a string", '{"path":"compliance/controls.yaml"}'],
    ["percent-encoding", "compliance%2Fcontrols.yaml"],
    ["a percent-encoded separator", "a.txt%2Ccompliance/controls.yaml"],
    ["a percent-encoded space", "a.txt%20compliance/controls.yaml"],
    ["U+2028", "a.txt\u2028compliance/controls.yaml"],
    ["U+2029", "a.txt\u2029compliance/controls.yaml"],
    ["a vertical tab", "a.txt\vcompliance/controls.yaml"],
    ["a form feed", "a.txt\fcompliance/controls.yaml"],
    ["U+001C", "a.txt\u001ccompliance/controls.yaml"],
    ["U+001D", "a.txt\u001dcompliance/controls.yaml"],
    ["U+001E", "a.txt\u001ecompliance/controls.yaml"],
    ["U+0085", "a.txt\u0085compliance/controls.yaml"],
    ["a secret file among words", "read ./.env now"],
  ])("refuses a protected or secret path after %s", (_name, text) => {
    const r = mcp({ files: text });
    expect(r.decision, text).toBe("deny");
  });

  it("refuses an absolute file URL into the checkout and a percent-encoded one, and allows one elsewhere", () => {
    expect(mcp({ url: `file://${root}/scripts/harness/pre-tool-guard.ts` }).decision).toBe("deny");
    expect(mcp({ url: `file://${root}/scripts%2Fharness%2Fpre-tool-guard.ts` }).decision).toBe(
      "deny",
    );
    expectAllowed(mcp({ url: "file:///somewhere/else/scripts/harness/x.ts" }), "another tree");
  });

  it("judges words in an object key and in a nested array too", () => {
    expect(mcp({ "a.txt, compliance/controls.yaml": 1 }).decision).toBe("deny");
    expect(mcp({ list: [["a", "b; compliance/controls.yaml"]] }).decision).toBe("deny");
  });

  it.each([
    "Résumé de la visite",
    "line one\u2028line two",
    "see the environment-file discussion in the doc",
    "https://example.com/a/b?c=d&e=f",
    "meet at 14:30; bring notes, a pen | a laptop",
    "apps/backend/package.json",
    "docs/compliance-notes.md, apps/web/src/App.tsx",
    '{"query":"unpaid invoices","limit":20}',
    "100% sure",
    "file:///tmp/report.pdf",
  ])("allows everyday text %j", (text) => {
    expectAllowed(mcp({ text }), text);
  });

  it("a prose mention of a protected path is refused (the guard cannot tell prose from a path)", () => {
    expect(mcp({ note: "see compliance/controls.yaml for the register" }).decision).toBe("deny");
  });
});

describe("ADV-L4: a NUL byte in a shell command is refused", () => {
  const root = scratchRepo();
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

  it.each([
    ["Claude", (c: string) => claudeIn(root, bash(c))],
    ["Codex", (c: string) => codexIn(root, bash(c))],
  ] as const)("%s: denies a command with a NUL in it", (_agent, run) => {
    for (const cmd of ["echo hi\0; ls", "ls\0", "\0cat package.json"]) {
      const r = run(cmd);
      expect(r.status, r.stderr).toBe(0);
      expect(r.decision, JSON.stringify(cmd)).toBe("deny");
    }
  });

  it("allows the same command without it", () => {
    expectAllowed(claudeIn(root, bash("echo hi; ls")), "no NUL");
    expectAllowed(codexIn(root, bash("echo hi; ls")), "no NUL");
  });
});

describe("ADV-L5: obfuscated spellings of apply_patch in a Codex shell command are refused", () => {
  const PATCH = "*** Begin Patch\n*** Add File: notes.txt\n+x\n*** End Patch";
  const heredoc = (name: string) => `${name} <<'EOF'\n${PATCH}\nEOF`;

  it.each([
    ["a variable", `a=apply; \${a}_patch <<'EOF'\n${PATCH}\nEOF`],
    ["a variable without the underscore", `a=apply_; \${a}patch <<'EOF'\n${PATCH}\nEOF`],
    ["a command substitution", `$(echo apply)_patch <<'EOF'\n${PATCH}\nEOF`],
    ["quotes", heredoc("'apply'_patch")],
    ["double quotes", heredoc('"apply"_patch')],
    ["a backslash", heredoc("apply\\_patch")],
    ["quotes in the middle", heredoc('app""ly_patch')],
    ["upper case", heredoc("APPLY_PATCH")],
    ["mixed case", heredoc("Apply_Patch")],
    ["the name with no underscore, upper case", heredoc("APPLYPATCH")],
  ])("refuses %s", (_name, cmd) => {
    expect(shellPatch(cmd).kind, cmd).toBe("refuse");
  });

  it("still takes the one plain heredoc, and leaves unrelated commands alone", () => {
    expect(shellPatch(heredoc("apply_patch"))).toEqual({ kind: "patch", text: PATCH });
    for (const cmd of [
      "ls -la",
      "git apply --check x.patch",
      "git format-patch -1",
      "echo $FOO_PATCH_LEVEL",
      "bun run test",
      "rg applyPatches docs",
      'echo "it\'s a patch"',
    ]) {
      expect(shellPatch(cmd), cmd).toEqual({ kind: "none" });
    }
  });

  it("is refused through the real Codex hook, and the plain heredoc to an ordinary file is allowed", () => {
    const root = scratchRepo();
    const run = (command: string) => codexIn(root, { tool_name: "Bash", tool_input: { command } });
    expect(run(`a=apply; \${a}_patch <<'EOF'\n${PATCH}\nEOF`).decision).toBe("deny");
    expect(run(heredoc("'apply'_patch")).decision).toBe("deny");
    expectAllowed(run(heredoc("apply_patch")), "the plain heredoc");
  });
});
