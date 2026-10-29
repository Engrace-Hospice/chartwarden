#!/usr/bin/env bun
/**
 * Claude Code Stop hook — the fast, change-scoped slice of `arch:fitness`, run once per response.
 * ------------------------------------------------------------------------------------------------
 * ECC's `stop:format-typecheck` already batches Biome + tsc at Stop. It does not know the repo's
 * architecture gates, so an agent can finish a turn with a migration that breaks `arch:tenancy` and
 * only learn it at pre-push, many edits later. This hook closes that gap cheaply:
 *
 *   1. collect the working-tree changes (tracked diff + untracked, not ignored);
 *   2. skip entirely if that set is byte-identical to the last green run (most turns);
 *   3. PHI/credential-scan the changed text files (catches content written through Bash, which the
 *      PreToolUse guard never sees);
 *   4. run only the gates whose inputs changed — every gate here measured < 5 s on the full tree.
 *      The slow ones (`arch:tables` ~54 s, `arch:boundaries` ~39 s, `arch:gaps` ~12 s) stay with the
 *      pre-push hook and CI, where they already run;
 *   5. on failure, block the stop with the tail of each failing gate's output so the agent fixes it
 *      in the same turn. The SAME failure (same gates / same files, whatever the edits in between)
 *      blocks at most twice per session, then is released with a notice
 *      rather than looping.
 *
 * Off switch for a human: `CW_STOP_GATE=off`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, loadRegistry, projectDir, readHookInput, sha256 } from "./io";
import { describeFindings, isScannable, scanLarge } from "./patterns";

/** Path pattern → the fast gates that read it. Exported for the tests. */
export const GATE_MAP: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [
    /^packages\/db\/migrations\//,
    ["arch:tenancy", "arch:ddl", "arch:migration-numbering", "arch:org-indexes"],
  ],
  [/^architecture\//, ["arch:manifest-mirror", "arch:parity"]],
  [/^\.trivyignore\.yaml$/, ["arch:vuln-allowlist"]],
  [
    /^apps\/backend\/src\/.*\.ts$/,
    [
      "arch:error-envelope",
      "arch:request-header-auth",
      "arch:abac-predicates",
      "arch:context-attributes",
      "arch:route-reachability",
      "arch:queue-names",
    ],
  ],
  [/^packages\/[^/]+\/src\/.*\.ts$/, ["arch:error-envelope", "arch:queue-names"]],
  [
    /^(packages\/(ai-platform|intake-extraction|messaging)\/|docs\/architecture\/CHARTWARDEN_AI_GOVERNANCE)/,
    ["arch:ai-governance", "arch:ai-messaging-readonly"],
  ],
  [/(^|\/)(outbox|events?)[^/]*\.ts$|event-catalog/, ["arch:outbox-bindings"]],
  [/\.test\.tsx?$|^tsconfig|\/tsconfig/, ["arch:test-typecheck"]],
  [/^package\.json$|\.github\/workflows\/ci\.yml$/, ["arch:live-suites"]],
  [
    /^(compliance\/|\.claude\/|scripts\/harness\/|\.githooks\/|\.gitleaks\.toml$|\.gitignore$|CLAUDE\.md$|AGENTS\.md$)/,
    ["arch:compliance"],
  ],
];

export function gatesFor(paths: readonly string[]): string[] {
  const out = new Set<string>();
  if (paths.length > 0) out.add("arch:merge-artifacts");
  for (const p of paths)
    for (const [re, gates] of GATE_MAP) if (re.test(p)) for (const g of gates) out.add(g);
  return [...out];
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** NUL-separated (`-z`): git quotes non-ASCII and special names otherwise, and a quoted name looks deleted. */
export function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

function changedFiles(root: string): string[] {
  const tracked = splitNul(git(root, ["diff", "--name-only", "-z", "HEAD"]));
  const untracked = splitNul(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

interface State {
  greenFingerprint?: string;
  /** session id + signature of WHAT failed (gate names, scanned file paths) — not file mtimes, which
   *  change on every fix attempt and would otherwise reset the counter forever. */
  failKey?: string;
  blocks?: number;
}

const tail = (s: string, lines: number) => s.trimEnd().split("\n").slice(-lines).join("\n");

async function main(): Promise<void> {
  if (process.env.CW_STOP_GATE === "off") return;
  const hook = await readHookInput();
  const root = projectDir(hook);
  let files: string[];
  try {
    files = changedFiles(root);
  } catch {
    return; // not a git checkout — nothing to scope by
  }
  if (files.length === 0) return;

  const present = files.filter((f) => existsSync(join(root, f)));
  const fingerprint = sha256(
    `${present
      .map((f) => {
        const s = statSync(join(root, f));
        return `${f}:${s.size}:${s.mtimeMs}`;
      })
      .join("|")}|deleted:${files.length - present.length}`,
  );
  const cacheDir = join(root, ".claude", ".cache");
  const statePath = join(cacheDir, "stop-gate.json");
  let state: State = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {}
  if (state.greenFingerprint === fingerprint) return;

  const problems: string[] = [];
  const failIds: string[] = [];

  // PHI / credential scan of what changed (text files; one past MAX_SCAN_CHARS is reported, not skipped).
  const registry = loadRegistry(root);
  for (const f of present) {
    if (!isScannable(f)) continue;
    const full = join(root, f);
    const st = statSync(full);
    if (!st.isFile()) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    const findings = scanLarge(buf.toString("utf8"), registry, f);
    if (findings.length > 0) {
      failIds.push(`phi:${f}`);
      problems.push(`PHI/secret scan: ${describeFindings(f, findings)}`);
    }
  }

  const gates = gatesFor(files);
  const ran: string[] = [];
  for (const g of gates) {
    const r = spawnSync("bun", ["run", g], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    ran.push(g);
    if (r.status !== 0) {
      failIds.push(`gate:${g}`);
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      problems.push(`${g} failed:\n${tail(out, 25)}`);
    }
  }

  mkdirSync(cacheDir, { recursive: true });
  if (problems.length === 0) {
    writeFileSync(statePath, JSON.stringify({ greenFingerprint: fingerprint } satisfies State));
    appendLedger(root, hook.session_id, {
      event: "stop_gate",
      decision: "pass",
      target: ran.join(","),
    });
    return;
  }

  const failKey = sha256(`${hook.session_id ?? ""}|${failIds.join("|")}`);
  const blocks = state.failKey === failKey ? (state.blocks ?? 0) + 1 : 1;
  writeFileSync(statePath, JSON.stringify({ failKey, blocks } satisfies State));
  const summary = problems.join("\n\n").slice(0, 4000);
  appendLedger(root, hook.session_id, {
    event: "stop_gate",
    decision: blocks > 2 ? "released" : "block",
    target: ran.join(","),
    reason: failIds.join(",").slice(0, 500),
  });

  if (blocks > 2 || (hook.stop_hook_active === true && blocks > 1)) {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `[chartwarden-harness] Stop gate still red after ${blocks - 1} fix attempt(s); releasing. Unresolved:\n${summary}`,
      }),
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `[chartwarden-harness] Change-scoped gates are red. Fix these before finishing (the full set still runs at pre-push and in CI):\n\n${summary}`,
    }),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[chartwarden-harness] stop-gate error (not blocking): ${String(err)}\n`);
  process.exit(0);
});
