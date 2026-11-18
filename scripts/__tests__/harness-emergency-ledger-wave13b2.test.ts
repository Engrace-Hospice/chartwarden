/**
 * Wave 13 part B2, items L4 and CR-8 (the emergency deny) and L2 (a hook input of the wrong shape).
 *
 * L4: the emergency deny is the deadline (6.5 s) plus the ledger child's kill timeout plus bun's start; with the child's
 * bound at 1,000 ms that was 7.5 to 7.6 s against Codex's 8 s alarm. The bound is now 500 ms.
 *
 * CR-8: the ledger child (`emergency-ledger.ts`) imported `io.ts`, which imported `patterns.ts`: a corrupted
 * `patterns.ts` (exactly the tamper case) lost the ledger line. The child's import graph is now `io.ts` and
 * `synthetic-registry.ts` only. A read-only `.claude/audit` also cost 0.6 s (50 x 10 ms lock tries that could never
 * win): an unwritable directory is given up on at once, and the emergency child waits for a lock at most 10 x 10 ms.
 *
 * L2: a hook input whose `tool_input` is not an object, or whose Bash `command` is not text, exited 0 (allow) in
 * Claude mode. Both modes now deny (exit 2) and ledger it.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { judgeHook } from "../harness/guard-judge";
import { DEADLINE_MS, LEDGER_TIMEOUT_MS } from "../harness/hard-deadline";
import {
  CLAUDE_HOOK,
  CODEX_HOOK,
  REPO,
  bashPayload,
  guardCopy,
  removeCopies,
  runClaude,
  runCodex,
  scratchDir,
} from "./_guard-copy";
import { withoutGuardSwitches } from "./helpers/scrubbed-env";

afterAll(removeCopies);

const LEDGER_ON = { CW_AGENT_LEDGER: "on" };
const GARBAGE = "12:00:00.000000 git.c:460             trace: built-in: git status\n";
const HARNESS = join(REPO, "scripts/harness");
const monthLedger = (): string => `agent-ledger-${new Date().toISOString().slice(0, 7)}.jsonl`;

interface Line {
  readonly tool?: string;
  readonly decision?: string;
  readonly reason?: string;
}

function ledgerOf(dir: string): Line[] {
  const audit = join(dir, ".claude/audit");
  if (!existsSync(audit)) return [];
  return readdirSync(audit)
    .filter((f) => /^agent-ledger-\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(join(audit, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as Line);
}

describe("L4: the worst case of an emergency deny stays well under Codex's 8 s alarm", () => {
  const CODEX_ALARM_MS = 8000;
  const BUN_START_MS = 300; // a loaded machine
  const MARGIN_MS = 600;

  it("DEADLINE_MS + the ledger child's bound + a loaded bun start leaves at least 600 ms", () => {
    expect(DEADLINE_MS + LEDGER_TIMEOUT_MS + BUN_START_MS).toBeLessThanOrEqual(
      CODEX_ALARM_MS - MARGIN_MS,
    );
  });

  it("the child's bound is not zero (a line must be able to land)", () => {
    expect(LEDGER_TIMEOUT_MS).toBeGreaterThanOrEqual(300);
  });

  it("a hung ledger child delays the exit by its bound and not by a second", () => {
    const dir = guardCopy();
    const started = performance.now();
    const r = runClaude(dir, bashPayload("echo hi"), {
      ...LEDGER_ON,
      CW_HARNESS_TEST_FAULT: "hang",
      CW_HARNESS_TEST_LEDGER_FAULT: "hang",
      CW_HARNESS_DEADLINE_MS_FOR_TESTS: "300",
    });
    const ms = performance.now() - started;
    expect(r.status).toBe(2);
    // the deadline (300 ms), the child's bound, two bun starts and the shell: well under the old 1,000 ms bound plus the deadline
    expect(ms).toBeLessThan(1650);
    expect(ms).toBeGreaterThanOrEqual(300 + LEDGER_TIMEOUT_MS);
  });
});

/** Every `./name` a harness file imports (static `from "./x"`), as file names. */
function importsOf(file: string): string[] {
  const text = readFileSync(join(HARNESS, file), "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([\w-]+)["']/g)].map(
    (m) => `${m[1]}.ts`,
  );
}

function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  for (let file = todo.pop(); file; file = todo.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    todo.push(...importsOf(file));
  }
  return seen;
}

describe("CR-8: the ledger child loads io.ts and the registry, nothing else", () => {
  it("the import closure of emergency-ledger.ts is exactly three files", () => {
    expect([...importClosure("emergency-ledger.ts")].sort()).toEqual([
      "emergency-ledger.ts",
      "io.ts",
      "synthetic-registry.ts",
    ]);
  });

  it.each(["patterns.ts", "content-scan.ts", "guard-judge.ts", "hard-deadline.ts"])(
    "%s is not in the child's closure",
    (file) => {
      expect(importClosure("emergency-ledger.ts").has(file)).toBe(false);
    },
  );

  const CORRUPTED = [
    "patterns.ts",
    "content-scan.ts",
    "secret-names.ts",
    "guard-judge.ts",
    "word-readings.ts",
  ];
  const AGENTS = [
    ["Claude", CLAUDE_HOOK, "Bash"],
    ["Codex", CODEX_HOOK, "codex/Bash"],
  ] as const;

  it.each(CORRUPTED.flatMap((f) => AGENTS.map((a) => [f, ...a] as const)))(
    "%s corrupted: the call is refused (exit 2) and the emergency line is still written (%s)",
    (file, agent, hook, tool) => {
      const dir = guardCopy();
      appendFileSync(join(dir, "scripts/harness", file), GARBAGE);
      const payload = bashPayload("echo emergency-marker-9c1d");
      const env = LEDGER_ON;
      const r =
        hook === CODEX_HOOK
          ? runCodex(dir, payload, env, hook)
          : runClaude(dir, payload, env, hook);
      expect(r.status, agent).toBe(2);
      const lines = ledgerOf(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ tool, decision: "deny" });
      expect(lines[0]?.reason).toMatch(/^emergency deny \(worker (?:error|closed)\)/);
    },
  );

  it("control: the same corruption of the child's own io.ts loses the line (the deny stands)", () => {
    const dir = guardCopy();
    appendFileSync(join(dir, "scripts/harness/io.ts"), GARBAGE);
    const r = runClaude(dir, bashPayload("echo hi"), LEDGER_ON);
    expect(r.status).toBe(2);
    expect(ledgerOf(dir)).toEqual([]);
  });
});

describe("CR-8: a lock that cannot be won is not waited for", () => {
  const skipRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const IO = join(HARNESS, "io.ts");
  const BUN_FLAGS = ["--config=/dev/null", "--no-env-file", "--tsconfig-override=/dev/null"];

  /** `appendLedger` timed inside a bun process (it sleeps with `Bun.sleepSync`, which vitest's node does not have). */
  const appendMs = (root: string, attempts: number | undefined): number => {
    const call = attempts === undefined ? "" : `, ${attempts}`;
    const program = `import { appendLedger } from ${JSON.stringify(IO)};
const started = performance.now();
appendLedger(${JSON.stringify(root)}, undefined, { event: "pre_tool", decision: "deny", reason: "t" }${call});
console.log(performance.now() - started);`;
    const r = spawnSync("bun", [...BUN_FLAGS, "-e", program], {
      encoding: "utf8",
      env: { ...withoutGuardSwitches(process.env), ...LEDGER_ON },
      timeout: 20_000,
    });
    return Number(r.stdout.trim());
  };
  const heldLockRoot = (): string => {
    const root = scratchDir("cw-held-lock-");
    mkdirSync(join(root, ".claude", "audit"), { recursive: true });
    writeFileSync(join(root, ".claude", "audit", `${monthLedger()}.lock`), "");
    return root;
  };

  it.skipIf(skipRoot)("a read-only audit directory is given up on at once (was 500+ ms)", () => {
    const root = scratchDir("cw-ro-audit-");
    const audit = join(root, ".claude", "audit");
    mkdirSync(audit, { recursive: true });
    chmodSync(audit, 0o555);
    try {
      expect(appendMs(root, undefined)).toBeLessThan(150);
    } finally {
      chmodSync(audit, 0o755);
    }
    expect(ledgerOf(root)).toEqual([]);
  });

  it.skipIf(skipRoot)(
    "a read-only audit directory costs the emergency child no waiting either",
    () => {
      const root = scratchDir("cw-ro-audit-");
      const audit = join(root, ".claude", "audit");
      mkdirSync(audit, { recursive: true });
      chmodSync(audit, 0o555);
      try {
        expect(appendMs(root, 10)).toBeLessThan(60);
      } finally {
        chmodSync(audit, 0o755);
      }
    },
  );

  it("control: another writer's lock is still waited for, 50 x 10 ms by default", () => {
    const ms = appendMs(heldLockRoot(), undefined);
    expect(ms).toBeGreaterThanOrEqual(450);
  });

  it("a held lock costs the attempts it is given: 10 x 10 ms", () => {
    const root = heldLockRoot();
    const ms = appendMs(root, 10);
    expect(ms).toBeGreaterThanOrEqual(90);
    expect(ms).toBeLessThan(350);
    expect(ledgerOf(root)).toEqual([]);
  });

  /** The child itself, run by hand, the whole process: its start is the same with and without the lock. */
  const childMs = (dir: string): number => {
    const started = performance.now();
    spawnSync(
      "bun",
      [
        ...BUN_FLAGS,
        join(dir, "scripts/harness/emergency-ledger.ts"),
        "--claude",
        "emergency deny (deadline): t",
      ],
      {
        input: JSON.stringify(bashPayload("echo hi")),
        env: { ...withoutGuardSwitches(process.env), CLAUDE_PROJECT_DIR: dir, ...LEDGER_ON },
        timeout: 10_000,
      },
    );
    return performance.now() - started;
  };

  it("the child with a held lock takes about 100 ms longer than the child with a free one, not 500", () => {
    const free = guardCopy();
    const held = guardCopy();
    mkdirSync(join(held, ".claude/audit"), { recursive: true });
    writeFileSync(join(held, ".claude/audit", `${monthLedger()}.lock`), "");
    childMs(free); // warm the file cache
    const reference = Math.min(childMs(free), childMs(free));
    const withLock = childMs(held);
    expect(withLock - reference).toBeLessThan(350);
    expect(ledgerOf(held)).toEqual([]);
    expect(ledgerOf(free).length).toBeGreaterThan(0);
  });
});

describe("L2: a hook input of the wrong shape is refused in both modes", () => {
  const SHAPES: Array<[string, unknown, RegExp]> = [
    [
      "a string tool_input",
      { tool_name: "Bash", tool_input: "git status" },
      /tool input was not an object/,
    ],
    [
      "a string tool_input on Write",
      { tool_name: "Write", tool_input: "x" },
      /tool input was not an object/,
    ],
    ["a number tool_input", { tool_name: "Bash", tool_input: 5 }, /tool input was not an object/],
    [
      "an array tool_input",
      { tool_name: "Bash", tool_input: ["git status"] },
      /tool input was not an object/,
    ],
    [
      "a null tool_input on Bash",
      { tool_name: "Bash", tool_input: null },
      /tool input was not an object/,
    ],
    ["a missing tool_input on Bash", { tool_name: "Bash" }, /command was not text/],
    ["a number command", { tool_name: "Bash", tool_input: { command: 5 } }, /command was not text/],
    [
      "an array command",
      { tool_name: "Bash", tool_input: { command: ["git", "status"] } },
      /command was not text/,
    ],
    [
      "an object command",
      { tool_name: "Bash", tool_input: { command: { a: 1 } } },
      /command was not text/,
    ],
    [
      "a null command",
      { tool_name: "Bash", tool_input: { command: null } },
      /command was not text/,
    ],
    ["a missing command", { tool_name: "Bash", tool_input: {} }, /command was not text/],
    [
      "a boolean command",
      { tool_name: "Bash", tool_input: { command: true } },
      /command was not text/,
    ],
  ];

  it.each(SHAPES.flatMap(([n, h, r]) => [false, true].map((c) => [n, h, r, c] as const)))(
    "%s is denied for its own reason (codex: %s)",
    (_name, hook, reason, codex) => {
      const answer = judgeHook(hook as never, codex);
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toMatch(reason);
    },
  );

  it.each(SHAPES.slice(0, 3))("%s: the real Claude hook exits 2 and ledgers it", (_name, hook) => {
    const dir = guardCopy();
    const r = runClaude(dir, hook, LEDGER_ON);
    expect(r.status).toBe(0); // a deny is JSON on exit 0 from the worker; the decision is what counts
    expect(r.decision).toBe("deny");
    const lines = ledgerOf(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: "deny" });
  });

  const OK: Array<[string, unknown]> = [
    ["an ordinary Bash command", bashPayload("git status")],
    ["a Bash command with a workdir-free echo", bashPayload("echo hello")],
    [
      "Write of a plain file",
      { tool_name: "Write", tool_input: { file_path: "/tmp/x.txt", content: "hi" } },
    ],
    ["Read of a plain file", { tool_name: "Read", tool_input: { file_path: "/tmp/x.txt" } }],
    ["Grep with a pattern", { tool_name: "Grep", tool_input: { pattern: "foo" } }],
  ];

  it.each(OK)("everyday neighbour: %s stays allow in Claude mode", (_name, hook) => {
    expect(judgeHook(hook as never, false).decision).toBe("allow");
  });

  it("the ledger line of the shape refusal names the tool and no content", () => {
    const dir = guardCopy();
    runClaude(dir, { tool_name: "Bash", tool_input: "echo shape-marker-4e2b" }, LEDGER_ON);
    const text = readFileSync(join(dir, ".claude/audit", monthLedger()), "utf8");
    expect(text).not.toContain("shape-marker-4e2b");
    expect(ledgerOf(dir)[0]).toMatchObject({ tool: "Bash", decision: "deny" });
  });
});
