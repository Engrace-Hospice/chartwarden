/**
 * ADV-H2, ADV-L3 and the `.git` half of ADV-C3/H6 (2026-11-10 adversarial review): Claude's Write/Edit/MultiEdit/
 * NotebookEdit were protected only by `permissions.ask` rules narrower than `PROTECTED_PATH`; `.git/config` and
 * `.git/hooks/` (which make git run a program outside the classifier), nested instruction files and the rest of
 * what an agent or `bun` loads were not protected at all. One definition now judges a shell write, a Codex patch
 * and Claude's edit tools; the everyday paths next to each must stay quiet.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { PROTECTED_FRAGMENT, PROTECTED_SAMPLES, isProtectedPath } from "../harness/protected-paths";

const ROOT = join(__dirname, "../..");
const GUARD = join(ROOT, "scripts/harness/pre-tool-guard.ts");

const NEWLY_PROTECTED = [
  ".claude/settings.local.json",
  ".claude/commands/deploy.md",
  ".claude/hooks/x.sh",
  ".claude/plugins/p.json",
  ".claude/launch.json",
  ".claude/agents/x.md",
  ".claude/skills/s/SKILL.md",
  ".claude/audit/agent-ledger-2026-11.jsonl",
  ".claude/.cache/x",
  ".agents/agents/x.md",
  ".agents/skills/s/SKILL.md",
  ".agents/plugins/p.json",
  ".agents/commands/x.md",
  ".codex/config.toml",
  ".codex/hooks/x.sh",
  ".codex/rules/x.rules",
  ".codex/prompts/x.md",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  "AGENTS.override.md",
  ".bunfig.toml",
  "scripts/bunfig.toml",
  "apps/web/CLAUDE.md",
  "docs/AGENTS.md",
  "CLAUDE.local.md",
  ".mcp.json",
  "apps/x/.mcp.json",
  ".git/config",
  ".git/config.worktree",
  ".git/hooks/pre-commit",
  ".git/modules/sub/config",
  ".git/worktrees/wt/config.worktree",
  "apps/x/.git/config",
  "apps/x/.git/hooks/pre-push",
  ".git",
  ".GIT/CONFIG",
];
const EVERYDAY = [
  "apps/web/src/App.tsx",
  "apps/backend/src/index.ts",
  "docs/compliance/AGENT_HARNESS.md",
  "docs/modules/README.md",
  "docs/scripts/harness-notes.md",
  ".agents/plans/p.md",
  ".agents/prds/prd.md",
  ".claude/plans/p.md",
  ".codex/sessions/x.jsonl",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".gitignore",
  ".gitattributes",
  "my.git/config",
  "docs/git/config.md",
  ".git-notes/config",
  "README.md",
];

describe("isProtectedPath: what a human approves", () => {
  it.each(NEWLY_PROTECTED)("protects %s", (p) => expect(isProtectedPath(p)).toBe(true));
  it.each(EVERYDAY)("leaves %s alone", (p) => expect(isProtectedPath(p)).toBe(false));
  it("treats a path under `~` or outside the repo like one inside it, for what is loaded from anywhere", () => {
    for (const p of [
      "~/.git/config",
      "/Users/dev/proj/.git/hooks/pre-commit",
      "~/proj/CLAUDE.md",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });
});

describe("PROTECTED_SAMPLES and PROTECTED_FRAGMENT agree with PROTECTED_PATH", () => {
  it("every sample is a protected path (a directory that holds one is an ancestor)", () => {
    for (const sample of PROTECTED_SAMPLES) {
      const rel = sample.startsWith("~/") ? sample : sample;
      expect(isProtectedPath(rel), sample).toBe(true);
    }
  });
  it.each([
    "open('.git/config','a')",
    "open('.claude/commands/x.md','w')",
    "Path('apps/web/CLAUDE.md').write_text('x')",
    "write('.mcp.json')",
    "rm('.codex/prompts/x')",
    "os.remove('.git/hooks/pre-commit')",
  ])("flags inline text that names %s", (text) => {
    expect(PROTECTED_FRAGMENT.test(text.replace(/['"`+\\\s]/g, ""))).toBe(true);
  });
  it.each(["open('.agents/plans/p.md')", "open('.codex/sessions/x')", "open('docs/guide.md')"])(
    "leaves inline text that names %s",
    (text) => {
      expect(PROTECTED_FRAGMENT.test(text.replace(/['"`+\\\s]/g, ""))).toBe(false);
    },
  );
});

describe("the shell classifier asks about the newly protected paths and not about everyday ones", () => {
  const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
  const d = (cmd: string) => classifyBash(cmd, ctx).decision;
  it.each([
    "printf '[core]\\n\\tworktree = /tmp/x\\n' >> .git/config",
    "echo x > .git/hooks/pre-commit",
    "cp /tmp/x .git/hooks/pre-push",
    "tee -a .git/config < /tmp/x",
    "rm -rf .git",
    "echo x > .claude/commands/x.md",
    "echo '{}' > .mcp.json",
    "sed -i s/a/b/ apps/web/CLAUDE.md",
    "echo x > .codex/prompts/p.md",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "cat .git/config",
    "ls .git/hooks",
    "git status --short",
    "echo x > docs/notes.md",
    "echo x > .agents/plans/p.md",
    "mkdir -p apps/web/src && echo x > apps/web/src/a.ts",
    "bun run test",
  ])("allows the everyday %s", (cmd) => {
    const verdict = classifyBash(cmd, ctx);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("Claude's own edit tools ask about every protected path (the real hook)", () => {
  const call = (tool: string, file: string, extra: Record<string, unknown> = {}) => {
    const r = spawnSync("bun", [GUARD], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "protected-paths",
        tool_name: tool,
        tool_input: { [tool === "NotebookEdit" ? "notebook_path" : "file_path"]: file, ...extra },
        cwd: ROOT,
      }),
      encoding: "utf8",
      env: { ...process.env, CW_AGENT_LEDGER: "off", CLAUDE_PROJECT_DIR: ROOT },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const answer = (r: { stdout: string }) =>
    r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : undefined;
  const EDITS: Array<[string, Record<string, unknown>]> = [
    ["Write", { content: "x" }],
    ["Edit", { old_string: "a", new_string: "b" }],
    ["MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] }],
    ["NotebookEdit", { new_source: "x" }],
  ];

  it.each(EDITS)(
    "%s: asks about a protected path the settings.json ask rules never named",
    (tool, extra) => {
      for (const rel of [
        ".claude/agents/x.md",
        ".git/config",
        ".codex/prompts/x.md",
        "apps/web/CLAUDE.md",
      ]) {
        const r = call(tool, join(ROOT, rel), extra);
        expect(r.status, `${tool} ${rel} ${r.stderr}`).toBe(0);
        expect(answer(r), `${tool} ${rel}`).toBe("ask");
      }
    },
  );

  it.each(EDITS)("%s: allows an everyday path with exit 0 and no output", (tool, extra) => {
    for (const rel of ["apps/web/src/App.tsx", "docs/notes.md", ".agents/plans/p.md"]) {
      const r = call(tool, join(ROOT, rel), extra);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout, `${tool} ${rel}`).toBe("");
      expect(r.stderr).toBe("");
    }
  });

  it("does not ask about READING a protected path", () => {
    for (const tool of ["Read", "Grep", "Glob"]) {
      const r = call(tool, join(ROOT, ".claude/settings.json"));
      expect(r.stdout, tool).toBe("");
    }
  });

  it("a secret path is still a deny, not an ask", () => {
    const r = call("Write", join(ROOT, "apps/backend/.env"), { content: "x" });
    expect(answer(r)).toBe("deny");
  });

  it("a path that reaches a protected one through a symlink asks too", () => {
    const r = call("Write", join(ROOT, ".claude/../.claude/rules/phi-and-secrets.md"), {
      content: "x",
    });
    expect(answer(r)).toBe("ask");
  });
});

describe("a Codex apply_patch is refused for the newly protected paths too (the real hook)", () => {
  const patch = (path: string) =>
    ["*** Begin Patch", `*** Add File: ${path}`, "+x", "*** End Patch"].join("\n");
  const run = (path: string) => {
    const r = spawnSync("bun", [GUARD, "--codex"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "protected-paths-codex",
        tool_name: "apply_patch",
        tool_input: { command: patch(path) },
        cwd: ROOT,
      }),
      encoding: "utf8",
      env: { ...process.env, CW_AGENT_LEDGER: "off", CW_HARNESS_ROOT_FOR_TESTS: ROOT },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  it.each([
    ".git/config",
    ".git/hooks/pre-commit",
    "apps/web/CLAUDE.md",
    ".codex/prompts/x.md",
    ".claude/commands/deploy.md",
    ".mcp.json",
  ])("refuses a patch that adds %s", (path) => {
    const r = run(path);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
  it.each(["apps/web/src/new-file.ts", "docs/notes.md", ".agents/plans/p.md"])(
    "allows a patch that adds %s: exit 0, no output",
    (path) => {
      const r = run(path);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    },
  );
});
