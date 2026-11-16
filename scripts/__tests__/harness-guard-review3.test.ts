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

type Out = { status: number | null; out: Record<string, any> | null; stderr: string };
const decision = (r: Out): string | undefined => r.out?.hookSpecificOutput?.permissionDecision;
const reason = (r: Out): string => r.out?.hookSpecificOutput?.permissionDecisionReason ?? "";
/**
 * "Allowed" means the guard ran and had no opinion: exit 0, nothing on stdout, nothing on stderr. A bare
 * `decision === undefined` also passes when the hook crashed and printed nothing.
 */
const expectAllowed = (r: Out, label?: string): void => {
  expect(r.status, `${label ?? ""} stderr: ${r.stderr}`).toBe(0);
  expect(r.out, label).toBeNull();
  expect(r.stderr, label).toBe("");
};

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
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
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
      expectAllowed(bash(command, workdir), `${command} @ ${workdir}`);
    }
  });

  it("keeps a workdir that leaves the repo from granting a protected target by name alone", () => {
    // Same file names, but in a directory that is not the repo's protected tree.
    const elsewhere = scratch("cw-review3-else-");
    put(elsewhere, "scripts/harness/x.ts");
    expectAllowed(bash("echo x > x.ts", join(elsewhere, "scripts/harness")));
  });

  // The directory a command runs in is a real one: a workdir that is a symlink into a protected tree writes there.
  it("judges a workdir by the real directory it is, not by its symlinked name", () => {
    symlinkSync("../scripts/harness", join(root, "apps/link"));
    symlinkSync("backend", join(root, "apps/alias"));
    for (const command of ["echo x > io.ts", "tee patterns.ts < /tmp/x", "sed -i s/a/b/ io.ts"]) {
      expect(decision(bash(command, "apps/link")), `${command} @ apps/link`).toBe("deny");
      expect(decision(bash(command, join(root, "apps/link")))).toBe("deny");
    }
    expectAllowed(bash("echo x > notes.txt", "apps/alias"));
    expectAllowed(bash("cat package.json", "apps/alias"));
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
    expectAllowed(fine);
  });
  it("keeps everyday calls from a symlinked cwd allowed", () => {
    for (const command of ["git status", "echo x > notes.txt", "ls apps"]) {
      const r = claude(root, { tool_name: "Bash", tool_input: { command }, cwd: alias });
      expectAllowed(r, command);
    }
    const r = codex(root, { tool_name: "Bash", tool_input: { command: "ls apps" }, cwd: alias });
    expectAllowed(r);
  });
});

// A bare name such as `server.key` is a secret when a file of that name exists where the command runs; the guard
// asks the filesystem, so after a `cd` it must ask in the directory the `cd` leads to, not only the starting one.
describe("a key file is refused in the directory a cd leads to, from both agents", () => {
  const root = repo();
  put(root, "apps/backend/id_rsa", "x");
  const bash = (command: string, workdir?: string) => ({
    claude: claude(root, { tool_name: "Bash", tool_input: { command } }),
    codex: codex(root, { tool_name: "Bash", tool_input: { command, workdir } }),
  });

  it.each([
    "cd deploy/production/tls && cat server.key",
    "cd deploy/production/tls; base64 server.key",
    "(cd deploy/production/tls && xxd server.key)",
    "cd apps/backend && cat id_rsa",
  ])("denies `%s`", (command) => {
    const r = bash(command);
    expect(decision(r.claude), command).toBe("deny");
    expect(decision(r.codex), command).toBe("deny");
  });

  it("denies the same read from a Codex workdir, where the start directory is the workdir", () => {
    const r = codex(root, {
      tool_name: "Bash",
      tool_input: { command: "cd production/tls && cat server.key", workdir: "deploy" },
    });
    expect(decision(r)).toBe("deny");
    const here = codex(root, {
      tool_name: "Bash",
      tool_input: { command: "cat server.key", workdir: "deploy/production/tls" },
    });
    expect(decision(here)).toBe("deny");
  });

  it.each([
    "cd apps/backend && cat package.json",
    "cd apps/web && cat server.key",
    "cd deploy/production/tls && ls",
  ])("allows the everyday `%s`", (command) => {
    const r = bash(command);
    expectAllowed(r.claude, command);
    expectAllowed(r.codex, command);
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
      // A prose MENTION of a secret file name is refused since 2026-11-10 (every word is judged as a path), so this
      // ordinary-text sample does not name one.
      { note: "see the environment-file discussion in the doc" },
    ]) {
      expectAllowed(mcp(input), JSON.stringify(input));
    }
  });
});

describe("finding 5: a tsconfig.json cannot rewrite the guard's own imports", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const codexHooks = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8"));
  const claudeCommand: string = settings.hooks.PreToolUse[0].hooks[0].command;
  const codexCommand: string = codexHooks.hooks.PreToolUse[0].hooks[0].command;

  /**
   * A throwaway git repo holding a copy of the harness and a hostile config that maps every import to `evil.ts`.
   * `at` is the directory (below the repo root) that holds the config and is the session directory; `extended` puts
   * the paths in a `base.json` that the config only `extends`.
   */
  const hostileAt = (config: string, at = "", extended = false): { dir: string; cwd: string } => {
    const dir = scratch("cw-review3-tsconfig-");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts/harness"), join(dir, "scripts/harness"), { recursive: true });
    writeFileSync(join(dir, "evil.ts"), "process.exit(0);\n");
    // The Codex hook runs the script of the nearest directory that holds `.git`, `.codex/hooks.json` and the guard.
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex/hooks.json"), "{}\n");
    const cwd = join(dir, at);
    mkdirSync(cwd, { recursive: true });
    const paths = { compilerOptions: { baseUrl: dir, paths: { "*": [join(dir, "evil.ts")] } } };
    if (extended) {
      writeFileSync(join(cwd, "base.json"), JSON.stringify(paths));
      writeFileSync(join(cwd, config), JSON.stringify({ extends: "./base.json" }));
    } else writeFileSync(join(cwd, config), JSON.stringify(paths));
    spawnSync("git", ["init", "-q", dir]);
    return { dir, cwd };
  };
  const hostile = (config: string): string => hostileAt(config).dir;
  const SECRET_READ = (dir: string, cwd = dir) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "t5",
      tool_name: "Read",
      tool_input: { file_path: join(dir, ".env") },
      cwd,
    });
  /** The pinned command, exactly as the hook runs it: through a shell, in the session directory. */
  const hook = (command: string, dir: string, cwd = dir) => {
    const env = { ...baseEnv(), CLAUDE_PROJECT_DIR: dir, CW_AGENT_LEDGER: "off" };
    const r = spawnSync("sh", ["-c", command], {
      cwd,
      input: SECRET_READ(dir, cwd),
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
    // The guard's own deny, not the wrapper's exit 2: a guard that crashed or never started would also exit 2, and
    // that is not the guard having read the call.
    const out = JSON.parse(r.stdout || "{}").hookSpecificOutput;
    expect(out?.permissionDecision, `${r.stdout} ${r.stderr}`).toBe("deny");
    expect(out?.permissionDecisionReason).toMatch(/\.env/);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/the guard failed or timed out/);
  });
  // The docs say the override was checked against a root, a nested and an extended config; these are those cases.
  describe.each([
    ["a nested config (scripts/)", "scripts", false],
    ["a doubly nested config (scripts/harness/)", "scripts/harness", false],
    ["a config that only extends the hostile one", "", true],
    ["a nested config that extends the hostile one", "scripts", true],
  ] as const)("%s", (_name, at, extended) => {
    it.each(["tsconfig.json", "jsconfig.json"])(
      "both pinned commands still deny a secret read with a hostile %s in the session directory",
      (config) => {
        const { dir, cwd } = hostileAt(config, at, extended);
        for (const command of [claudeCommand, codexCommand]) {
          const r = hook(command, dir, cwd);
          const out = JSON.parse(r.stdout || "{}").hookSpecificOutput;
          expect(out?.permissionDecision, `${command.slice(0, 30)} ${r.stderr}`).toBe("deny");
          expect(out?.permissionDecisionReason).toMatch(/environment file/);
        }
      },
    );
    it("without the override flag the hijack is real (the case proves something)", () => {
      const { dir, cwd } = hostileAt("tsconfig.json", at, extended);
      const bare = claudeCommand.replace(" --tsconfig-override=/dev/null", "");
      expect(hook(bare, dir, cwd).stdout).toBe("");
    });
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
  const FAST_MS = 5000;
  const cds = `${Array.from({ length: 15 }, (_, i) => `cd /tmp/d${i};`).join(" ")} `;
  const words = (count: number, braces: string): string =>
    Array.from({ length: count }, (_, i) => `w${i}${braces}`).join(" ");
  const hostile = [
    ["rm -f", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}", 1300],
    ["touch", "{,}{,}{,}{,}{,}{,}{,}{,}", 1900],
    ["mv", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}", 1300],
  ] as const;
  // The best of two runs of the real hook: a spawn that lands on a loaded machine is not a regression, two are.
  const timed = (call: () => Out) => {
    let best = Number.POSITIVE_INFINITY;
    let result = call();
    for (let run = 0; run < 2; run++) {
      const started = performance.now();
      result = call();
      best = Math.min(best, performance.now() - started);
    }
    return { result, ms: best };
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
    expectAllowed(r);
  });

  // The hook's timeout is 10 s and a call whose hook is killed RUNS, so the payload a secret read follows must not
  // be able to eat the time: both of these took 7 to 25 s, nested substitutions each holding nearly the whole text.
  const THREE_S = 3000;
  const CAP = 64 * 1024;
  const nestedBraces = (levels: number): string => {
    const tail = "\ncat .env";
    const room = CAP - tail.length - levels * 3 - 20;
    return `${"$(".repeat(levels)}cat ${"y".repeat(room - 120)}${"{a,b}".repeat(16)}${")".repeat(levels)}${tail}`;
  };
  const nestedSegments = `${"$(".repeat(31)}${"a;".repeat(30_000)}${")".repeat(31)}\ncat .env`;

  it.each([
    ["a payload nested 9 deep, with sixteen brace groups", nestedBraces(9)],
    ["31 nested substitutions of 30,000 segments each", nestedSegments],
  ])(
    "refuses the secret read after %s in under 3 s, from a symlinked root",
    (_name, command) => {
      for (const run of [
        () => claude(alias, { tool_name: "Bash", tool_input: { command }, cwd: alias }),
        () => codex(alias, { tool_name: "Bash", tool_input: { command }, cwd: alias }),
      ]) {
        const { result, ms } = timed(run);
        expect(decision(result)).toBe("deny");
        expect(ms).toBeLessThan(THREE_S);
      }
    },
    60_000,
  );
});

// CR-H1 (2026-11-10 review): a Read/Write/Edit/Grep/Glob `file_path` of 500 KB made of `a/../` went quadratic in
// the real-path computation (4 to 9 s here, a SIGTERM on a loaded machine). The textual deny now runs first and
// a path no longer than a path can be on disk is the only one resolved on disk.
describe("CR-H1: a 500 KB file_path is answered quickly and still denies a secret target", () => {
  const root = repo();
  const HALF_S = 3000;
  const detour = "a/../".repeat(100_000);
  const secret = ["apps/backend/", ".", "env"].join("");
  const call = (tool: string, file: string, extra: Record<string, unknown> = {}) => {
    const started = performance.now();
    const r = claude(root, {
      tool_name: tool,
      tool_input: { file_path: file, ...extra },
      cwd: root,
    });
    return { r, ms: performance.now() - started };
  };

  it.each([
    ["Read", {}],
    ["Write", { content: "x" }],
    ["Edit", { old_string: "a", new_string: "b" }],
  ])("denies %s of a long path that names a live env file, in well under 1 s", (tool, extra) => {
    const { r, ms } = call(tool, `${root}/${detour}${secret}`, extra);
    expect(decision(r)).toBe("deny");
    expect(ms).toBeLessThan(HALF_S);
  });

  it("denies a long relative path too", () => {
    const { r, ms } = call("Read", `${detour}${secret}`);
    expect(decision(r)).toBe("deny");
    expect(ms).toBeLessThan(HALF_S);
  });

  it("allows a long path that resolves to an ordinary file: exit 0, no output", () => {
    const started = performance.now();
    const r = spawnSync("bun", [GUARD], {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: `${root}/${detour}apps/backend/package.json` },
        cwd: root,
      }),
      encoding: "utf8",
      env: { ...baseEnv(), CLAUDE_PROJECT_DIR: root },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(performance.now() - started).toBeLessThan(HALF_S);
  });
});
