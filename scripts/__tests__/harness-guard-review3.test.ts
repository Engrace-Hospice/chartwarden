/**
 * Third round of the 2026-11-09 adversarial review of `pre-tool-guard.ts`: Codex's `workdir`, a cwd and repo root
 * that name the same directory through different text (a symlinked `/tmp`), exotic characters in MCP strings, and
 * a `tsconfig.json` that rewrites the guard's own imports. Each test spawns the real hook, as the agent does, and
 * every deny case has a nearby everyday call that must stay allowed.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

/** The environment a hook runs in, minus the two switches that would turn the ledger off or the guard open. */
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "CW_AGENT_LEDGER" && e[0] !== "CW_HARNESS_FAIL_OPEN",
    ),
  );

function run(args: string[], payload: Record<string, unknown>, env: Record<string, string>): Out {
  const r = spawnSync("bun", [GUARD, ...args], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "r3", ...payload }),
    encoding: "utf8",
    env,
  });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

/** Codex: the repo root is pinned to `root` through the test-only seam. */
const codex = (root: string, payload: Record<string, unknown>): Out =>
  run(["--codex"], { cwd: root, ...payload }, { ...baseEnv(), CW_HARNESS_ROOT_FOR_TESTS: root });

/** Claude Code: the repo root is `CLAUDE_PROJECT_DIR`; `cwd` is the session's current directory. */
const claude = (root: string, payload: Record<string, unknown>): Out =>
  run([], { cwd: root, ...payload }, { ...baseEnv(), CLAUDE_PROJECT_DIR: root });

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

const put = (root: string, rel: string, text = ""): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** A repo-shaped directory: the protected trees, an app directory and a TLS directory holding a key. */
const repo = (): string => {
  const root = scratch("cw-review3-");
  for (const d of ["scripts/harness", "compliance", ".githooks", "apps/backend"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  put(root, "deploy/production/tls/server.key", "x");
  put(root, "apps/backend/package.json", "{}");
  return root;
};

describe("finding 3: Codex `workdir` is where a shell command runs, so its relative targets resolve from it", () => {
  const root = repo();
  const bash = (command: string, workdir?: unknown) =>
    codex(root, { tool_name: "Bash", tool_input: { command, workdir } });

  it.each([
    ["echo x > pre-tool-guard.ts", "scripts/harness"],
    ["tee patterns.ts < /tmp/x", "scripts/harness"],
    ["echo x > controls.yaml", "compliance"],
    ["sed -i s/a/b/ pre-commit", ".githooks"],
    ["echo x > io.ts", join(root, "scripts/harness")],
    ["echo x > ../scripts/harness/io.ts", "apps"],
    ["cat server.key", "deploy/production/tls"],
  ])("refuses `%s` run in %s", (command, workdir) => {
    const r = bash(command, workdir);
    expect(decision(r), `${command} @ ${workdir}`).toBe("deny");
  });

  it.each([5, 0, true, ["scripts"], { dir: "scripts" }])(
    "refuses a workdir that is not text (%j) for an otherwise harmless command, and logs it",
    (workdir) => {
      const r = bash("ls", workdir);
      expect(decision(r)).toBe("deny");
      expect(reason(r)).toMatch(/workdir/);
      const last = ledgerEntries(root).at(-1);
      expect(last).toMatchObject({ decision: "deny", tool: "codex/Bash" });
      expect(last?.reason).toMatch(/workdir/);
    },
  );

  it("keeps everyday calls with a workdir allowed", () => {
    for (const [command, workdir] of [
      ["echo x > notes.txt", "apps/backend"],
      ["ls", "apps/backend"],
      ["cat package.json", "apps/backend"],
      ["cat package.json", join(root, "apps/backend")],
      ["git status", "."],
      ["ls", ""],
      ["ls", null],
      ["ls", undefined],
      ["cat package.json", "apps/../apps/backend"],
    ] as const) {
      expect(decision(bash(command, workdir)), `${command} @ ${workdir}`).toBeUndefined();
    }
  });

  it("keeps a workdir that leaves the repo from granting a protected target by name alone", () => {
    // Same file names, but in a directory that is not the repo's protected tree.
    const elsewhere = scratch("cw-review3-else-");
    put(elsewhere, "scripts/harness/x.ts");
    expect(decision(bash("echo x > x.ts", join(elsewhere, "scripts/harness")))).toBeUndefined();
  });
});

describe("finding 9: cwd and repo root are compared as real paths, not as text", () => {
  const root = repo();
  const holder = scratch("cw-review3-link-");
  const alias = join(holder, "alias");
  symlinkSync(root, alias);
  const WRITE = "echo x > scripts/harness/pre-tool-guard.ts";

  it("Claude: a cwd that is a symlink to the root still protects a relative write", () => {
    const r = claude(root, { tool_name: "Bash", tool_input: { command: WRITE }, cwd: alias });
    expect(decision(r)).toBe("ask");
  });
  it("Claude: a root that is a symlink to the cwd still protects a relative write", () => {
    const r = claude(alias, { tool_name: "Bash", tool_input: { command: WRITE }, cwd: root });
    expect(decision(r)).toBe("ask");
  });
  it("Codex: a cwd that is a symlink to the root is refused", () => {
    const r = codex(root, { tool_name: "Bash", tool_input: { command: WRITE }, cwd: alias });
    expect(decision(r)).toBe("deny");
  });
  it("Claude: an absolute write through the root's own text is still protected", () => {
    const r = claude(alias, {
      tool_name: "Bash",
      tool_input: { command: `echo x > ${alias}/scripts/harness/io.ts` },
      cwd: root,
    });
    expect(decision(r)).toBe("ask");
  });
  it("Claude: a Read of an innocent-looking symlink whose target is a secret file is refused", () => {
    put(root, "tls/live.key", "x");
    symlinkSync(join(root, "tls/live.key"), join(root, "notes.txt"));
    const r = claude(root, { tool_name: "Read", tool_input: { file_path: `${alias}/notes.txt` } });
    expect(decision(r)).toBe("deny");
    const fine = claude(root, {
      tool_name: "Read",
      tool_input: { file_path: `${alias}/apps/backend/package.json` },
    });
    expect(decision(fine)).toBeUndefined();
  });
  it("keeps everyday calls from a symlinked cwd allowed", () => {
    for (const command of ["git status", "echo x > notes.txt", "ls apps"]) {
      const r = claude(root, { tool_name: "Bash", tool_input: { command }, cwd: alias });
      expect(decision(r), command).toBeUndefined();
    }
    const r = codex(root, { tool_name: "Bash", tool_input: { command: "ls apps" }, cwd: alias });
    expect(decision(r)).toBeUndefined();
  });
});
