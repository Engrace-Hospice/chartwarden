/**
 * T0 (owner-approved, wave 7): Claude's PreToolUse guard command fails CLOSED. Claude Code reads any exit code other
 * than 2 as ALLOW (the hook "failed", the call runs): a corrupted entry module is exit 1, a missing `bun` 127, an OOM
 * kill 137. The pinned command therefore ends in a plain-shell tail (no perl, no alarm: a missing perl would lock out
 * every call) that turns every non-zero exit into the refusal Claude Code honours, the same tail the Codex command
 * has. The guard's own answers are untouched: a deny or ask is JSON on exit 0, an emergency deny is exit 2, an allow
 * is exit 0 (and `||` never fires on exit 0, so `CW_HARNESS_FAIL_OPEN=1` still lets a call through).
 *
 * Every test runs the REAL committed command through `sh -c` on a COPY of the guard tree. The OLD command (the same
 * text without the tail, spelled out below) is the negative control: it really answers allow-by-exit-1 on the same
 * corruption, which proves the hazard exists on this machine and that the tail, not the setup, is what refuses.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK,
  CLAUDE_HOOK_WITHOUT_TAIL,
  REPO,
  bashPayload,
  guardCopy,
  removeCopies,
  runClaude,
  scratchDir,
} from "./_guard-copy";

afterAll(removeCopies);

const BUN_HARDENED = "bun --config=/dev/null --no-env-file --tsconfig-override=/dev/null";
const OLD_HOOK = CLAUDE_HOOK_WITHOUT_TAIL;
const TAIL =
  " || { echo '[chartwarden-harness] the guard failed to run, so the call is refused' >&2; exit 2; }";
const MESSAGE = "[chartwarden-harness] the guard failed to run, so the call is refused";

/** What a trace line (or any stray text) appended to a module does to it: bun cannot parse the file. */
const GARBAGE = "12:00:00.000000 git.c:460             trace: built-in: git status\n";
const ENTRY_FILES = ["pre-tool-guard.ts", "hard-deadline.ts"];
const READS_SECRET = bashPayload("cat apps/backend/.env");
const EVERYDAY = bashPayload("git status --short");

function corruptedCopy(file: string): string {
  const dir = guardCopy();
  appendFileSync(join(dir, "scripts/harness", file), GARBAGE);
  return dir;
}

describe("the committed Claude guard command is the old one plus the fail-closed tail", () => {
  const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
  const groups: Array<{ hooks: Array<{ command: string }> }> = settings.hooks.PreToolUse;

  it("both PreToolUse groups (core and MCP) run exactly OLD + tail", () => {
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.hooks[0]?.command).toBe(`${OLD_HOOK}${TAIL}`);
    expect(CLAUDE_HOOK).toBe(`${OLD_HOOK}${TAIL}`);
  });

  it("the tail is plain shell: no perl, no alarm, no external program that could be missing", () => {
    expect(CLAUDE_HOOK).not.toMatch(/perl|alarm|timeout/);
  });

  it("the ledger and Stop-gate commands are unchanged (no tail)", () => {
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      `${BUN_HARDENED} "$CLAUDE_PROJECT_DIR"/scripts/harness/post-tool-ledger.ts`,
    );
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `${BUN_HARDENED} "$CLAUDE_PROJECT_DIR"/scripts/harness/stop-gate.ts`,
    );
  });
});

describe("(a) the hazard, proved with the OLD command", () => {
  it.each(ENTRY_FILES)(
    "%s corrupted: the old command exits 1 with no decision (= allow)",
    (file) => {
      const r = runClaude(corruptedCopy(file), READS_SECRET, {}, OLD_HOOK);
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe("");
      expect(r.decision).toBe("exit1");
    },
  );

  it("a PATH without bun: the old command exits 127 (= allow)", () => {
    const r = runClaude(
      guardCopy(),
      READS_SECRET,
      { PATH: scratchDir("cw-empty-path-") },
      OLD_HOOK,
    );
    expect(r.status).toBe(127);
    expect(r.stdout.trim()).toBe("");
  });
});

describe("(b) the NEW command refuses on the same corruption", () => {
  it.each(ENTRY_FILES)("%s corrupted: exit 2, the fixed message on stderr, no JSON", (file) => {
    const r = runClaude(corruptedCopy(file), READS_SECRET);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MESSAGE);
    expect(r.stdout.trim()).toBe("");
    expect(r.decision).toBe("exit2");
  });

  it.each(ENTRY_FILES)(
    "%s corrupted: an everyday call is refused too (it fails closed, not selectively)",
    (file) => {
      const r = runClaude(corruptedCopy(file), EVERYDAY);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(MESSAGE);
    },
  );
});

describe("(c) a PATH without bun", () => {
  it("the new command exits 2 with the message (command not found is 127, then the tail)", () => {
    const r = runClaude(guardCopy(), EVERYDAY, { PATH: scratchDir("cw-empty-path-") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MESSAGE);
  });

  it("a CLAUDE_PROJECT_DIR with no guard script in it (module not found, exit 1) is refused as well", () => {
    const r = runClaude(guardCopy(), EVERYDAY, { CLAUDE_PROJECT_DIR: scratchDir("cw-no-guard-") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MESSAGE);
    const old = runClaude(
      guardCopy(),
      EVERYDAY,
      { CLAUDE_PROJECT_DIR: scratchDir("cw-no-guard-") },
      OLD_HOOK,
    );
    expect(old.status).toBe(1);
  });
});

describe("(d) the guard's own answers are untouched by the tail", () => {
  it("an ordinary call: exit 0, nothing printed, no refusal message", () => {
    const r = runClaude(guardCopy(), EVERYDAY);
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.stderr).not.toContain(MESSAGE);
  });

  it("a denied call: the guard's JSON deny (exit 0 is the guard's own channel), no refusal message", () => {
    const r = runClaude(guardCopy(), READS_SECRET);
    expect(r.decision).toBe("deny");
    expect(r.stdout).toMatch(/\.env/);
    expect(r.stderr).not.toContain(MESSAGE);
  });

  it.each(["hang", "throw", "exit"])(
    "an emergency deny (worker fault %s) is the guard's own exit 2 and JSON deny, still exit 2",
    (fault) => {
      const r = runClaude(guardCopy(), EVERYDAY, {
        CW_HARNESS_TEST_FAULT: fault,
        CW_HARNESS_DEADLINE_MS_FOR_TESTS: "300",
      });
      expect(r.status).toBe(2);
      expect(r.decision).toBe("deny");
      expect(r.stdout).toMatch(/did not answer/);
    },
  );
});

describe("(e) an ask is still an ask", () => {
  it("`git push origin main` answers ask (JSON on exit 0), not a refusal", () => {
    const r = runClaude(guardCopy(), bashPayload("git push origin main"));
    expect(r.decision).toBe("ask");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(MESSAGE);
  });
});

describe("CW_HARNESS_FAIL_OPEN=1 (the human's escape hatch) is not turned into a refusal", () => {
  it("an unparseable input: the guard answers allow on exit 0 and the tail never fires", () => {
    const dir = guardCopy();
    const refused = runClaude(dir, "not a hook input");
    expect(refused.decision).toBe("deny");
    const open = runClaude(dir, "not a hook input", { CW_HARNESS_FAIL_OPEN: "1" });
    expect(open.status).toBe(0);
    expect(open.decision).toBe("allow");
    expect(open.stderr).not.toContain(MESSAGE);
  });

  it("it cannot rescue a guard that cannot start: a corrupted entry module is still refused", () => {
    const r = runClaude(corruptedCopy("pre-tool-guard.ts"), EVERYDAY, {
      CW_HARNESS_FAIL_OPEN: "1",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MESSAGE);
  });
});
