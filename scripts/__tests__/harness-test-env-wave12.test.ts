/**
 * Wave 12, G-3 (R9-COMP-10): the environment harness tests hand to the real tools they run (`helpers/scrubbed-env.ts`).
 * `harness-db-uri.test.ts` ran the real `pg_isready` with the developer's environment, so a `PGHOSTADDR`, `PGSERVICE` or
 * `PGPASSFILE` of theirs reached libpq; the git calls of four test files, and every real hook run through
 * `_guard-copy.ts`, inherited `GIT_DIR`, `GIT_INDEX_FILE` and the developer's own guard switches. These tests pin the
 * helper, with a poisoned parent environment (loopback addresses and scratch paths only: nothing here reaches anything).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { bashPayload, guardCopy, removeCopies, runClaude } from "./_guard-copy";
import {
  GUARD_SWITCHES,
  scrubbedGitEnv,
  scrubbedToolEnv,
  withoutGuardSwitches,
} from "./helpers/scrubbed-env";

const scratch = mkdtempSync(join(tmpdir(), "cw-test-env-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeCopies();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const POISON = {
  PGHOSTADDR: "127.0.0.3",
  PGSERVICE: "cw-no-such-service",
  PGPASSFILE: join(scratch, "no-such-passfile"),
  PGSERVICEFILE: join(scratch, "no-such-service-file"),
  GIT_DIR: join(scratch, "poison-git-dir"),
  GIT_INDEX_FILE: join(scratch, "poison-index"),
  GIT_CONFIG_GLOBAL: join(scratch, "poison-gitconfig"),
};
const poisonParent = (): void => {
  for (const [name, value] of Object.entries(POISON)) vi.stubEnv(name, value);
};

describe("scrubbedToolEnv: PATH, a scratch HOME and LANG, whatever the parent holds", () => {
  it("holds exactly those three names, and the extras it is given", () => {
    poisonParent();
    const env = scrubbedToolEnv(scratch, { PGCONNECT_TIMEOUT: "2" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "PGCONNECT_TIMEOUT"]);
    expect(env).toMatchObject({ HOME: scratch, LANG: "C", PGCONNECT_TIMEOUT: "2" });
    expect(env.PATH).toBe(process.env.PATH);
  });

  it.each(Object.keys(POISON))("does not carry the parent's %s", (name) => {
    poisonParent();
    expect(scrubbedToolEnv(scratch)).not.toHaveProperty(name);
    expect(scrubbedGitEnv(scratch)[name]).not.toBe(POISON[name as keyof typeof POISON]);
  });

  it("keeps the extras last, so a probe can still set what it means to", () => {
    expect(scrubbedToolEnv(scratch, { LANG: "en_US.UTF-8" }).LANG).toBe("en_US.UTF-8");
  });
});

describe("scrubbedGitEnv: a poisoned GIT_DIR does not reach git, the control shows it would", () => {
  const git = (env: Record<string, string>, cwd: string) =>
    spawnSync("git", ["rev-parse", "--git-dir"], { cwd, env, encoding: "utf8" });

  it("git reads the repository it is in, not the one the parent environment names", () => {
    const repo = join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    const init = spawnSync("git", ["init", "-q"], { cwd: repo, env: scrubbedGitEnv(scratch) });
    expect(init.status).toBe(0);
    poisonParent();
    // The hazard: the inherited environment points `git` at the parent's repository, whatever directory it is run in.
    const inherited = git({ ...process.env } as Record<string, string>, repo);
    expect(inherited.stdout.trim() || inherited.stderr).toContain("poison-git-dir");
    // The fix: the scrubbed environment finds the repository in the directory it was run in.
    const scrubbed = git(scrubbedGitEnv(scratch), repo);
    expect(scrubbed.status).toBe(0);
    expect(scrubbed.stdout.trim()).toBe(".git");
  });

  it("holds no system and no global git configuration", () => {
    expect(scrubbedGitEnv(scratch)).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });
});

describe("withoutGuardSwitches: the developer's own switches of the guard stay out of a test", () => {
  it.each(GUARD_SWITCHES)("drops %s", (name) => {
    expect(withoutGuardSwitches({ [name]: "1", KEEP: "yes" })).toEqual({ KEEP: "yes" });
  });

  it("names the switches that turn the guard open, break it on purpose or move its root", () => {
    expect([...GUARD_SWITCHES].sort()).toEqual([
      "CW_HARNESS_DEADLINE_MS_FOR_TESTS",
      "CW_HARNESS_FAIL_OPEN",
      "CW_HARNESS_ROOT_FOR_TESTS",
      "CW_HARNESS_TEST_FAULT",
      "CW_HARNESS_TEST_LEDGER_FAULT",
    ]);
  });

  it("drops an undefined entry too, and keeps everything else", () => {
    expect(withoutGuardSwitches({ A: "1", B: undefined, PATH: "/bin" })).toEqual({
      A: "1",
      PATH: "/bin",
    });
  });
});

describe("a real hook run through _guard-copy does not inherit the developer's fail-open switch", () => {
  // A `cwd` that is not text is an internal error: with CW_HARNESS_FAIL_OPEN=1 the guard answers allow, without it deny.
  const internalError = { ...bashPayload("ls"), cwd: 5 };

  it("denies although the parent environment says fail open", () => {
    vi.stubEnv("CW_HARNESS_FAIL_OPEN", "1");
    expect(runClaude(guardCopy(), internalError).decision).toBe("deny");
  });

  it("control: a test that asks for fail-open explicitly still gets it", () => {
    expect(runClaude(guardCopy(), internalError, { CW_HARNESS_FAIL_OPEN: "1" }).decision).toBe(
      "allow",
    );
  });
});
