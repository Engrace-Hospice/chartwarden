/**
 * Wave 7, T4 (round-5 compliance review, LOW): the two asks the stack added, Claude's ask on a path-capable MCP tool
 * and on an Edit/Write/MultiEdit/NotebookEdit of a protected path, both call `log()`, but every real-hook test set
 * `CW_AGENT_LEDGER=off`, so nothing proved a ledger line lands. Here the REAL pinned Claude command runs on a COPY of
 * the guard tree with the ledger ON, and the copy's own ledger is read back. The emergency denies of `hard-deadline.ts`
 * (a hung or dead judgement, a malformed answer) and the internal-error deny are deliberately NOT ledgered (a failing
 * worker cannot be trusted to log, and the entry thread must stay free to answer): pinned here so the header of
 * `guard-judge.ts` stays true.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bashPayload, guardCopy, removeCopies, runClaude } from "./_guard-copy";

afterAll(removeCopies);

const LEDGER_ON = { CW_AGENT_LEDGER: "on" };

interface Line {
  readonly event: string;
  readonly tool?: string;
  readonly target?: string;
  readonly decision?: string;
  readonly reason?: string;
}

/** Every line of the copy's ledger, parsed; none when the copy wrote no ledger. */
function ledgerOf(dir: string): Line[] {
  const audit = join(dir, ".claude/audit");
  if (!existsSync(audit)) return [];
  return readdirSync(audit)
    .filter((f) => /^agent-ledger-\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(join(audit, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as Line);
}

describe("an ask the stack added leaves a ledger line", () => {
  it("Claude's ask on a path-capable MCP tool", () => {
    const dir = guardCopy();
    const tool = "mcp__claude-in-chrome__file_upload";
    const r = runClaude(
      dir,
      { tool_name: tool, tool_input: { paths: ["scripts/harness/pre-tool-guard.ts"] } },
      LEDGER_ON,
    );
    expect(r.decision).toBe("ask");
    const lines = ledgerOf(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "pre_tool", tool, decision: "ask" });
    expect(lines[0]?.reason).toMatch(/harness/);
  });

  it.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])(
    "Claude's ask on %s of a protected path",
    (tool) => {
      const dir = guardCopy();
      const file_path = join(dir, "scripts/harness/hard-deadline.ts");
      const r = runClaude(
        dir,
        {
          tool_name: tool,
          tool_input: { file_path, old_string: "a", new_string: "b", content: "b" },
        },
        LEDGER_ON,
      );
      expect(r.decision).toBe("ask");
      const lines = ledgerOf(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pre_tool", tool, decision: "ask" });
      expect(lines[0]?.target).toMatch(/scripts\/harness\/hard-deadline\.ts$/);
    },
  );

  it("control: an Edit of an everyday file asks nothing and writes no line", () => {
    const dir = guardCopy();
    const r = runClaude(
      dir,
      {
        tool_name: "Edit",
        tool_input: { file_path: join(dir, "apps/x.ts"), old_string: "a", new_string: "b" },
      },
      LEDGER_ON,
    );
    expect(r.decision).toBe("allow");
    expect(ledgerOf(dir)).toEqual([]);
  });

  it("control: the ledger is really on (a Bash deny leaves a line)", () => {
    const dir = guardCopy();
    expect(runClaude(dir, bashPayload("cat apps/backend/.env"), LEDGER_ON).decision).toBe("deny");
    expect(ledgerOf(dir).map((l) => l.decision)).toEqual(["deny"]);
  });
});

describe("the emergency denies are deliberately not ledgered", () => {
  it.each(["hang", "throw", "exit"])(
    "a worker fault (%s) answers exit 2 and writes no line",
    (fault) => {
      const dir = guardCopy();
      const r = runClaude(dir, bashPayload("git status"), {
        ...LEDGER_ON,
        CW_HARNESS_TEST_FAULT: fault,
        CW_HARNESS_DEADLINE_MS_FOR_TESTS: "300",
      });
      expect(r.status).toBe(2);
      expect(ledgerOf(dir)).toEqual([]);
    },
  );
});
