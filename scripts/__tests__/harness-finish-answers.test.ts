/**
 * Wave 6, CR-L2 (round-4 code review): the entry thread trusted whatever its worker sent back. An answer with no
 * `decision` printed no decision JSON and exited 0, which both agents read as an allow. `finish` now refuses anything
 * that is not an object holding `allow`, `ask` or `deny` (exit 2, the standard deny). `write` called `writeSync` once and
 * ignored its byte count: it now writes until every byte is out. Each case runs `finish` in its own bun process (it
 * exits), over the real module.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = join(__dirname, "../harness/hard-deadline.ts");

/** `finish(<answer>)` in a fresh process: what the hook would print and how it would exit. */
function finishWith(answerSource: string) {
  const program = `import { finish } from ${JSON.stringify(MODULE)}; finish(${answerSource} as never);`;
  const r = spawnSync("bun", ["--no-install", "-e", program], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("finish refuses an answer that is not a decision", () => {
  it.each([
    ["no decision", `{ reason: "x" }`],
    ["an empty object", "{}"],
    ["an unknown decision", `{ decision: "maybe", reason: "x" }`],
    ["a number for a decision", `{ decision: 1, reason: "x" }`],
    ["a null answer", "null"],
    ["an undefined answer", "undefined"],
    ["a string answer", `"allow"`],
    ["an array", `["allow"]`],
  ])("%s: exit 2 and the standard deny", (_name, source) => {
    const r = finishWith(source);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/not a decision/);
    expect(r.stderr).toMatch(/not a decision/);
  });
});

describe("finish prints a real decision as it always has", () => {
  it("allow: nothing on stdout, exit 0", () => {
    const r = finishWith(`{ decision: "allow", reason: "" }`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
  it.each(["ask", "deny"])("%s: the decision JSON, exit 0", (decision) => {
    const r = finishWith(`{ decision: "${decision}", reason: "why" }`);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecision).toBe(decision);
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("why");
  });
  it("a note for stderr is written to stderr", () => {
    const r = finishWith(`{ decision: "allow", reason: "", stderr: "note\\n" }`);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("note\n");
  });
  it("a large answer is written whole (writeSync may write less than it is given)", () => {
    const r = finishWith(`{ decision: "deny", reason: "x".repeat(300000) }`);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecisionReason).toHaveLength(300000);
  });
});
