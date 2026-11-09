/**
 * Path rules the Codex guard leans on (2026-11-09 adversarial review): macOS and Windows resolve a
 * differently-cased name to the real file, `bunfig.toml` runs code before the guard does, and settings or
 * hook files are loaded from any directory. A case-sensitive or root-anchored match is a bypass.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_REGISTRY,
  isInteractiveShell,
  isProtectedPath,
  scanContent,
  secretPathReason,
} from "../harness/patterns";

describe("isProtectedPath", () => {
  it.each([
    ".claude/settings.json",
    ".claude/rules/phi-and-secrets.md",
    ".agents/rules/x.md",
    ".agents/plugins/p.json",
    ".codex/hooks.json",
    ".codex/config.toml",
    ".codex/rules/x.rules",
    ".codex/hooks/x.sh",
    "scripts/harness/patterns.ts",
    "compliance/controls.yaml",
    "bunfig.toml",
    "AGENTS.override.md",
    ".trivyignore.yaml",
    ".github/workflows/ci.yml",
    "deploy/production/compose.yml",
    "AGENTS.md",
    "CLAUDE.md",
  ])("protects %s", (p) => expect(isProtectedPath(p)).toBe(true));

  it.each([
    ".Claude/rules/phi-and-secrets.md",
    ".CLAUDE/AUDIT/agent-ledger-2026-11.jsonl",
    ".CODEX/HOOKS.JSON",
    "Scripts/Harness/pre-tool-guard.ts",
    "COMPLIANCE/controls.yaml",
    "BunFig.toml",
    "AGENTS.OVERRIDE.MD",
    ".TRIVYIGNORE.YAML",
    ".GITHUB/WORKFLOWS/CI.YML",
    "DEPLOY/PRODUCTION/COMPOSE.YML",
    "agents.md",
    "claude.md",
  ])("protects the case variant %s", (p) => expect(isProtectedPath(p)).toBe(true));

  it.each([
    "apps/web/.codex/config.toml",
    "apps/web/.codex/hooks.json",
    "packages/x/bunfig.toml",
    "packages/x/.bunfig.toml",
    "sub/AGENTS.override.md",
    "sub/.claude/settings.local.json",
    "/Users/dev/.codex/config.toml",
    "../../home/.codex/hooks.json",
  ])("protects %s at any depth, nested or outside the repo", (p) =>
    expect(isProtectedPath(p)).toBe(true),
  );

  it.each([
    "docs/compliance/AGENT_HARNESS.md",
    "docs/scripts/harness-notes.md",
    "src/bunfig.ts",
    "apps/backend/src/index.ts",
    "docs/AGENTS.md",
    "apps/web/CLAUDE.md",
    ".codex/sessions/x.jsonl",
  ])("leaves %s alone", (p) => expect(isProtectedPath(p)).toBe(false));
});

describe("secretPathReason — credentials a coding agent holds", () => {
  it.each([
    ".codex/auth.json",
    "/Users/dev/.codex/auth.json",
    ".claude/.credentials.json",
    ".config/gh/hosts.yml",
    ".git-credentials",
    ".kube/config",
    ".SSH/config",
    ".AWS/credentials",
    ".DOCKER/config.json",
  ])("refuses %s", (p) => expect(secretPathReason(p)).not.toBeNull());

  it.each(["src/ssh.ts", ".codex/hooks.json", "docs/aws-credentials.md", ".env.example"])(
    "allows %s",
    (p) => expect(secretPathReason(p)).toBeNull(),
  );
});

describe("isInteractiveShell — a shell the guard cannot follow (Codex's write_stdin is not hooked)", () => {
  it.each([
    "bash",
    "sh -i",
    "zsh",
    "python3",
    "python",
    "node",
    "env bash",
    "psql",
    "bash -l",
    "bash --login",
    "bash -o vi",
    "zsh -o SH_WORD_SPLIT",
    "sh -o vi",
    "ksh -o vi",
    "fish --init-command true",
    "bash < /dev/tty",
    "python3 < /dev/stdin",
    "psql < /dev/tty",
    "bash -c bash",
    "sh -c python3",
    "fish -c node",
    "bash -c 'printf ok'",
    "bash -c 'eval bash'",
    "bash -c '$(printf bash)'",
    "bash -c '$SHELL'",
    "bash -c '$CMD'",
    "bash -c bash --help",
    "sh -c python3 --version",
    "sh -c 'ls'",
    "zsh -c 'exit 0'",
    "ksh -c 'exit 0'",
    "fish -c true",
    "python3 -q",
    "python3 -E",
    "python3 -v",
    "python3 -W ignore",
    "python3 --check-hash-based-pycs always",
    "python3 --int-max-str-digits 640",
    "node --interactive",
    "node --inspect-port 9229",
    "node --inspect-port 127.0.0.1:9229",
    "node --diagnostic-dir /tmp",
    "node --redirect-warnings /tmp/node-warnings.log",
    "node --heapsnapshot-near-heap-limit 1",
    "node --stack-trace-limit 10",
    "node --max-http-header-size 16384",
    "node --inspect-port 9229 scripts/x.js",
    "node -r dotenv/config",
    "ruby -I lib",
    "ruby --encoding utf-8",
    "perl --include-directory lib",
    "php --define x=1",
    "python3 -m code",
    "python3 -c 'import code; code.interact()'",
    "python3 -c 'import code; code.interact()' --version",
    "node -e 'require(\"repl\").start()'",
    "ruby -e 'exec \"irb\"'",
    "perl -e 'exec \"perl\"'",
    "lua -e 'os.execute(\"lua\")'",
    "php -r 'system(\"php -a\");'",
    "psql -h localhost -U postgres",
    "psql -v ON_ERROR_STOP=1",
    "psql -e",
    "pgcli -e",
    "mysql -f",
    "sqlite3 -echo",
    "sqlite3 data.db",
    "sqlite3 data.db '.shell bash'",
    "sqlite3 data.db '.system bash'",
    "psql -c '\\! bash'",
    "pgcli --command '\\! sh'",
    "mysql -e 'system bash'",
    "psql -c '\\! bash' < /dev/tty",
    "sqlite3 data.db '.shell bash' < /dev/tty",
    "mysql --host localhost --user root",
    "true; bash -l",
    "bun repl",
    "  tmux ",
    "script -q /dev/null bash",
    "screen bash",
    "tmux new-session bash",
    "docker exec -it app bash",
    "docker run --interactive --tty image bash",
    "podman exec -i app sh",
    "podman run -t image sh",
    "docker compose exec app bash",
    "docker compose run --interactive app bash",
    "kubectl exec -it pod -- bash",
    "rlwrap bash",
  ])("refuses the bare %j", (cmd) => expect(isInteractiveShell(cmd)).toBe(true));
  it.each([
    "python3 scripts/x.py",
    "bash scripts/deploy.sh",
    "node -v",
    "node --inspect-port 9229 -- scripts/x.js",
    "python3 -V",
    "bash --help",
    "python3 --version",
    "psql --version",
    "bun run test",
    "bash --login -- scripts/deploy.sh",
    "python3 -q -- scripts/x.py",
    "ruby --encoding utf-8 -- scripts/x.rb",
    "perl --include-directory lib -- scripts/x.pl",
    "php --define x=1 -- scripts/x.php",
    "psql -h localhost -c 'select 1'",
    "psql -f scripts/query.sql",
    "pgcli --file scripts/query.sql",
    "mysql -h localhost -e 'select 1'",
    "sqlite3 data.db 'select 1'",
    "docker exec app ls",
    "docker run image true",
    "podman exec app ls",
    "docker compose exec -T app ls",
    "kubectl exec pod -- ls",
    "ls",
  ])("allows %j", (cmd) => expect(isInteractiveShell(cmd)).toBe(false));
});

describe("scanContent — the line number of every finding, found without rescanning from the top", () => {
  it("reports each finding on its own line", () => {
    // Assembled at runtime so this file does not trip the scanner it tests.
    const key = ["AKIA", "Z".repeat(16)].join("");
    const text = [
      "const a = 1;",
      `const k1 = "${key}";`,
      "",
      "// more",
      `const k2 = "${key}";`,
    ].join("\n");
    const lines = scanContent(text, EMPTY_REGISTRY, "src/a.ts").map((f) => f.line);
    expect(lines).toEqual([2, 5]);
  });
});
