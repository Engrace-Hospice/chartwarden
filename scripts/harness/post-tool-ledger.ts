#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook (async) — records WHAT the agent did, never what it saw.
 * Target only: a repo-relative path for file tools, the command's first word + SHA-256 for Bash, the
 * domain for WebFetch. See io.ts for why the ledger holds no content.
 */
import { appendLedger, projectDir, readHookInput, relPath, sha256 } from "./io";

async function main(): Promise<void> {
  const hook = await readHookInput();
  const tool = hook.tool_name ?? "";
  const input = hook.tool_input ?? {};
  const root = projectDir(hook);
  let target = relPath(root, input.file_path ?? input.notebook_path ?? input.path);
  let cmd: string | undefined;
  if (tool === "Bash") {
    cmd = String(input.command ?? "");
    // First word only (skipping VAR=value prefixes): arguments can carry URLs with passwords.
    target =
      cmd
        .trim()
        .split(/\s+/)
        .find((t) => !t.includes("=")) ?? "";
  } else if (tool === "WebFetch" && typeof input.url === "string") {
    try {
      target = new URL(input.url).hostname;
    } catch {}
  } else if (tool.startsWith("mcp__")) {
    target = tool;
  }
  appendLedger(root, hook.session_id, {
    event: "post_tool",
    tool,
    target,
    cmd_sha256: cmd ? sha256(cmd) : undefined,
  });
}

main().catch(() => process.exit(0));
