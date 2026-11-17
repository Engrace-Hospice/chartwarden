/**
 * Wave 7, T4 (round-5 compliance review, LOW): the two asks the stack added, Claude's ask on a path-capable MCP tool
 * and on an Edit/Write/MultiEdit/NotebookEdit of a protected path, both call `log()`, but every real-hook test set
 * `CW_AGENT_LEDGER=off`, so nothing proved a ledger line lands. Here the REAL pinned Claude command runs on a COPY of
 * the guard tree with the ledger ON, and the copy's own ledger is read back.
 *
 * Wave 12, G-2 (R9-COMP-12, HIPAA 164.312(b)): the emergency denies were deliberately NOT ledgered (a failing worker
 * cannot be trusted to log, the entry thread must stay free to answer its own timer): the deadline, a worker that died
 * or errored, a malformed answer, and (found by this wave) an input the guard cannot parse and an internal error. Each
 * now leaves ONE line (the tool's name, the cause, the SHA-256 of a Bash command, never its text), written by a child
 * process AFTER the deny is out and under a hard timeout. The second half of this file pins every path in both agents,
 * and that the deny is the same, and as fast, when the ledger is unwritable, locked or hangs.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEDGER_TIMEOUT_MS } from "../harness/hard-deadline";
import { sha256, verifyChain } from "../harness/io";
import {
  CLAUDE_HOOK,
  CODEX_HOOK,
  bashPayload,
  guardCopy,
  removeCopies,
  runClaude,
} from "./_guard-copy";
import { withoutGuardSwitches } from "./helpers/scrubbed-env";

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

/** What a hook command printed and how it ended, and when each happened. */
interface RawRun {
  readonly status: number | null;
  readonly stdout: string;
  /** Milliseconds until the first byte of stdout (0 when there was none), and until the process ended. */
  readonly firstOutputMs: number;
  readonly ms: number;
}

/**
 * A pinned hook command run with the input given as raw text (`null`: stdin is left open and never ends), on a copy of
 * the guard tree, timed. `_guard-copy.ts` runs synchronously and always sends JSON.
 */
function runRaw(
  hook: string,
  dir: string,
  env: Record<string, string>,
  input: string | null,
): Promise<RawRun> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn("/bin/sh", ["-c", hook], {
      cwd: dir,
      env: { ...withoutGuardSwitches(process.env), CLAUDE_PROJECT_DIR: dir, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let firstOutputMs = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      firstOutputMs ||= performance.now() - started;
      stdout += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      resolve({ status, stdout, firstOutputMs, ms: performance.now() - started });
    });
    if (input !== null) child.stdin.end(input);
  });
}

/** The text of every ledger file the copy wrote, whole (for the chain and for what must not be in it). */
function ledgerText(dir: string): string {
  const audit = join(dir, ".claude/audit");
  if (!existsSync(audit)) return "";
  return readdirSync(audit)
    .filter((f) => /^agent-ledger-\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => readFileSync(join(audit, f), "utf8"))
    .join("");
}

const monthLedger = (): string => `agent-ledger-${new Date().toISOString().slice(0, 7)}.jsonl`;

describe("every emergency deny leaves exactly one ledger line", () => {
  // A command that is not in the ledger: only its SHA-256 may be.
  const COMMAND = "echo emergency-marker-7f3a";
  const SHORT_DEADLINE = { CW_HARNESS_DEADLINE_MS_FOR_TESTS: "300" };
  /** Each way the entry thread refuses on its own, the fault that forces it, and the cause the line names. */
  const PATHS = [
    ["hang", "deadline"],
    ["throw", "worker error"],
    ["process-exit", "worker error"],
    // bun reports a worker that closes itself as an error on some builds and as a close on others: one cause or the other.
    ["exit", "worker (?:error|closed)"],
    ["malformed", "malformed answer"],
  ] as const;
  const AGENTS = [
    ["Claude", CLAUDE_HOOK, "Bash"],
    ["Codex", CODEX_HOOK, "codex/Bash"],
  ] as const;
  /** The payload as the agent sends it: Codex's hook input also carries the session directory. */
  const payloadFor = (hook: string, dir: string, extra: object = {}): string =>
    JSON.stringify({
      ...bashPayload(COMMAND),
      ...(hook === CODEX_HOOK ? { cwd: dir, hook_event_name: "PreToolUse" } : {}),
      ...extra,
    });

  it.each(PATHS.flatMap(([fault, cause]) => AGENTS.map((a) => [fault, cause, ...a] as const)))(
    "a worker fault (%s) is ledgered as /%s/ in %s mode, with the command's hash and never its text",
    async (fault, cause, _agent, hook, tool) => {
      const dir = guardCopy();
      const r = await runRaw(
        hook,
        dir,
        { ...LEDGER_ON, CW_HARNESS_TEST_FAULT: fault, ...SHORT_DEADLINE },
        payloadFor(hook, dir),
      );
      expect(r.status).toBe(2);
      const lines = ledgerOf(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pre_tool", tool, decision: "deny" });
      expect(lines[0]?.reason).toMatch(new RegExp(`^emergency deny \\(${cause}\\): `));
      expect(lines[0]).toMatchObject({ cmd_sha256: sha256(COMMAND) });
      expect(ledgerText(dir)).not.toContain("emergency-marker-7f3a");
      expect(verifyChain(ledgerText(dir)).ok).toBe(true);
    },
  );

  it("a worker that cannot start is ledgered too (the entry thread's own catch)", async () => {
    const dir = guardCopy();
    rmSync(join(dir, "scripts/harness/guard-worker.ts"));
    const r = await runRaw(
      CLAUDE_HOOK,
      dir,
      { ...LEDGER_ON, ...SHORT_DEADLINE },
      payloadFor(CLAUDE_HOOK, dir),
    );
    expect(r.status).toBe(2);
    const lines = ledgerOf(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.reason).toMatch(/^emergency deny \((worker could not start|worker error)\): /);
  });

  it("a call whose input never ends is ledgered at the deadline, naming no tool", async () => {
    const dir = guardCopy();
    const r = await runRaw(CLAUDE_HOOK, dir, { ...LEDGER_ON, ...SHORT_DEADLINE }, null);
    expect(r.status).toBe(2);
    const lines = ledgerOf(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: "deny" });
    expect(lines[0]?.reason).toMatch(/^emergency deny \(deadline\): /);
    expect(lines[0]?.tool).toBeUndefined();
  });

  it.each(AGENTS)(
    "%s mode: an input the guard cannot parse is a deny the guard made on its own, and is ledgered",
    async (_agent, hook, _tool) => {
      const dir = guardCopy();
      const r = await runRaw(hook, dir, LEDGER_ON, "not an object");
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      const lines = ledgerOf(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pre_tool", decision: "deny" });
      expect(lines[0]?.reason).toMatch(/unparseable hook input/);
    },
  );

  it.each(AGENTS)(
    "%s mode: an internal error is a deny, and the line names the kind of error, not its text",
    async (_agent, hook, tool) => {
      const dir = guardCopy();
      // A `cwd` that is not text throws inside the judgement (the error text names guard source, not the call).
      const r = await runRaw(hook, dir, LEDGER_ON, payloadFor(hook, dir, { cwd: 5 }));
      expect(r.stdout).toMatch(/internal error/);
      const lines = ledgerOf(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pre_tool", tool, decision: "deny" });
      expect(lines[0]?.reason).toBe(
        "internal error (TypeError): the guard could not judge this call",
      );
    },
  );

  it("control: a call that is judged normally writes no emergency line", () => {
    const dir = guardCopy();
    expect(runClaude(dir, bashPayload("git status"), LEDGER_ON).decision).toBe("allow");
    expect(ledgerOf(dir)).toEqual([]);
  });

  // Off means off: no line, no directory, and no child process either (one that would hang is not waited for).
  it.each(PATHS.map(([fault]) => fault))(
    "the ledger off writes nothing and starts no ledger child (%s)",
    async (fault) => {
      const dir = guardCopy();
      const r = await runRaw(
        CLAUDE_HOOK,
        dir,
        {
          CW_AGENT_LEDGER: "off",
          CW_HARNESS_TEST_FAULT: fault,
          CW_HARNESS_TEST_LEDGER_FAULT: "hang",
          ...SHORT_DEADLINE,
        },
        payloadFor(CLAUDE_HOOK, dir),
      );
      expect(r.status).toBe(2);
      expect(existsSync(join(dir, ".claude/audit"))).toBe(false);
      expect(r.ms - r.firstOutputMs).toBeLessThan(LEDGER_TIMEOUT_MS * 0.6);
    },
  );
});

describe("the deny is the same when the ledger cannot be written", () => {
  const COMMAND = "git status";
  const SHORT_DEADLINE = { CW_HARNESS_DEADLINE_MS_FOR_TESTS: "300" };
  /** The slowest an emergency may take: the deadline, the ledger child's bound, a cold start and a loaded machine. */
  const SLACK_MS = 4000;
  const BOUND_MS = 300 + LEDGER_TIMEOUT_MS + SLACK_MS;
  const FAULTS = ["hang", "throw", "exit", "malformed"] as const;
  const input = JSON.stringify(bashPayload(COMMAND));

  /** What the call answered with the ledger off: the reference the other runs must equal. */
  const reference = async (fault: string): Promise<{ status: number | null; stdout: string }> => {
    const r = await runRaw(
      CLAUDE_HOOK,
      guardCopy(),
      { CW_AGENT_LEDGER: "off", CW_HARNESS_TEST_FAULT: fault, ...SHORT_DEADLINE },
      input,
    );
    return { status: r.status, stdout: r.stdout };
  };
  const answer = (r: RawRun): { status: number | null; stdout: string } => ({
    status: r.status,
    stdout: r.stdout,
  });

  it.each(FAULTS)(
    "an unwritable ledger directory (%s): the same deny, nothing thrown",
    async (fault) => {
      const dir = guardCopy();
      writeFileSync(join(dir, ".claude/audit"), "a file where the directory belongs\n");
      const r = await runRaw(
        CLAUDE_HOOK,
        dir,
        { ...LEDGER_ON, CW_HARNESS_TEST_FAULT: fault, ...SHORT_DEADLINE },
        input,
      );
      expect(answer(r)).toEqual(await reference(fault));
      expect(r.status).toBe(2);
    },
  );

  it("a ledger held by another writer: the same deny, inside the bound, and no line", async () => {
    const dir = guardCopy();
    mkdirSync(join(dir, ".claude/audit"), { recursive: true });
    // A fresh lock: `appendLedger` waits its 50 x 10 ms for it, then skips the entry.
    writeFileSync(join(dir, ".claude/audit", `${monthLedger()}.lock`), "");
    const r = await runRaw(
      CLAUDE_HOOK,
      dir,
      { ...LEDGER_ON, CW_HARNESS_TEST_FAULT: "hang", ...SHORT_DEADLINE },
      input,
    );
    expect(answer(r)).toEqual(await reference("hang"));
    expect(r.ms).toBeLessThan(BOUND_MS);
    expect(ledgerOf(dir)).toEqual([]);
  });

  it.each(["hang", "malformed"])(
    "a ledger child that hangs is killed at its bound (%s): the same deny, no line, never a hung guard",
    async (fault) => {
      const dir = guardCopy();
      const r = await runRaw(
        CLAUDE_HOOK,
        dir,
        {
          ...LEDGER_ON,
          CW_HARNESS_TEST_FAULT: fault,
          CW_HARNESS_TEST_LEDGER_FAULT: "hang",
          ...SHORT_DEADLINE,
        },
        input,
      );
      expect(answer(r)).toEqual(await reference(fault));
      expect(r.ms).toBeGreaterThanOrEqual(LEDGER_TIMEOUT_MS); // it waited for the child, and no longer
      expect(r.ms).toBeLessThan(BOUND_MS);
      expect(ledgerOf(dir)).toEqual([]);
    },
  );

  it.each(["hang", "throw", "malformed"])(
    "the deny is on stdout before the ledger child starts (%s): a hung child delays the exit, not the answer",
    async (fault) => {
      const r = await runRaw(
        CLAUDE_HOOK,
        guardCopy(),
        {
          ...LEDGER_ON,
          CW_HARNESS_TEST_FAULT: fault,
          CW_HARNESS_TEST_LEDGER_FAULT: "hang",
          ...SHORT_DEADLINE,
        },
        input,
      );
      expect(r.status).toBe(2);
      // The child hangs for LEDGER_TIMEOUT_MS after the deny: had the ledger gone first, the deny would arrive with it.
      expect(r.ms - r.firstOutputMs).toBeGreaterThan(LEDGER_TIMEOUT_MS * 0.6);
    },
  );

  // `finish` in a fresh process, like harness-finish-answers.test.ts: a ledger child that cannot even be started (here
  // `spawnSync` rejects the input it is given) is a lost line: the deny and exit 2 stand.
  it("a ledger child that cannot be started changes nothing about the deny", () => {
    const module = join(__dirname, "../harness/hard-deadline.ts");
    const program = `import { finish } from ${JSON.stringify(module)}; finish(null as never, { cause: "test", raw: 5 as never, codex: false });`;
    const r = spawnSync("bun", ["--no-install", "-e", program], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ...LEDGER_ON },
    });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
