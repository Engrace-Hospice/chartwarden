/**
 * The Codex guard (`pre-tool-guard.ts --codex`), second round of the 2026-11-09 adversarial review: MCP tools,
 * the repo root the guard resolves in production, the fail-open switch, the ledger's effective decision and
 * the places a non-string input used to be coerced and judged. Each test spawns the real hook, as Codex does.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Fixture values are assembled at runtime so this file does not trip the scanner it tests.
const ISSUED_SSN = ["524", "71", "3388"].join("-");
const AWS_KEY = ["AKIA", "Z".repeat(16)].join("");
const ROOT = join(__dirname, "../..");
const GUARD = join(ROOT, "scripts/harness/pre-tool-guard.ts");

const made: string[] = [];
const scratch = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

type Out = { status: number | null; out: Record<string, any> | null };
const decision = (r: Out): string | undefined => r.out?.hookSpecificOutput?.permissionDecision;
const reason = (r: Out): string => r.out?.hookSpecificOutput?.permissionDecisionReason ?? "";
const patchOf = (...body: string[]): string =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
const applyPatch = (...body: string[]) => ({
  tool_name: "apply_patch",
  tool_input: { command: patchOf(...body) },
});

/** The guard with its repo root pinned to `root` (the test-only seam), as the other Codex suites run it. */
function codexGuard(
  root: string,
  input: Record<string, unknown>,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Out {
  const r = spawnSync("bun", [GUARD, "--codex"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "g1",
      cwd: opts.cwd ?? root,
      ...input,
    }),
    encoding: "utf8",
    env: { ...process.env, CW_HARNESS_ROOT_FOR_TESTS: root, ...opts.env },
  });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

function ledgerEntries(root: string): Array<Record<string, any>> {
  const dir = join(root, ".claude", "audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
}

describe("MCP tools (`mcp__<server>__<tool>`): every string in tool_input is judged", () => {
  const root = scratch("cw-mcp-");
  mkdirSync(join(root, "compliance"), { recursive: true });
  symlinkSync(join(root, "compliance"), join(root, "notes-link"));
  mkdirSync(join(root, "scripts/harness"), { recursive: true });
  const mcp = (tool_input: unknown, cwd = root, tool_name = "mcp__files__write") =>
    codexGuard(root, { tool_name, tool_input }, { cwd });

  it("is silent on an ordinary call, an empty object and non-string values", () => {
    expect(mcp({ path: "src/a.ts", content: "export const a = 1;" }).out).toBeNull();
    expect(mcp({}).out).toBeNull();
    expect(mcp({ limit: 5, deep: false, none: null, ids: [1, 2, 3] }).out).toBeNull();
    expect(mcp({ path: ".env.example" }).out).toBeNull();
  });

  it.each([
    [".env", { path: ".env" }],
    ["a nested array of objects", { files: [{ name: "a", path: "config/.env.production" }] }],
    ["a value under a key nobody would guess", { zz: { qq: ["id_rsa"] } }],
    ["a path as an object KEY", { files: { ".env": "A=1" } }],
    ["a second line of a string", { paths: "README.md\n.env" }],
    ["a credentials file of the tools", { path: ".codex/auth.json" }],
    ["a database dump", { path: "backups/prod.sql.gz" }],
  ])("denies a secret path: %s", (_name, input) => {
    const r = mcp(input);
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/Agents never read or write it/);
  });

  it.each([
    "compliance/controls.yaml",
    ".claude/settings.json",
    ".codex/hooks.json",
    "scripts/harness/patterns.ts",
    "bunfig.toml",
    "apps/web/.codex/config.toml",
    "../../home/.codex/hooks.json",
    "Scripts/Harness/patterns.ts",
  ])("denies the protected path %s", (path) => {
    const r = mcp({ operation: { target: path } });
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/harness or the compliance/);
  });
  it("resolves a relative value from the session cwd, as apply_patch does", () => {
    // From `sub`, `../compliance/controls.yaml` is only protected once it is resolved against the cwd.
    mkdirSync(join(root, "sub"), { recursive: true });
    const r = mcp({ path: "../compliance/controls.yaml" }, join(root, "sub"));
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/`compliance\/controls\.yaml` is part of the agent harness/);
    // And a value is not judged against the root when the cwd is a subdirectory.
    expect(mcp({ path: "controls.yaml" }, join(root, "sub")).out).toBeNull();
  });
  it("follows a symlink inside the repo into a protected directory", () => {
    expect(decision(mcp({ path: "notes-link/controls.yaml" }))).toBe("deny");
  });

  it("scans every string for PHI and credentials, whatever the key, and never echoes the value", () => {
    for (const input of [
      { content: `ssn: "${ISSUED_SSN}"` },
      { q: { deeper: [`note ${ISSUED_SSN}`] } },
      { body: `const k = "${AWS_KEY}";` },
    ]) {
      const r = mcp(input);
      expect(decision(r), JSON.stringify(Object.keys(input))).toBe("deny");
      expect(JSON.stringify(r.out)).not.toContain(ISSUED_SSN);
      expect(JSON.stringify(r.out)).not.toContain(AWS_KEY);
    }
  });
  it("does not echo a long or multi-word value when it names the offender", () => {
    const r = mcp({ note: `please read this ${"x ".repeat(150)}~/.ssh/config` });
    expect(decision(r)).toBe("deny");
    expect(JSON.stringify(r.out).length).toBeLessThan(2000);
    expect(reason(r)).toMatch(/A value in the tool input is the SSH configuration directory/);
    expect(reason(r)).not.toContain("please read this");
  });

  it.each([
    ["a string", "just text"],
    ["an array", ["a", "b"]],
    ["a number", 7],
    ["null", null],
    ["nothing", undefined],
  ])("denies a tool_input that is %s, not an object", (_name, value) => {
    const r = mcp(value);
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/not an object/);
  });
  it("denies an input nested past the depth it will walk, or holding too many strings or too much text", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { n: deep };
    expect(decision(mcp(deep as object))).toBe("deny");
    expect(decision(mcp({ ids: Array.from({ length: 3000 }, (_, i) => `id-${i}`) }))).toBe("deny");
    const huge = mcp({ text: "a".repeat(300_000) });
    expect(decision(huge)).toBe("deny");
    expect(reason(huge)).toMatch(/KB/);
  });
  it("judges the tool whatever the server and tool are called, and ledgers the denial as codex/<tool>", () => {
    const r = codexGuard(root, {
      tool_name: "mcp__other_server__do_thing",
      tool_input: { path: ".env" },
      session_id: "mcp-l",
    });
    expect(decision(r)).toBe("deny");
    const mine = ledgerEntries(root).filter((e) => e.session === "mcp-l");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tool: "codex/mcp__other_server__do_thing", decision: "deny" });
  });
  it("stays silent on a Codex tool it has no opinion about (not an MCP tool)", () => {
    expect(
      codexGuard(root, { tool_name: "update_plan", tool_input: { plan: [".env"] } }).out,
    ).toBeNull();
  });
});

describe("the root in --codex mode is where the guard's own script lives (the pinned hook command's repo)", () => {
  // Production sets neither variable: the hook inherits the developer's environment, minus the test seam.
  const {
    CW_HARNESS_ROOT_FOR_TESTS: _seam,
    CLAUDE_PROJECT_DIR: _project,
    ...CLEAN_ENV
  } = process.env;

  /** A temp git repo holding its own copy of scripts/harness, so the script's location IS the repo. */
  function makeRepo(): { repo: string; sub: string } {
    const repo = scratch("cw-repo-");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    cpSync(join(ROOT, "scripts/harness"), join(repo, "scripts/harness"), { recursive: true });
    const sub = join(repo, "sub/dir");
    mkdirSync(sub, { recursive: true });
    return { repo, sub };
  }
  /** The hook as production runs it: the repo's own script, from a subdirectory, no root override at all. */
  function production(
    repo: string,
    cwd: string,
    input: Record<string, unknown>,
    env: Record<string, string> = {},
  ): Out {
    const r = spawnSync("bun", [join(repo, "scripts/harness/pre-tool-guard.ts"), "--codex"], {
      cwd,
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "p1", cwd, ...input }),
      encoding: "utf8",
      env: { ...CLEAN_ENV, ...env },
    });
    return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  }

  it("denies a root-anchored protected patch from a subdirectory, and ledgers it at the repo root", () => {
    const { repo, sub } = makeRepo();
    const r = production(
      repo,
      sub,
      applyPatch("*** Update File: ../../compliance/controls.yaml", "@@", "+x"),
    );
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/`compliance\/controls\.yaml` is part of the agent harness/);
    expect(ledgerEntries(repo).some((e) => e.tool === "codex/apply_patch")).toBe(true);
    expect(existsSync(join(sub, ".claude"))).toBe(false);
  });
  it("stays silent on an ordinary patch from the same subdirectory", () => {
    const { repo, sub } = makeRepo();
    expect(
      production(repo, sub, applyPatch("*** Add File: src/x.ts", "+export const a = 1;")).out,
    ).toBeNull();
  });
  it("ignores CLAUDE_PROJECT_DIR in --codex mode: a Claude shell's export must not move the root", () => {
    const { repo, sub } = makeRepo();
    const elsewhere = scratch("cw-other-");
    const r = production(
      repo,
      sub,
      applyPatch("*** Update File: ../../compliance/controls.yaml", "@@", "+x"),
      { CLAUDE_PROJECT_DIR: elsewhere },
    );
    expect(decision(r)).toBe("deny");
    expect(ledgerEntries(repo).length).toBeGreaterThan(0);
    expect(existsSync(join(elsewhere, ".claude"))).toBe(false);
  });
  it("keeps Claude Code's root as CLAUDE_PROJECT_DIR (only --codex stopped reading it)", () => {
    const { repo } = makeRepo();
    const claudeRoot = scratch("cw-claude-root-");
    const r = spawnSync("bun", [join(repo, "scripts/harness/pre-tool-guard.ts")], {
      input: JSON.stringify({
        session_id: "cl1",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      }),
      encoding: "utf8",
      env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: claudeRoot },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(ledgerEntries(claudeRoot)).toHaveLength(1);
    expect(ledgerEntries(repo)).toHaveLength(0);
  });
});

describe("CW_HARNESS_FAIL_OPEN=1 in checkPatch", () => {
  const root = scratch("cw-failopen-");
  const FAIL_OPEN = { CW_HARNESS_FAIL_OPEN: "1" };
  const unreadable = { tool_name: "apply_patch", tool_input: { command: "not a patch" } };

  it("refuses a patch it cannot read by default, and lets it through for a human who set the switch", () => {
    expect(decision(codexGuard(root, unreadable))).toBe("deny");
    const open = codexGuard(root, unreadable, { env: FAIL_OPEN });
    expect(open.status).toBe(0);
    expect(open.out).toBeNull();
  });
  it("still judges a patch it CAN read", () => {
    const bad = applyPatch("*** Update File: compliance/controls.yaml", "@@", "+x");
    expect(decision(codexGuard(root, bad, { env: FAIL_OPEN }))).toBe("deny");
    const leak = applyPatch("*** Add File: a.test.ts", `+ssn: "${ISSUED_SSN}"`);
    expect(decision(codexGuard(root, leak, { env: FAIL_OPEN }))).toBe("deny");
  });
  it("still refuses a patch past the size the scan can finish in time: the switch is for unreadable, not unscannable", () => {
    const huge = {
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Begin Patch\n*** Add File: a.txt\n+${"a".repeat(300_000)}\n*** End Patch`,
      },
    };
    expect(decision(codexGuard(root, huge, { env: FAIL_OPEN }))).toBe("deny");
  });
});

describe("the ledger records the EFFECTIVE decision", () => {
  const root = scratch("cw-ledger-");
  const push = { tool_name: "Bash", tool_input: { command: "git push origin main" } };

  it("writes deny, not ask, for a Codex-mode ask — and ask for the same call under Claude Code", () => {
    const codex = codexGuard(root, { ...push, session_id: "eff-codex" });
    expect(decision(codex)).toBe("deny");
    const claude = spawnSync("bun", [GUARD], {
      input: JSON.stringify({ session_id: "eff-claude", ...push }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    expect(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision).toBe("ask");

    const entries = ledgerEntries(root);
    const forCodex = entries.filter((e) => e.session === "eff-codex");
    expect(forCodex).toHaveLength(1);
    expect(forCodex[0]).toMatchObject({ tool: "codex/Bash", decision: "deny" });
    expect(entries.filter((e) => e.decision === "ask").map((e) => e.session)).toEqual([
      "eff-claude",
    ]);
  });
});

describe("a non-string input is refused, never coerced to a string and judged (--codex)", () => {
  const root = scratch("cw-coerce-");
  const shell = (command: unknown, extra: Record<string, unknown> = {}, session = "co1") =>
    codexGuard(root, { tool_name: "Bash", tool_input: { command, ...extra }, session_id: session });
  const heredoc = (...body: string[]) => `apply_patch <<'EOF'\n${patchOf(...body)}\nEOF`;

  it.each([
    ["an array that spells a push", ["git push origin main"]],
    ["an array that spells a .env read", ["cat", ".env"]],
    ["an object", { cmd: "ls" }],
    ["a number", 7],
    ["null", null],
    ["a missing command", undefined],
  ])(
    "refuses a Bash command that is %s, with the not-text reason and a ledger entry",
    (_n, command) => {
      const session = `co-${_n}`;
      const r = shell(command, {}, session);
      expect(decision(r)).toBe("deny");
      expect(reason(r)).toMatch(/not text/);
      expect(reason(r)).not.toMatch(/Codex cannot ask/); // the classifier never saw `String(command)`
      expect(ledgerEntries(root).filter((e) => e.session === session)).toMatchObject([
        { tool: "codex/Bash", decision: "deny" },
      ]);
    },
  );
  it.each([
    ["a number", 5],
    ["an array", ["scripts/harness"]],
    ["an object", { path: "x" }],
    ["true", true],
  ])(
    "refuses a shell patch whose workdir is %s instead of judging it against the cwd",
    (_n, workdir) => {
      const r = shell(heredoc("*** Add File: src/x.ts", "+export const a = 1;"), { workdir });
      expect(decision(r)).toBe("deny");
      expect(reason(r)).toMatch(/workdir/);
    },
  );
  it("still takes a plain string workdir, an empty one, or none", () => {
    const patch = heredoc("*** Add File: src/x.ts", "+export const a = 1;");
    expect(shell(patch, { workdir: root }).out).toBeNull();
    expect(shell(patch, { workdir: "" }).out).toBeNull();
    expect(shell(patch, { workdir: null }).out).toBeNull();
    expect(shell(patch).out).toBeNull();
  });
  it("refuses an edit-tool field the guard would scan as `String(value)`", () => {
    const r = codexGuard(root, {
      tool_name: "Write",
      tool_input: { file_path: join(root, "a.ts"), content: { text: ISSUED_SSN } },
    });
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toMatch(/not text/);
  });
  it("refuses an apply_patch input that is not text", () => {
    expect(
      decision(codexGuard(root, { tool_name: "apply_patch", tool_input: { command: ["x"] } })),
    ).toBe("deny");
  });
});
