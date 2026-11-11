/**
 * What the agent harness protects from an agent's own edits: the guard, the ledger, the approved lists, the
 * compliance record, and everything an agent, `bun`, `git` or the shell loads that could switch them off.
 * One definition for every tool: the Bash classifier, Codex `apply_patch`, MCP strings and Claude's own
 * Edit/Write/MultiEdit/NotebookEdit (`permissions.ask` there names fewer paths than this does).
 *
 * `/i`: macOS and Windows resolve `.CLAUDE/`, `Compliance/` and `.CODEX/HOOKS.JSON` to the real files, so a
 * case-sensitive match is a bypass. Directories anchored at the repo root come first; what an agent, `bun` or
 * `git` loads from ANY directory (nested, or under `~`) is matched at any depth: a `preload` line in a
 * `bunfig.toml` runs before the guard does, a nested `CLAUDE.md` is loaded when the agent works there, and
 * `.git/config` or `.git/hooks/` make git run a program (`core.worktree`, `core.fsmonitor`, `core.hooksPath`)
 * outside the classifier.
 */
const ROOT_ANCHORED = [
  String.raw`\.claude\/(?:audit|\.cache|rules|agents|skills|commands|hooks|plugins)(?:\/|$)`,
  String.raw`\.claude\/launch\.json$`,
  // `.agents/` is Codex's twin of `.claude/`. Its plans and prds are local state an agent writes every day.
  String.raw`\.agents(?:\/(?!(?:plans|prds)(?:\/|$))|$)`,
  String.raw`scripts\/harness(?:\/|$)`,
  String.raw`compliance(?:\/|$)`,
  String.raw`\.githooks(?:\/|$)`,
  String.raw`\.github\/workflows(?:\/|$)`,
  String.raw`deploy\/production(?:\/|$)`,
  String.raw`\.gitleaks\.toml$`,
  String.raw`\.trivyignore\.yaml$`,
  String.raw`scripts\/check-compliance-controls\.ts$`,
  // GitHub reads CODEOWNERS from the root, `.github/` or `docs/`.
  String.raw`(?:\.github\/|docs\/)?CODEOWNERS$`,
];
const ANY_DEPTH = [
  String.raw`(?:AGENTS|CLAUDE)(?:\.local)?\.md$`,
  String.raw`AGENTS\.override\.md$`,
  String.raw`\.claude\/settings(?:\.local)?\.json$`,
  // Codex's own state (`.codex/sessions/`) is not a load point.
  String.raw`\.codex(?:\/(?!sessions(?:\/|$))|$)`,
  String.raw`\.?bunfig\.toml$`,
  String.raw`\.mcp\.json$`,
  String.raw`\.git\/(?:config(?:\.worktree)?$|hooks(?:\/|$)|modules\/|worktrees\/)`,
  String.raw`\.git$`,
];

const PROTECTED_PATH = new RegExp(
  `^(?:\\.\\/)?(?:${ROOT_ANCHORED.join("|")})|(?:^|\\/)(?:${ANY_DEPTH.join("|")})`,
  "i",
);

/** A repo-relative path the harness protects: guard, ledger, rules, compliance record, hook and git configuration. */
export const isProtectedPath = (rel: string): boolean => PROTECTED_PATH.test(rel);

/** `PROTECTED_PATH` itself, for code that tests it against many candidate paths. */
export const protectedPathPattern = PROTECTED_PATH;

/** Representative protected files, lower-case: a directory that holds one of them is an ancestor. */
export const PROTECTED_SAMPLES: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/launch.json",
  ".claude/rules/x",
  ".claude/agents/x",
  ".claude/skills/x",
  ".claude/commands/x",
  ".claude/hooks/x",
  ".claude/plugins/x",
  ".claude/audit/x",
  ".claude/.cache/x",
  ".agents/rules/x",
  ".agents/agents/x",
  ".agents/skills/x",
  ".agents/plugins/x",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".codex/hooks/x",
  ".codex/rules/x",
  "scripts/harness/x",
  "scripts/check-compliance-controls.ts",
  "compliance/x",
  ".githooks/x",
  ".github/codeowners",
  ".github/workflows/x",
  "docs/codeowners",
  "deploy/production/x",
  ".trivyignore.yaml",
  ".mcp.json",
  ".git/config",
  ".git/hooks/x",
  "agents.md",
  "claude.md",
  "~/.codex/hooks.json",
  "~/.codex/config.toml",
  "~/.claude/settings.json",
  "~/.claude/settings.local.json",
  "~/.bunfig.toml",
];

/**
 * A protected path as it reads once text is squashed (quotes, `+`, backslashes and whitespace removed:
 * `'scripts/'+'harness/x'` is `scripts/harness/x`). Directories anchored at the repo root must not be preceded
 * by a path component (`docs/compliance/` is a docs page); what is loaded from any directory counts anywhere.
 */
export const PROTECTED_FRAGMENT = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9_.-])(?<![A-Za-z0-9_-]\/)(?:\.claude\/(?:audit|\.cache|rules|agents|skills|commands|hooks|plugins|launch\.json)|\.agents\/(?!plans|prds)|scripts\/harness|compliance\/|\.githooks|\.github\/workflows|deploy\/production|\.gitleaks\.toml|\.trivyignore\.yaml|scripts\/check-compliance-controls|\.github\/codeowners)`,
    String.raw`(?<![A-Za-z0-9_-])(?:\.claude\/settings(?:\.local)?\.json|\.codex\/(?!sessions)|\.?bunfig\.toml|agents\.override\.md|(?:agents|claude)(?:\.local)?\.md|\.mcp\.json|\.git\/(?:config|hooks|modules|worktrees))`,
  ].join("|"),
  "i",
);
