#!/usr/bin/env bun
/**
 * Claude Code / Codex PreToolUse hook entry point, one process per guarded tool call. The judgement is in
 * `guard-judge.ts`; it runs in a worker (`guard-worker.ts`) so that this thread can enforce a hard wall-clock
 * deadline (`hard-deadline.ts`): a call the guard cannot judge in time is refused (exit 2) in both agents,
 * never run. `--codex` (run from `.codex/hooks.json`) is the same guard for Codex.
 */
import { runGuard } from "./hard-deadline";

await runGuard(new URL("./guard-worker.ts", import.meta.url), process.argv.includes("--codex"));
