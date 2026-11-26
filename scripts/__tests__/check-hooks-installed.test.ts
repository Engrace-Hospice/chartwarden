// CW-SEC-01 — a fresh clone cannot skip the pre-commit scan silently: `prepare` installs the hooks and
// fails loudly, and `arch:hooks-installed` fails when they are not active.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HooksState, hooksProblems } from "../check-hooks-installed";
import { scrubbedGitEnv } from "./helpers/scrubbed-env";

const repoRoot = join(__dirname, "../..");
const script = join(repoRoot, "scripts/check-hooks-installed.ts");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const ROOT = "/clone";
const okFiles = [
  { name: "pre-commit", exists: true, executable: true },
  { name: "pre-push", exists: true, executable: true },
];
const state = (over: Partial<HooksState> = {}): HooksState => ({
  hooksPath: ".githooks",
  root: ROOT,
  hookFiles: okFiles,
  ...over,
});

describe("hooksProblems", () => {
  it("passes when core.hooksPath is .githooks (relative, or absolute to this clone) and the hooks run", () => {
    expect(hooksProblems(state())).toEqual([]);
    expect(hooksProblems(state({ hooksPath: `${ROOT}/.githooks` }))).toEqual([]);
  });

  it("fails when core.hooksPath is unset or blank — the fresh-clone case", () => {
    for (const hooksPath of [undefined, "", "  "])
      expect(hooksProblems(state({ hooksPath }))).toEqual([
        expect.stringContaining("core.hooksPath is not set"),
      ]);
  });

  it("fails when core.hooksPath points somewhere else, including another clone's .githooks", () => {
    for (const hooksPath of ["/dev/null", ".husky", "/other/.githooks", ".githooks/sub"])
      expect(hooksProblems(state({ hooksPath }))).toEqual([
        expect.stringContaining("the secret scan will not run on commit"),
      ]);
  });

  it("fails when a hook file is missing or not executable (git skips a non-executable hook)", () => {
    const files = [
      { name: "pre-commit", exists: true, executable: false },
      { name: "pre-push", exists: false, executable: false },
    ];
    expect(hooksProblems(state({ hookFiles: files }))).toEqual([
      ".githooks/pre-commit is not executable (git skips it): chmod +x it",
      ".githooks/pre-push is missing",
    ]);
  });

  it("names the remedy", () => {
    expect(hooksProblems(state({ hooksPath: undefined })).join()).toContain("bun run setup:hooks");
  });
});

describe("package.json", () => {
  it("installs the hooks from `prepare` and `setup:hooks` through the checked script, not `|| true`", () => {
    for (const name of ["prepare", "setup:hooks"]) {
      expect(pkg.scripts[name], name).toBe("bun run scripts/check-hooks-installed.ts --install");
      expect(pkg.scripts[name], name).not.toMatch(/\|\|\s*true|2>\/dev\/null/);
    }
  });

  it("exposes the check as arch:hooks-installed", () => {
    expect(pkg.scripts["arch:hooks-installed"]).toBe("bun run scripts/check-hooks-installed.ts");
  });
});

describe("the script, in a throwaway clone", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Every git spawn in this suite gets the scrubbed environment: it runs inside `.githooks/pre-push` (`bun run test`),
   * where git exports GIT_DIR / GIT_INDEX_FILE, and an inherited one would aim `git init` and `git config` at the
   * REAL repository (and leave its core.hooksPath disabled when an assertion fails).
   */
  const envFor = (dir: string, extra: Record<string, string> = {}): Record<string, string> => ({
    ...scrubbedGitEnv(dir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  });
  const gitIn = (dir: string, args: string[]) =>
    spawnSync("git", args, { cwd: dir, env: envFor(dir) });

  /** A real repo holding executable pre-commit and pre-push files, nothing configured. */
  function clone(): string {
    const dir = mkdtempSync(join(tmpdir(), "cw-hooks-"));
    made.push(dir);
    gitIn(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".githooks"));
    for (const h of ["pre-commit", "pre-push"]) {
      writeFileSync(join(dir, ".githooks", h), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, ".githooks", h), 0o755);
    }
    return dir;
  }

  function run(dir: string, args: string[], extra: Record<string, string> = {}) {
    const r = spawnSync("bun", [script, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: envFor(dir, extra),
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("is unaffected by GIT_DIR in the parent environment, as when the suite runs under a git hook", () => {
    const realEnv = scrubbedGitEnv(repoRoot);
    const realGitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: realEnv,
    }).stdout.trim();
    const readReal = () =>
      spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: realEnv,
      }).stdout;
    const before = readReal();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = realGitDir;
    try {
      const dir = clone();
      expect(run(dir, []).out).toContain("core.hooksPath is not set");
      expect(run(dir, ["--install"]).code).toBe(0);
      expect(run(dir, []).code).toBe(0);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = saved;
    }
    // The real clone's setting was neither read as the temp repo's nor rewritten by it.
    expect(readReal()).toBe(before);
  });

  it("check fails in a fresh clone, passes once --install ran", () => {
    const dir = clone();
    const before = run(dir, []);
    expect(before.code).toBe(1);
    expect(before.out).toContain("core.hooksPath is not set");

    expect(run(dir, ["--install"]).code).toBe(0);
    const after = run(dir, []);
    expect(after.code).toBe(0);
    expect(after.out).toContain("OK check-hooks-installed");
  });

  it("check fails when the hooks path is re-pointed, or a hook loses its execute bit", () => {
    const dir = clone();
    run(dir, ["--install"]);
    gitIn(dir, ["config", "core.hooksPath", "/dev/null"]);
    expect(run(dir, []).code).toBe(1);

    gitIn(dir, ["config", "core.hooksPath", ".githooks"]);
    chmodSync(join(dir, ".githooks", "pre-commit"), 0o644);
    const result = run(dir, []);
    // Windows has no execute bit; there the check cannot see this and passes.
    if (process.platform !== "win32") {
      expect(result.code).toBe(1);
      expect(result.out).toContain("pre-commit is not executable");
    }
  });

  it("check is skipped on GitHub Actions, where the server-side scan is the control", () => {
    const dir = clone();
    const r = run(dir, [], { GITHUB_ACTIONS: "true" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP check-hooks-installed: GitHub Actions");
  });

  it("check is NOT skipped by a bare CI variable: agent sessions set CI and are where commits are made", () => {
    const dir = clone();
    for (const CI of ["true", "1", "false"]) expect(run(dir, [], { CI }).code, CI).toBe(1);
  });

  it("neither mode fails without a .git (an image build context)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-nogit-"));
    made.push(dir);
    expect(run(dir, []).code).toBe(0);
    const install = run(dir, ["--install"]);
    expect(install.code).toBe(0);
    expect(install.out).toContain("nothing to install");
  });

  it("a .git that git cannot read is a failure in both modes, never a quiet skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-badgit-"));
    made.push(dir);
    writeFileSync(join(dir, ".git"), "this is not a gitfile\n");
    const check = run(dir, []);
    expect(check.code).toBe(1);
    expect(check.out).toContain("git could not read its configuration");
    const install = run(dir, ["--install"]);
    expect(install.code).toBe(1);
    expect(install.out).toContain("git could not read its configuration");
  });

  it("the git environment this suite builds carries no GIT_DIR or GIT_INDEX_FILE", () => {
    const keys = Object.keys(envFor(repoRoot, {}));
    expect(keys.filter((k) => k.startsWith("GIT_") && !k.startsWith("GIT_CONFIG"))).toEqual([]);
  });

  it("--install is idempotent: nothing to write, nothing to fail", () => {
    const dir = clone();
    expect(run(dir, ["--install"]).out).toContain("core.hooksPath -> .githooks");
    const again = run(dir, ["--install"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "--install fails loudly when it must write and git cannot (the old `|| true` hid this), but not when already set",
    () => {
      const dir = clone();
      // git replaces `.git/config` through a lock file, so only an unwritable `.git` stops it.
      chmodSync(join(dir, ".git"), 0o555);
      try {
        const r = run(dir, ["--install"]);
        expect(r.code).toBe(1);
        expect(r.out).toContain("could not set core.hooksPath");
      } finally {
        chmodSync(join(dir, ".git"), 0o755);
      }
      run(dir, ["--install"]);
      chmodSync(join(dir, ".git"), 0o555);
      try {
        expect(run(dir, ["--install"]).code).toBe(0);
      } finally {
        chmodSync(join(dir, ".git"), 0o755);
      }
    },
  );
});
