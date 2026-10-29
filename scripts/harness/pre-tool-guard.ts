#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook — one process per tool call for every guarded tool.
 *
 *   Read / Grep / Glob / Edit / Write / MultiEdit / NotebookEdit  → refuse secret paths
 *   Edit / Write / MultiEdit / NotebookEdit                       → refuse PHI-shaped or credential content
 *   Bash                                                          → `classifyBash` (deny / ask / allow)
 *
 * Silence means "no opinion": the normal permission rules in .claude/settings.json still apply. Every
 * deny/ask is written to the agent ledger (metadata only).
 *
 * Fails CLOSED: empty or unparseable input, an internal error, and content too large to scan all answer
 * `deny`, because a guard that goes quiet when it breaks is a guard an oversized or malformed call can
 * switch off. A human who needs the session back sets `CW_HARNESS_FAIL_OPEN=1` for that one session.
 * (A guard process that never starts, e.g. `bun` missing, is non-blocking in Claude Code itself; the
 * Stop gate, the pre-commit scan and CI are the lines behind it.)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendLedger, loadRegistry, projectDir, readHookInput, relPath, sha256 } from "./io";
import {
  type Decision,
  MAX_SCAN_CHARS,
  classifyBash,
  describeFindings,
  globReachesSecret,
  scanContent,
  secretPathReason,
} from "./patterns";

function respond(decision: Exclude<Decision, "allow">, reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: `[chartwarden-harness] ${reason}`,
      },
    }),
  );
  process.exit(0);
}

function currentBranch(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The text an editing tool is about to put on disk. */
function newContent(tool: string, input: Record<string, unknown>): string {
  if (tool === "Write") return String(input.content ?? "");
  if (tool === "Edit") return String(input.new_string ?? "");
  if (tool === "NotebookEdit") return String(input.new_source ?? "");
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    return (input.edits as Array<{ new_string?: unknown }>)
      .map((e) => String(e.new_string ?? ""))
      .join("\n");
  }
  return "";
}

async function main(): Promise<void> {
  const hook = await readHookInput();
  if (hook.invalid) {
    if (process.env.CW_HARNESS_FAIL_OPEN === "1") return;
    respond(
      "deny",
      "The guard received empty or unparseable input, so it cannot judge this call. (CW_HARNESS_FAIL_OPEN=1 lets a human bypass for a session.)",
    );
  }
  const tool = hook.tool_name ?? "";
  const input = hook.tool_input ?? {};
  const root = projectDir(hook);
  const log = (decision: string, reason: string, target?: string, cmd?: string) =>
    appendLedger(root, hook.session_id, {
      event: "pre_tool",
      tool,
      target,
      cmd_sha256: cmd ? sha256(cmd) : undefined,
      decision,
      reason,
    });

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    const cwd = hook.cwd || root;
    const v = classifyBash(cmd, {
      branch: currentBranch(root),
      root,
      exists: (p) => existsSync(isAbsolute(p) ? p : join(cwd, p)),
    });
    if (v.decision !== "allow") {
      log(
        v.decision,
        v.reason,
        cmd
          .trim()
          .split(/\s+/)
          .find((t) => !t.includes("=")),
        cmd,
      );
      respond(v.decision, v.reason);
    }
    return;
  }

  const rawPath = input.file_path ?? input.notebook_path ?? input.path;
  const target = relPath(root, rawPath);
  if (target) {
    const why = secretPathReason(target);
    if (why) {
      const reason = `\`${target}\` is ${why}. Agents never read or write it; use the committed .example template for its shape.`;
      log("deny", reason, target);
      respond("deny", reason);
    }
  }
  // Grep/Glob with a glob that names secret files, e.g. `glob: ".env*"` or `"**/*.pem"`.
  if (
    (tool === "Grep" || tool === "Glob") &&
    // Glob's argument is `pattern`; Grep's `pattern` is a content regex, so only its `glob` counts.
    (tool === "Glob" ? [input.pattern, input.glob] : [input.glob]).some(
      (g) =>
        typeof g === "string" &&
        (/(^|\/)\.env\b(?!\.example)/.test(g) ||
          globReachesSecret(g) ||
          /\.(pem|key|p12|pfx|dump)\b/.test(g)),
    )
  ) {
    const reason = "Searching live .env files would surface secrets.";
    log("deny", reason, String(input.glob ?? input.pattern));
    respond("deny", reason);
  }

  const content = newContent(tool, input);
  if (content.length > MAX_SCAN_CHARS) {
    const reason = `This ${tool} writes ${Math.round(content.length / 1_000_000)} MB in one call, past the ${MAX_SCAN_CHARS / 1_000_000} MB the PHI/credential scan can vouch for. Write it in smaller pieces.`;
    log("deny", reason, target);
    respond("deny", reason);
  }
  if (content) {
    const findings = scanContent(content, loadRegistry(root), target);
    if (findings.length > 0) {
      const reason = describeFindings(target || "(content)", findings);
      log("deny", reason, target);
      respond("deny", reason);
    }
  }
}

main().catch((err: unknown) => {
  if (process.env.CW_HARNESS_FAIL_OPEN === "1") {
    process.stderr.write(
      `[chartwarden-harness] pre-tool-guard error (failing open): ${String(err)}\n`,
    );
    process.exit(0);
  }
  respond(
    "deny",
    `The guard hit an internal error and cannot judge this call: ${String(err).slice(0, 200)}`,
  );
});
