/**
 * Wave 6, T1 evidence (ADV-1): why `GIT_TRACE=<guard file>` must be refused BEFORE git runs. git appends one trace
 * line to the file the variable names. Appended to the two modules the hook's entry thread imports synchronously
 * (`pre-tool-guard.ts`, `hard-deadline.ts`), that line is not valid TypeScript: bun cannot start the hook and
 * exits 1, and Claude Code treats any exit code other than 0 and 2 as a non-blocking error, that is, as ALLOW, for
 * every later call of the session. (The pinned Codex command has a `|| exit 2` wrapper: it fails closed. Wave 7, T0,
 * gave Claude's guard command the same plain-shell tail: the hazard stays proved with the OLD command, spelled out
 * as `CLAUDE_HOOK_WITHOUT_TAIL`, and the committed command refuses; see `harness-claude-fail-closed.test.ts`.)
 *
 * Everything runs on a COPY of the guard tree under a temp dir through the REAL pinned commands; the worktree's own
 * guard files are never written, and no payload command is executed (the hooks only classify it).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_WITHOUT_TAIL,
  bashPayload,
  guardCopy,
  removeCopies,
  runClaude,
  runCodex,
} from "./_guard-copy";

afterAll(removeCopies);

/** The line `GIT_TRACE=<file> git status` appends, as git writes it (a time, a source location, a message). */
const TRACE_LINE = "12:00:00.000000 git.c:460             trace: built-in: git status\n";
const ENTRY_FILES = ["pre-tool-guard.ts", "hard-deadline.ts"];
const ATTACK = (file: string) => `export GIT_TRACE=$PWD/scripts/harness/${file}; git status`;

describe("a trace line appended to an entry-thread module", () => {
  it("control: the intact copy answers, and an everyday call is allowed", () => {
    const dir = guardCopy();
    expect(runClaude(dir, bashPayload("git status --short")).decision).toBe("allow");
    expect(runClaude(dir, bashPayload("cat apps/backend/.env")).decision).toBe("deny");
  });

  it.each(ENTRY_FILES)(
    "%s: the OLD Claude command (no tail) exits 1 with no decision, which Claude Code reads as allow",
    (file) => {
      const dir = guardCopy();
      appendFileSync(join(dir, "scripts/harness", file), TRACE_LINE);
      const r = runClaude(dir, bashPayload("cat apps/backend/.env"), {}, CLAUDE_HOOK_WITHOUT_TAIL);
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe("");
      expect(r.decision).toBe("exit1");
    },
  );

  it.each(ENTRY_FILES)(
    "%s: the committed Claude command now fails closed too (exit 2, the refusal on stderr)",
    (file) => {
      const dir = guardCopy();
      appendFileSync(join(dir, "scripts/harness", file), TRACE_LINE);
      const r = runClaude(dir, bashPayload("cat apps/backend/.env"));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/the guard failed to run, so the call is refused/);
    },
  );

  it.each(ENTRY_FILES)("%s: the Codex hook still fails closed (exit 2)", (file) => {
    const dir = guardCopy();
    appendFileSync(join(dir, "scripts/harness", file), TRACE_LINE);
    const r = runCodex(dir, bashPayload("cat apps/backend/.env"));
    expect(r.status).toBe(2);
  });
});

describe("the write is refused before it happens", () => {
  it.each(ENTRY_FILES)(
    "the real Claude hook asks for `export GIT_TRACE=<%s>; git status`",
    (file) => {
      const dir = guardCopy();
      const r = runClaude(dir, bashPayload(ATTACK(file)));
      expect(r.decision).toBe("ask");
      expect(r.stdout).toMatch(/trace|redirect|GIT_INDEX_FILE/i);
    },
  );

  it.each(ENTRY_FILES)("the real Codex hook denies it (Codex cannot ask)", (file) => {
    const dir = guardCopy();
    expect(runCodex(dir, bashPayload(ATTACK(file))).decision).toBe("deny");
  });

  it("the prefix, subshell and later-statement spellings are refused the same way", () => {
    const dir = guardCopy();
    const target = "$PWD/scripts/harness/pre-tool-guard.ts";
    for (const cmd of [
      `GIT_TRACE=${target} git status`,
      `(export GIT_TRACE=${target}; git log -1)`,
      `export GIT_TRACE2_EVENT=${target}\ngit status`,
      `env GIT_TRACE_PACKET=${target} git fetch`,
    ]) {
      expect(runClaude(dir, bashPayload(cmd)).decision, cmd).toBe("ask");
    }
  });

  it("a trace to a scratch file, or to stderr, is allowed", () => {
    const dir = guardCopy();
    for (const cmd of [
      "export GIT_TRACE=/tmp/git-trace.log; git status",
      "export GIT_TRACE=1; git status",
      "export GIT_TRACE2_EVENT=/dev/null; git status",
    ]) {
      expect(runClaude(dir, bashPayload(cmd)).decision, cmd).toBe("allow");
    }
  });
});
