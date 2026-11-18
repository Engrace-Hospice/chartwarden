#!/usr/bin/env bun
/**
 * Writes ONE ledger line for an emergency deny: the entry thread of the guard (`hard-deadline.ts`) answered a call with
 * the standard deny because its deadline passed, its worker died, or the worker's answer was not a decision (HIPAA
 * 164.312(b), audit controls: a refusal the guard made on its own is still something an agent was stopped from doing,
 * and every other deny and ask is ledgered). The line has the same shape as the ones `guard-judge.ts` writes through
 * `appendLedger`: event, tool, decision, a reason, the SHA-256 of a Bash command (never its text), no file content.
 *
 * It runs as a CHILD PROCESS of the entry thread, after the deny is already on stdout and stderr, under a hard timeout
 * and with its output thrown away: the entry thread must stay free to answer its own timer, and a file system that
 * hangs cannot be bounded from inside the thread that waits on it (a guard killed at Claude's 10 s timeout lets the call
 * run), but a child can be killed. Whatever happens here (a locked ledger, an unwritable directory, a crash, the
 * timeout) changes nothing about the deny: the parent exits 2 either way.
 *
 * argv: `--claude` or `--codex`, then the reason. stdin: the hook input as the guard received it, possibly empty or
 * cut off (a call whose input never ended has no tool to name).
 *
 * `CW_HARNESS_TEST_LEDGER_FAULT=hang` is the seam a test uses to prove the timeout; production never sets it and the
 * shared settings cannot (their `env` is allow-listed).
 */
import { readFileSync } from "node:fs";
import { appendLedger, codexRoot, parseHookInput, projectDir, sha256 } from "./io";

/**
 * This file imports `./io` and nothing else of the harness (`io.ts` itself loads only `synthetic-registry.ts`): a
 * corrupted `patterns.ts`, which is exactly when an emergency deny happens, must not take the ledger line with it.
 * `harness-emergency-ledger-wave13b2.test.ts` pins the import graph and runs it against a corrupted copy.
 *
 * The child waits at most 10 x 10 ms for another writer's lock (the worker's own writes wait 50 x 10 ms): the parent
 * kills it at `LEDGER_TIMEOUT_MS` anyway, and a lost line is cheaper than a late exit.
 */
const EMERGENCY_LOCK_ATTEMPTS = 10;

const [, , mode, reason = "emergency deny"] = process.argv;
const codex = mode === "--codex";

if (process.env.CW_HARNESS_TEST_LEDGER_FAULT === "hang") for (;;);

try {
  const hook = parseHookInput(readFileSync(0, "utf8"));
  // The input may be anything a failing guard was handed: only text is written, and never more than a name.
  const tool = typeof hook.tool_name === "string" ? hook.tool_name : "";
  const session = typeof hook.session_id === "string" ? hook.session_id : undefined;
  const command = tool === "Bash" ? hook.tool_input?.command : undefined;
  appendLedger(
    codex ? codexRoot() : projectDir(hook),
    session,
    {
      event: "pre_tool",
      tool: tool && codex ? `codex/${tool}` : tool,
      cmd_sha256: typeof command === "string" ? sha256(command) : undefined,
      decision: "deny",
      reason,
    },
    EMERGENCY_LOCK_ATTEMPTS,
  );
} catch {
  // best effort, like every ledger write: a ledger failure never blocks the developer's work or changes the deny
}
