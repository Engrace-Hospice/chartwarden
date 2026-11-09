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
 *
 * `--codex` (run from `.codex/hooks.json`) is the same guard for Codex. Codex cannot prompt: `ask` is
 * "parsed but not supported yet" there, the hook run is marked failed and the tool call PROCEEDS. So every
 * `ask` is answered `deny`. File edits arrive as `apply_patch` (the patch text is `tool_input.command`) and
 * are judged file by file; Codex has no Read/Grep/Glob tools, its reads are shell commands (`Bash`).
 * Hooks there are trust-gated per developer (`/hooks`) and OpenAI calls them a guardrail, not an
 * enforcement boundary.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseApplyPatch } from "./codex-patch";
import { appendLedger, loadRegistry, projectDir, readHookInput, relPath, sha256 } from "./io";
import {
  type Decision,
  MAX_SCAN_CHARS,
  classifyBash,
  describeFindings,
  globReachesSecret,
  isProtectedPath,
  scanContent,
  secretPathReason,
} from "./patterns";

/** `--codex`: the hook is driven by Codex (`.codex/hooks.json`), not by Claude Code. */
const CODEX = process.argv.includes("--codex");
const CODEX_NO_ASK =
  "Codex cannot ask a human, so what Claude Code would have asked about is refused here: ";
/** What is actually answered: Codex has no `ask`, and an `ask` it cannot honour lets the call run. */
const effective = (d: Decision): Decision => (CODEX && d === "ask" ? "deny" : d);

type Log = (decision: Decision, reason: string, target?: string, cmd?: string) => void;

function respond(decision: Exclude<Decision, "allow">, reason: string): never {
  const final = effective(decision);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: final,
        permissionDecisionReason: `[chartwarden-harness] ${final === decision ? "" : CODEX_NO_ASK}${reason}`,
      },
    }),
  );
  process.exit(0);
}

/** Codex gives the session cwd, which may be a subdirectory; the rules are relative to the repo root. */
function codexRoot(cwd: string | undefined): string {
  const from = cwd || process.cwd();
  try {
    return (
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: from,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || from
    );
  } catch {
    return from;
  }
}

/**
 * Codex `apply_patch`: every path it names (and a rename's target), then the text it adds, judged exactly
 * as Claude's Edit/Write are. A patch the parser cannot read is refused: it cannot be judged.
 */
function checkPatch(text: string, root: string, cwd: string, log: Log): void {
  function deny(reason: string, target?: string): never {
    log("deny", reason, target);
    return respond("deny", reason);
  }
  const parsed = parseApplyPatch(text);
  if (!parsed.ok) {
    if (process.env.CW_HARNESS_FAIL_OPEN === "1") return;
    deny(
      `The guard could not read this apply_patch (${parsed.reason}), so it cannot judge it. (CW_HARNESS_FAIL_OPEN=1 lets a human bypass for a session.)`,
    );
  }
  const rel = (p: string): string => relPath(root, isAbsolute(p) ? p : join(cwd, p));
  const registry = loadRegistry(root);
  for (const f of parsed.files) {
    for (const target of (f.moveTo ? [f.path, f.moveTo] : [f.path]).map(rel)) {
      const why = secretPathReason(target);
      if (why) {
        deny(
          `\`${target}\` is ${why}. Agents never read or write it; use the committed .example template for its shape.`,
          target,
        );
      }
      if (isProtectedPath(target)) {
        deny(
          `\`${target}\` is part of the agent harness or the compliance record. Codex cannot ask a human, so a human edits it (or Claude Code, with approval).`,
          target,
        );
      }
    }
    const target = rel(f.path);
    if (f.added.length > MAX_SCAN_CHARS) {
      deny(
        `This patch adds ${Math.round(f.added.length / 1_000_000)} MB to one file, past the ${MAX_SCAN_CHARS / 1_000_000} MB the PHI/credential scan can vouch for. Add it in smaller pieces.`,
        target,
      );
    }
    const findings = scanContent(f.added, registry, target);
    if (findings.length > 0) deny(describeFindings(target, findings), target);
  }
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
  const root = CODEX ? process.env.CLAUDE_PROJECT_DIR || codexRoot(hook.cwd) : projectDir(hook);
  const cwd = hook.cwd || root;
  const log: Log = (decision, reason, target, cmd) =>
    appendLedger(root, hook.session_id, {
      event: "pre_tool",
      tool: CODEX ? `codex/${tool}` : tool,
      target,
      cmd_sha256: cmd ? sha256(cmd) : undefined,
      decision: effective(decision),
      reason,
    });

  if (CODEX && tool === "apply_patch") {
    checkPatch(String(input.command ?? ""), root, cwd, log);
    return;
  }

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
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
    // Codex often applies a patch as `apply_patch <<'EOF' ...` through the shell; judge that text too.
    if (CODEX && cmd.includes("*** Begin Patch")) checkPatch(cmd, root, cwd, log);
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
