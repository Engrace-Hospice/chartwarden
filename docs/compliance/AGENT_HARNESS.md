# ChartWarden agent harness (Claude Code + ECC)

This is the evidence pointer for control **CW-CM-02** in `compliance/controls.yaml`. It covers how AI
coding agents work in this repo without touching PHI or secrets and without bypassing change
management, and how that stays cheap.

## Division of labour

| Concern | Owner |
|---|---|
| Plan, TDD, code review, react review, security scan, save/resume session | **ECC** (`ecc@ecc`, per-user plugin) |
| Format + `tsc` at Stop | ECC `stop:format-typecheck` |
| Refuse secret paths, PHI-shaped identifiers, credentials, gate bypasses, prod DB access | `scripts/harness/pre-tool-guard.ts` (PreToolUse) |
| Change-scoped architecture gates + PHI scan once per turn | `scripts/harness/stop-gate.ts` (Stop) |
| Metadata-only, hash-chained record of agent actions (local telemetry that catches accidents, not tampering) | `scripts/harness/post-tool-ledger.ts` → `.claude/audit/` |
| PHI/secret scan for humans and CI | `.githooks/pre-commit`, CI `secret-and-phi-scan` (`harness:phi-scan` + gitleaks) |
| HIPAA/SOC 2 claim → evidence register | `compliance/controls.yaml` + `arch:compliance` (in `arch:fitness`) |
| Regulatory review of a diff | `.claude/agents/compliance-reviewer.md` |
| Domain rules, loaded only for matching paths | `.claude/rules/*.md` |
| Codex's twin of the shared harness text (same rules, agent and skills, so a second agent works from the same words) | `.agents/{rules,agents,skills}` + `AGENTS.md`, held identical to `.claude/` + `CLAUDE.md` by `arch:compliance` |

The project's `CLAUDE.md` and gates still win over ECC's generic guidance.

## The Codex twin (`.agents/`, `AGENTS.md`)

Codex reads `AGENTS.md` and `.agents/skills/`; the rest of `.agents/` is a reference copy it follows when
pointed at it. Change `CLAUDE.md` or the shared `.claude/` pieces and make the same change in `AGENTS.md` /
`.agents/` in the same commit: `arch:compliance` fails on any difference, missing file or orphan. It is
the same allow-list in `.gitignore` (plans, prds and local state stay out of git), the same CODEOWNERS
owner, and the same guard coverage (`scripts/harness/patterns.ts` asks before a shell write to
`.agents/{rules,agents,skills}`; `.claude/settings.json` asks before an Edit of `.agents/rules/**`).

`settings.json` is deliberately not mirrored: it is Claude Code's format and Codex does not read it (checked
against Codex 0.162.1: its own config is `.codex/config.toml` and `.codex/hooks.json`).

### The Codex guard (`.codex/hooks.json`)

`.codex/hooks.json` runs the same `scripts/harness/pre-tool-guard.ts` for Codex, with `--codex`. It matches
`Bash`, `write_stdin`, `apply_patch` and MCP tools (`Bash|write_stdin|apply_patch|mcp__.*`). Four things differ from Claude Code, all
from Codex's hook protocol:

- **Codex cannot ask.** `permissionDecision: "ask"` is "parsed but not supported yet": the hook run is
  marked failed and the tool call proceeds. So under `--codex` every `ask` is answered `deny`, including a
  push, a non-local `ssh` and any write to a protected path. A human runs those, or Claude Code asks.
- **Edits arrive as `apply_patch`**, with the patch text in `tool_input.command`.
  `scripts/harness/codex-patch.ts` takes it apart; every path, rename target and added line is judged as
  Edit/Write are (a rename's destination is scanned without the source file's exemptions). Paths resolve
  from the session directory with symlinks followed, and match case-insensitively (macOS and Windows resolve
  `.Claude/` to `.claude/`). A path with a control or exotic-space character is refused (Codex's Rust trim
  drops U+0085 where JS's does not, so `hooks.json<U+0085>` would otherwise read as another file), as is a
  patch the parser cannot read or one over 256 KB (the scan must finish inside Codex's timeout; a patch sent
through the shell is also bound by the 64 KB command cap below, so a larger one must use the `apply_patch` tool). Through
  the shell only exactly one `apply_patch <<'EOF' … EOF` is accepted, run in the session directory or the
  call's `workdir`; `cd`, a pipe, a redirect or a second command is refused, because `apply_patch` is on
  PATH and each of those applies a patch the guard cannot place. A command that could run `apply_patch` in any
  case, through quotes, backslashes or empty expansions (`'apply'_patch`, `apply\_patch`, `APPLY_PATCH`), or
  behind `${a}_patch` or `$(echo apply)_patch`, is held to the same rule; a name assembled at run time from pieces
  the text never joins stays with the sandbox (ADV-L5). Codex has no Read/Grep/Glob tools; its reads
  are shell commands. An interactive shell, language REPL or database client is refused even when it has
  login, quiet or connection flags. The hook also matches `write_stdin` and permits empty polling only;
  refusing the interactive process at creation remains defence in depth. A reviewed script, finite input
  file, or standalone help/version invocation remains available. A command or workdir that is present and not text is refused, never coerced with
  `String()` and judged. The call's `workdir` is where a shell command runs, so every relative target in
  it (a redirect, `tee`, `sed -i`, a `cat` of a key file that exists there) is judged from the session
  directory joined with the `workdir`, not from the session directory itself.
- **MCP tools** arrive as `mcp__<server>__<tool>` with arbitrary JSON, and nothing says which field is a path
  or text. The guard therefore judges EVERY string in `tool_input`, object keys included, at any depth: each
  line as a secret path and as a protected path (as written, and resolved from the session directory with
  symlinks followed, exactly as an `apply_patch` path is), and the whole string through the PHI/credential
  scan. It guesses nothing else about the tool. An input that is not an object, nests 32 levels or deeper,
  holds more than 2,000 strings or 256 KB of text, or has more than 20,000 lines to resolve is refused (the
  scan has to finish inside Codex's timeout). A reason names a path only when the value is one short word;
  it never echoes prose. A line that becomes a secret or protected path once its control, format and
  non-ASCII-space characters are removed (`hooks.json<U+0085>`: a Rust trim strips U+0085, a JS one keeps
  it) is refused, as an `apply_patch` path with such a character is. Ordinary text with unicode or odd
  spaces in it is not: only a line that turns into such a path is. A string is split into lines on every
  Unicode line break (CR, LF, NUL, VT, FF, FS, GS, RS, NEL, U+2028, U+2029) and each line into the words a
  tool could open as a path (split on whitespace and `, ; | :`, `file://` removed, quotes and brackets trimmed,
  percent-decoded, also after decoding the whole line), and each word is judged as a whole line is
  (`scripts/harness/mcp-tokens.ts`; ADV-L2). A string that only MENTIONS a protected or secret path in prose
  (`see compliance/controls.yaml`) is therefore refused too: the guard cannot tell prose from a path the tool will
  open, and a refusal there costs a rephrase. Of the 3,160 MCP calls in this repo's Claude sessions (96.5% the
  Chrome extension, the rest Chrome DevTools, Pencil and REA), none is refused by it.
- **The root is where the guard script lives**, not `CLAUDE_PROJECT_DIR`. The pinned command walks up from the
  session directory (its real path, `Cwd::getcwd`) to the nearest directory that holds `.git`,
  `.codex/hooks.json` AND `scripts/harness/pre-tool-guard.ts`, and runs that script, so the script's
  grandparent is the session's checkout. It reads no git configuration. It used to run
  `$(git rev-parse --show-toplevel)/scripts/harness/pre-tool-guard.ts`, and `git config core.worktree /tmp/x` (or a
  `[core] worktree` line appended to `.git/config`) re-pointed that at an attacker's script, so two allowed
  commands switched the Codex guard off (2026-11-10 review, ADV-C3). Linked worktrees (`git worktree add`,
  including the ones under `.claude/worktrees/`), a symlinked checkout and a session directory below the root
  each find their own checkout (tested in `harness-codex-anchor.test.ts`); a nested `git init` below the session
  directory is skipped unless it also holds the hook config and the script (planting those is a write to a
  protected path, denied in Codex); nothing found exits 127 and the wrapper refuses the call. **Residual:** a
  nested repo that plants all three files by a means the shell classifier cannot see (a script file, an
  interpreter's own `open()`) still wins, and `.git/config`, `.git/hooks/` and the hook config are protected
  paths for that reason; the sandbox is the boundary. (The managed-rollout dispatcher under `deploy/codex/`, where
  it exists, resolves the root with `git rev-parse` too and needs the same change.) An exported
  `CLAUDE_PROJECT_DIR` (from a Claude shell, pointing at another tree) used to override that and silently moved
  every protected-path match onto the wrong root. `CW_HARNESS_ROOT_FOR_TESTS` is the test-only seam; production
  never sets it, and a developer must not export it. Claude Code still takes its root from
  `CLAUDE_PROJECT_DIR`, which Claude Code itself sets.
- **The hook command is pinned byte for byte** (`CODEX_GUARD_COMMAND` in
  `scripts/check-compliance-controls.ts`), and each part matters. `bun --config=/dev/null --no-env-file
  --tsconfig-override=/dev/null`: a `bunfig.toml` `preload` in the session directory would otherwise run
  before the guard and could silence it (`bunfig.toml` is protected for that reason), and bun applies the
  `compilerOptions.paths` of the `tsconfig.json` (or `jsconfig.json`) in the session directory, or of the
  file it extends, to the guard script's OWN imports: `"paths": {"*": ["./evil.ts"]}` beside an `evil.ts`
  that calls `process.exit(0)` made the guard exit 0 without reading its input, so every secret read was
  allowed. An empty override leaves no `paths` to apply, wherever the session directory is: the hostile-fixture
  tests in `scripts/__tests__/harness-guard-review3.test.ts` run both real pinned commands against a root, a nested
  (`scripts/`, `scripts/harness/`) and an extended (`"extends": "./base.json"`) `tsconfig.json` and `jsconfig.json`,
  and show that without the flag each of them really silences the guard.
  Each change to the pinned Codex command (the flag, then the walk-up root lookup) needs each developer to re-trust it with `/hooks`. `--no-env-file` is
  a silent no-op on bun 1.3.0 to 1.3.2 (verified against each release; 1.3.3 and later honour it), so
  `engines.bun` in `package.json` is `>=1.3.3` (CI and the images pin 1.3.5); `arch:compliance` fails when it names
  an earlier floor, no range, or a version it cannot read.
  `perl -e 'alarm 8; …; exec @ARGV, "$root/scripts/harness/pre-tool-guard.ts", "--codex" or exit 127'`: Codex runs
  the call when a hook times out (10 s here) and when `exec` fails perl would exit 0, an allow; the same perl
  finds the checkout (above), under the same alarm. `|| exit 2`:
  exit 2 with a message blocks in Codex, so a guard that cannot start, crashes or times out blocks the call.
  `perl` and `bun` must be on the hook's PATH; without them every shell call and patch is refused, loudly.
  Claude's own three hooks (guard, ledger, Stop gate) are pinned the same way (`CLAUDE_GUARD_COMMAND`,
  `CLAUDE_LEDGER_COMMAND`, `CLAUDE_STOP_COMMAND`) and run with the same
  `--config=/dev/null --no-env-file --tsconfig-override=/dev/null`, for the same reason. They deliberately have no perl alarm and no `|| exit 2`: Claude Code has its own
  timeout, and a missing `perl` would otherwise lock out every Claude tool call.
- **The hook layer is a guardrail, not a boundary.** Each developer must trust the hook once (`/hooks`, tied
  to its hash, so a changed hook is skipped until re-trusted) and the project `.codex/` layer must be
  trusted. It can be switched off (`[features] hooks = false`, or a fresh `CODEX_HOME`) or bypassed
  (`--dangerously-bypass-hook-trust`), and OpenAI calls hooks "a useful guardrail, not a complete
  enforcement boundary". The shell layer is text heuristics, the same as Claude's: it does not understand an
  interpreter script (`python - <<EOF`), `git apply`, `git checkout <rev> -- <protected path>`, a directory
  move or copy, or an obfuscated command name. `write_stdin` fails closed on every non-empty or malformed
  `chars` value and permits empty polling only; an MCP tool is judged only by the strings in its input, not
  by what the tool does with them. **Run Codex in its `workspace-write`
  sandbox: that, not this hook, is the boundary.** Codex has no ledger or Stop gate yet; only the guard's own
  deny entries reach `.claude/audit/`, tagged `codex/<tool>`, capped at 1000 characters a field, and carrying
  the decision actually answered (`deny`, never the `ask` Codex cannot honour).

**Real paths, not text** (both agents). A cwd and a repo root that name one directory with different text (macOS's
`/tmp` against `/private/tmp`, a symlinked checkout) used to compare as unequal, so a relative write to
`scripts/harness/` from the symlinked spelling answered allow. The guard judges a shell command twice, with
the paths as written and with the real path of the root and of the directory the command runs in, and the
stricter answer wins (real paths alone would lose the match for an absolute path spelled with the root's
own symlinked text). Read/Write/Edit paths are checked as written and as the real file they name, so a
symlink to a secret file is refused under an innocent name.

`.codex/` (except its `sessions/`), `bunfig.toml`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.override.md`, `.git/config` and `.git/hooks/` are on the guard's protected list at any depth (they are
loaded or run from any directory, and `~/.codex/config.toml` can disable the hook for a user); at the repo root
so are `.claude/{audit,.cache,rules,agents,skills,commands,hooks,plugins,launch.json}`, `.agents/` (except its
local `plans/` and `prds/`), `scripts/harness/`, `compliance/`, `.githooks/`, `.github/workflows/`,
`deploy/production/` and CODEOWNERS at its three homes. One definition (`scripts/harness/protected-paths.ts`)
judges a shell write, a Codex patch, an MCP string and Claude's own Write/Edit/MultiEdit/NotebookEdit, which ASK
for every one of them: the `permissions.ask` rules in `settings.json` name fewer paths, and an Edit tool call
the rules did not name used to pass without a word (2026-11-10 review, ADV-H2); `.codex/config.toml` itself stays local and git-ignored, at any depth: `.gitignore` ignores
`**/.codex/*` and `**/.agents/*` (a nested `apps/x/.codex/` is local state too) and re-includes only the
root's shared pieces, each AFTER the ignore line (git's last match wins). `arch:compliance` fails if
`.codex/hooks.json` is missing or differs from the pinned command, matcher (`Bash|write_stdin|apply_patch|mcp__.*`), type
or timeout (an integer of 9 to 30 s: strictly above the 8 s perl alarm it is pinned with, derived from the
same constant, because a timeout at or under the alarm fires inside Codex first and the call runs), if
`.claude/settings.json` has no PreToolUse group with the pinned MCP matcher (`CLAUDE_MCP_GUARD_MATCHER`, see
"MCP tools in Claude Code" below) or any guard group's matcher also matches a tool with no path in its input
(`mcp__.*`, `*`, an empty matcher), if one of the three Claude hook commands differs from its pinned form or the Claude guard's timeout is not an integer of
5 to 30 s, if the ledger's or the Stop gate's timeout (when one is set) is not an integer of 5 to 600 s or the
Stop gate is `async` (it would no longer hold the turn), if `.claude/settings.json` sets `disableAllHooks`, a
`bypassPermissions` default mode, or an `env` entry that is not an `ECC_*` or `CLAUDE_CODE_*` variable (the block
is an ALLOW-list: `PATH`, `BASH_ENV`, `ZDOTDIR`, `NODE_OPTIONS`, `HOME`, `SHELL`, `LD_PRELOAD`,
`DYLD_INSERT_LIBRARIES`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `BUN_OPTIONS` (a `--preload` there runs before the
guard) all fail, naming the key), or one of the named switches `CW_HARNESS_FAIL_OPEN`, `CW_AGENT_LEDGER`,
`CW_STOP_GATE`, `CLAUDE_PROJECT_DIR`, `CW_HARNESS_ROOT_FOR_TESTS`, the deadline's test seams `CW_HARNESS_TEST_FAULT` and
`CW_HARNESS_DEADLINE_MS_FOR_TESTS`, or `ECC_GATEGUARD` (which the prefix would let
through), if the `.claude/` and `.agents/` mirror reads as empty on either side or differs by a
single byte (files are compared by SHA-256 of their bytes, not decoded text), or if `.gitignore` or
CODEOWNERS stop covering any of this or `bunfig.toml`. `.gitignore` is judged by git, not by its text: the
gate writes it into a throwaway repository and runs `git check-ignore --no-index -v` over the shared pieces
(`.agents/{rules,agents,skills}`, `.codex/hooks.json`, `.claude/{settings.json,rules,agents,skills}`, the env
template, `scripts/harness/pre-tool-guard.ts`, `compliance/controls.yaml`, `.githooks/pre-commit`,
`.github/CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`: none may be ignored) and the local state (`.agents/{plans,prds}`,
`.codex/config.toml` at any depth, `.claude/{audit,.cache,plans,settings.local.json}`, live env files including
`.env.local` and `apps/backend/.env.local`: all must be), so a later
`!**/.codex/config.toml`, `.agents/rules/*` or `.claude/*` line fails even though every line the text checks
look for is still there. A CRLF `.gitignore` fails, and so does a git that cannot be run, hangs past 10 s or
cannot get a temp directory (the probe reports an error and never passes by default).

## MCP tools in Claude Code (a targeted matcher, path words only, ask-only)

Claude Code's PreToolUse guard used to run for `Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit` only, so
no MCP tool input was judged in a Claude session (Codex's matcher has always included `mcp__.*`). A second
PreToolUse group in `.claude/settings.json` now runs the same pinned guard command for the MCP tools whose
input can name a path, open a local file in a page, run page JavaScript or write a file the agent names:

- Chrome extension: `file_upload`, `upload_image`, `javascript_tool`, `navigate` and `browser_batch` (its items
  are `{name, input}` and can carry `navigate`, `javascript_tool` and `file_upload`);
- Chrome DevTools: `upload_file`, `evaluate_script` (code, and a `filePath` its output is saved to),
  `navigate_page`, `new_page`, and the tools that save to a path the agent names: `take_screenshot`,
  `take_snapshot`, `take_heapsnapshot`, `performance_start_trace`, `performance_stop_trace`,
  `get_network_request`, `lighthouse_audit`.

The matcher is an anchored regular expression listing those names (`CLAUDE_MCP_GUARD_MATCHER` in
`scripts/harness/hook-matcher.ts`), **not** `mcp__.*`: free-text connectors would be stopped for prose that merely
names `.env`. Claude Code reads a matcher as an exact list of names when it holds only letters, digits, `_` and
`|`, and as a regular expression otherwise (checked against the 2.1.317 binary); the server names hold `-`, so
this one is a regular expression and is anchored on both sides.

For one of these tools the guard (`scripts/harness/mcp-claude.ts`) splits every string value AND key of the
input on every Unicode line break and into words (the Codex split, plus a finer one at quotes, brackets, `=`,
`+`, `!`, `&` and `?` so a path inside `fetch("file:///x/y")` is a word of its own), judges each word as a
secret path and as a protected path (as written, and resolved from the session directory with symlinks followed,
as in Codex), and **asks**, naming the tool and the category (`secret path`, `harness path`, a path hidden behind
control characters, or an input too big, too deep or not an object to judge), never the value. Only path words
are judged: there is **no PHI/credential text scan** in Claude mode (Codex still scans text and still turns every
ask into a deny; `harness-mcp-claude.test.ts` pins both). Two narrowings keep prose and code quiet: a line of
several words and no slash is judged by its words, not whole, and a dotted identifier with no slash (`e.key`,
`process.env`) is not a file among them; a line that is one path (a single word, or one with a slash) is judged
whole. Measured on this repo's sessions: 1,268 of the 3,359 recorded MCP calls are of a guarded tool, and the
rule asks for none of them (the one false positive before the narrowing was `e.key`); a call takes about 20 ms.

**Not covered, and why.** `computer`, `find`, `read_page`, `get_page_text`, `form_input`, `read_network_requests`,
`gif_creator` and the other tools that carry coordinates, element references or no path are not judged (the hook
is not run for them: the matcher is tested against the real tool names, `harness-mcp-claude-hook.test.ts`).
Free-text connectors (Gmail send, reply and forward, Drive create and download, Calendar, and any other
claude.ai connector) carry prose and can send it off the machine; whether to guard them is an owner decision, since
a path-word judge would stop a message that names `.env`. Pencil's `execute` (a `filePath` of a design file and a
script) and REA's binary tools open files the agent names and are not guarded either: they have no demonstrated
path to a protected file in this repo's use and are left to an owner decision. The words are text, so a path the
page code computes (`'.' + 'env'`), reads from a string table or builds from `atob` is not seen. The names are
the ones this repo's sessions show (`claude-in-chrome`, `plugin_ecc_chrome-devtools`): the same server installed
under another name (`mcp__chrome-devtools__…`) is not matched until it is added to the list and to the pin. The tools' own
permission prompts and Claude Code's permission rules are the other layer. `arch:compliance` pins the matcher
like Codex's: a dropped or edited MCP group, and any guard group that also matches a tool with no path in its input
(`mcp__.*`, `*`, an empty matcher), fails it.

## ECC settings applied by the project (`.claude/settings.json` → `env`)

| Setting | Why |
|---|---|
| `ECC_DISABLED_HOOKS=pre:observe:continuous-learning,stop:evaluate-session,stop:desktop-notify` | The observer stores the first 5,000 characters of every tool's **input and output** on disk and feeds them to a background Claude run. In an EHR repo one stray read of a real record would persist it outside our controls. Desktop notifications put response text on the lock screen. |
| `ECC_SKIP_OBSERVE=1` | A second switch for the same observer, read by its shell entry point. |
| `ECC_GOVERNANCE_CAPTURE` (deliberately not set) | Would write detections and approvals to ECC's own state store, outside this repo's retention and review. The repo's ledger and git history are the record instead. |
| `ECC_SESSION_RETENTION_DAYS=30`, `cleanupPeriodDays: 30` | Session summaries and transcripts are not kept forever. |
| `ECC_SESSION_START_MAX_CHARS=4000` | Halves the context ECC injects at session start (default 8,000). |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | No telemetry or error reports from sessions in this repo. Side effect: auto-update is off, so update Claude Code deliberately. |

`arch:compliance` fails if the two content-capturing ECC hooks are re-enabled, if the Read denies
are removed, or if the guard or Stop hook is unwired.

## Efficiency

- **One guard process per tool call.** Bun starts in tens of milliseconds, and the guard doesn't shell
  out except for one `git rev-parse` on Bash calls.
- **The Stop gate runs once per response, and usually not at all.** It hashes the changed-file set and
  skips if it matches the last green run. When it does run, it picks only gates whose inputs
  changed. All of them measured under 5 s on the full tree. `arch:tables` (~54 s), `arch:boundaries`
  (~39 s) and `arch:gaps` (~12 s) stay with pre-push and CI.
- **Path-scoped rules.** Only `phi-and-secrets.md` loads every session. Migration, auth/audit and AI
  rules load when matching files are touched.
- **Allow-list for read-only gates.** `bun run arch:*`, `typecheck`, `test`, `lint` and `git
  status/diff/log` run without a permission prompt once the folder is trusted.
- **Avoid ECC's multi-agent loop commands** (CLAUDE.md "Using ECC"). They push every round.

## What needs a human

The harness answers **ask** (you approve or decline) for these:
- edits to `compliance/**`, the harness itself, the root `CLAUDE.md` / `AGENTS.md`, `.githooks/**`,
  `.gitleaks.toml`, `.trivyignore.yaml`, CI workflows and `deploy/production/**`;
- `git push` (and always for pushes to main), `gh pr merge`, `gh secret`;
- `ssh`/`scp`/`rsync`, raw sockets (`nc`, `socat`, `openssl s_client`), outbound uploads with
  `curl -d/-F/-T`, and requests to a remote host that expand shell values into the URL;
- shell writes to the harness and compliance files above, and setting `CW_STOP_GATE`,
  `CW_AGENT_LEDGER` or `CW_HARNESS_FAIL_OPEN`;
- any live suite (`bun run test:*:live`), with a reminder to use a private container.

It answers **deny** for these:
- reading `.env*` (except `.env.example`), keys, dumps;
- dumping the environment;
- the git hook-skip flag and its abbreviations, `SKIP_FITNESS=1`, re-pointing `core.hooksPath`, and
  `git -c` with hook-disabling keys;
- force-pushing main;
- `psql`/`pg_dump` to a non-local host;
- writing an SSN/MBI-shaped value not in `compliance/synthetic-identifiers.json`, or a credential.

These are guard rails for a cooperative agent, not a sandbox. The authoritative controls remain RLS,
the gates, CI and access control on the servers.

## What the guard covers, and what it cannot

Covered (each has a regression test in `scripts/__tests__/harness-bypasses.test.ts`):
- git global options and abbreviations (`git -C . commit -n`, `-c core.hooksPath=…`);
- command substitution, backticks, subshells, `bash -c`, `eval`, redirections (`cat <.env`) and
  wildcards that expand onto secret files (`cat .e*`, `cat *.env`);
- inline interpreter code that names a secret file (`python -c`, `node -e`, `bun -e`, `perl -e`, `awk`);
- shell writes to the harness itself (`.claude/settings.json`, `.claude/audit/`, `scripts/harness/`,
  `compliance/`, `.githooks/`, `.gitleaks.toml`, `CODEOWNERS`, `.git/config`, `.git/hooks/`; the whole list is
  in the protected-path paragraph above), which **ask** because the Edit-tool prompt does not see them;
- `git config` (and `git -c`) of a key that makes git run a program or skip the hooks, in any spelling:
  `core.worktree`, `core.fsmonitor`, `core.hooksPath` (any case; only `.githooks` is the repo's own value),
  `core.sshCommand`, `core.pager`, `core.editor`, `alias.*`, `include.*`/`includeIf.*`, `credential.helper`,
  `diff.external`, `filter.*.smudge|clean|process`, `gpg.program`, `init.templateDir` and the rest of
  `scripts/harness/git-config-rules.ts` are **denied**; reading a key is not (`harness-git-config-rules.test.ts`);
- git writers that rewrite the whole working tree and can put an older, weaker guard back **ask** when any
  directory the command may run in holds the repo: `reset --hard`, `checkout|switch` with a force or detach option
  or to a lone commit (`abc1234`, `HEAD~3`), `read-tree -u`, `checkout-index -a|-f`, `cherry-pick`, `revert`,
  `stash pop|apply|branch` of a named older stash, a forced `-X ours|theirs`, magic pathspecs (`:/`, `:(top)`)
  and a wildcard pathspec that matches a protected path. A lone word after `git checkout` is looked up where the
  command RUNS (`cd scripts/harness && git checkout pre-tool-guard.ts` asks). **Not asked, by design:** a plain
  `git merge`, `rebase`, `pull`, `switch <branch>` or `checkout <branch>` (about 2% of the Bash commands in this
  repo's sessions, and git's three-way rules never put an older file over a newer one; CODEOWNERS and PR review
  are the control for what a merged commit holds), `rebase --onto`, and the plain `stash pop` of the top stash
  (the agent restoring what it just stashed; measured at 0.14% of commands). (`harness-git-tree-rules.test.ts`);
- a NUL byte in a Bash command (the shell would cut the command there), refused;
- raw sockets and plain GETs that carry expanded values to a non-local host. "Local" means loopback,
  `host.docker.internal`, or a service named in `docker-compose.yml`; `*.internal` and bare host names
  are **not** local.

**Shell classifier limits and coverage.** `classifyBash` is a text heuristic for a cooperative agent, not a
sandbox. It tracks `cd`, `pushd DIR` and `..` through a command, and expands `~`, `~/…`, `$HOME`, `$CODEX_HOME`
and `$PWD` (any other tilde prefix, `~user`, `~+`, `~-`, is an unknown directory, and so is `~` once a command
sets `HOME`; with `HOME` unset `~` is the account's home). A `cd` is trusted only along an `&&` chain; after `;`,
a newline, a pipe, `&` or a group (`( … )`) the command may still run where it started, and a `cd` after `||`
may not have run at all, so a relative write is judged against EVERY directory it could be in (at most 16, then
unknown, which asks). Anything that can move the shell and is not modelled makes the directory unknown, and a
relative write from an unknown directory asks: `source`/`.`, an `eval` that names a `cd` or is built at run
time, a function or `case` whose body holds a `cd`, a `pushd` that rotates or keeps the stack (`pushd`,
`pushd +1`, `pushd -n DIR`), `popd`, any `cd` once `CDPATH` is named, and `cd -`. `env -C DIR`, `env --chdir`
and `sudo -D` run their command in DIR, and the command lines of `find -exec`/`-ok` are judged as commands of
their own (`-execdir` runs in a directory the guard does not know). A program name the shell would unquote
(`\cd`, `\rm`) is the program it names. A bare file name is a secret when a file of that name exists in ANY
directory the command may be in (and, for a program that reads files, in an unknown one). It resolves every write target before comparing it
with the protected paths, and it treats a directory that contains a protected path as protected when the
command is a delete, move, or tree-merge (`rm -r`, `mv`, `cp -R`, `rsync`, `tar x`, `unzip`); a recursive
`chmod`/`chown`/`rm`, or a `find … -delete` or `-exec` that is not narrowed by `-name`/`-path`/`-regex`,
over the whole repo root asks as well. The writers it understands are redirections, `tee`, `dd of=`,
`sed -i` (including the GNU long-option abbreviations), `perl -i`, `find -delete/-exec`, `cp/mv/ln/install`,
`chmod/chown -R`, `patch`, `curl -o` (and `--output-dir`, with `-o` or `-O`), `wget -O`/`-o`/`-a`/`-P`, `sort -o`,
`openssl -out`, `base64 -o` (a long output option is matched by any prefix its tool accepts: `sort --out`,
`wget --output-d`; a prefix two options share is ambiguous and writes nothing), `find -fprint/-fprint0/-fprintf/
-fls`, the sed `w` command and `s///w` flag, in-place compressors, and
`git apply/am/checkout/restore/rm/mv/clean/format-patch -o/config --file/archive -o/bundle create`. It judges the commands inside `$( )`,
backticks and `<( )`/`>( )` as command lines, and sees through `sudo`, `env`, `builtin` and `--`. It reads
inline interpreter code and heredoc or stdin script bodies as text, with quotes and `+` removed. It cannot
read a script file written by an earlier tool call (`python3 /tmp/w.py`; one written and run by the same command line is read, see Wave 4 below), computed or encoded names, glob targets, symlinked shell targets inside command text (a path it reads in the text is not followed), a `$VAR` path
prefix, a path piped into `xargs`, `curl -O` or a bare `wget URL` (they write the URL's file name into the
current directory; they are judged only when that directory is itself protected), a `$VAR` or computed program
name (`${X:-git} push`, an array run as a command), or the writers it has no model for (`split`, `cpio -p`,
compilers and bundlers with an output option such as `cc -o` or `tsc --outFile`,
and any program that writes where its own configuration says). Wave 3 added, each with a test file under `scripts/__tests__/harness-*.test.ts`:
the `&&` trust of a `cd` is per command (only a group, a pipe or a `&` at or before a command cancels it, and the
lines of a script a shell reads do; a later pipe does not); another spelling of the root or home (upper case,
the `/System/Volumes/Data` firmlink, `/tmp` for `/private/tmp`) names the same protected file; a write to the bun
binary or a shell startup file (`~/.bun/**`, `~/.zshenv`, `~/.zshrc`, `~/.profile`, `~/.bash*`) asks;
inline code (`python -c/-Bc`, `perl -e/-ne`, `node -pe`, `php -r`, `deno eval`, `osascript -e`, `awk`) and a script a shell is
handed (`echo '…' | sh`, `bash <<< '…'`, `source <(echo '…')`) are judged, and a pipe into a shell from anything but
`echo`/`printf`/a heredoc asks; a command word built around a substitution (`$(true)git push …`), an `ssh` host a
substitution or variable builds, and `function f { cmd; }` bodies are judged; more output writers (`gpg -o`, `zip F`,
`tar cf F`, `pg_dump -f`, `psql -o`, `sqlite3 F`, `script F`, `ditto`, `plutil -o`, `yq -i`, `sponge`, `curl -D/-c/--trace/--stderr`,
`openssl -writerand/-keylogfile/-sess_out`, rsync's `--log-file/--backup-dir/--write-batch/--temp-dir`, `cp -tDIR`/`--target=DIR`,
`host:path` naming this machine) and the read-write redirect `<>` are judged like a redirect target; `rm -r`, `chmod/chown/chgrp/setfacl/
chflags/xattr -R`, `mv`, `find -delete` and an unpacked archive (`tar`/`bsdtar`/`gtar`, `7z x`, `cpio -i`, `ditto -x`) over an
ancestor of the repo root ask, as do GNU abbreviations (`rm --rec`); a `find` action is narrowed only by a name or path
test that matches no protected file (`-name '*.tmp'` narrows, `-name '*'`, `'*.ts'`, `-o -true`, `! -name` do not), and
`-exec sh -c 'rm {}'`, `env rm`, `sudo rm`, `perl -pi` count as writers; wrappers (`caffeinate`, `arch`, `flock`, `parallel`,
`strace`, `doas`, `pkexec`, `taskset`, `chrt`, `busybox`, `gtimeout`, `xcrun`, `lima`, `runuser`, `sudo --user`, `exec -a`,
`stdbuf -o`, `env -P`) are seen through, and a command string handed to a shell (`watch`, `su -c`, `flock -c`, `ssh localhost 'cmd'`,
`ssh -o ProxyCommand=`, `rsync -e`, `tar --checkpoint-action=exec=`) is judged as a command line; `docker|podman run` with a
writable bind mount of the repo is judged with the container's paths mapped back (`-v "$PWD":/w img rm /w/x`); a nested
`claude --bare`, `codex --disable … hooks`, `-C`/`--cd`, or an agent started outside the repo asks. Recursive reads, copies
and archives (`grep -r`, `--rec`, `-d recurse`, `rg -u`, `find … -exec cat|grep`, `cp -r`, `rsync -a`, `ditto`, `tar c`, `zip -r`)
of a directory that holds a live env file that EXISTS (`deploy/production`, `apps`, `apps/backend`) ask; `printenv SECRET`,
a script that prints the whole environment or a secret variable (`print(os.environ)`, `console.log(process.env.X_TOKEN)`),
`security find-*-password`/`dump-keychain`, `gh auth token`, `docker exec … env|printenv`, and `~/.gnupg` are refused, and
`docker inspect` without a narrow `--format` asks. Limits that remain: a program the wrapper and writer tables do not name; a
here-string, pipe or `source <( )` that is not `echo`/`printf`; a bind mount reached through a compose file; a
`cat deploy/production/*` (a bare `*` never matches a dotfile, so it reads no live env file, but it can read one named
`*.env`); a name pattern or regex the narrowing check cannot compile (it never compiles an agent's regex, so it counts as
broad). Whole-tree reads that bypass
`.gitignore` (`grep -r`, `rg -u/--hidden`, `tar c .`, `docker compose config`) ask, as do file names built
by command substitution and agents started with approval prompts, the sandbox or hooks off. A harness
switch variable (`CLAUDE_PROJECT_DIR`, `CODEX_HOME`, `CW_HARNESS_FAIL_OPEN`, `HOME`, …) followed by `=`, `+=` or `:=` asks
ANYWHERE in a command, however it is spelled (`export $(echo X=…)`, `ssh h 'X=… cmd'`, `watch 'X=… cmd'`, a value an
assignment builds, `export CODEX_HO\ME=…`, `export CODEX_HOME{,}=…`), and so does a command that names one for the shell or
the session to set with no `=` (`printf -v X`, `read X`, `for X in …`, `launchctl setenv X v`, `tmux set-environment X v`,
`systemctl set-environment`, `defaults write d X v`). The exception is a command that only prints or searches (`rg`, `grep`,
`ag`, `ack`, `echo`, `printf`, `cat`, `head`, `tail`, `wc`, `sed -n`, `git log/grep/show/diff/commit`) with nothing
assigned before it, no redirect except `/dev/null` and its output going only to another such command or a filter
(`sort`, `uniq`, `cut`, `tr`, `nl`, `column`): `rg CODEX_HOME= docs` and `echo CODEX_HOME=x` set nothing. "Only prints" is
judged by what the command can DO: `sort -o`/`--output`/`--compress-program`, `uniq IN OUT`, a `sed` script with a `w`, `W` or `e`
command or flag (or `sed -f`), `git grep -O`/`--open-files-in-pager`, `git commit -t`/`--template`, `rg --pre`/`--hostname-bin`
and `ag`/`ack --pager` write a file or run a command, so none of them is a print. A switch name with no `=`
(`export CODEX_HOME`) sets nothing and is allowed. Reasons
never echo URL userinfo and cap any token they quote. Work is bounded because a guard that times out lets the
call through in Claude Code: a command over 64 KB (64 x 1,024 UTF-16 code units, the JavaScript string length, not bytes) is REFUSED before it is parsed (an ask would let padding
turn a denied command into a prompt; put large file content in a file with the Write tool, and a heredoc patch
that size through the `apply_patch` tool), the text judged across a command and everything nested in it is
budgeted (256 KB: a text nested N deep in `$( )` is judged once per level, each nearly the whole command), a
wall-clock limit of 1 s per judging backs them (the guard judges twice from a symlinked root), glob matching is a two-pointer matcher with star backtracking, O(name length x wildcard tokens) over the short
sample names and with no regular expression (so no exponential backtracking), brace alternatives
(4,096) and path resolutions (16,384) are budgeted per command in items AND in characters (8 MB of expanded
brace text, 8 MB of resolved path text, so one 4,000-character word expanded 4,096 ways spends what 4,096 short
words would not; a word over 4,096 characters is never expanded, and a `cd` is charged for characters only), a
`git -C` chain of more than 8 operands asks and a followed directory is capped at 1,024 characters, and
substitutions (32 per level) and judged command lines (300 per call) are capped; over any of those caps the
answer is ask, and a deny found before the cap was hit still stands. A spent brace or resolution budget does not
stop the rest of the command from being judged: a secret file name is still found, even one that a single brace
group builds from a stem and an optional suffix, because each word is also read one group at a time, linearly;
only the clock and the judged-text budget stop judging. `baseName` and `trimSlashes` are linear (a regular
expression for them was quadratic on a run of `/`). Reading a protected file does not ask; only a command that writes one does.
A budget spent while paths are resolved no longer answers for the whole command: the command asks (as above) unless a
later check in the same command line denies it, so a `psql` to a production host with thousands of redirect targets is
still denied (`harness-hidden-path-budget.test.ts`).

**Wave 4.** Each item has a test file under `scripts/__tests__/harness-*.test.ts`.
- *Command lines git hands to a shell* (`git-exec-strings.ts`, `harness-git-exec-strings.test.ts`) are judged as
  command lines: `git rebase -x|--exec`, `submodule foreach`, `bisect run`, `difftool -x|--extcmd`, `filter-branch
  --*-filter`, `grep -O|--open-files-in-pager`, `instaweb --httpd|-b`, and `--upload-pack|--receive-pack|--exec` (and
  `clone -u`) of fetch, pull, push, clone, ls-remote and archive, run where `git -C` puts them; so are the values of
  `EDITOR`, `VISUAL`, `PAGER`, `GIT_EDITOR`, `GIT_PAGER`, `GIT_SEQUENCE_EDITOR`, `GIT_ASKPASS`, `SSH_ASKPASS`,
  `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND` and `GIT_EXTERNAL_DIFF` (as a prefix, after `env`, or in `export`). A harmless string
  (`git rebase -x 'bun run test'`) still allows. An exec-capable config key injected through `GIT_CONFIG_KEY_n` or
  `GIT_CONFIG_PARAMETERS` is **denied** exactly as `git -c` is (one table, `git-config-rules.ts`); `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_ALLOW_PROTOCOL`, the global
  options `--git-dir` and `--exec-path=`, an `ext::` remote URL, and `--template` of `git clone`/`git init` **ask**; `git clone -c|--config` of an
  exec-capable key is **denied**; `protocol.allow` (the default policy that lets `ext::`
  run) joins `protocol.ext.*` among the config keys that are denied. **Not decided by text:** a program named instead of a command line
  (`GIT_ASKPASS=/tmp/x`, `git rebase -x ./run.sh`: the path is judged, the script behind it is not read), and `git -C <another
  repository>`, whose own `.git/config` can name a `core.fsmonitor`.
- *`git grep --no-index` and `--untracked --no-exclude-standard`* apply no .gitignore, so they ask over a directory that holds
  a live env file that exists, as `grep -r` does (`git-grep-sweep.ts`, `harness-git-grep-sweep.test.ts`); `--exclude-standard`
  (the last of the two wins), a plain `git grep`, and a directory without one stay allowed.
- *A script written and run by one command line* (`written-scripts.ts`, `harness-written-scripts.test.ts`). A heredoc body is
  data, so `cat > /tmp/x.sh <<'EOF' … EOF` and `bash /tmp/x.sh` hid the script. The text a command writes with a heredoc, a
  here-string, a printed literal (`echo`/`printf`) or an `echo`/`printf` piped into `tee` is now matched, by the same path
  normalisation as every other path (each directory a `cd` may have left it in), with a later command that runs the file: a shell
  (`bash|sh|zsh|dash|ksh F`, `source F`, `. F`, `bash < F`), an interpreter (`python3|node|bun [run]|deno run|perl|ruby|php F`) or the
  file itself (`./F`, `/tmp/F`), and judged as the script it is (shell text as a command line, other languages as inline code). **A
  file written by an earlier tool call, built from a variable or a command's output (`cat a b > F`, `sed -i`), or edited in place stays
  unread**: the guard sees one command line at a time. Heredoc data that nothing runs stays allowed.
- *The live-suite ask* is for a command that RUNS a live suite (`bun run test:*:live`, `vitest` directly or through `bunx`, `npx`
  or `bun x`, over a `.live.test` file); `bunx biome check x.live.test.ts` and the text of a script that only names a suite are not
  one (`live-suite.ts`, `harness-live-suite.test.ts`). No rule that judges a command line (a push to main, a production
  database host, `docker compose config`, an upload) is applied to the text of an inline script that only names it.
- *A backup copy of a file* (`.bak`, `~`, `.orig`, `.old`, `.save`, `.swp`) is judged by the file it copies (`backup-names.ts`,
  `harness-backup-names.test.ts`): `.env.bak`, `tls.key.orig`, `server.pem.save` and `.env~` are refused, `src/x.ts.bak` and
  `.gitleaks.toml.bak` are not, and a `.bak` of an original with no source extension (`prod.sql.bak`, `prod.bak`) is still a database
  backup. A file named `*backup*` with an archive extension (`backup.tar.gz`) is refused.

**Wave 6.** Each item has a test file under `scripts/__tests__/harness-*.test.ts`.
- *Git and command-line variables are judged wherever a command line sets them* (`shell-assignments.ts`,
  `git-exec-strings.ts`, `harness-env-assignments.test.ts`). One reading of an assignment (`NAME=v`, `NAME+=v`, `${NAME:=v}`, a
  name spelled with quotes, backslashes or a brace group: `GIT_TR\ACE=x`, `GIT_TRACE{,}=x`) is shared by the harness-switch rule and
  these. A prefix assignment, `export`/`declare`/`typeset`/`readonly`/`local`, `env`, a subshell, a brace group, a later statement and
  a nested `bash -c` or `ssh h '…'` all count: `export GIT_TRACE=<guard file>; git status` no longer slips past a rule that only read
  the git segment's own prefix. The git variables that name a FILE git writes (`GIT_TRACE`, `GIT_TRACE2`, `GIT_TRACE2_EVENT`,
  `GIT_TRACE2_PERF`, `GIT_TRACE_PACKET`, `GIT_TRACE_PACKFILE`, `GIT_TRACE_CURL`, `GIT_TRACE_SETUP`, `GIT_TRACE_PERFORMANCE`,
  `GIT_TRACE_REFS`, `GIT_TRACE_SHALLOW`, `GIT_TRACE_FSMONITOR`, `GIT_TRACE_PACK_ACCESS`, `GIT_REDIRECT_STDOUT`, `GIT_REDIRECT_STDERR`,
  and `GIT_INDEX_FILE`) are judged as write targets, like a redirect: a path onto the guard, the ledger, the hook configuration or a
  startup file **asks** (Codex: denies); `/dev/null`, `/dev/stderr`, `/tmp/x.log`, and the values `1`, `2`, `true`, `false`, `0`, `off`,
  a file descriptor, `2>&1` and an `af_unix:` socket stay allowed. Why it matters: git appends one trace line to the file, and a line
  appended to `pre-tool-guard.ts` or `hard-deadline.ts` (the two modules the entry thread imports before the worker exists) makes bun
  fail to start, so the pinned Claude command exits 1, which Claude Code reads as allow for every later call
  (`harness-trace-corrupts-guard.test.ts` proves it on a copy of the guard tree through the real pinned commands, and that the
  write is refused first; the pinned Codex command still fails closed). The variables whose value is a command line are judged as one
  (`MANPAGER`, `BROWSER`, `LESSOPEN`, `LESSCLOSE`, `PROMPT_COMMAND`, `PYTHONSTARTUP`, `RUBYOPT`, `SUDO_EDITOR`, `KUBE_EDITOR`,
  `GH_EDITOR`, `GH_PAGER`, `GH_BROWSER`, `SVN_EDITOR`, `FCEDIT`, `PSQL_EDITOR`, `PSQL_PAGER`, `RSYNC_RSH`, `GIT_SSH` and the older
  list), and `EDITOR+=…` reaches them as `EDITOR=…` does; `GIT_COMMON_DIR` joins the re-pointing variables that ask. **Not decided by
  text:** a name set by `read`, `printf -v`, `launchctl setenv`, `tmux set-environment` or a sourced file, a value built at run
  time (`GIT_TRACE=$LOG`, `GIT_TRACE=$(mktemp)`), and a program path named in one of the command variables (`PAGER=/tmp/x`: the path is
  judged, the program behind it is not read).

**Shell lexing.** `scripts/harness/shell-lex.ts` reads a command once, in one linear pass, before any rule
runs; the line splitter, the redirection reader and the substitution scan all use its result, so a quote, an
escape, a comment or a heredoc body cannot hide a later command. It models single quotes (no escapes); double
quotes (a backslash escapes the next character, and `$( )`, backticks and `${ }` inside still run); `$'…'` (a
backslash escapes, `\'` included); backslash escapes and backslash-newline continuations (dropped, as the shell
does); `#` comments, only where a `#` starts a word (`a#b`, `$#` and `${#x}` are not comments, and a comment is
never judged); `$( )`, `<( )`, `>( )`, `$(( ))`, `${ }` and backticks nested with their own quoting; and
heredocs (`<<W`, `<<-W`, a quoted or escaped `W`; `<<<` is a here-string, not a heredoc). A heredoc body is
data, so a commit message that mentions `rm scripts/harness/x` is text. The exceptions are a body fed to a
shell, `eval`, `source`/`.`, `at` or `batch`, to a command that names one of them as an argument or whose name
is a `$VAR` or a substitution, or through a pipe into one of those: its lines are judged as commands; and an
unquoted body, whose `$( )` and backticks run and are judged. An interpreter's body (`python3 -`, `node -`) is
read as text, as before. A `)` that opens no group ends the command before it (`case x) cmd`, `(x) cmd`,
`f() { cmd; }`). A text that ends inside a quote, `$( )`, `${ }`, backtick or heredoc (no delimiter line), or
after a trailing backslash, ASKS, and the unfinished tail is dropped from the commands, so a garbage tail is
not judged over and over; a deny found in the part before it still stands. It does not model: aliases and
functions defined earlier in the session, or `function f { … }` bodies; a `case` pattern inside `$( )`; `[[ ]]`
and `(( ))` operators that read as a heredoc (`(( x << 2 ))` asks); zsh-only syntax (`=( )`, glob qualifiers, a
`setopt` that changes quoting or comments); the quote rules of a `${ }` beyond "a single quote is ordinary
inside double quotes"; a heredoc whose body starts inside a `$( )` that opens after its operator on the same
line; what a `$'…'` expands to (it only finds the closing quote; the word reader decodes the escapes); or a
command word built around a substitution (`$(true)git …`). Heredoc scripts nested more than 16 deep answer ask
(substitutions stay capped at 32 per level, as above).

**A hard deadline, in both agents.** A guard that crashes, is killed at the hook's own 10 s timeout, or exits with
anything but 2 lets the tool call run in Claude Code; only Codex's pinned command wraps the guard in `perl alarm 8
… || exit 2`, and Claude's three pinned commands deliberately have no perl wrapper (a missing `perl` would lock
out every Claude call). So the guard enforces its own deadline. `pre-tool-guard.ts` is a small entry thread
(`hard-deadline.ts`): it arms a 6.5 s timer before it reads stdin, runs the judgement (`guard-judge.ts`) in a Bun
worker (`guard-worker.ts`), and when the timer fires, the worker dies or errors without answering, or stdin never
ends, it prints the standard deny JSON, a stderr line and EXITS 2 (a block in both agents), whatever the worker is
stuck in. The worker makes `process.exit` a throw: on bun 1.3.5 (what CI pins) a `process.exit(0)` called in a
worker ended the WHOLE process silently with status 0, which both agents read as an allow. Normal answers are unchanged (JSON for a deny or an ask, nothing for an allow, exit 0); the extra
latency is about 2 ms per call. A worker needs neither `--config` nor `--tsconfig-override` of its own: it is
started by the already-hardened entry, and the hostile-config tests run through it. Test seams, never set in
production and forbidden in the shared `env`: `CW_HARNESS_TEST_FAULT` (`hang`, `exit`, `throw`) and
`CW_HARNESS_DEADLINE_MS_FOR_TESTS` (it can only shorten the deadline); `harness-hard-deadline.test.ts` forces each
through the entry point and through both real pinned commands. Not covered: a `bun` that is missing or too slow
to start, and a process killed for memory before it can answer; the Stop gate, the pre-commit scan and CI are the
lines behind those. A `Read`/`Write`/`Edit` path of 500 KB made of `a/../` used to go quadratic in the real-path
walk (4 to 9 s); the written path is judged first, the walk is iterative, and a path longer than PATH_MAX is
collapsed textually and never resolved link by link.

**Fails closed.** Empty or unparseable hook input, an internal error, and a write too large to scan
(over 8 MB) all answer `deny`. A human who needs the session back sets `CW_HARNESS_FAIL_OPEN=1` for it.
Codex PTY requests (`tty`, `pty`, or `use_pty`) also fail closed: later `write_stdin` input does not fire
the original command's PreToolUse check. The Codex hook therefore matches `write_stdin` itself and allows
only empty polling; every non-empty or malformed `chars` value is denied before reaching the process.
Agents use finite non-PTY commands instead; the interactive-process classifier remains a defence-in-depth
control for commands that can attach stdin without requesting a PTY.

Cannot cover:
- A nested repo (below the Codex session directory) that plants the hook config, a guard script and `.git` by a
  means the shell text does not show (see "The root is where the guard script lives"), plain `merge`/`rebase`/
  `pull`/branch switching (above), the same writers through an interpreter script file or a `$VAR` path, and
  a template directory handed to `git init`/`git clone` by a means other than `--template` (it carries hooks).
- A program that reads a file through a construct the rules do not anticipate (a script it just wrote,
  a path piped into `xargs`, a compiled binary). Shell text is not a security boundary. The real fixes are a
  filesystem sandbox (Claude Code's sandbox read-deny for `.env*`, keys and dumps) or keeping live secret
  files out of the working tree. Until then CW-CM-02 stays `partial`.
- `Grep` with no `glob` over a directory: it relies on ripgrep honouring `.gitignore`, which lists `.env`
  (`arch:compliance` checks that line stays).
- Files the scanners skip as binary: `.pdf`, images, archives and `.pen` design files.
- A guard process that never starts (for example `bun` missing): Claude Code treats that as
  non-blocking. The Stop gate, the pre-commit scan and CI are the lines behind it.
- The Stop gate is advisory after two identical failures (it releases with a notice instead of looping).

## The ledger

`.claude/audit/agent-ledger-YYYY-MM.jsonl` is an unkeyed SHA-256 chain. An accidentally edited, removed
or reordered line breaks it, each month starts from the previous month's last hash, and
`.claude/audit/HEAD` anchors the newest file's line count and hash (`bun run harness:ledger:verify`).
Anyone who can write the directory can rewrite the chain and `HEAD` together, so it is **not**
tamper-proof evidence. If you need that, run `bun run harness:ledger:verify --print-head` and publish the
line somewhere the agent cannot write (a PR comment, a CI artifact).

## Who must review changes to the harness

`.github/CODEOWNERS` names an owner for `.claude/settings.json`, rules, agents, skills, the `.agents/` twins, `.codex/hooks.json`,
`scripts/harness/`, `compliance/`, `.githooks/`, `.gitleaks.toml` and the workflows. It only forces a
review once `main` requires code-owner review (branch protection, open in #16). The CI job runs the PR's
own `phi-scan.ts` and `.gitleaks.toml`, which is why those paths need that review.

## Synthetic identifiers

`compliance/synthetic-identifiers.json` carries a `reviewed` block with a SHA-256 over its `ssn` and
`mbi` lists. `arch:compliance` fails when the lists change without it: a human confirms each new value
is synthetic, then runs `bun run scripts/check-compliance-controls.ts --fingerprint` and records the
result. Prefer never-issued values (SSN area 000, 666, 9xx) in fixtures, which need no listing.

## Setup (once per machine)

```bash
bun install
bun run setup:hooks                 # core.hooksPath -> .githooks (pre-commit + pre-push)
# optional but recommended locally: gitleaks v8.30.1 on PATH
claude                              # trust the folder when asked, so the allow-list takes effect
/plugin list                        # confirm ecc@ecc is enabled
```

Verify that everything works:

```bash
bun run arch:compliance             # register + harness wiring
bun run harness:phi-scan --all      # repo-wide baseline (clean on 2026-10-27)
bunx vitest run scripts/__tests__/harness-*.test.ts scripts/__tests__/compliance-controls.test.ts scripts/__tests__/codex-patch.test.ts
bun run harness:ledger:verify       # after a session, the chain is intact
```

## Human overrides

- `CW_STOP_GATE=off claude`: skip the Stop gate for one session (e.g. a docs-only marathon).
- `CW_AGENT_LEDGER=off`: no ledger lines.
- A new synthetic identifier: edit `compliance/synthetic-identifiers.json` and approve the prompt.
