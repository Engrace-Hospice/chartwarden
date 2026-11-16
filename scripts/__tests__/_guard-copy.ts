/**
 * A throwaway COPY of the guard tree, and the REAL pinned hook commands run against it as Claude Code and Codex run
 * them (`sh -c <command>` from the session directory, the payload on stdin). Real-hook tests corrupt or poison the
 * copy, never the checkout; payloads are only classified, nothing in them runs.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = join(__dirname, "../..");
const commandOf = (file: string): string =>
  JSON.parse(readFileSync(join(REPO, file), "utf8")).hooks.PreToolUse[0].hooks[0].command;
/** The two pinned commands, as committed. */
export const CLAUDE_HOOK: string = commandOf(".claude/settings.json");
/**
 * Claude's guard command as it was before the fail-closed tail (wave 7, T0), spelled out rather than derived: the
 * negative control that really exits 1 (= Claude Code's allow) when the guard cannot start.
 */
export const CLAUDE_HOOK_WITHOUT_TAIL =
  'bun --config=/dev/null --no-env-file --tsconfig-override=/dev/null "$CLAUDE_PROJECT_DIR"/scripts/harness/pre-tool-guard.ts';
export const CODEX_HOOK: string = commandOf(".codex/hooks.json");

const made: string[] = [];
/** Remove every copy this file made (call from `afterAll`). */
export function removeCopies(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** An empty temp directory (real path), removed by {@link removeCopies}. */
export function scratchDir(prefix = "cw-scratch-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A directory shaped like the checkout: the guard, the hook configuration, a `.git` marker. */
export function guardCopy(): string {
  const dir = scratchDir("cw-guard-copy-");
  cpSync(join(REPO, "scripts/harness"), join(dir, "scripts/harness"), { recursive: true });
  mkdirSync(join(dir, "compliance"), { recursive: true });
  cpSync(
    join(REPO, "compliance/synthetic-identifiers.json"),
    join(dir, "compliance/synthetic-identifiers.json"),
  );
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), "{}\n");
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex/hooks.json"), "{}\n");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

export interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `permissionDecision` of the hook's JSON answer; `allow` when it printed nothing and exited 0. */
  readonly decision: string;
}

function decisionOf(status: number | null, stdout: string): string {
  const m = /"permissionDecision":"(\w+)"/.exec(stdout);
  if (m?.[1]) return m[1];
  if (status === 0 && stdout.trim() === "") return "allow";
  return status === 2 ? "exit2" : `exit${status}`;
}

function run(hook: string, dir: string, payload: unknown, env: Record<string, string>): HookRun {
  const r = spawnSync("/bin/sh", ["-c", hook], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CW_AGENT_LEDGER: "off", CLAUDE_PROJECT_DIR: dir, ...env },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    decision: decisionOf(r.status, r.stdout ?? ""),
  };
}

export const bashPayload = (command: string): { tool_name: string; tool_input: unknown } => ({
  tool_name: "Bash",
  tool_input: { command },
});

/**
 * The pinned Claude command (the committed one unless `hook` says otherwise), with the project directory set the way
 * Claude Code sets it.
 */
export const runClaude = (
  dir: string,
  payload: unknown,
  env: Record<string, string> = {},
  hook: string = CLAUDE_HOOK,
): HookRun => run(hook, dir, payload, env);

/** A pinned Codex command (the committed one unless `hook` says otherwise), from the session directory `dir`. */
export const runCodex = (
  dir: string,
  payload: unknown,
  env: Record<string, string> = {},
  hook: string = CODEX_HOOK,
): HookRun => {
  const withCwd = { ...(payload as object), cwd: dir, hook_event_name: "PreToolUse" };
  return run(hook, dir, withCwd, env);
};
