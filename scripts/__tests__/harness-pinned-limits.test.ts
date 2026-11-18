/**
 * Wave 6, CR-M4 (round-4 code review): three limits that no test pinned, so a mutant that changed each one survived
 * (M06, M27, M28; M25, the 256-alternative cap, is pinned in `harness-work-budget.test.ts`). Each test below fails when
 * its constant is moved either way: raised (the limit stops protecting) or lowered (everyday commands start to ask).
 *
 * M02 and M03 (the worker's `close` listener and its `onerror` handler) are redundant with each other: each alone
 * answers a dead worker, so a mutant that removes one survives by design. M04 (the `process.exit` override of a
 * worker) cannot fail on bun 1.4.4, where a worker's `process.exit` no longer ends the process; it is the 1.3.5 CI
 * that pins it (`harness-hard-deadline.test.ts`). None of the three needs a test change.
 */
import { describe, expect, it } from "vitest";
import { judgeHook } from "../harness/guard-judge";
import { classifyBash } from "../harness/patterns";
import { MAX_COMMAND_JUDGE_MS, work } from "../harness/work-budget";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };

describe("M06: the classifier's own clock is one second", () => {
  it("MAX_COMMAND_JUDGE_MS is 1000", () => {
    expect(MAX_COMMAND_JUDGE_MS).toBe(1000);
  });
  it("a command judged with no limit of its own gets a deadline one second away", () => {
    classifyBash("echo hi", ctx);
    const remaining = work.deadline - performance.now();
    // The deadline was set when the command started: a little under a second is left, not 100 ms and not 10 s.
    expect(remaining).toBeGreaterThan(900);
    expect(remaining).toBeLessThanOrEqual(1000);
  });
  it("a limit in the context replaces it", () => {
    classifyBash("echo hi", { ...ctx, judgeTimeLimitMs: 250 });
    const remaining = work.deadline - performance.now();
    expect(remaining).toBeGreaterThan(150);
    expect(remaining).toBeLessThanOrEqual(250);
  });
});

/** `echo` of `outer` substitutions, each holding `inner` more: 1 + outer + outer * inner command lines are judged. */
const fan = (outer: number, inner: number): string => {
  const leaves = Array.from({ length: inner }, () => "$(true)").join(" ");
  return `echo ${Array.from({ length: outer }, () => `$(echo ${leaves})`).join(" ")}`;
};

describe("M27: at most 300 command lines are judged for one command", () => {
  it("300 are judged and allowed", () => {
    expect(1 + 13 + 13 * 22).toBe(300);
    expect(classifyBash(fan(13, 22), ctx).decision).toBe("allow");
  });
  it("301 ask, with a reason that says why", () => {
    expect(1 + 15 + 15 * 19).toBe(301);
    const verdict = classifyBash(fan(15, 19), ctx);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/nested too deeply, or too many/);
  });
  it("a deny found before the budget ran out stands", () => {
    const secret = ["cat apps/backend/", ".", "env"].join("");
    expect(classifyBash(`${secret}; ${fan(20, 20)}`, ctx).decision).toBe("deny");
  });
});

/** A hook for the judge: a Read of a path longer than any reason may be, naming a live env file. */
const longRead = (): Parameters<typeof judgeHook>[0] =>
  ({
    tool_name: "Read",
    tool_input: { file_path: `/tmp/cw-w6/${"a".repeat(5000)}/${[".", "en", "v"].join("")}` },
    cwd: "/tmp/cw-w6",
  }) as never;

describe("M28: a reason is cut at 600 characters, so command text cannot grow the output", () => {
  it("answers with 600 characters and an ellipsis, not the 5 KB path", () => {
    const answer = judgeHook(longRead(), false);
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toHaveLength(601);
    expect(answer.reason.endsWith("…")).toBe(true);
    expect(answer.reason.startsWith("[chartwarden-harness] ")).toBe(true);
  });
  it("leaves a short reason whole", () => {
    const answer = judgeHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
        cwd: "/tmp/cw-w6",
      } as never,
      false,
    );
    expect(answer.reason.length).toBeLessThan(600);
    expect(answer.reason.endsWith("…")).toBe(false);
  });
});
