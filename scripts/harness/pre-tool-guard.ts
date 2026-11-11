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
 * are judged file by file; Codex has no Read/Grep/Glob tools, its reads are shell commands (`Bash`); an MCP
 * tool (`mcp__<server>__<tool>`) takes arbitrary JSON, so every string in it is judged as a path and as text.
 * The repo root there is where this script lives (the hook command runs the script from the git toplevel),
 * never `CLAUDE_PROJECT_DIR`. Hooks there are trust-gated per developer (`/hooks`) and OpenAI calls them a
 * guardrail, not an enforcement boundary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PATCH_CHARS,
  mcpStrings,
  parseApplyPatch,
  shellPatch,
  withoutOddChars,
} from "./codex-patch";
import { appendLedger, loadRegistry, projectDir, readHookInput, relPath, sha256 } from "./io";
import {
  type BashVerdict,
  type Decision,
  MAX_SCAN_CHARS,
  classifyBash,
  describeFindings,
  globReachesSecret,
  isInteractiveShell,
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

const MAX_REASON_CHARS = 600;

function respond(decision: Exclude<Decision, "allow">, reason: string): never {
  const final = effective(decision);
  const text = `[chartwarden-harness] ${final === decision ? "" : CODEX_NO_ASK}${reason}`;
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: final,
      // A reason can echo command text (a 400 KB URL host); a long one must not grow the output.
      permissionDecisionReason:
        text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text,
    },
  });
  // Synchronous: `process.stdout.write` then `exit` cut a large write to a pipe off at 64 KB, and Codex runs a
  // call whose hook output is not valid JSON.
  try {
    writeSync(1, json);
  } catch {
    process.stdout.write(json);
  }
  process.exit(0);
}

function refuse(log: Log, reason: string, target?: string, cmd?: string): never {
  log("deny", reason, target, cmd);
  return respond("deny", reason);
}

/** The real path, or for a path that does not exist yet its nearest existing parent's real path plus the rest. */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canon(parent), basename(p));
  }
}

/**
 * `--codex`: the repo root is where THIS script lives. The pinned hook command runs
 * `$(git rev-parse --show-toplevel)/scripts/harness/pre-tool-guard.ts`, so the script's grandparent is the git
 * toplevel of the Codex session, with no `git` call and no environment variable to move it: `CLAUDE_PROJECT_DIR`
 * (a developer may export it from a Claude shell, pointing at another tree) used to override the root here, and
 * protected-path matching then ran against the wrong tree without a word. `CW_HARNESS_ROOT_FOR_TESTS` is the
 * test seam; production never sets it.
 */
const codexRoot = (): string =>
  process.env.CW_HARNESS_ROOT_FOR_TESTS ||
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A path as the repo sees it: real paths on both sides, relative paths resolved from the directory `base`. */
function pathResolver(root: string, base: string): (p: string) => string {
  const realRoot = canon(root);
  return (p) => relPath(realRoot, canon(isAbsolute(p) ? p : join(base, p)));
}

/**
 * Codex `apply_patch`: every path it names (and a rename's target), then the text it adds, judged exactly
 * as Claude's Edit/Write are. A patch the parser cannot read is refused: it cannot be judged.
 */
function checkPatch(text: string, root: string, base: string, log: Log): void {
  if (text.length > MAX_PATCH_CHARS) {
    refuse(
      log,
      `This patch is ${Math.round(text.length / 1024)} KB, past the ${MAX_PATCH_CHARS / 1024} KB the guard can scan inside Codex's hook timeout (a hook that times out lets the call run). Split it.`,
    );
  }
  const parsed = parseApplyPatch(text);
  if (!parsed.ok) {
    if (process.env.CW_HARNESS_FAIL_OPEN === "1") return;
    refuse(
      log,
      `The guard could not read this apply_patch (${parsed.reason}), so it cannot judge it. (CW_HARNESS_FAIL_OPEN=1 lets a human bypass for a session.)`,
    );
  }
  // Real paths on both sides, resolved from the directory the patch runs in: a symlinked cwd or root would
  // otherwise turn `.codex/hooks.json` into `../../..`, and a symlink into a protected directory would pass.
  const rel = pathResolver(root, base);
  const registry = loadRegistry(root);
  for (const f of parsed.files) {
    for (const target of (f.moveTo ? [f.path, f.moveTo] : [f.path]).map(rel)) {
      const why = secretPathReason(target);
      if (why) {
        refuse(
          log,
          `\`${target}\` is ${why}. Agents never read or write it; use the committed .example template for its shape.`,
          target,
        );
      }
      if (isProtectedPath(target)) {
        refuse(
          log,
          `\`${target}\` is part of the agent harness or the compliance record. Codex cannot ask a human, so a human edits it (or Claude Code, with approval).`,
          target,
        );
      }
    }
    // A rename's destination is where the text lands: scan it with no source-path exemptions, or a lockfile
    // or test fixture renamed INTO source would skip the content rules.
    const target = rel(f.path);
    const findings = scanContent(f.added, registry, f.moveTo ? "" : target);
    if (findings.length > 0) refuse(log, describeFindings(target, findings), target);
  }
}

const NOT_TEXT = "was not text, so the guard cannot judge it";
/** A line this long is not a path (PATH_MAX is 4096): it is matched as written and never resolved on disk. */
const MAX_PATH_CHARS = 4096;
/** Lines of an MCP input resolved on disk in one call; past it the call is refused (the work must fit the hook's timeout). */
const MAX_MCP_PATH_LINES = 20_000;

/** A name for the log and the reason only when it is short and one word: never echo prose, which may hold PHI. */
const nameOf = (s: string): string | undefined =>
  s.length <= 200 && !/\s/.test(s) ? s : undefined;

/**
 * A line that reads as a secret or protected path only once its control, format and non-ASCII-space characters
 * are taken out (a trailing U+0085: a Rust `trim` strips it, a JS one keeps it) is refused, as the same path in
 * an `apply_patch` header is. Free text with such characters in it stays allowed: only a line that BECOMES a
 * secret or protected path is refused, and the reason echoes that path, never the odd characters.
 */
function refuseHiddenPath(
  line: string,
  written: string,
  rel: (p: string) => string,
  log: Log,
): void {
  const bare = withoutOddChars(line).trim();
  if (!bare || bare === written || bare.length > MAX_PATH_CHARS) return;
  for (const target of [bare, rel(bare)]) {
    if (!secretPathReason(target) && !isProtectedPath(target)) continue;
    const named = nameOf(target) ? `\`${target}\`` : "A value in the tool input";
    refuse(
      log,
      `${named} names a secret or protected path with control or non-ASCII-space characters in it, which a tool may strip. Refused; write the plain path if it is legitimate.`,
      nameOf(target),
    );
  }
}

/**
 * `--codex`, an MCP tool (`mcp__<server>__<tool>`): Codex hands it arbitrary JSON and nothing says which field
 * is a path or text, so EVERY string in it (keys too) is judged: each line as a secret path and as a protected
 * path, as written and resolved from the session cwd with symlinks followed (as `apply_patch` paths are), and
 * the whole string through the PHI/credential scan with no source-file exemptions. Nothing is guessed about what
 * the tool does with a value. An input that is not an object, or too big or deep to scan in time, is refused.
 */
function checkMcp(raw: unknown, root: string, base: string, log: Log): void {
  const got = mcpStrings(raw);
  if (!got.ok) refuse(log, `The MCP tool input could not be judged: ${got.reason}.`);
  const rel = pathResolver(root, base);
  const registry = loadRegistry(root);
  let lines = 0;
  for (const value of got.strings) {
    for (const line of value.split(/[\r\n\0]/)) {
      const written = line.trim();
      if (!written) continue;
      if (++lines > MAX_MCP_PATH_LINES) {
        refuse(
          log,
          `The MCP tool input has more than ${MAX_MCP_PATH_LINES} lines of text, past what the guard can resolve inside Codex's hook timeout. Split it.`,
        );
      }
      const candidates = written.length > MAX_PATH_CHARS ? [written] : [written, rel(written)];
      for (const target of candidates) {
        const named = nameOf(target) ? `\`${target}\`` : "A value in the tool input";
        const why = secretPathReason(target);
        if (why) {
          refuse(
            log,
            `${named} is ${why}. Agents never read or write it; use the committed .example template for its shape.`,
            nameOf(target),
          );
        }
        if (isProtectedPath(target)) {
          refuse(
            log,
            `${named} is part of the agent harness or the compliance record. Codex cannot ask a human, so a human edits it (or Claude Code, with approval).`,
            nameOf(target),
          );
        }
      }
      refuseHiddenPath(line, written, rel, log);
    }
    const findings = scanContent(value, registry, "");
    if (findings.length > 0) refuse(log, describeFindings("(an MCP tool argument)", findings));
  }
}

/** Codex shell commands: no bare interactive shell, and a patch applied through the shell is one plain heredoc. */
function checkCodexShell(cmd: string, root: string, workdir: string, log: Log): void {
  if (isInteractiveShell(cmd)) {
    refuse(
      log,
      "A bare interactive shell or REPL is refused. Non-empty write_stdin input also fails closed, but refusing the persistent process at creation is defence in depth. Run the command you need directly.",
      undefined,
      cmd,
    );
  }
  const shell = shellPatch(cmd);
  if (shell.kind === "refuse") refuse(log, shell.reason, undefined, cmd);
  if (shell.kind === "patch") checkPatch(shell.text, root, workdir, log);
}

/**
 * Codex's exec tool takes a `workdir`, relative to the session cwd, and every relative target in the command
 * resolves from it: it is where a relative write lands. Claude's Bash tool has none. `""` is no workdir;
 * `undefined` is one that is present and not text, which must not silently fall back to the session cwd, for
 * every command and not only a patch.
 */
function workdirOf(input: Record<string, unknown>): string | undefined {
  const workdir = input.workdir;
  if (!CODEX || workdir === undefined || workdir === null) return "";
  return typeof workdir === "string" ? workdir : undefined;
}

const VERDICT_RANK: Readonly<Record<Decision, number>> = { allow: 0, ask: 1, deny: 2 };

/**
 * `classifyBash` compares paths as text, so a cwd and a root that name one directory through different text (a
 * symlinked `/tmp` against `/private/tmp`) would not match. Judged twice, as written and with the real path of
 * the root and the directory the command runs in, and the stricter answer wins: real paths alone would lose
 * the match for a command that spells an absolute path with the root's own, symlinked, text.
 */
function judgeBash(cmd: string, root: string, cwd: string, workdir: string): BashVerdict {
  const branch = currentBranch(root);
  const judge = (r: string, base: string): BashVerdict => {
    // A persisted `cd apps/backend` from an earlier call leaves the shell there: judge relative writes from it.
    // A `workdir` that is a symlink (`apps/link -> ../scripts/harness`) is where the command really runs.
    const dir = workdir ? canon(resolve(base, workdir)) : base;
    return classifyBash(cmd, {
      branch,
      root: r,
      cwd: dir,
      exists: (p) => existsSync(isAbsolute(p) ? p : join(dir, p)),
    });
  };
  const written = judge(root, cwd);
  const realRoot = canon(root);
  const realCwd = canon(cwd);
  if (realRoot === root && realCwd === cwd) return written;
  const real = judge(realRoot, realCwd);
  return VERDICT_RANK[real.decision] > VERDICT_RANK[written.decision] ? real : written;
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

/**
 * A text field of an editing tool. Absent is empty text; under `--codex` a value that is present and not a
 * string is `undefined` (refused), never `String(value)` judged as if it were what the tool would write.
 */
const textField = (v: unknown): string | undefined =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : CODEX ? undefined : String(v);

/** The text an editing tool is about to put on disk; `undefined` when a field it holds is not text (`--codex`). */
function newContent(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === "Write") return textField(input.content);
  if (tool === "Edit") return textField(input.new_string);
  if (tool === "NotebookEdit") return textField(input.new_source);
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const parts = (input.edits as Array<{ new_string?: unknown }>).map((e) =>
      textField(e.new_string),
    );
    return parts.some((p) => p === undefined) ? undefined : parts.join("\n");
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
  const root = CODEX ? codexRoot() : projectDir(hook);
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
    const patch = input.command;
    if (typeof patch !== "string") {
      refuse(log, `The apply_patch input ${NOT_TEXT}.`);
    }
    checkPatch(patch, root, cwd, log);
    return;
  }

  if (CODEX && tool === "write_stdin") {
    const chars = input.chars;
    if (chars === undefined || chars === null || chars === "") return;
    if (typeof chars !== "string") refuse(log, `The write_stdin chars ${NOT_TEXT}.`);
    refuse(
      log,
      "Non-empty write_stdin input is refused: it reaches an existing process without re-running that process's PreToolUse command checks. Use a finite exec_command call instead.",
    );
  }

  if (CODEX && tool.startsWith("mcp__")) {
    checkMcp(hook.tool_input, root, cwd, log);
    return;
  }

  if (tool === "Bash") {
    const command = input.command;
    // `String(command)` of an array or object is not what the shell would run: refuse it before judging it.
    if (CODEX && typeof command !== "string") refuse(log, `The command ${NOT_TEXT}.`);
    const cmd = String(command ?? "");
    if (CODEX && (input.tty === true || input.pty === true || input.use_pty === true)) {
      refuse(
        log,
        "Codex PTY execution is refused at creation; non-empty write_stdin input also fails closed. Run a finite non-PTY command instead.",
        undefined,
        cmd,
      );
    }
    const workdir = workdirOf(input);
    if (workdir === undefined) refuse(log, `The command's workdir ${NOT_TEXT}.`, undefined, cmd);
    const v = judgeBash(cmd, root, cwd, workdir);
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
    if (CODEX) checkCodexShell(cmd, root, workdir ? resolve(cwd, workdir) : cwd, log);
    return;
  }

  const rawPath = input.file_path ?? input.notebook_path ?? input.path;
  const target = relPath(root, rawPath);
  // As written, and as the real file it names (a symlink, or a root written through a symlinked prefix).
  const realTarget =
    typeof rawPath === "string" && rawPath ? pathResolver(root, cwd)(rawPath) : target;
  for (const name of new Set([target, realTarget])) {
    const why = name ? secretPathReason(name) : null;
    if (why) {
      const reason = `\`${name}\` is ${why}. Agents never read or write it; use the committed .example template for its shape.`;
      log("deny", reason, name);
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
  if (content === undefined) {
    const reason = `A field of this ${tool} ${NOT_TEXT}.`;
    log("deny", reason, target);
    respond("deny", reason);
  }
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
