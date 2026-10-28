/**
 * The hook ENTRY POINTS, driven exactly as Claude Code drives them: JSON on stdin, decision JSON on
 * stdout. Proves the guard emits the documented PreToolUse shape, fails open on garbage, and that the
 * ledger it writes is a valid hash chain holding no content.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyChain } from "../harness/io";
import { gatesFor } from "../harness/stop-gate";

// Fixture values are assembled at runtime so this file does not trip the very scanner it tests
// (the Stop gate and harness:phi-scan read test files too).
const ISSUED_SSN = ["524", "71", "3388"].join("-");
const ROOT = join(__dirname, "../..");
const tmp = mkdtempSync(join(tmpdir(), "cw-harness-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function guard(
  input: unknown,
  raw?: string,
): { status: number | null; out: Record<string, any> | null } {
  const r = spawnSync("bun", [join(ROOT, "scripts/harness/pre-tool-guard.ts")], {
    input: raw ?? JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
  });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

describe("pre-tool-guard entry point", () => {
  it("denies Read of .env with the PreToolUse decision shape", () => {
    const { status, out } = guard({
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: join(tmp, ".env") },
    });
    expect(status).toBe(0);
    expect(out?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });
  it("denies a Write carrying an issued-looking SSN, and never echoes the value", () => {
    const { out } = guard({
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: join(tmp, "a.test.ts"), content: `ssn: "${ISSUED_SSN}"` },
    });
    expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.stringify(out)).not.toContain(ISSUED_SSN);
  });
  it("asks before a push to main", () => {
    const { out } = guard({
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
    });
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
  });
  it("is silent on an ordinary edit", () => {
    expect(
      guard({
        tool_name: "Edit",
        tool_input: { file_path: join(tmp, "x.ts"), new_string: "export const a = 1;" },
      }).out,
    ).toBeNull();
  });
  it("denies a Glob whose pattern targets live .env files", () => {
    const { out } = guard({ tool_name: "Glob", tool_input: { pattern: "**/.env*" } });
    expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
  it("fails open on malformed input", () => {
    expect(guard(null, "{not json").status).toBe(0);
  });
  it("wrote a valid, content-free ledger chain for the decisions above", () => {
    const dir = join(tmp, ".claude", "audit");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    expect(file).toBeDefined();
    const text = readFileSync(join(dir, file as string), "utf8");
    expect(verifyChain(text)).toMatchObject({ ok: true });
    expect(text).not.toContain(ISSUED_SSN);
    expect(text).not.toContain("git push origin main"); // commands are hashed, not stored
    const tampered = text.replace('"deny"', '"allow"');
    expect(verifyChain(tampered).ok).toBe(false);
  });
});

describe("stop-gate scoping", () => {
  it("runs nothing for no changes and only cheap structural gates for docs", () => {
    expect(gatesFor([])).toEqual([]);
    expect(gatesFor(["docs/x.md"])).toEqual(["arch:merge-artifacts"]);
  });
  it("maps a migration to the tenancy family and harness files to arch:compliance", () => {
    expect(gatesFor(["packages/db/migrations/1200_x.sql"])).toEqual(
      expect.arrayContaining(["arch:tenancy", "arch:ddl", "arch:migration-numbering"]),
    );
    expect(gatesFor([".claude/settings.json"])).toContain("arch:compliance");
  });
  it("never schedules the slow gates (tables, boundaries, gaps) at Stop", () => {
    const all = gatesFor([
      "packages/db/migrations/1.sql",
      "architecture/module-manifest.ts",
      "apps/backend/src/index.ts",
      "packages/auth/src/a.ts",
    ]);
    for (const slow of ["arch:tables", "arch:boundaries", "arch:gaps", "arch:fitness"])
      expect(all).not.toContain(slow);
  });
});
