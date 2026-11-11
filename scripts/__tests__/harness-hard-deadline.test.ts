/**
 * A hard deadline for the whole guard (2026-11-10 reviews, "structural point" and CR-H1/H2). In Claude Code a
 * guard that crashes, is killed at the hook's 10 s timeout or exits with anything but 2 lets the tool call RUN;
 * only Codex's pinned command wraps the guard in `perl alarm 8 ... || exit 2`. The guard now judges in a worker
 * and its entry thread refuses the call (deny JSON, stderr line, exit 2) when the deadline passes or the worker
 * dies. Each test spawns the real entry point, or the real pinned hook command, with a fault forced through the
 * test seam; a normal call next to each must be unchanged.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS, deadlineMs, denyJson } from "../harness/hard-deadline";

const ROOT = join(__dirname, "../..");
const GUARD = join(ROOT, "scripts/harness/pre-tool-guard.ts");
const SHORT_DEADLINE_MS = 400;
/** Far above the short deadline and far below the real one: proves the SEAM's deadline, not a lucky kill. */
const WITHIN_MS = 4000;

const claudeCommand: string = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"))
  .hooks.PreToolUse[0].hooks[0].command;
const codexCommand: string = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8")).hooks
  .PreToolUse[0].hooks[0].command;

const bash = (command: string): string =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "deadline",
    tool_name: "Bash",
    tool_input: { command },
    cwd: ROOT,
  });

const baseEnv = (extra: Record<string, string>): Record<string, string> => ({
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined &&
        ![
          "CW_HARNESS_FAIL_OPEN",
          "CW_HARNESS_TEST_FAULT",
          "CW_HARNESS_DEADLINE_MS_FOR_TESTS",
        ].includes(e[0]),
    ),
  ) as Record<string, string>),
  CW_AGENT_LEDGER: "off",
  CLAUDE_PROJECT_DIR: ROOT,
  ...extra,
});

const timed = (run: () => ReturnType<typeof spawnSync<string>>) => {
  const started = performance.now();
  const r = run();
  return { r, ms: performance.now() - started };
};

const entry = (extra: Record<string, string>, args: string[] = []) =>
  timed(() =>
    spawnSync("bun", [GUARD, ...args], {
      input: bash("ls"),
      encoding: "utf8",
      env: baseEnv(extra),
      timeout: 20_000,
    }),
  );

const pinned = (command: string, extra: Record<string, string>) =>
  timed(() =>
    spawnSync("/bin/sh", ["-c", command], {
      cwd: ROOT,
      input: bash("ls"),
      encoding: "utf8",
      env: baseEnv(extra),
      timeout: 20_000,
    }),
  );

/**
 * bun 1.3.5 (what CI pins) prints this line to stderr for `--tsconfig-override=/dev/null`, and the base commit
 * does too; it is not the guard speaking, so a test that checks the guard's stderr is empty ignores it.
 */
const withoutBunNoise = (stderr: string): string =>
  stderr.replace(
    /Internal error: directory mismatch for directory "\/dev\/null", fd \d+\. .*\n?/g,
    "",
  );

const deniedWithExit2 = (r: { status: number | null; stdout: string; stderr: string }): void => {
  expect(r.status, r.stderr).toBe(2);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.permissionDecision).toBe("deny");
  expect(out.permissionDecisionReason).toMatch(/^\[chartwarden-harness\] The guard did not answer/);
  expect(r.stderr).toMatch(/did not answer in time/);
};

describe("deadlineMs: the seam can shorten the deadline and never lengthen it", () => {
  it("is 6.5 s by default", () => {
    expect(deadlineMs({})).toBe(DEADLINE_MS);
    expect(DEADLINE_MS).toBe(6500);
  });
  it("honours a shorter value", () => {
    expect(deadlineMs({ CW_HARNESS_DEADLINE_MS_FOR_TESTS: "400" })).toBe(400);
  });
  it.each(["999999999", "6501", "10", "-1", "abc", "", "NaN", "Infinity"])(
    "ignores %j and keeps the default",
    (value) => {
      expect(deadlineMs({ CW_HARNESS_DEADLINE_MS_FOR_TESTS: value })).toBe(DEADLINE_MS);
    },
  );
  it("answers with the standard deny shape", () => {
    expect(JSON.parse(denyJson("why")).hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "[chartwarden-harness] why",
    });
  });
});

describe("a judgement that hangs, dies or crashes is refused with exit 2, in both agents", () => {
  it.each([
    ["Claude", []],
    ["Codex", ["--codex"]],
  ] as const)("%s mode: a worker stuck in a loop is cut off at the deadline", (_agent, args) => {
    const { r, ms } = entry(
      {
        CW_HARNESS_TEST_FAULT: "hang",
        CW_HARNESS_DEADLINE_MS_FOR_TESTS: String(SHORT_DEADLINE_MS),
      },
      [...args],
    );
    deniedWithExit2(r);
    expect(ms).toBeGreaterThanOrEqual(SHORT_DEADLINE_MS);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("a worker that exits without answering is refused at once, not at the deadline", () => {
    const { r, ms } = entry({ CW_HARNESS_TEST_FAULT: "exit" });
    deniedWithExit2(r);
    expect(ms).toBeLessThan(WITHIN_MS); // the default 6.5 s deadline is still in force: this is the close event
  });

  // On bun 1.3.5 (CI) a `process.exit(0)` called in a worker ended the WHOLE process silently with status 0, which
  // reads as allow; the worker makes `process.exit` a throw, so any such call is answered with a deny.
  it("a `process.exit` inside the worker is refused too, not read as an allow", () => {
    const { r, ms } = entry({ CW_HARNESS_TEST_FAULT: "process-exit" });
    deniedWithExit2(r);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("a worker that throws is refused at once", () => {
    const { r, ms } = entry({ CW_HARNESS_TEST_FAULT: "throw" });
    deniedWithExit2(r);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("a hook input that never ends is cut off at the deadline too", async () => {
    const child = spawn("bun", [GUARD], {
      env: baseEnv({ CW_HARNESS_DEADLINE_MS_FOR_TESTS: String(SHORT_DEADLINE_MS) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(2);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("the REAL pinned Claude command answers a hung judgement with deny and exit 2", () => {
    const { r, ms } = pinned(claudeCommand, {
      CW_HARNESS_TEST_FAULT: "hang",
      CW_HARNESS_DEADLINE_MS_FOR_TESTS: String(SHORT_DEADLINE_MS),
    });
    deniedWithExit2(r);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("the REAL pinned Codex command answers a hung judgement with deny and exit 2", () => {
    const { r, ms } = pinned(codexCommand, {
      CW_HARNESS_TEST_FAULT: "hang",
      CW_HARNESS_DEADLINE_MS_FOR_TESTS: String(SHORT_DEADLINE_MS),
    });
    deniedWithExit2(r);
    expect(ms).toBeLessThan(WITHIN_MS);
  });
});

describe("a call the guard can judge is answered as before, and quickly", () => {
  it("allows an everyday command: exit 0, nothing on stdout or stderr", () => {
    const { r, ms } = pinned(claudeCommand, {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(withoutBunNoise(r.stderr)).toBe("");
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("still denies a secret read with its own reason, exit 0 (not the deadline's exit 2)", () => {
    const r = spawnSync("bun", [GUARD], {
      input: bash("cat apps/backend/.env"),
      encoding: "utf8",
      env: baseEnv({}),
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).not.toMatch(/did not answer/);
  });

  it("answers an ask as a deny in Codex mode and keeps it an ask in Claude mode", () => {
    const payload = bash("git push origin main");
    const run = (args: string[]) =>
      spawnSync("bun", [GUARD, ...args], { input: payload, encoding: "utf8", env: baseEnv({}) });
    expect(JSON.parse(run([]).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(JSON.parse(run(["--codex"]).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
