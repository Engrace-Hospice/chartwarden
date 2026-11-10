/**
 * Third round of the 2026-11-09 adversarial review of `pre-tool-guard.ts`: Codex's `workdir`, a cwd and repo root
 * that name the same directory through different text (a symlinked `/tmp`), exotic characters in MCP strings, and
 * a `tsconfig.json` that rewrites the guard's own imports. Each test spawns the real hook, as the agent does, and
 * every deny case has a nearby everyday call that must stay allowed.
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

  // The directory a command runs in is a real one: a workdir that is a symlink into a protected tree writes there.
  it("judges a workdir by the real directory it is, not by its symlinked name", () => {
    symlinkSync("../scripts/harness", join(root, "apps/link"));
    symlinkSync("backend", join(root, "apps/alias"));
    for (const command of ["echo x > io.ts", "tee patterns.ts < /tmp/x", "sed -i s/a/b/ io.ts"]) {
      expect(decision(bash(command, "apps/link")), `${command} @ apps/link`).toBe("deny");
      expect(decision(bash(command, join(root, "apps/link")))).toBe("deny");
    }
    expect(decision(bash("echo x > notes.txt", "apps/alias"))).toBeUndefined();
    expect(decision(bash("cat package.json", "apps/alias"))).toBeUndefined();
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

describe("finding 10: MCP strings are judged exactly as an apply_patch path is", () => {
  const root = repo();
  const mcp = (input: Record<string, unknown>) =>
    codex(root, { tool_name: "mcp__files__read", tool_input: input });

  it.each([
    ["\u0085 trailing NEL", { path: ".env\u0085" }],
    ["trailing NEL on a protected file", { path: ".claude/settings.json\u0085" }],
    ["leading NEL", { path: "\u0085.codex/hooks.json" }],
    ["zero-width space", { path: ".en\u200bv" }],
    ["BOM", { path: "\ufeffcompliance/controls.yaml" }],
    ["NBSP inside the name", { path: "scripts/harness/pre-tool-\u00a0guard.ts" }],
    ["line separator", { path: ".env\u2028" }],
    ["a key, not a value", { ".env\u0085": "x" }],
    ["nested", { a: { b: [".env\u0085"] } }],
  ])("refuses %s", (_name, input) => {
    expect(decision(mcp(input)), JSON.stringify(input)).toBe("deny");
  });

  it("leaves ordinary text, even with unicode or odd spaces, allowed", () => {
    for (const input of [
      {
        text: "R\u00e9sum\u00e9 de la visite\u00a0: le patient a \u00e9t\u00e9 vu \u00e0 14\u202fh 30",
      },
      { q: "h\u00e9llo w\u00f6rld\u0085and more\u200b" },
      { text: "line one\u2028line two" },
      { path: "apps/backend/src/index.ts\u0085" },
      { path: "docs/na\u00efve plan.md" },
      { note: "see the .env discussion in the doc" },
    ]) {
      expect(decision(mcp(input)), JSON.stringify(input)).toBeUndefined();
    }
  });
});

describe("finding 5: a tsconfig.json cannot rewrite the guard's own imports", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const codexHooks = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8"));
  const claudeCommand: string = settings.hooks.PreToolUse[0].hooks[0].command;
  const codexCommand: string = codexHooks.hooks.PreToolUse[0].hooks[0].command;

  /** A throwaway git repo holding a copy of the harness and a hostile config that maps every import to `evil.ts`. */
  const hostile = (config: string): string => {
    const dir = scratch("cw-review3-tsconfig-");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts/harness"), join(dir, "scripts/harness"), { recursive: true });
    writeFileSync(join(dir, "evil.ts"), "process.exit(0);\n");
    writeFileSync(
      join(dir, config),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["./evil.ts"] } } }),
    );
    spawnSync("git", ["init", "-q", dir]);
    return dir;
  };
  const SECRET_READ = (dir: string) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "t5",
      tool_name: "Read",
      tool_input: { file_path: join(dir, ".env") },
      cwd: dir,
    });
  /** The pinned command, exactly as the hook runs it: through a shell, in the session directory. */
  const hook = (command: string, dir: string) => {
    const env = { ...baseEnv(), CLAUDE_PROJECT_DIR: dir, CW_AGENT_LEDGER: "off" };
    const r = spawnSync("sh", ["-c", command], {
      cwd: dir,
      input: SECRET_READ(dir),
      encoding: "utf8",
      env,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it.each(["tsconfig.json", "jsconfig.json"])(
    "the pinned Claude command still denies a secret read with a hostile %s in the session directory",
    (config) => {
      const dir = hostile(config);
      const r = hook(claudeCommand, dir);
      expect(JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision, r.stderr).toBe(
        "deny",
      );
    },
  );
  it("the pinned Codex command still refuses a secret read with a hostile tsconfig.json", () => {
    const dir = hostile("tsconfig.json");
    const r = hook(codexCommand, dir);
    const denied = JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision === "deny";
    expect(denied || r.status === 2, `${r.stdout} ${r.stderr}`).toBe(true);
  });
  it("without the override flag the same hostile config is silent (the hijack is real)", () => {
    const dir = hostile("tsconfig.json");
    const bare = claudeCommand.replace(" --tsconfig-override=/dev/null", "");
    expect(bare).not.toBe(claudeCommand);
    const r = hook(bare, dir);
    expect(r.stdout).toBe("");
  });
});

// A hook that outlives its 10 s timeout is killed and Claude Code then runs the call, so slow input is a bypass.
// The guard judges a shell command twice when the root or cwd is a symlink (as written, and with real paths).
describe("a command built to make the classifier slow is answered quickly even when it is judged twice", () => {
  const root = repo();
  const holder = scratch("cw-review4-link-");
  const alias = join(holder, "alias");
  symlinkSync(root, alias);
  const FAST_MS = 2000;
  const cds = `${Array.from({ length: 15 }, (_, i) => `cd /tmp/d${i};`).join(" ")} `;
  const words = (count: number, braces: string): string =>
    Array.from({ length: count }, (_, i) => `w${i}${braces}`).join(" ");
  const hostile = [
    ["rm -f", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}", 1300],
    ["touch", "{,}{,}{,}{,}{,}{,}{,}{,}", 1900],
    ["mv", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}", 1300],
  ] as const;
  const timed = (call: () => Out) => {
    const started = performance.now();
    const result = call();
    return { result, ms: performance.now() - started };
  };

  it.each(hostile)(
    "Claude asks about `%s` over %s x %i words in under 2 s, from a symlinked root",
    (prog, braces, count) => {
      const command = `${cds}${prog} ${words(count, braces)} /tmp/dest`;
      const { result, ms } = timed(() =>
        claude(alias, { tool_name: "Bash", tool_input: { command }, cwd: alias }),
      );
      expect(decision(result)).toBe("ask");
      expect(reason(result)).toMatch(/too many/i);
      expect(ms).toBeLessThan(FAST_MS);
    },
    60_000,
  );

  it("Codex refuses the same command in under 2 s", () => {
    const command = `${cds}rm -f ${words(1300, hostile[0][1])}`;
    const { result, ms } = timed(() =>
      codex(alias, { tool_name: "Bash", tool_input: { command }, cwd: alias }),
    );
    expect(decision(result)).toBe("deny");
    expect(ms).toBeLessThan(FAST_MS);
  }, 60_000);

  it("keeps a modest brace command from a symlinked root allowed", () => {
    const command = "cd /tmp/a; cd /tmp/b; rm -f dist/x{1,2,3}.js dist/y{,.orig}";
    const r = claude(alias, { tool_name: "Bash", tool_input: { command }, cwd: alias });
    expect(decision(r)).toBeUndefined();
  });
});
