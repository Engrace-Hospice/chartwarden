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
`Bash`, `write_stdin`, `apply_patch` and MCP tools (`Bash|write_stdin|apply_patch|mcp__.*`). Several things differ from Claude Code, all
from Codex's hook protocol (the bullets below):

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
  open, and a refusal there costs a rephrase. None of the MCP calls recorded in this repo's Claude sessions (nearly all of
  them the Chrome extension, the rest Chrome DevTools, Pencil and REA) is refused by it; the count is in the MCP section below.
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
  paths for that reason; the sandbox is the boundary. (A managed-rollout dispatcher that resolves the root with `git rev-parse`
  would need the same change; there is none in this repository.) An exported
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
  Each change to the pinned Codex command (the flag, then the walk-up root lookup, then the perl environment strip) needs each developer to re-trust it with `/hooks`. `--no-env-file` is
  a silent no-op on bun 1.3.0 to 1.3.2 (verified against each release; 1.3.3 and later honour it), so
  `engines.bun` in `package.json` is `>=1.3.3` (CI and the images pin 1.3.5); `arch:compliance` fails when it names
  an earlier floor, no range, or a version it cannot read.
  `perl -e 'alarm 8; …; exec @ARGV, "$root/scripts/harness/pre-tool-guard.ts", "--codex" or exit 127'`: Codex runs
  the call when a hook times out (10 s here) and when `exec` fails perl would exit 0, an allow; the same perl
  finds the checkout (above), under the same alarm. `env -u PERL5OPT -u PERL5LIB -u PERLLIB -u PERL5DB` in front of
  it: perl is the first process and reads those variables BEFORE the `-e` body, so `PERL5OPT=-Mstrict;BEGIN{exit(0)}`, or
  a `Cwd.pm` that exits in BEGIN found through `PERL5LIB` or `PERLLIB`, ended the wrapper with exit 0 before bun ran
  (Codex: allow; `harness-codex-perl-env.test.ts` runs the real command with each poison, and the previous command
  as the control that really allows). Tested on macOS's perl 5.34; `env -u` is the same on GNU and busybox
  coreutils, and Linux perl reads the same variables, but this was not run on Linux. `perl -T` ignores the
  variables too and was rejected: it then refuses the `exec` of bun ("Insecure $ENV{PATH}"). An `env` that cannot start
  still ends in `|| exit 2`. `|| exit 2`:
  exit 2 with a message blocks in Codex, so a guard that cannot start, crashes or times out blocks the call.
  `perl` and `bun` must be on the hook's PATH; without them every shell call and patch is refused, loudly.
  Claude's own three hooks (guard, ledger, Stop gate) are pinned the same way (`CLAUDE_GUARD_COMMAND`,
  `CLAUDE_LEDGER_COMMAND`, `CLAUDE_STOP_COMMAND`) and run with the same
  `--config=/dev/null --no-env-file --tsconfig-override=/dev/null`, for the same reason. None has a perl alarm: Claude
  Code has its own timeout, the guard enforces its own deadline (see "A hard deadline" below), and a missing `perl`
  would otherwise lock out every Claude tool call.
- **Claude's guard command fails closed (wave 7, T0, owner-approved).** It used to be the bare `bun … pre-tool-guard.ts`.
  Claude Code reads any exit code other than 2 as ALLOW, so a guard that could not run let the call through: a corrupted
  entry module (`pre-tool-guard.ts` or `hard-deadline.ts`: exit 1, which `GIT_TRACE=<file>` could cause by appending a
  line, `harness-trace-corrupts-guard.test.ts`), a missing `bun` (127), an OOM kill (137). The guard command, in BOTH
  PreToolUse groups (the core group and the MCP group), now ends in `|| { echo '[chartwarden-harness] the guard failed to
  run, so the call is refused' >&2; exit 2; }`, a plain-shell tail like Codex's: no perl, no alarm, no program that could
  be missing (`echo` and `exit` are shell builtins). `CLAUDE_GUARD_COMMAND` pins it byte for byte; dropping or altering
  the tail fails `arch:compliance`. The guard's own answers are untouched: a deny or an ask is JSON on exit 0, the
  emergency deny of `hard-deadline.ts` is exit 2 (the tail then prints its line as well, harmlessly), an allow is exit 0,
  and `||` never fires on exit 0, so `CW_HARNESS_FAIL_OPEN=1` (which makes the guard itself answer allow on exit 0) still
  lets a call through; it cannot rescue a guard that cannot start. The ledger and Stop-gate commands keep the bare form.
  **The price is a lockout:** a broken guard now refuses EVERY Claude tool call, the editing tools and the shell the
  repair would need included. The human repairs it outside Claude Code, in a terminal: `git restore scripts/harness`
  (or `git checkout -- scripts/harness`) and a `bun --version` check that `bun` is on the PATH Claude Code runs hooks
  with. **Residual:** a SILENT exit 0 (an empty or no-op guard module, a `bun` that exits 0 earlier on PATH) is not a non-zero exit and reads as allow: wave 8 considered
  a positive acknowledgement and DECLINED it (see Wave 8, T0b). A corrupted or edited `.claude/settings.json` itself is a different failure that the tail cannot
  close (the tail lives in that file; what Claude Code does with a settings file it cannot parse was not verified
  here); `arch:compliance`, the Stop gate, the pre-commit scan, CI and CODEOWNERS are the lines behind it, and the file
  is a protected path (an Edit of it asks).
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

`.codex/` (except its `sessions/`), `bunfig.toml` and `.bunfig.toml`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.override.md`, `.claude/settings.json` and `settings.local.json`, `.git/config` and `.git/config.worktree`, `.git/hooks/`,
`.git/modules/`, `.git/worktrees/` and the `.git` gitfile itself are on the guard's protected list at any depth (they are
loaded or run from any directory, and `~/.codex/config.toml` can disable the hook for a user); at the repo root
so are `.claude/{audit,.cache,rules,agents,skills,commands,hooks,plugins,launch.json}`, `.agents/` (except its
local `plans/` and `prds/`), `scripts/harness/`, `compliance/`, `.githooks/`, `.github/workflows/`,
`deploy/production/` and CODEOWNERS at its three homes. One definition of "protected" (`scripts/harness/protected-paths.ts`: one
pattern, one fragment pattern derived from it for text, and a list of sample names; the three agree on every tracked protected
file, `harness-protected-definition.test.ts`; the names the find rule and the wildcard pathspec rules try are read from the tree by
`protected-names.ts`, each listing root with a budget of its own, and a listing that is incomplete (a root over its budget, an
unreadable directory, a file deeper than the walk) makes every name test and every wildcard "may match": it fails closed, wave 7,
CR5-5; and the Stop gate's `arch:compliance` map asks the same `isProtectedPath`)
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
7 to 30 s (above the guard's own 6.5 s deadline, derived from `DEADLINE_MS`: a hook that Claude Code kills first is an allow), if the ledger's or the Stop gate's timeout (when one is set) is not an integer of 5 to 600 s or the
Stop gate is `async` (it would no longer hold the turn), if `.claude/settings.json` sets `disableAllHooks`, a
`bypassPermissions` default mode, or an `env` entry that is not an `ECC_*` variable or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (the block
is an ALLOW-list: `PATH`, `BASH_ENV`, `ZDOTDIR`, `NODE_OPTIONS`, `HOME`, `SHELL`, `LD_PRELOAD`,
`DYLD_INSERT_LIBRARIES`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `BUN_OPTIONS` (a `--preload` there runs before the
guard) all fail, naming the key), or one of the named switches `CW_HARNESS_FAIL_OPEN`, `CW_AGENT_LEDGER`,
`CW_STOP_GATE`, `CLAUDE_PROJECT_DIR`, `CW_HARNESS_ROOT_FOR_TESTS`, the deadline's test seams `CW_HARNESS_TEST_FAULT` and
`CW_HARNESS_DEADLINE_MS_FOR_TESTS`, `ECC_GATEGUARD` or `ECC_GOVERNANCE_CAPTURE` (which the `ECC_` prefix would let
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
whole. Measured once on the sessions recorded when this stack was built (the one MCP count in this document; it grows with
every session): 1,268 of the 3,359 recorded MCP calls are of a guarded tool, and the rule asks for none of them (the one
false positive before the narrowing was `e.key`); a call takes about 20 ms.

**Not covered, and why.** `computer`, `find`, `read_page`, `get_page_text`, `form_input`, `read_network_requests`,
and the other tools that carry coordinates, element references or no path are not judged (the hook
is not run for them: the matcher is tested against the real tool names, `harness-mcp-claude-hook.test.ts`).
Free-text connectors (Gmail send, reply and forward, Drive create and download, Calendar, and any other
claude.ai connector) carry prose and can send it off the machine; whether to guard them is an owner decision, since
a path-word judge would stop a message that names `.env`. Pencil's `execute` (a `filePath` of a design file and a
script), REA's tools (`mcp__rea__open_binary` and `mcp__rea__export_evidence_bundle` take absolute local paths, and the
matcher names the Chrome tools only, so `mcp__rea__*` is not matched) and the Chrome extension's `gif_creator` (its `filename`;
what Chrome's download sandbox does with a `../` there was not verified) are **ungated by owner decision: these tools can name an
arbitrary local path.** The words are text, so a path the
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
- a database client (`psql`, `pg_dump`, `mysql`, `redis-cli`, `mongosh`, and 41 more programs; wave 9) connecting to a non-local host, in any spelling of the target;
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
  and a wildcard pathspec of `git rm|mv|restore|checkout` that keeps a protected directory as its literal prefix
  (`scripts/harness/hard-dead*`, `compliance/zzz-*`: a file the directory may gain) or can match a protected name the tree holds
  (`scripts/h*/hard-deadline.ts`); wave 7, CR5-4: the literal prefix used to be dropped for any wildcard, a regression of wave 3. A
  lone word after `git checkout` is looked up where the
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
name (`${X:-git} push`, an array run as a command), or a program that writes where its own configuration says (wave 7
models `split`, `cpio -p`, `cc -o`, `tsc --outFile` and a few dozen more, and a generic backstop asks about a program it has
no model for that is handed a protected path: see Wave 7). Wave 3 added, each with a test file under `scripts/__tests__/harness-*.test.ts`:
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
never echo URL userinfo and cap any token they quote. Work is bounded because a guard that runs out of time
refuses the call (the 6.5 s deadline below) and a refusal costs a rephrase: a command over 64 KB (64 x 1,024 UTF-16 code units, the JavaScript string length, not bytes) is REFUSED before it is parsed (an ask would let padding
turn a denied command into a prompt; put large file content in a file with the Write tool, and a heredoc patch
that size through the `apply_patch` tool), the text judged across a command and everything nested in it is
budgeted (256 KB: a text nested N deep in `$( )` is judged once per level, each nearly the whole command), a
wall-clock limit of 1 s per judging backs them (the guard judges twice from a symlinked root), glob matching is a two-pointer matcher with star backtracking, O(name length x wildcard tokens) over the short
sample names and with no regular expression (so no exponential backtracking), brace alternatives
(4,096) and path resolutions (16,384) are budgeted per command in items AND in characters (8 MB of expanded
brace text, 8 MB of resolved path text, so one 4,000-character word expanded 4,096 ways spends what 4,096 short
words would not, so the per-word cap is the command's 4,096 alternatives, scaled down for a long word to about a million characters; a
word over 4,096 characters is not expanded, but when the command holds an UNQUOTED brace group (the lexer's reading, `bare-braces.ts`,
never whitespace in the word) it spends the budget and is read one group at a time, all-first and all-last; a command whose braces are
all quoted or escaped expands none and spends nothing; a `cd` is charged for characters only), a
`git -C` chain of more than 8 operands asks and a followed directory is capped at 1,024 characters, and
substitutions (32 per level) and judged command lines (300 per call) are capped; over any of those caps the
answer is ask (a word that holds more brace alternatives than its cap is cut and spends the budget when the command holds an unquoted
group; a long inline script or JSON body with object literals, every brace quoted, is not a finding), and a deny found before
the cap was hit still stands. Inside the cap every alternative is read, so a name that needs a MIX of first and last alternatives
(`{c,'x y'}{'x y',r}…` spelling `credentials` with a quoted or escaped space as the junk) is found and denied; past the cap the cut
keeps what a cheap reading can reach (each group alone, and every group taking its first and its last alternative, so `~/.aws/{x,}`
repeated nine times and then `credentials` is a deny, not a silent allow) and the command ASKS: a name that needs a mix past the cap
is an ask, never an allow (CR5-1). A brace-expanded destination of `cp`, `mv`, `ln` and `install` is every alternative of the last
argument, not the last alternative (`cp x .claude/{settings.json,y}` asks). A spent brace or resolution budget does not
stop the rest of the command from being judged: a secret file name is still found, even one that a single brace
group builds from a stem and an optional suffix, because each word is also read one group at a time, linearly;
only the clock and the judged-text budget stop judging. The per-command budget (`work`), the judged-lines counter and the Codex flag are module state, refilled by `classifyBash`
at depth 0: correct because the worker judges one hook per process (a long-lived embedding must not share them; passing a
`Work` object through is a mechanical refactor left for later, CR-L1). `baseName` and `trimSlashes` are linear (a regular
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
  normalisation as every other path (each directory a `cd` may have left it in, and with `/tmp`, `/private/tmp`, `/TMP` and the
  `/System/Volumes/Data` firmlink folded to one file: `harness-written-script-aliases.test.ts`), with a later command that runs the file: a shell
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
  `git-exec-strings.ts`, `harness-env-assignments.test.ts`). One reading of an assignment (`assignments()`: `NAME=v`, `NAME+=v`,
  `${NAME:=v}` wherever it stands in a word, a name spelled with quotes, backslashes, a brace group or a sequence: `GIT_TR\ACE=x`,
  `GIT_TRACE{,}=x`, `GIT_TRACE{2..2}=x`) is shared by the harness-switch rule, the git rules and the loader rules (wave 7, CR5-3: the
  harness-switch rule used regular expressions of its own, `braceVariants` was a second brace expander, and `${NAME:=v}` was read only
  there). A name that is still not a name after expansion (`${X}=v` given to an assigning builtin) asks, and so does a brace group in a
  program word (`env GIT_TRACE{2..2}=x git status`). A prefix assignment, `export`/`declare`/`typeset`/`readonly`/`local`, `env`, a subshell, a brace group, a later statement and
  a nested `bash -c` or `ssh h '…'` all count: `export GIT_TRACE=<guard file>; git status` no longer slips past a rule that only read
  the git segment's own prefix. The git variables that name a FILE git writes (`GIT_TRACE`, `GIT_TRACE2`, `GIT_TRACE2_EVENT`,
  `GIT_TRACE2_PERF`, `GIT_TRACE_PACKET`, `GIT_TRACE_PACKFILE`, `GIT_TRACE_CURL`, `GIT_TRACE_SETUP`, `GIT_TRACE_PERFORMANCE`,
  `GIT_TRACE_REFS`, `GIT_TRACE_SHALLOW`, `GIT_TRACE_FSMONITOR`, `GIT_TRACE_PACK_ACCESS`, `GIT_REDIRECT_STDOUT`, `GIT_REDIRECT_STDERR`,
  and `GIT_INDEX_FILE`) are judged as write targets, like a redirect: a path onto the guard, the ledger, the hook configuration or a
  startup file **asks** (Codex: denies); `/dev/null`, `/dev/stderr`, `/tmp/x.log`, and the values `1`, `2`, `true`, `false`, `0`, `off`,
  a file descriptor, `2>&1` and an `af_unix:` socket stay allowed as a trace TARGET (the `GIT_TRACE=<file> git status` PREFIX form still
  asks, whatever the value, through the generic `GIT_*` override rule: only `export` and kin reach the value check). Why it matters: git appends one trace line to the file, and a line
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
- *Variables bun and perl read at start* (`env-hazards.ts`, `harness-env-hazards.test.ts`). `BUN_OPTIONS=--preload=x.js` or
  `NODE_OPTIONS=--require=x.js` on a nested `claude`/`codex`, `PERL5OPT=-Mstrict` on the Codex wrapper, `LD_PRELOAD` and `PATH`
  decide what loads before a hook judges anything; `arch:compliance` already refused them in the shared settings `env`
  block, and nothing refused them on a command line. Now a command line **asks** when it assigns, anywhere (prefix, `export`,
  `env`, `+=`, a subshell, a later statement, a nested `bash -c`), `PERL5LIB`, `PERLLIB`, `PERL5DB`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES` or any `BUN_CONFIG_*` (a non-empty value), or `BUN_OPTIONS`/`NODE_OPTIONS` with a value that names an
  option that loads or runs code (`-r`, `--require`, `--import`, `--loader`, `--experimental-loader`, `--preload`, `-e`,
  `--eval`, `-p`, `--print`), or `PERL5OPT` with a switch that loads a module or a path (`-M`, `-m`, `-I`, `-d`, also bundled:
  `-wMstrict`). `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc` (the repo's typecheck script) and `PERL5OPT=-w` stay
  allowed. When the same command line also starts a coding agent (`claude`, `codex`, `bunx claude`, `npx
  @anthropic-ai/claude-code`), `PATH`, `SHELL`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `LD_LIBRARY_PATH` and every `DYLD_*` ask too, in
  either order and at every nesting level (wave 7, CR5-2: the variable is looked for in the WHOLE command text, so `PATH=… bash -c
  'claude -p x'`, `env PATH=… sh -c '…'`, `eval '…'` and `echo '…' | sh` ask; before, the variable and the agent had to sit in the same
  nested command line): they are too common to refuse everywhere. Reading is not setting: `echo $NODE_OPTIONS`, `printenv NODE_OPTIONS`
  and `rg BUN_OPTIONS= docs` assign nothing, and an empty value clears the variable. Codex denies every ask. **Not decided by
  text:** a variable set by an earlier tool call, a startup file or the human's own shell; `bun`/`node`/`perl` running a harness
  script directly is not modelled.
- *Commands that print every file under a directory* (`tree-sweep.ts`, `secret-reads.ts`, `harness-tree-sweeps.test.ts`).
  `git diff --no-index DIR DIR`, `diff -r`/`-R`/`--recursive` (any cluster, `-ru`, `-rq`, `-Nr`), `colordiff -r`, and
  `git diff A B` when one operand is outside the working tree (git implies `--no-index`; `git diff HEAD -- A` is not it)
  **ask**, as `grep -r` does, when an operand is the repo root, a directory above it (`..`, `~`), a directory that holds a live
  env file that exists, a glob that can match such a directory (`apps/*`, `apps/b*`), a brace operand (`{apps,docs}`), or cannot be
  placed (a `cd` the guard cannot follow, a variable it cannot place: wave 7, CR5-6 puts the same reading under `cp -r`, `rsync -a`,
  `tar c` and `find -exec cat`; a variable the SAME command line sets to a literal is placed there, `D=.; grep -r x $D` asks and
  `S=/tmp/x; diff -r $S/a $S/b` does not, and any other variable operand asks). A plain `diff DIR DIR` compares the same-named files directly under both (`-N`: any file), so it asks when
  an operand directly holds one. `git grep --no-index` and `grep -r`/`rg -u` now read their operands the same way: pathspec magic
  (`:/apps`, `:(glob)…`, `:!x`; for git grep only) cannot be placed and asks, and so do `..`, `~` and a glob. `cmp` is not
  judged (on a directory it only says "Is a directory"); words inside `<( )` are not operands. `diff -r a.txt b.txt`, `git diff
  --no-index a.txt b.txt`, `git diff HEAD~1`, `diff -r dir1 dir2` over directories with no live env file, and `git grep --no-index foo
  -- 'scripts/*.ts'` stay allowed. **Not decided by text:** a symlink to a directory inside an operand, and a glob whose literal part
  is built at run time. The corpus cost: grep -r over `..` and a recursive diff after an unresolvable `cd $VAR`.
- *Files a git option makes git write* (`git-config-rules.ts`, `harness-git-output-writes.test.ts`). `--output=FILE` (or `--output
  FILE`) was judged for `diff`, `log` and `show` only (a deny); `format-patch`, `blame`, `shortlog`, `range-diff`, `diff-tree`,
  `diff-index`, `diff-files`, `whatchanged`, `reflog`, `difftool`, `rev-list` and `stash show` now ask when FILE is a protected path (every
  one was run in a scratch repository on git 2.53 and wrote the file, except `stash show`, which needs a stash and rests on
  the documentation), `git credential-store --file=PATH` and `git credential-cache --socket=PATH` are write targets too, and a
  relative FILE is read from where `git -C DIR` runs. The harmless `--output-indicator-new=+` of `git log` is no longer denied.
  The other round-4 ADV-6 forms were re-run on git 2.53 and run nothing, so they are not findings: `git pull --rebase --exec`
  ("unknown option `exec'"), `git fetch -u CMD` (`-u` is `--update-head-ok`), `git rebase -xi CMD` (`-x` takes `i`), `git
  rebase --e=CMD` ("ambiguous option"), `git bisect --no-checkout run` and `git submodule foreach -- CMD` (usage errors) and
  `git grep -O CMD` (the pager's value is attached only). The git config keys that name a program joined the exec-key table
  (denied, as `git config core.pager` is): `core.alternateRefsCommand`, `browser.*.cmd|path`, `web.browser`, `help.browser`,
  `man.*.cmd|path`, `guitool.*.cmd`, `sendemail.smtpServer|toCmd|ccCmd`, `instaweb.httpd|browser`, `imap.tunnel`,
  `gpg.ssh.defaultKeyCommand`, `tar.*.command` and `trailer.*.command`; each is in the git 2.53 documentation, and none was
  run (the chain from the key to a command is the documentation's).
- *The live-suite ask reaches a runner through indirection* (`live-suite.ts`, `harness-live-suite-indirection.test.ts`): `node
  node_modules/.bin/vitest run x.live.test.ts`, `node`/`bun node_modules/vitest/vitest.mjs …`, the package's own `test` script
  (`bun run test -- x.live.test.ts`, `npm test`, `npm run test`, `pnpm test`, `yarn test`) and a quoted glob
  (`"apps/backend/__tests__/*.live.*"`) ask like `vitest run x.live.test.ts`; `bunx biome|tsc|prettier|eslint …
  x.live.test.ts` and `rg`/`grep`/`cat`/`sed`/`git`/`wc` over it still allow (the corpus shows no live-suite transition against
  the wave-5 stack). There is no Makefile, so `make live` names nothing. **Not decided by text:** `xargs bunx vitest run < list`
  (the files come from standard input), and a runner started by a script file the agent wrote.
- *One file, however APFS spells it* (`path-alias.ts` `aliasNormalise`, `harness-path-spellings.test.ts`). On macOS's case- and
  normalization-insensitive APFS (checked in a scratch directory on the machine the stack was built on) upper and mixed case, an
  NFD or NFC spelling, `./`, `//`, `/./` and `/../` all name one file, and so do the names that differ by Unicode case folding:
  U+212A KELVIN SIGN is `k`, U+017F LONG S is `s`, U+00DF SHARP S is `ss`, the U+FB01 and U+FB02 ligatures are `fi` and `fl`. The
  guard's `/i` patterns knew ASCII case only, so `.claude/hoo<KELVIN SIGN>s/x`, `scripts/harne<SHARP S>/pre-tool-guard.ts` and
  `~/.pgpa<LONG S><LONG S>` reached a protected or secret file unasked. `aliasNormalise` (NFKC, plus sharp s) now runs where a
  shell word becomes a path (`resolvePath`), inside `isProtectedPath` and inside `secretPathReason`, so Bash, Write, Edit,
  MultiEdit, NotebookEdit, Read, `apply_patch` and the MCP path words judge the ASCII name; it is wider than APFS (a fullwidth
  letter folds too), the direction that fails safe, and a path with no non-ASCII character is returned untouched after one linear
  scan. A real path through a symlink (`src/link -> scripts/harness`) is judged by its real path for the editing tools and
  `apply_patch`. **Not decided by text:** a symlink inside a shell command's text (the guard reads no file system for it), and
  Windows' trailing dot and space (`pre-tool-guard.ts.` is a different file on APFS and Linux, and is protected anyway by the
  directory it sits in).
- *The pinned Codex command ignores perl's own variables* (`PERL5OPT`, `PERL5LIB`, `PERLLIB`, `PERL5DB`): see "The hook command is
  pinned byte for byte" above and `harness-codex-perl-env.test.ts`.

**Wave 7.** Each item has a test file under `scripts/__tests__/harness-*.test.ts`. The finding IDs are mapped in "Finding IDs cited in this
document" at the end.
- *Claude's guard command fails closed* (T0): see "Claude's guard command fails closed" above and `harness-claude-fail-closed.test.ts`.
- *A SQL client's own command language* (`db-client-escapes.ts`, `harness-db-client-escapes.test.ts`, ADV5-1). `sqlite3 :memory: '.shell
  echo x > <guard file>'`, `psql -c '\! …'`, `mysql -e 'system …'` and `pgcli -c '\! …'` run an operating-system command from inside an
  ordinary database client; Claude's classifier allowed all of them, because the escape was recognised only by Codex's interactive-shell
  check. The text a client is handed (an argument and the value attached to it, a here-string, a heredoc body, what an `echo`/`printf`
  earlier in the pipeline prints) is now read: a shell escape **asks** whatever it names (sqlite3 `.shell`, `.system`, `.load`, `.excel`,
  `.www`, `.once -e`, a `|cmd` target of `.output`/`.once`/`.import`/`.read`, with the abbreviations the shell accepts (wave 7 pinned only `.sys`; wave 8 read every prefix on sqlite 3.51.0: `.sh` and `.sy` ARE `.system`, `.cl` is `.clone`, see Wave 8); psql and
  pgcli `\!`, `\setenv`, `\pager`, a `|cmd` target of `\o`/`\g`/`\gx`/`\w`, `\copy … program`; mysql, mariadb and mycli `system`, `\!`,
  `pager`, `\P`, `--pager=`), also in a container (`docker compose exec db psql …`). A file the client writes (`.output`, `.once`,
  `.backup`, `.save`, `.clone`, `.log`, `.trace`, `.open`, `writefile()`, `VACUUM INTO`, `ATTACH`; `\o`, `\g`, `\gx`, `\w`, `\copy … to`,
  `\lo_export`; `tee`, `--tee=`) is judged like a redirect target, so a protected path asks and `/tmp/out.csv` does not; a file it reads
  and runs or prints (`.read`, `.import`, `\i`, `\ir`, `\copy … from`, `source`) is judged like a read, so a secret file is **denied**.
  Everyday use stays allowed: `sqlite3 db 'select 1'`, `.tables`, `psql -c 'select 1'`, `\dt`, `mysql -e 'select 1'`, a regular expression
  `'\w+'` inside SQL. The shared reader is a superset of what Codex's `isInteractiveShell` caught, and Codex turns every ask into a deny, so
  its answers for these stay deny. **Not decided by text:** a script file (`psql -f F`, `sqlite3 db < F`, `mysql < F`: the file is not read),
  a command built at run time (`psql -c "$CMD"`), SQL that makes the SERVER write or run something (`COPY … TO PROGRAM`, `INTO OUTFILE`),
  and a client the table does not name (wave 8 added `litecli`, `usql`, `duckdb`, `cockroach sql`, `sqlcmd`, `sqlplus`, `mongosh`,
  `clickhouse-client` and `trino`; `iredis`, `mssql-cli`, `harlequin` and a client through an alias remain). Corpus cost: see the wave-8 corpus paragraph.
- *Siblings of the tree sweeps* (`sibling-sweeps.ts`, `harness-sibling-sweeps.test.ts`, ADV5-3). Each is rewritten into the
  command line it is the sibling of, and that line is judged by the machinery the original already has (operand placement,
  narrowing by a source-file name test, a write onto a protected path): `ack` (recursive, reads no .gitignore) as `grep -r`, `ag`
  with `-u`, `-U`, `--unrestricted`, `--skip-vcs-ignores` or `--hidden` as `rg -u`, `fd -x`/`--exec` and `-X`/`--exec-batch` (wave 8: also the short clusters `-Hx`, `-HIx`, `-Ix`, `-HX`, `-xcat` and `--exec=cat`) as `find
  … -exec` (`-e ts` narrows it, as `-name '*.ts'` does for find; one non-source extension such as `env` does not), `find … | cpio -p
  DEST` and `pax -rw SRC DEST` as `cp -r`, `pax -w` and `find … | cpio -o` as `tar c`. A reason says which sibling it judged and as
  what. **What reproduced and what did not** (checked on this machine, fd 10.4.2 and macOS's cpio and pax): `find . -depth -print |
  cpio -pdm DEST` and `pax -rw . DEST` copy a hidden gitignored file, so they ask like `cp -r`. `fd` and `ag` skip gitignored files by
  default (the repo's ignore list names `.env`), so a plain `fd -H … -x cat` or `ag -l X .` does not reach a live env file there, while
  `fd -u`/`-I` and `ag -u` do; `fd -x` asks over the root like `find -exec` anyway (the guard does not read a repo's ignore rules),
  and a plain `ag` stays allowed as a plain `rg` is (`ag` is not installed here: its default is from its documentation). `ag
  --version`, `ack --version`, `fd -e ts`, `fd pattern src`, `cpio -t < archive`, `pax -r < archive` and a sweep of a directory
  that holds no live env file are not asked. **Not decided by text:** the names a `cpio` or `pax` reads from standard input when
  no `find` feeds it in the same pipeline (`cat list | cpio -o`, `git ls-files | cpio -p`), and an `fd` run from `--base-directory`.
- *More writers, and a backstop for the rest* (`writers-more.ts`, `protected-operands.ts`, `harness-writers-more.test.ts`,
  `harness-protected-operands.test.ts`, ADV5-2). About twenty ordinary commands wrote to a path the agent names and had no
  rule: a file written onto `pre-tool-guard.ts` or `hard-deadline.ts` makes the hook's entry thread unable to start. **Modelled
  now** (each judged like a redirect target; options read from the tool's own `--help` or manual): `bun build --outfile|--outdir|
  --metafile`, `tsc --outFile|--outDir|--declarationDir|--tsBuildInfoFile|--generateTrace|--generateCpuProfile` (any case,
  through `bunx`, `npx`, `bun x|run`, `pnpm|yarn|npm exec|dlx`), `vitest --outputFile[.reporter]|--coverage.reportsDirectory`,
  `eslint -o|--output-file|--cache-location`, `biome --log-path`, `uniq IN OUT`, `split`/`csplit` prefixes, `shuf -o`, `pandoc -o`,
  `cc|gcc|g++|clang|rustc|swiftc|ld|strip|objcopy -o`, `go build|test|install -o`, `curl --etag-save|--hsts|--alt-svc|--ssl-sessions`,
  `wget --save-cookies|--hsts-file|--rejected-log|--warc-file|-e output_document=`, `ssh -E|-S|-o UserKnownHostsFile=|ControlPath=`,
  `gh release download -D|-O`, `gh run download -D`, `gh repo|gist clone DIR`, `docker|podman cp CONTAINER:… DEST|save|export -o`, the
  `git` subcommands that write outside `.git` (`fast-export|fast-import --export-marks`, `worktree add|move`, `init [DIR]`, `clone SRC
  [DIR]`, `pack-objects BASE`, `index-pack -o`, `merge-file`, `interpret-trailers --in-place`, `checkout-index --prefix`, `read-tree
  --index-output`, `mailsplit -o`, `mailinfo`, `bugreport|diagnose -o`, `submodule add`), and `git sparse-checkout set|add|reapply|init`
  joins the whole-working-tree writers (it removes the tracked files outside its patterns, the guard included). **Did not reproduce:**
  `gh api --output` is not a gh option (gh 2.87.3 refuses it), so it writes nothing; `git hash-object -w --path=` only names a path
  for filters and writes under `.git`; `git cat-file --filters`, `git var` and `git commit -F|--template` read; `git update-ref`,
  `symbolic-ref`, `notes` and `update-index` write under `.git`, which is not on the protected list except `config`, `hooks`, `modules`
  and `worktrees`. **The backstop:** the class is unbounded (five rounds, each found more), so a command whose text names a protected
  path (a literal operand, an option value, `key=value`, in any alias spelling and from every directory the command may run in) as
  an argument of a program that is not known to only read, **asks** (wave 8 rewrote this: a READER is exempt only until one of its write
  flags appears, and a modelled program's positional operands are exempt, its attached option values are not; see Wave 8)
  (Codex: denies), naming the program (`sd 's/a/b/' scripts/harness/x.ts`, `prettier --write`, `shfmt -w`, `bunx biome check
  --write scripts/harness/x.ts`, a tool invented next year). The read/check list was chosen from this repo's real Bash commands:
  of 124,735 distinct commands, 5,201 name a protected path and were allowed before, led by `grep`, `git`, `sed`, `ls`, `cat`, `bunx`,
  `wc`, `cmp`, `diff`, `bun`, `awk`, `head`, `rg`; all of those that only read, and the shell keywords (`for`, `do`), are listed. It never
  turns a deny into an ask (a deny is found first), reads a word with whitespace as prose (a commit message), skips a directory it
  cannot resolve (no unknown program asks after `cd $VAR`), and does not read a computed name, a variable path or an encoded name:
  **the sandbox is the real boundary.** (The wave-7 corpus figures that stood here, 87 allow to ask of 124,738, were measured on the
  wave-7 tree and went stale; the figures are re-measured on the final wave-8 tree below.)
- *The round-5 code review* (CR5-1 to CR5-11; each item has its own test file `harness-*.test.ts`, named below).
  **CR5-1** (`bare-braces.ts`, `harness-cr5-braces-env.test.ts`): described in the budget paragraph above; `{c,'x y'}` and `x\ y`
  alternatives are read in full inside the cap. **CR5-2** (`env-hazards.ts`): an agent-hook variable assigned anywhere asks when an
  agent starts at any nesting level. **CR5-3** (`shell-assignments.ts`): one assignment grammar, sequences, `${NAME:=v}`, an
  unplaceable name asks. **CR5-4, CR5-5** (`protected-names.ts`, `harness-protected-wildcards.test.ts`): described under the
  protected-path paragraph and the git writers above. **CR5-6** (`harness-sweep-unified.test.ts`): copy-out, archive and
  `find -exec cat` ask through the reading `grep -r` uses, `find` is read as a boolean expression (`-o` narrows nothing), a brace
  operand is its alternatives, and a variable operand is placed from the command's own literal assignments or asks. **CR5-7**
  (`live-env-files.ts`, `harness-live-env-files.test.ts`): "a live env file" is read from the tree (every env file that is not a
  tracked template, in the root, `deploy/production` and the children of `apps`, `services`, `packages` and `deploy`); the seven-path
  list is only the fallback for a caller that cannot list; on this machine the main checkout holds one, so the corpus cost is 0.
  **CR5-8** (`harness-script-text-aliases.test.ts` and additions to `harness-mcp-claude.test.ts`, `harness-hook-matcher.test.ts`): the
  five surviving hand mutants are pinned (the five `CODE_DELIMITERS` characters, the Gmail send entry of the not-guarded list,
  `aliasNormalise` in `scriptTextVerdict`) or gone with their code (`MAX_VARIANTS`, the dead `env` entry); wall-clock bounds near
  their typical time were raised to 3 to 5 s. **CR5-9**: this document's eight claims the review found false are corrected in the
  paragraphs they sat in. **CR5-10**: `braceVariants` is gone, and `tree-sweep.ts` `spells` now delegates to `isLongOption` (it was the fifth
  reader); three inline long-option abbreviation readers REMAINED (`git-grep-sweep.ts`, `git-exec-strings.ts`, `harness-switch.ts`; wave 8 did
  not unify them; wave 9, W9-4, did: `longName` and `spellsLong` in `option-values.ts`); follow-ups left: the two `VARIABLE_SETTER` regular expressions
  (`git-exec-strings.ts`, `harness-switch.ts`), `patterns.ts` at about 3,000 lines against the 800-line ceiling, module-level state
  (`work`, `judgeBudget`, the one-shot caches), and `readStdin` duplicating `io.ts`. **CR5-11** (`live-suite-files.ts`,
  `harness-live-suite-substring.test.ts`): `bunx vitest run care-plan-conformance` runs the live suite beside the unit tests, because
  vitest filters by substring of the path; a filter that reaches into the file name of a live suite the tree holds **asks**. A
  directory filter (`scripts/__tests__`, `apps/backend/__tests__`, `packages/db`) runs every test under it, live suites among
  them, and is not asked (asking was 0.34% of this repo's real commands); the remaining ask costs 0.17% (unit-test stems that also
  name a live twin). A bare `vitest run` with no filter runs everything the config includes, live suites too, and is not asked.

**Wave 8.** Each item has a test file `scripts/__tests__/harness-*.test.ts` (named below; the round-6 reviewers' payloads are in them, and
the data-driven tests walk every entry of the tables). The finding IDs (ADV6-n from the adversarial review, CR6-n from the code review) are
mapped in "Finding IDs cited in this document".
- *Package runners are peeled once* (`runners.ts`, `package-scripts.ts`, `harness-runners.test.ts`, `harness-package-scripts.test.ts`; T1,
  ADV6-1, CR6-2, CR6-8). `bunx`, `npx`, `pnpx`, `bun x`, `pnpm|yarn|npm exec|dlx`, `npm x` and `bun|yarn run X` start a program, so where the
  classifier finds a command's program (under `env`, `nice`, `timeout`, `time`, `sudo` or another runner too) the runner is replaced by what it
  starts, and EVERY rule judges that command: `bunx git push origin main` asks, `bunx git commit --no-verify` is denied, `bunx rm -rf
  scripts/harness`, `npx rm .claude/settings.json`, `pnpm exec cp x CLAUDE.md` and `bun run cp x CLAUDE.md` ask, as typed. (That held only for the spellings the one regex of wave 8 read: `pnpm -r exec`, `pnpm -w exec`, `pnpm -c exec`, `yarn workspace X exec`, `yarn workspaces foreach exec` and `bun exec STR` hid their command until wave 10, part A8: each manager now has the option grammar of its own CLI, see "Wave 10 part A" below.) `-c STR`, `--call
  STR`, `--call=STR` and pnpm's `--shell-mode` hand a string to a shell (`sh -c STR`, judged as a command line). `bun run X`, `yarn run X`,
  `bun X` and `yarn X` run a package SCRIPT when X is a key of the nearest `package.json` (read once per command, only when a name needs
  it; a name with a colon such as `arch:fitness` always is one), a file when X looks like one, a builtin subcommand (`bun test`, `yarn install`),
  and otherwise the PATH program X (`bun run echo hello` ran `echo`: the reviewer checked); `npm run X` and `pnpm run X` only run scripts. The
  two readers that disagreed (`executed()` and `underRunner()`) are deleted. Wave 9 added `corepack`, `volta run`, `mise
  exec`, `asdf exec`, `direnv exec`, `cross-env`, `dotenv`, `dotenvx run`, `env-cmd`, `doppler run`, `op run`, `lerna exec` and `nx exec` (see Wave 9); a runner no table names still
  hides its command from the rules by name, and the backstop below asks when such a program is handed a protected path. Everyday `bunx biome check x.ts`, `bunx tsc --noEmit`, `bunx vitest run <unit test>`, `bun run test`, `bun run
  arch:fitness`, `npx --version` and `bunx playwright test <spec>` stay allowed.
- *The backstop, rewritten* (`protected-operands.ts`, `harness-backstop-wave8.test.ts`, `harness-protected-operands.test.ts`; T2, CR6-1, ADV6-2,
  CR6-4, ADV6-5). Three kinds of program. A READER (`cat`, `grep`, `ls`, `cloc`, `shfmt -d`, `docker`, `bun`, `node`, `python`, `sed`, `awk`, …) is
  exempt until the command line carries one of its WRITE FLAGS, which are data next to its name, with an example each (`tree -o`, `awk '… >
  ARGV[1]'` or `-i inplace`/`--include`/`-f`, `plutil -replace|-remove|-insert|-extract|-convert|-create` or `-o`, `python -m json.tool IN OUT` and
  `-m venv|zipfile|…`, `docker cp|save|export|buildx` or `-o|--output|--iidfile`, `jest --outputFile`, `playwright screenshot|pdf|codegen|--output`,
  `markdownlint --fix|-o`, `gitleaks -r|--report-path`, `node --redirect-warnings|--cpu-prof-dir|--heap-prof-dir|--report-dir|--trace-event-file-pattern`,
  `bun --cwd|--reporter-outfile|--coverage-dir`, `deno compile -o|bundle`, `npm|pnpm|yarn --prefix|--cwd|-C`, `cpio -o|-O|-p`, `pax -w`, GNU `sed`
  `e` and `s///e`, `less -o`, `file -C`, `cloc --out`, `scc -o`, `ruff format|--fix|--output-file`, `semgrep --autofix|-o|--*-output`, `trivy -o`,
  `redis-cli --rdb`, `code --user-data-dir`, …); a flagged reader is then treated like an unknown program. A MODELLED program (`cp`, `mv`, `rm`,
  `tee`, `git`, `curl`, `tar`, `zip`, `psql`, … the table lists them) has its own write model, so its POSITIONAL operands are the model's (`cp
  scripts/harness/x.ts /tmp/y` reads), and a protected path attached to an option (`--out=P`, `-o=P`, `key=P`) is not exempt. Every other
  program asks for any word that names a protected path, positional or not. `plutil`, `7z`, `strip`, `objcopy`, `go`, `cc`/`gcc`/`rustc`, `cpio`,
  `pax`, `sftp`, `env` and `sudo` left the modelled list (their models were partial). Words are placed like every other operand: brace
  alternatives, the variables the command line sets to a literal (`D=scripts; sd a b $D/harness/x.ts`), then the predicate the write rules use
  (the path, a directory above one such as `scripts` or `.claude`, a wildcard that can match a protected file, or whose directory part can match
  a directory in which every file is protected: `scripts/h?rness/new.ts`); the REPO ROOT (`.`, `..`, `$PWD`) and a wildcard with no `/` (`*`,
  `*.ts`) count only when the command line carries a write flag (`bunx biome check --write .`, `prettier --write *.md`, `shfmt -w .`, `gofmt -w .`
  ask; `ecc-agentshield scan --path .` and a helper script given `"$PWD"` do not). For a program that is neither a reader nor modelled, the names
  inside a word that holds whitespace or code punctuation (an inline program, an SQL string, a here-string) are read too: a name that looks
  like a path and is a secret file is **denied** (`duckdb -c "select * from read_csv('<env file>')"`, `Rscript -e`, `julia -e`, `emacs --eval`,
  `expect -c`, `tclsh <<<`, `mongosh --eval`), a protected one asks; a SQL column (`r.key`), a property chain or a variable-prefixed path is not a
  file here, and a function the command line defines is called with prose as often as with code, so its arguments are read as words only. An
  editor's (`ed`, `ex`, `vi`, `vim`, `nvim`) command text (an argument, a here-string, a here-document, what a `printf` pipes in) is read
  through the client reader: every name in it is a file it may write. `time -o FILE` and `strace -o FILE` are wrapper options: the file is judged
  like a redirect target. `-o=FILE` (Go, clap) and `-coverprofile=FILE` are read as the file. The data-driven consistency test asks, for every
  MODELLED name, a write shape that must ask, and for every READER name a read shape that must allow and, where it has write flags, one that
  must ask. `cloc`, `tokei`, `scc`, `cspell`, `depcruise`, `shfmt -d`, `ruff check`, `eza`, `lsof`, `open`, `make`, `semgrep`, `trivy`, `code` and
  `redis-cli` joined the readers (they asked before). Most of those tools are NOT installed on the machine the stack was built on: their
  write flags were read from their documentation, not run. `make` runs recipes the guard cannot read, as `bun run NAME` runs a script.
- *Database clients under real shell quoting* (`db-client-escapes.ts`, `client-reading.ts`, `sqlite-commands.ts`, `postgres-commands.ts`,
  `sql-file-functions.ts`, `harness-db-clients-wave8.test.ts`; T3, ADV6-6, CR6-3, ADV6-5). Bash collapses `"\\o X"` to `\o X`, but the lexer kept both
  backslashes, so `psql -c "\\o CODEOWNERS"`, `psql <<< "\\o |sh"`, `mysql -e "\\! id"` and `sqlite3 :memory: "select writefile(\"X\",'x')"` were
  never read as the escapes they are: both the lexed text and the text the client receives are read. psql starts a meta-command at ANY
  unquoted backslash (`select 1 \o X`, `\g`, `\s FILE`, `\cd`), with single and double quotes, dollar quotes and comments skipped, and the
  arguments of a command ending at `\\`. sqlite3 command abbreviations come from a table of probed minimums (every prefix of every
  name was run with NO argument on sqlite 3.51.0: `.sh`, `.sy` are `.system`, `.c`, `.cl` are `.clone`, `.o` is output or once or open, `.sa` and
  `.ba` are unknown commands, `.load` is disabled in this build, `.www` and `.excel` were not run and carry conservative minimums);
  `harness-db-clients-wave8.test.ts` walks every prefix of every entry. `.cd DIR` moves a later relative `.output`/`.once`/`.backup` file, and
  `.parameter set @f X` binds the file a later `writefile(@f, …)` or `readfile(@f)` names. `.testcase`, `.restore`, `.ar -c -f`, `\s FILE` and the
  SQL that names a file in ANY client are read: `readfile`, `writefile`, `read_csv|json|text|parquet`, `pg_read_file`, `lo_import`, `lo_export`,
  `COPY … TO|FROM 'file'` (server-side), `COPY … PROGRAM`, `INTO OUTFILE|DUMPFILE`, `EXPORT DATABASE`, `LOAD_FILE`, `file()`, `load_extension()`,
  `xp_cmdshell`. The files a client's own options name (`psql -f`, `mysql --defaults-file`, `sqlite3 -init`, `sqlcmd -i|-o`, `--queries-file`,
  `trino --file`) are reads or writes of that path. Still not read: a script file's CONTENTS, a command built at run time, a client the table
  does not name, and a variable (`\set X …` then `\o :X`).
- *Options that run a command line* (`option-commands.ts`, `harness-option-commands-wave8.test.ts`; T4, ADV6-7). `ssh -o 'ProxyCommand cmd'`
  (the space form), `-o ProxyCommand=cmd`, `-oProxyCommand=cmd`, `-o 'ProxyCommand = cmd'`, `LocalCommand` and `KnownHostsCommand` (any case
  of the option name), for `ssh`, `scp` and `sftp`; scp's and sftp's `-S program` and sftp's `-D server` (any program but `ssh` asks: the guard has
  no command line to judge); `zip -T -TT cmd`; `rg --pre cmd` and `--hostname-bin cmd`; `man -P cmd` and `--pager=cmd`; `less '+!cmd'`. Each value is
  judged as a command line, so a harmless one answers as typed. `-F config` reads a config file that may hold any of these: judged only as a read
  of that path. Not covered: a config file's contents.
- *More shapes of printing the environment* (`env-dump.ts`, `env-shapes.ts`, `harness-env-dump-wave8.test.ts`; T5, ADV6-8, CR6-12). `bun -e
  'console.log(Bun.env)'`, `typeset -x|-p`, `declare -px`, `export -px`, `jq -n 'env'`/`'$ENV'`/`'env.X_SECRET'`, perl `$ENV{X_SECRET}` and `say for %ENV`,
  awk `ENVIRON`, `ps eww`, `ps aux -E`, `ps auxe`, `launchctl export|getenv SECRET`, deno `Deno.env.toObject()`, python `os.environ` in any printed shape
  (`print(*os.environ.items())`, `dict()`, `json.dumps`, a loop), node `JSON.stringify({...process.env})` and `Object.entries`, ruby `ENV.to_h` are
  **denied**: a sink (a print, a log, a serializer) has to take the whole environment, directly or through up to three wrapping calls, a spread
  or a splat, and the sink must be a WHOLE word (three TypeScript snippets in a python heredoc were once read as a dump because
  `partnerAccessAvailability(process.env)` starts with the letter `p`). `connect(process.env)` and `spawn(cmd, {env: process.env})` pass the
  environment on and are not dumps. `declare -x NAME=value`, `typeset -x NAME=value`, `export NAME=value` and `set -x` ASSIGN or switch an option and
  are no longer denied (v6 and v7 denied them).
- *Sweeps* (`sibling-sweeps.ts`, `tar-grammar.ts`, `listing.ts`, `live-env-files.ts`, `live-suite-files.ts`, `harness-sweeps-wave8.test.ts`; T6,
  CR6-5, ADV6-9, ADV6-10, CR6-6). `fd -Hx`, `-HIx`, `-Ix`, `-HX`, `-xcat`, `--exec=cat` are `find -exec`. `ugrep -r`, `rga`, `pt`, `sift`, `ucg`, `zgrep -r`,
  `gitleaks detect --no-git|dir`, `trufflehog filesystem`, `semgrep --no-git-ignore`, `scp -r` and `ag -a|--all-types` are siblings of `grep -r`/`cp -r`/`rg
  -u`; `gitleaks … --redact` (the repo's own pre-commit hook) stays allowed. rga, pt, sift and ucg were treated as recursive by default from their
  documentation (none is installed here). An unknown program asked to read recursively (`-r`, `-R`, `-a`, `--hidden`, `--recursive`, `--no-ignore`) a PLACED
  directory (not the root, not a wildcard) that holds a live env file asks. tar is read with its own grammar: clusters whose values come in order
  (`-cCf apps /tmp/o.tar portal` takes DIR then FILE; `-Capps` attaches), `--directory=`, `--dir=` and any unambiguous abbreviation, `-T` and
  `--files-from` (an unreadable list: asks when creating), and each `-C` applies to the operands after it; `tar x` unpacks into the last `-C` in any
  spelling. The tree-sweep operand is matched as the file system folds names (case, NFKC): `grep -r X APPS/PORTAL` asks. The listings of the live env
  files and the live suites return `{files, complete}`: more directories than the cap, a depth past 16 (it was a silent 8), a symlinked directory and
  an unreadable one make the listing incomplete, and every rule that asks "could this reach one?" then answers yes (ask), as the protected-names listing
  does; `.envrc` is a live env file. A symlinked directory under a listed root is a gap, not followed, unless it points inside a walked root; a symlink to a FILE is a file (wave 9, W9-0: wave 8 treated every symlink as a gap, which made every vitest filter ask on a checkout that holds a Python virtualenv). The three inline long-option abbreviation readers named under CR5-10 were
  unified in wave 9 (W9-4); the `isOption` definitions (four: `client-reading.ts`, `protected-operands.ts`, `sibling-sweeps.ts`, `writers-more.ts`) and the
  operand readers (`operands` in `writers.ts` and `writers-more.ts`, `operandsOf` in `sibling-sweeps.ts`) are not unified: they differ on a lone `-` and on an
  empty argument, so one function would change an answer (wave 10 list: not done).
- *PATH shadows, persistence, secret names* (`toolchain-paths.ts`, `launchctl-rules.ts`, `secret-names.ts`, `harness-persistence-wave8.test.ts`; T7,
  ADV6-3, ADV6-12, ADV6-14). A program the pinned commands and the guard call (`bun`, `bunx`, `perl`, `env`, `sh`, `node`, `git`, `python3`) is protected BY
  NAME in any directory (`cp /usr/bin/true ~/.kimi-code/bin/bun` asks; Codex denies): the fixed list could never name every user-writable PATH directory
  that comes before `~/.bun/bin`. The cost is an ask for an ordinary write to a file or directory of that name (`echo x >> env`, `rm -rf
  ~/Library/Caches/bun`, `mkdir sim/bin/bun`): 9 of the 129,020 real commands. **Residual:** the guard runs under whatever `bun` the PATH of the hook
  resolves; pinning an absolute path in a shared settings file is machine-specific and is not proposed. `~/.gitconfig`, `~/.config/git/*`, `~/.claude.json`,
  `~/Library/LaunchAgents/**`, `~/.claude/{rules,plugins,hooks,commands,agents,skills}/**` and `~/.codex/{config.toml,hooks.json,AGENTS.md}` are protected
  (the settings files, every `CLAUDE.md` and the whole `.codex/` already were); `~/.claude/projects/**` (the memory files the Write tool writes every
  session), caches and history are NOT. `launchctl setenv|unsetenv|load|unload|bootstrap|bootout|enable|disable|kickstart|submit|bsexec|asuser` asks. Corpus
  cost of these paths: 0 commands wrote any of them. Secret names added: `.envrc`, `secrets.json|yaml|yml`, `application_default_credentials.json`,
  `.my.cnf`, `.mylogin.cnf`, and a RELATIVE `env.sh` (an absolute path or one behind a variable, `source $S/env.sh`, is the agent's own scratch script: 16
  such commands in the corpus, so it stays readable); `.env~`, `.env.swp` and `.env.bak` were already read through their original. `git ls-files` shows
  no tracked file with any of these names.
- *Assignments* (`variable-rebinding.ts`, `harness-variable-rebinding-wave8.test.ts`; T8, ADV6-13). A variable the command line binds more than once, or by
  `read`, `printf -v`, `for`, `select`, `while read`, `eval`, `let`, `(( ))`, `+=`, `mapfile`, `readarray`, `getopts` or `${S:=…}`, is dropped from the literal map: an
  operand that uses it cannot be placed, and a sweep over it asks. `S=apps/portal; cp -r $S /tmp/o` still asks; `D=src; ls $D` still allows. Read as text over the
  whole command, so a variable rebound to something harmless also asks (an over-reading, never a miss).
- *The gate, the tests and the structure* (`hook-pin.ts`, `harness-hook-pin.test.ts`, `content-scan.ts`; T9). `arch:compliance` pins the WHOLE hook object of
  Claude's three pinned hooks: a group holds `matcher` and `hooks`, exactly one hook, and that hook exactly `type` (`"command"`), `command` and `timeout`
  (the ledger also `async`); `if`, `shell`, `once`, `asyncRewake`, another `type` and a stray hook all fail it (whether this Claude Code honours `if`, `shell` or
  `once` was not verified; the gate refuses them either way). The surviving hand mutants are pinned (the `.dist` template exclusion, `.live.test.tsx`
  suites, gawk `--include`/`-iinplace`, `dlx`, the `-c` value), and a corrupted `guard-worker.ts`, `guard-judge.ts` or `patterns.ts` is shown to be the
  guard's own JSON deny with exit 2 through the real pinned command. The wall-clock bounds of 100 to 1,500 ms became 3 to 5 s with a comment that they guard
  a super-linear blow-up. `judge` (150 lines) and `mainWrites` (59) are under 50 lines by extraction; the pure secret-path and content rules (about 300
  lines) moved to `content-scan.ts` and `patterns.ts` re-exports every name, so it is 2,963 lines (3,043 at the wave-7 tip; the ceiling is still 800).
  `spendIfShellWouldExpand` (always true, with an unused parameter) is gone. **CR6-11:** `ISSUED_SSN` in `scripts/__tests__/_fixtures.ts` is deliberately
  an issued-looking value (area 524) built from parts; `.claude/rules/phi-and-secrets.md` says every SSN is synthetic or has area 000, 666 or 9xx. The exception
  is stated in the fixture's comment and in this paragraph; the rule file (and its `.agents` twin, mirrored by `arch:compliance`) should name it too, which needs the
  owner.
- **Claude's positive acknowledgement was NOT adopted (T0b declined, ADV6-4).** The wave-7 tail refuses a NON-ZERO exit; an entry module that is empty, only a
  comment, or `export {};`, a no-op `runGuard` and a `bun` script doing `exit 0` earlier on PATH make the pinned Claude command exit 0 with nothing on stdout,
  which Claude Code reads as allow (shown on a copy, `harness-claude-fail-closed.test.ts`, "KNOWN RESIDUAL"; Codex is the same). The proposed fix (the guard
  prints `{}` for an allow and the command refuses an empty stdout) was declined because whether Claude Code accepts `{}` as "no decision" on EVERY tool call
  could not be verified here, a wrong guess is a lockout of every developer's every Claude tool call, the file that would carry the fix is the file whose
  editing is gated, and it reaches 85 allow assertions and the real-hook helper of the suite. The lines behind the residual: every write that could empty
  or replace a guard module is a protected path (an ask; Codex denies), `bun` shadows are now protected by name, CODEOWNERS and `arch:compliance` review the
  harness, and the Stop gate runs. It needs the owner's decision and a check of Claude Code's behaviour with a real session.
- **Corpus cost, measured on the final tree.** 129,020 distinct Bash commands recorded in this machine's Claude sessions, classified in process by the
  wave-7 tip and by this tree (nothing executed; the tool is a scratch script, not committed): 60 allow to ask (0.047%), 1 ask to deny, no
  throws; the slowest single classification was 248 ms (227 ms for the wave-7 tip in the same run; a real hook call is 40 to 90 ms). The 60: 38
  `bunx biome check --write .` at the repo root (an in-place write the guard cannot see into: `lint:fix` is `bun run lint:fix`, a package script, and is
  not asked), 4 `tar cf X -T list`, 4 `$B check --write .` (a variable used as the program name), 3 `echo … >> env` and 2 `rm -rf ~/Library/Caches/bun` and 2
  `perl -e 'alarm; exec @ARGV' bunx …` and 2 `mkdir sim/bin/bun` (a PATH-shadow name), 2 `bun --bun run vitest run <live suite>` (the live-suite ask
  now reaches a runner behind `bun --bun run`), 1 `$G` (a variable program handed `scripts`); the 1 ask to deny is an agent's own scratch `env.sh` written
  by a heredoc beside a `cd $SP`. Removed asks: the real corpus holds no `cloc`, `tokei`, `scc`, `cspell`, `shfmt -d`, `ruff check`, `eza`, `lsof`, `open`,
  `make -C`, `semgrep` or `trivy` over a harness path (v7 asked about each when the stack was probed; the tip allows all 14, `harness-backstop-wave8.test.ts`),
  and `declare -x FOO=bar` and `set -x`, denied in v6 and v7, allow.
- **Residuals, stated plainly.** Computed names (`$VAR/x`, `$(printf …)`, an encoded name) stay unseen. An alias or a function wrapper (`alias c='cp -r'` then
  `c apps/portal /tmp/o`; `g() { git "$@"; }`) hides its command by name; a function body is judged, its call is not tied to it. A glob target is
  read only when it has a slash (or a write flag). A symlinked directory is a gap in the listings and a symlink in a sweep operand is not followed.
  `xargs`-fed names (a pipe) and `-T`-listed names are unreadable (`xargs -a FILE` is read: wave 9). A heredoc handed to an unknown program is not read (a here-string is). A package-runner or wrapper this
  table does not name (wave 9 added the version managers and loaders; wave 10 added `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `hatch`, `pipenv`, `conda`, `micromamba`, `devbox`, `flox`, `nix`, `nix-shell` and the wrappers `nsenter`, `sshpass`, `firejail`, `systemd-run`, `fakeroot`, `valgrind`, `gdb --args`, `ltrace`, `dtruss`, `perf`, `numactl`, `cpulimit`, `torify`, `tsocks`, `toybox`, `setpriv`; `bwrap`, `rlwrap`, `hyperfine` and the recipes of `make`, `just` and `task` remain) hides its command by name. The guard runs under whatever `bun` the PATH
  resolves (the PATH-shadow residual above). The positive-acknowledgement residual above (Codex too: it has no acknowledgement at all). The write flags and
  abbreviations of tools not installed here (`cloc`, `tokei`, `scc`, `cspell`, `depcruise`, `shfmt`, `ruff`, `semgrep`, `trivy`, `code`, `markdownlint`,
  `jest`, `mocha`, `deno`, `tree`, `7z`, `objcopy`, `ugrep`, `rga`, `pt`, `sift`, `ucg`, `trufflehog`, GNU `sed`, `litecli`, `usql`, `duckdb`, `sqlcmd`,
  `sqlplus`, `mongosh`, `clickhouse-client`, `trino`) were read from documentation; nothing was run on Linux or with bun 1.3.5.

**Wave 9.** Residuals the orchestrator found while verifying wave 8, in priority order. Each item has a test file
`scripts/__tests__/harness-*-wave9.test.ts` and its own commit; the data-driven tests walk every entry of the new tables.
- *A regression of wave 8, fixed first: a symlink is decided by its target* (`symlink-target.ts`, `live-suite-files.ts`, `live-env-files.ts`,
  `harness-listing-symlinks-wave9.test.ts`; W9-0, CR6-6). Wave 8 treated every symlink in the live-suite and live-env listings as "listing
  incomplete", and the real checkout holds `services/docling-worker/.venv/bin/python`, `python3` and `python3.12` (links to FILES in a Python virtualenv),
  so on the real checkout every `bunx vitest run <any filter>`, `bunx vitest run scripts/__tests__/harness-hooks.test.ts` included, asked "Live suites DROP ROLE
  chartwarden_app": 9,241 of 140,767 real commands (6.56%) against the 60 (0.047%) that wave 8's own figure reported, because that figure was measured on a
  worktree that has no virtualenv. **Measure false positives against the real checkout's listing, not only a worktree's.** Now `statSync` (it follows the link)
  says what a link points at: a link to a FILE is judged by its name like a file (a `.live.test.ts` link is a suite), a dangling link holds nothing, a link to a
  directory that is inside a walked root (`.venv/lib64 -> lib` on Linux) holds nothing new (it is walked on its own), and only a link to a directory elsewhere, or
  one that cannot be resolved (a link to itself: ELOOP), is a gap. The env listing reads the direct children of `apps`, `services`, `packages` and `deploy` the
  same way (a file link is a file, a dangling link is gone, a directory link is a gap). On the real checkout the suite listing is now complete (530 suites, 3
  symlinks, 1,366 directories) where wave 8's was not. **Residual:** a filter that matches only the NAME of a symlinked directory is not seen.
- *One reader of the database target for every client* (`db-target.ts`, `db-target-clients.ts`, `harness-db-targets-wave9.test.ts`; W9-1; the rule of
  `.claude/rules/phi-and-secrets.md`: no production access from a session). The rule behind "Connecting to database host … is access to PHI" read `-h`,
  `--host=`, a postgres URL WITH userinfo and `PGHOST=` for four programs. A URL without userinfo (`psql postgres://HOST/db`), a libpq connection string
  (`psql "host=HOST dbname=db"`, `hostaddr=`), `-d` and `--dbname` URIs, `pg_dump postgres://HOST/db` and every other client were allowed. One reader now serves
  `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`, `pg_basebackup`, `pg_receivewal`, `pg_recvlogical`, `createdb`, `dropdb`, `pg_isready`, `vacuumdb`,
  `reindexdb`, `pgbench`, `pgcli`, `mysql`, `mariadb` and the `mysqldump`/`mysqladmin`/`mysqlshow`/`mysqlcheck`/`mysqlimport` family (and their `mariadb-*` names),
  `mycli`, `mysqlsh`, `redis-cli`, `valkey-cli`, `mongosh`, `mongo`, `mongodump`, `mongorestore`, `mongoexport`, `mongoimport`, `mongostat`, `mongotop`,
  `clickhouse-client`, `clickhouse`, `cockroach`, `usql`, `sqlcmd`, `trino` and `cqlsh`: an option table per client (which option letters take a value, which
  name the host, which carry a connection string, which name an alias or a file), a URI reader (no userinfo needed, a port, IPv6 literals, percent-encoding,
  `a,b` host lists, `?host=` and `?hostaddr=` parameters, `mongodb+srv://`), a libpq connection-string reader that handles quoting and a `dbname=` that is itself
  a URI, and the EXISTING local-host predicate of `content-scan.ts`, unchanged (loopback, `host.docker.internal`, a compose service, a socket directory;
  `prod`, `db.internal` and `10.0.0.5` are not local). A host that is not local is **denied**, in any option spelling (`-h H`, `-hH`, `--host=H`, `--host H`, `--ho=H`,
  `-AtXqh H`), inline (`PGHOST=H psql`, `env PGHOST=H psql`, `MYSQL_HOST`, `COCKROACH_URL`, `COCKROACH_HOST`, `CLICKHOUSE_HOST`) and set earlier on the same
  command line (`export PGHOST=H; psql`, `PGHOST=H; psql`: those were allowed before), under a runner or a wrapper (`bunx psql …`, `sudo -u postgres pg_dump …`).
  A target the reader cannot read (an open quote, an open bracket) is **denied**, not allowed. A service, a password file, a login path or a DSN alias (`psql
  service=NAME`, `PGSERVICE=`, `PGSERVICEFILE=`, `PGPASSFILE=`, `mysql --login-path=`, `--defaults-file=`, `pgcli -D NAME`, `mycli --dsn NAME`) names the host
  in a file the guard cannot read: **asks**. `$DATABASE_URL` asks for every client in the table (it was four). A SQL string, a file name and a `-v NAME=value`
  are values of options the table names, never read as a host: `psql -c "select … host = 'x.example.org'"` allows. Everyday `psql -h localhost`, `psql
  postgres://u@127.0.0.1:5433/db`, `psql -p 5433 -U u db`, `redis-cli get key:123`, `docker exec … psql` and `docker compose exec postgres psql` allow.
  **Residuals:** an option the table does not list is read as a flag (its value, if it is a host, is not seen); a bare single-label `mongosh NAME` is read as a
  database name, not a host; `clickhouse`, `usql` and `sqlcmd` take their DSN forms as the table lists them; a client behind an alias or `docker exec` is not
  read (as before); a variable that holds the host (`-h $HOST`) is still refused as an unplaceable host, never resolved.
- *The files a wrapper's own options name, and every long option's value* (`wrapper-options.ts`, `wrappers.ts`, `harness-wrapper-options-wave9.test.ts`; W9-2).
  A wrapper is stripped before its command is judged, so two things in its options were never looked at. First, the FILE an option names: `xargs -a FILE`
  (also `-aFILE`, `--arg-file`, `--arg-file=FILE`, `--arg`) and `parallel -a`, `--arg-file`, `--argfile`, `--sshloginfile`, `--slf`, `proxychains4 -f`, `doas -C` READ
  it and are judged like an input redirect (a live env file is **denied**, as for `cat`; a file named by a command substitution asks when the inner program prints
  files); `flock FILE cmd`, `parallel --joblog|--results|--tmpdir`, `strace -o|--output` and `time -o|--output` WRITE or create one and are judged like a redirect target
  (a protected path **asks**); `sudo -e FILE` (`--edit`) edits the files that follow, so sudo stays the program and they are judged as operands. Second, a long
  option with a SEPARATE value made its value the program: `nice --adjustment 5 git commit …` ran `5` as far as the rules knew. The long value options of `sudo`,
  `env`, `time`, `nice`, `ionice`, `xargs`, `stdbuf`, `strace`, `taskset`, `flock`, `parallel`, `chroot` and `unshare` are listed (wave 9 said "a prefix of two characters or more"; GNU getopt takes ANY unambiguous prefix, one character included, and since wave 10 every wrapper is read that way), and the short ones were audited (`xargs -J -R -S`, `env -a`, `ionice -P -u` added; `parallel -X`, `strace -T -D -k` were flags read as values and
  are fixed). New wrappers: `chroot`, `unshare`, `chronic`, `proxychains`, `proxychains4`, `ssh-agent`; `entr` and `watch` hand a command line to the judge; the
  Homebrew `g`-prefixed GNU tools (`gxargs`, `gnice`, `gstdbuf`, `genv`, `gnohup`, `gtime`) are the wrapper they prefix. A data-driven test walks every entry of the
  tables in every spelling. **Residuals:** a file named by `$(…)` is asked only when the inner program prints files (`xargs -a "$(ls)" echo` is not); a wrapper this
  table does not name (after wave 10: `bwrap`, `rlwrap`, `hyperfine`) still hides its command by name; the
  `sudo -R` (chroot) and `env -P` (alternative PATH) values are not followed.
- *Runners and environment loaders* (`runners.ts`, `harness-runners-wave9.test.ts`; W9-3). `corepack`, `volta run`, `mise exec|x` (tool specs and the `--`
  separator, `-c STR`), `asdf exec`, `direnv exec DIR`, `cross-env VAR=x cmd` (and `cross-env-shell "string"`), `dotenv`, `dotenvx run`, `env-cmd`, `doppler run`
  (`--command STR`), `op run`, `lerna exec` and `nx exec` start a command by name; they are peeled by the same code as `bunx` and every rule judges the inner
  command (`dotenv -- git commit` with the skip-hooks flag is denied, `volta run vitest run <live suite>` asks). `npm run-script` is a package script like `npm run` (no
  program); `turbo` has no `exec`; `tsx`/`ts-node`/`bun`/`deno run FILE` run a file, which is judged by name like any operand. **A runner's own option that names a file is no longer
  lost when the runner is peeled** (`peelRunnerWithFiles`): wave 8's peel dropped it, so `bun --env-file <live env file> run echo hi`, `bunx --package F echo` and `npx
  --userconfig F echo` were ALLOWED by wave 8 (wave 7 denied them); each is a deny again. **The env-file loaders already deny a live env file named in their flags**
  (`node --env-file=F`, `bun --env-file F`, `deno run --env-file=F`, `docker run --env-file F`, `uv run --env-file F`, `dotenv -e F`, `dotenvx run -f F`, `env-cmd -f
  F`, `op run --env-file F`, `direnv exec F`: the secret-name rule reads any word of the command line); the wave-9 brief assumed they were allowed and proposed an ask,
  which would have loosened them, so they stay denied. A template (`.env.example`, `.sample`, `.template`, `.dist`) and `docker compose --env-file F up` (the
  documented lifecycle exemption) stay allowed. A valued option's value never starts with a dash (`dotenv -c -e F -- cmd` keeps `-e F`). **Residuals:** `direnv exec .`
  loads the `.envrc` of the directory it names and is not asked; an alias or a function hides its command (as before); `op --account X run` was not peeled in wave 9; since wave 10 every manager reads the options before its subcommand with its own grammar, and an unknown one is a flag (lax grammars) or asks (bun, uv).
- *One reader of a long option's name* (`option-values.ts`, `harness-option-values-wave9.test.ts`; W9-4, CR6-8 follow-up). `git-grep-sweep.ts`, `git-exec-strings.ts`
  and `harness-switch.ts` read the text of a long option and its abbreviation through `longName` and `spellsLong`, which `optionValues` uses too. No answer changed
  (every harness test passes unchanged; no transition on 35,932 git-related real commands). **Not done, and miscounted in wave 9 (R7-CR-16):** the `isOption` definitions are FOUR after wave 10 (`client-reading.ts`, `protected-operands.ts`, `sibling-sweeps.ts`, `writers-more.ts`; `runners.ts` had a fifth, gone with its rewrite) plus the `operands`/`operandsOf` readers of `writers.ts`, `writers-more.ts` and `sibling-sweeps.ts`; they differ on a lone `-` and on an empty argument and one function would change an answer. The other prefix readers (`tar-grammar.ts`, `tree-sweep.ts`, `db-target.ts`, `option-commands.ts`) are not shared with `option-values.ts`; the wrapper and runner tables use `option-grammar.ts` since wave 10. `patterns.ts` got wiring only: 2,960 lines (wave 8: 2,963); the new logic is in `symlink-target.ts`, `db-target.ts` (and its client table `db-target-clients.ts`, 597 lines of data), `wrapper-options.ts` and `runners.ts`.
- **Corpus cost, measured on the final tree against the REAL checkout.** 140,767 distinct Bash commands recorded in this machine's Claude sessions (the transcript
  cache was rebuilt recursively, subagent sessions included), classified in process
  with `/tmp/cw-v8` (the wave-8 tip) and with this tree, the live listings read from the real checkout (read only; nothing executed; the differ is a scratch script,
  not committed). Wave 9 against wave 8: 9,239 ask to allow (6.563%), every one in the
  "Live suites DROP ROLE chartwarden_app" bucket (the first word of those compound commands: `cd` 6,761, `bunx` 819, `python3` 518, `sed` 158): the regression, undone, and
  2 commands of that bucket remain, the two where a substring filter really names a live suite; 0 allow to ask, 0 allow to deny, 0 ask to deny; no throws; the slowest single
  classification 107 ms (126 ms for the wave-8 tip). So wave 9 adds no classifier-level ask or deny on any real command (its budget was 0.02%, about 25 commands). Each
  task was also measured on the commands it touches before the final run: 5,088 database-client commands (W9-1), 6,614 wrapper commands (W9-2), 36,857 runner and
  environment-loader commands, `--env-file` ones included (W9-3: 0 transitions per loader), 35,932 git-related commands (W9-4, against the previous commit): no transition
  other than the regression's. Wave 8's own cost is unchanged (the orchestrator's real-checkout figures for wave 7 to wave 8: 9,241 asks in the live-suite bucket, now gone;
  44 "not a program the guard knows to be read-only, and its command line names a protected path", 13 "is the bun the agent hooks run on", 4 tar archives of the repo root or an
  env directory, 1 ask to deny: about 0.043%, accepted in wave 8). Against wave 7 the live-suite substring rule adds 2 asks on the vitest-related commands (24,368 of them). The pinned
  hook commands, replayed on this tree (Claude and Codex; the corrupted-copy fail-closed checks), answer as on the wave-8 tip, 44 to 98 ms per call.

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
anything but 2 lets the tool call run in Claude Code; Codex's pinned command wraps the guard in `perl alarm 8
… || exit 2`, and Claude's has no perl wrapper (a missing `perl` would lock out every Claude call; its plain-shell
`|| exit 2` tail, above, covers a guard that cannot start or crashes, but not a hang the tail never sees). So the
guard enforces its own deadline. `pre-tool-guard.ts` is a small entry thread
(`hard-deadline.ts`): it arms a 6.5 s timer before it reads stdin, runs the judgement (`guard-judge.ts`) in a Bun
worker (`guard-worker.ts`), and when the timer fires, the worker dies or errors without answering, or stdin never
ends, it prints the standard deny JSON, a stderr line and EXITS 2 (a block in both agents), whatever the worker is
stuck in. The worker makes `process.exit` a throw: on bun 1.3.5 (what CI pins) a `process.exit(0)` called in a
worker ended the WHOLE process silently with status 0, which both agents read as an allow. Normal answers are unchanged (JSON for a deny or an ask, nothing for an allow, exit 0); the extra
latency was about 5 ms per call when the deadline was added (median 21 to 26 ms over 35 runs on macOS, bun 1.3.5; measured once, not
re-measured since, and machine-dependent). A worker needs neither `--config` nor `--tsconfig-override` of its own: it is
started by the already-hardened entry, and the hostile-config tests run through it. Test seams, never set in
production and forbidden in the shared `env`: `CW_HARNESS_TEST_FAULT` (`hang`, `exit`, `process-exit`, `throw`) and
`CW_HARNESS_DEADLINE_MS_FOR_TESTS` (it can only shorten the deadline); `harness-hard-deadline.test.ts` forces each
through the entry point and through both real pinned commands. A `bun` that is missing, a module that cannot be
parsed, and a process killed for memory before it can answer exit non-zero, and both pinned commands now turn that
into exit 2 (Claude's through its tail, above); a `bun` so slow to start that the hook's own 10 s timeout kills the
whole `sh` first is not covered (the deadline starts only once the entry thread runs): the Stop gate, the pre-commit
scan and CI are the lines behind that. A `Read`/`Write`/`Edit` path of 500 KB made of `a/../` used to go quadratic in the real-path
walk (4 to 9 s); the written path is judged first, the walk is iterative, and a path longer than PATH_MAX is
collapsed textually and never resolved link by link.

**Fails closed.** Empty or unparseable hook input, an internal error, and a write too large to scan
(over 8 MB) all answer `deny`. A human who needs the session back sets `CW_HARNESS_FAIL_OPEN=1` for it (that makes
the guard answer allow on exit 0, which the fail-closed tail never touches; it does not help when the guard cannot
start at all: repair it outside Claude Code).
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
- A guard process that never starts (for example `bun` missing) used to be non-blocking in Claude Code; the
  command's `|| exit 2` tail now refuses the call instead (wave 7, T0), at the price of a lockout until a human
  repairs the guard outside Claude Code (see "Claude's guard command fails closed"). Not covered: a hook killed by
  Claude Code's own 10 s timeout before it can exit (the whole `sh` dies with it), and a corrupted
  `.claude/settings.json`. The Stop gate, the pre-commit scan and CI are the lines behind those.
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
- Every Claude tool call is refused with "the guard failed to run, so the call is refused": the guard cannot start
  (a corrupted `scripts/harness/pre-tool-guard.ts` or `hard-deadline.ts`, no `bun` on the hook's PATH). Claude Code can no longer
  repair it; in a terminal outside Claude Code run `git restore scripts/harness`, check `bun --version` and
  `bun --config=/dev/null scripts/harness/pre-tool-guard.ts < /dev/null` (a deny JSON is a healthy guard), and start
  Claude Code again.
- A new synthetic identifier: edit `compliance/synthetic-identifiers.json` and approve the prompt.

## Finding IDs cited in this document

The review records themselves are not committed to this repository; most of these IDs also appear in the message of the commit that
fixed them (`git log --grep '<ID>'`), and in the tests named in the paragraph that cites them. One line each.

| ID | What it was |
|---|---|
| ADV-C3 | The Codex hook command found the checkout with `git rev-parse --show-toplevel`; `git config core.worktree` re-pointed it at another script. Now a walk-up that reads no git configuration. |
| ADV-H2 | Claude's Edit/Write/MultiEdit/NotebookEdit of a protected path the `permissions.ask` rules did not name passed without a word. Now one protected-path definition asks. |
| ADV-L2 | MCP tool input was judged by whole strings; now by the words a tool could open as a path (`mcp-tokens.ts`). |
| ADV-L5 | `apply_patch` name obfuscation (`'apply'_patch`, `$(echo apply)_patch`) is held to the heredoc rule; a name assembled at run time stays with the sandbox. |
| ADV-1, ADV-7 | `GIT_TRACE=<guard file>` (and its kin, set by prefix, `export`, `env`, `+=`) made git append a line to the guard and corrupt it (exit 1 reads as allow). Now a write target. |
| ADV-2 | Variables that load code into bun or perl, or pick a nested agent's hook binary, ask. |
| ADV-3 | `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `PERL5DB` silenced the Codex wrapper before its `-e` body ran. Now `env -u` for each. |
| ADV-4, ADV-5 | `diff -r`, `git diff --no-index`, `git grep --no-index` printed live env files; now ask like `grep -r`. |
| ADV-6 | `--output=FILE` and `credential-store --file` of every git command that takes them are write targets. |
| ADV-8 | The live-suite ask reaches a runner through `node`, `bun`, `npm test` and a glob. |
| CR-C1, CR-C2 | A brace word over a path's length, or past the alternative cap, was not read; it spends the budget and is still read. |
| CR-C3 | `find`'s name narrowing used a hand-kept list of protected names; now read from the tree (`protected-names.ts`). |
| CR-L1 | The classifier's module-level budget state is correct only because the worker judges one hook per process. |
| CR-M5 | The Stop gate's compliance map, `PROTECTED_SAMPLES` and `PROTECTED_FRAGMENT` agree with the one protected definition. |
| CR-L3, CR-L4, CR-L5, CR-L6 | Round-4 low findings: the one Claude Code env variable on the allow-list, backup-name suffixes, doc corrections, exports nothing used. |
| ADV-C1, ADV-C2, ADV-M1, CR-H2, CR-M1 | 2026-11-10 findings on the per-command budget (in characters, not only items), `git -C` chains, and scripts matched under every spelling. |
| T6 | Protected and secret paths are matched under every spelling the file system folds into one name (NFKC, case, sharp s). |
| T0 | Wave 7: Claude's guard command ends in an exit-2 tail (this document, "Claude's guard command fails closed"). |
| ADV5-1 | `sqlite3 .shell`, `psql \!`, `mysql system`, `pgcli \!` ran an operating-system command under Claude; now ask. |
| ADV5-2 | About twenty ordinary commands wrote to a path the agent names with no rule (`bun build --outfile`, `uniq IN OUT`, …); modelled, plus a generic backstop. |
| ADV5-3 | Siblings of the tree sweeps (`ack`, `ag -u`, `fd -x`, `cpio -p`, `pax -rw`); judged as the sweeps they are siblings of. |
| ADV6-1, CR6-2, CR6-8 | Package runners (`bunx`, `npx`, `pnpx`, `bun x`, `pnpm|yarn|npm exec|dlx`, `bun|yarn run X`) hid the program they start from every rule; two runner readers disagreed. Now one reader, applied where the program is found (`runners.ts`). |
| ADV6-2, CR6-1 | The backstop's hand lists exempted programs that write (`plutil -replace`, `awk '… > ARGV[1]'`, `python -m json.tool IN OUT`, `7z a`, `tree -o`, vim/ed commands, `docker build -o`, `go -coverprofile`, `time -o`, …). A reader has write flags; a modelled program's positional operands are its model's. |
| ADV6-3 | A copy of `true` named `bun` in a user-writable PATH directory made both hooks silent no-ops. A program the hooks call is protected by name in any directory (residual: the guard runs under whatever `bun` PATH resolves). |
| ADV6-4 | An empty, comment-only or `export {};` guard module, a no-op `runGuard` or a `bun` doing `exit 0` makes the pinned command exit 0 with nothing (allow). **T0b declined, not fixed**: the residual is pinned by tests and stated above. |
| ADV6-5 | A secret read through `sqlite3 … readfile()`, `duckdb read_csv`, an unlisted interpreter's inline code. SQL file functions are read in every client; names inside code-like words are read for unknown programs. |
| ADV6-6, CR6-3 | DB-client escapes under real shell quoting (`"\\o X"`), the abbreviations `.sh`, `.sy`, `.cl`, `.cd` then `.output`, `.parameter` then `writefile(@f)`, and the clients the table did not name. |
| ADV6-7 | `ssh -o 'ProxyCommand cmd'`, `scp|sftp -o ProxyCommand`, `-S`, `zip -TT`, `rg --pre`, `man -P` ran a local command. |
| ADV6-8, CR6-12 | New shapes of printing the environment (`Bun.env`, `typeset`, `jq env`, perl, awk, `ps eww`, `launchctl`); and `declare -x NAME=value`, an assignment, was denied as a dump. |
| ADV6-9 | Secret scanners and unlisted recursive readers (`ugrep -r`, `gitleaks --no-git`, `trufflehog`, `rga`, `scp -r`, `ag -a`) read env-holding directories. |
| ADV6-10 | tar's directory-option grammar (`-cCf`, `-Capps`, `--directory=`, `--dir=`) and case spellings (`APPS/PORTAL`) slipped past the tree-sweep rule. |
| ADV6-11 | The compliance gate stayed green after a hook key other than command, timeout or async changed (`if`, `shell`, `once`, `type`, a stray hook). The whole hook object is pinned. |
| ADV6-12 | Persistence outside the protected set (global git config, `launchctl setenv|load`, launch agents, `~/.claude/{rules,plugins,hooks,…}`). |
| ADV6-13 | A variable rebound by `read`, `printf -v`, `for`, `eval`, `+=`, `source` stayed its first literal in a sweep operand. |
| ADV6-14 | Secret-name gaps: `.envrc`, `env.sh`, `secrets.json`, gcloud's ADC, `.my.cnf`. |
| CR6-4 | The backstop did not place its operands as every other rule does (braces, variables, ancestors, wildcards). |
| CR6-5 | `fd -Hx`, `-HIx`, `-xcat`, `--exec=cat` were not judged as `find -exec`. |
| CR6-6 | The live-suite and live-env listings truncated silently instead of answering "may match". Wave 8's fix was itself a regression (every symlink, a virtualenv's file links included, made every vitest filter ask on the real checkout): see W9-0. |
| CR6-7 | Five surviving hand mutants and no test that every exempted program is really modelled. |
| CR6-9 | `spendIfShellWouldExpand` could never be false. |
| CR6-10 | `judge` (150 lines) and `mainWrites` (58) over 50 lines. |
| CR6-11 | The `ISSUED_SSN` exception was recorded only in a code comment: now also in the fixture comment and Wave 8 above; the rule file `.claude/rules/phi-and-secrets.md` (and its `.agents` twin) should name it, which needs the owner. |
| W9-0 | Wave 8's listings called every symlink a gap; the real checkout's `.venv/bin/python*` file links made 9,241 real commands (6.6%) ask. A symlink is decided by its target. |
| W9-1 | A non-local database host was allowed in a URL without userinfo, a libpq connection string, `-d`/`--dbname` URIs, `pg_dump` URIs, `export PGHOST=H; psql` and every client but four. One target reader for 46 programs. |
| W9-2 | `xargs -a <live env file> echo` was allowed; a wrapper's file options and long options with a separate value were dropped unjudged (`nice --adjustment 5 cmd` hid `cmd`). Tables per wrapper. |
| W9-3 | `corepack`, `volta run`, `mise exec`, `asdf exec`, `direnv exec`, `cross-env`, `dotenv`, `dotenvx`, `env-cmd`, `doppler`, `op run`, `lerna exec`, `nx exec` hid their command; and wave 8's runner peel dropped the runner's own file options (`bun --env-file F run echo` was allowed). |
| W9-4 | One long-option abbreviation reader instead of three inline copies; four `isOption` definitions and three operand readers stay separate (they differ on a lone `-` and an empty argument; wave 10 corrected the count). |
| CR5-1 to CR5-11 | The round-5 code review: brace budget and whitespace (1), nested agent variables (2), one assignment grammar (3), wildcard pathspecs (4), per-root names (5), five sweep readings (6), the live env list (7), surviving mutants (8), doc claims (9), structure (10), vitest substring filters (11). |

## Wave 10 part A

Round 7 (two cold reviews of waves 8 and 9) found, and the orchestrator re-ran, the shell-structure, wrapper and runner findings below; part B of the same wave
holds the database, secret and sweep findings. Each item has a test file under `scripts/__tests__/harness-*-wave10.test.ts`. The orchestrator's spot-check
script (`verify-r7.ts`) went from 64 of 77 rows not as expected on the wave-9 tip to 28 on this part's tip: 27 belong to part B (database targets, secrets, variables) and one is the documented residual `make -C /tmp psql`. The design rule of
this part, from the brief: **wrapping a command must never make the answer weaker** (the wave-9 regressions were exactly that), and **unknown is not allow**.

- *A nested command string is read once, by the rules of the quote it came from* (`patterns.ts` `words(seg, values)` and `Parsed.handed`,
  `harness-nested-strings-wave10.test.ts`; R7-CR-1, pre-existing since wave 3). `bash -c "cat \".env\""` handed the inner shell `cat \".env\"`, a path with
  quote characters that matches no secret name, so an escaped quote hid the inner command from every rule (a secret read, a protected write, a force
  push, a database host). `words()` has a `values` mode that reads a word the way the shell hands it to the program (outside quotes `\x` is `x`; inside
  double quotes `\"`, `\\`, `\$` and a backtick lose their backslash and a backslash-newline is gone; single quotes keep every backslash), `parseSegment`
  keeps the program and arguments read that way (`Parsed.handed`, computed only for a segment that holds a backslash), and `nestedCommandVerdicts`
  judges every nested string from them: `bash|sh|zsh|dash -c` (any flag cluster ending in `c`), `eval`, `find -exec|-ok`, `watch`, `entr`, `su -c`,
  `runuser -c`, `flock -c`, `script -c`, an `ssh` remote command, `rsync -e`, `tar --to-command|-I`, a runner's `-c` (`npx`, `npm exec`), `docker exec` and `docker
  run … sh -c`, and a wrapper in front of any of them. One test per producer (31) against the four guarded commands, and 1 to 14 levels of `bash -c "…"` and of
  `bash -c '…'` with `'\''` quoting: every level is decoded (the wave-9 tip allowed 2 to 14 double-quote levels and 2 to 8 single-quote levels), and a
  nesting past the cap of 8, or past the 64 KB size cap, ASKS or is refused, never allowed. Mutation: using `parsed` instead of `parsed.handed` fails 109 of
  143 tests; keeping every backslash fails 109; dropping `\$` from the double-quote set fails 1. One mutant survives by design: the backslash-newline
  branch (the inner `judge` reads a continuation itself, so the branch is equivalent).
- *One option reader for every wrapper* (`option-grammar.ts`, `wrapper-specs.ts`, `wrapper-peel.ts`, `program-name.ts`, `harness-wrapper-grammar-wave10.test.ts`;
  R7-ADV-4, R7-CR-2, R7-ADV-5, R7-ADV-6, R7-CR-12, R7-CR-15). Wave 9 read a short cluster as one word (`sudo -upostgres pg_dump -h <host>` read the `e` of the
  value as `sudo -e`; `sudo -nu postgres CMD` ate the user's name as the command), read a long FLAG that prefixes a long VALUE option as that option (`sudo --login
  CMD`, a prefix of `--login-class`, ate `CMD`), had `timeout` and `taskset` readers of their own that took no abbreviation (`timeout --sig KILL 5 CMD`,
  `taskset --cpu 0 CMD`), and looked a wrapper up by its whole word (`/usr/bin/nice psql -h <host>`, `/usr/bin/env git push origin main`, `./nohup`,
  `~/bin/nice` were never peeled: 4 real commands use this shape, 2 were allowed). Now each wrapper has the grammar of its own CLI (short flags, short value
  options, long flags, long value options, optional values, operands before the command, the option that stands for a directory or a command string) and ONE
  reader takes it the way GNU getopt does: a cluster is read letter by letter and ends at the first value letter; a long option is an exact flag or value
  name FIRST, then any unambiguous prefix over flags and values together, one character down (the wave-9 doc said "two characters or more"); `--name=value`
  is one word whatever the name; `--` ends the options. The lookup uses `programName` (backslashes removed, directory dropped), the one helper for the wrapper
  and runner tables (shells and the rest of the classifier already took the last path component). `timeout` is a table entry like the others (and `gtimeout`,
  `gchroot`). A word the table cannot place (an unknown letter or long option, an ambiguous prefix) is **asked about** (`Parsed.unplaced`): rule 3 of the
  brief offered "judge every plausible start" or "ask", and ask was chosen because the corpus cost of it is 0 real commands (the corpus diff shows no unplaced-option bucket). A grammar that cannot be complete is
  `lax` (an unknown option is a flag, the older behaviour): `strace`, `unbuffer`, `xcrun`, `lima`, `chronic`, `proxychains`, `ssh-agent`, the residual wrappers
  below. `flock` and `runuser` stay the program only for a `-c` among their leading options or directly after the file or user operand (`flock /tmp/l psql
  -h <host> -c 'select 1'` is now peeled); `taskset -c LIST` supplies the mask operand. The MONOTONICITY property test iterates the real tables:
  for every wrapper it generates every declared flag, every value option with a value (joined `-xV`, `--opt=V`, separate), every unambiguous
  abbreviation of every long option, clusters and `--`, puts each of five guarded commands behind them (a push, the hook-bypass flag, a non-local
  database host, a write to a protected file, a live env file name) and asserts the wrapped answer is never weaker than the command alone; a second test
  asserts that no declared flag that prefixes a value option is read as it. Mutation: resolving a prefix before the exact name fails 9; dropping the
  value-letter rule fails 37; accepting an ambiguous prefix fails 2; matching the wrapper by its whole word fails 63; `taskset` without its
  `cpu-list` supplier fails 3.
- *A command run in a fresh container* (`container-run.ts`, `harness-container-run-wave10.test.ts`; R7-ADV-7, R7-CR-15). `containerRun` judged the command
  only when a writable bind mount let it map paths back, so `docker run --rm postgres:16 psql -h <host>`, `docker compose run --rm migrate psql -h <host>`,
  `podman|nerdctl run …`, `docker run --entrypoint psql IMG -h <host>` and `docker run -e PGHOST=<host> IMG psql` passed every rule while `docker exec db psql -h <host>`
  was denied (the wave-9 residual said "docker exec … is not read": the code denies it, both are stated here). Now the command behind the image or the compose
  service is judged with every rule for `docker|podman|nerdctl [container] run|create`, `docker|podman compose run` and `docker-compose|podman-compose run`: the
  options are read from each tool's own `--help` (docker, compose and podman are installed here; exact names, nerdctl takes the union), the image is the first
  word that is no option or value, `--entrypoint X` makes X the program, `-e NAME=VALUE` is an assignment in front of the command (so a database variable set
  for the container is read like one set for the shell), and an unknown option asks. The mount-mapping reader stays as it was; both run. The command is judged
  in the host's working directory. Corpus: 199 of the 518 real commands that run a client behind `docker run` or `compose run` were allowed on the wave-9 tip; on this tree none of them changes (their hosts are local). The whole corpus has 3 transitions, all of them here: 2 "Opening a raw connection to `X`" (a `docker run` whose inner command opens one: first words `docker` and `cd`) and 1 "built by command substitution … could name a live env file" (a `docker run` of an image name that holds a substitution).
- *`parallel`, `coproc`, `ssh`* (`parallel-command.ts`, `harness-parallel-ssh-wave10.test.ts`; R7-ADV-10, R7-ADV-11, R7-CR-12, R7-ADV-12). The words after `:::`
  are DATA: the `cp` model saw `/tmp/x` as the destination of `parallel cp {} .claude/settings.json ::: /tmp/x`. The command is cut off before the first
  separator; the lines judged in addition are the command once per datum with the datum where `{}` (or the replacement string `-I`, `--replace`, `--rpl`
  declares) is, or appended when nothing says where; a first word that holds whitespace is a command line (`parallel 'cp {} CLAUDE.md' ::: x`); with no command the
  data are the commands (`parallel ::: 'rm x'`); `::::` words are files read like an input redirect (a live env file is denied); data past 64 words are judged together once.
  The table has the 82 long value options of the manual (`--nice`, `--trim`, `--tagstring`, `--rpl`, `--id`, `--jl`, `--sshdelay`, `--memsuspend`, `--sql`, …,
  from memory of the manual: GNU parallel is not installed) and `-j2` reads its value attached. `coproc CMD` is a wrapper. `ssh` reads options up to the first word after
  the host, as OpenSSH does; from there on every word, dash words included, is the remote command (`ssh localhost sed -i s/a/b/ CLAUDE.md`); the quoted form keeps its answer.
- *Each package manager reads the grammar of its own CLI* (`runners.ts`, `runner-grammars.ts`, `harness-runner-grammars-wave10.test.ts`; R7-ADV-13, R7-CR-8,
  R7-ADV-15, R7-CR-13, R7-ADV-18). Wave 8 read every manager's options with ONE regex that listed `-r -c -w -F -C` as value options; they are flags in pnpm and yarn,
  so `pnpm -r exec CMD`, `pnpm -w exec CMD`, `pnpm -c exec CMD`, `pnpm exec --workspace-root CMD`, `pnpm --reporter silent exec CMD` hid the command. Now: bun's grammar is
  read from `bun --help` (1.4.4; every long option is a flag whose value rides after `=`: `bun --port 3000 run x` is a usage error, probed, so it is no run), pnpm's from `pnpm help
  exec|dlx` (10.30), uv's from `uv run|uvx|uv tool run --help`; npm's, yarn's and the environment loaders' are `lax` and from documentation (npm's own parser reads an unknown option
  as a boolean). `yarn workspace NAME CMD` and `yarn workspaces foreach [options] CMD` pass through to the yarn command behind them; `bun exec STR` runs STR as a shell line; `corepack
  pnpm@9 dlx …` names pnpm. Booleans wrongly listed as valued are flags (`env-cmd --fallback`, `lerna exec --include-dependencies`, `nx exec --parallel`, `op run --cache`) and
  `dotenvx run --ignore X` takes a value. New runners: `uv run|tool run`, `uvx`, `pipx run`, `poetry|pdm|rye|hatch|pipenv|devbox run`, `conda|micromamba run`,
  `nix shell|develop -c|--command CMD`, `nix-shell --run STR`, `flox activate -- CMD|-c STR`, `perf stat|record|trace`. **The word a runner starts is also read as an operand**
  (`bun <live env file>` and `bun run <live env file>` were allowed since wave 8, denied in wave 7: the runner peel made the name the program, which the secret-name rule
  does not scan). Two of the round-7 payloads are **not bypasses on bun 1.4.4** (probed in a scratch directory, with `echo`): `bun --bun cp …` and `bun --silent echo hi` print "Script not found" (a bare
  `bun NAME` runs no PATH program there, and an option before the name made the name no program in the wave-8 tests), and `bun --port 3000 run cp …` is a usage error; they stay unpeeled and the tests pin it.
- *Remote sessions ask, and the wave-9 residual wrappers are peeled* (`remote-access.ts`, `wrapper-specs.ts`, `harness-remote-access-wave10.test.ts`; R7-ADV-15). `kubectl
  exec|port-forward|cp|debug|attach`, `docker -H|--host`, `DOCKER_HOST=ssh|tcp://`, `docker context use`, `gcloud sql connect`, `gcloud compute ssh|scp`, `aws rds …`, `aws ssm
  start-session`, `aws ecs execute-command`, `fly postgres|pg connect|proxy`, `fly ssh|proxy`, `heroku pg:psql|pull|push`, `supabase db … --db-url|--linked`, `autossh` and
  `cloudflared access` ASK whatever runs behind them (the access a non-local ssh is; Codex denies). Corpus: 0 real commands (no bucket in the corpus diff). Peeled by the wrapper table: `torify`, `tsocks`, `toybox`, `firejail`, `valgrind`, `fakeroot`,
  `setpriv`, `nsenter`, `sshpass` (`-f FILE` is read), `systemd-run`, `ltrace`, `dtruss`, `numactl`, `cpulimit`, `gdb --args`; `make`, `just` and `task` run recipes of the repo,
  not an arbitrary command, and are **not** peeled (a documented residual). Still residual: `bwrap` (options with two values), `rlwrap`, `hyperfine` (every argument is a command line),
  and the stdin filters `ts` and `pv`.
- **Two existing tests changed their payload, and why.** `harness-hooks.test.ts` listed `kubectl exec|debug` (non-interactive) as commands the Codex guard allows outright;
  they ask now (Codex: deny) under the remote-session rule, so the rows assert only that the INTERACTIVE-shell rule does not fire. The derived long-option rows of
  `harness-wrapper-options-wave9.test.ts` got operand dummies for the wrappers that need one (`timeout`, `chrt`, `runuser`) and skip `env --split-string` (its words are
  the command, as `env -S` runs them) and `gdb` (it runs a command only behind `--args`).
- **Residuals.** A computed program name or a quoted wrapper option value is not read. A wrapper or runner option the lax tables do not list and that takes a separate value
  hides its command (`strace --foo bar cmd`, `pnpm --some-new-option v exec cmd`): npm, pnpm, yarn and the loaders are not complete lists. GNU `parallel`, `timeout`, `flock`,
  `taskset`, `ionice`, `chrt`, `runuser`, `unshare`, `strace`, `doas`, `nix`, `yarn`, `poetry`, `pdm`, `rye`, `hatch`, `pipenv`, `conda`, `micromamba`, `devbox`, `flox`, `perf`, `ltrace`, `numactl`,
  `cpulimit`, `setpriv`, `nsenter`, `sshpass`, `systemd-run`, `fakeroot` and `valgrind` are not installed here: their rows are from the manuals (`unverified` in the table comments), nothing was run on Linux.
  `docker run` is judged in the host's working directory (the container's own paths are not mapped unless a mount says so). Data of `parallel` past 64 words are judged together, once.
  `make`, `just`, `task` recipes, `bwrap`, `rlwrap`, `hyperfine`, `ts`, `pv` (above).
- **Corpus cost, measured on the final tree against the REAL checkout.** 140,767 distinct Bash commands recorded in this machine's Claude sessions, classified in process with the wave-9 tip (`f3a0e5f47`) and with this tree, the live listings read from the real checkout (read only; nothing executed; the differ is a scratch script, not committed). **3 transitions, 0.002%: 3 allow to ask** (the container-run bucket above), 0 allow to deny, 0 ask to deny, 0 deny to allow, 0 ask to allow; no throws; the slowest single classification 266 ms (322 ms on the wave-9 tip, same load). The budget for this part was 0.03% (about 42 commands). The wrapper-option asks (`unplaced`) and the remote-session asks cost 0 real commands; the by-path wrappers, `parallel` and the nested-string decode change no real command. The pinned hook commands, replayed on this tree (Claude and Codex; the corrupted-copy fail-closed checks), answer as on the wave-9 tip, 43 to 90 ms per call. The round-5, round-6 and everyday spot-check scripts answer identically (33, 42, 6, 35 and 228 rows: same or stronger, none weaker; `verify-r6.ts` fails only on its seven documented rows).

| ID | What it was |
|---|---|
| R7-CR-1 | Escaped quotes inside a double-quoted nested string hid the inner command in every nested-string producer, at every nesting depth. |
| R7-ADV-4, R7-CR-2 | Wave-9 regression: `sudo -upostgres …`, `sudo -nu x …`, `sudo --login …`, `taskset --cpu 0 …` hid the command (deny to allow). |
| R7-ADV-5 | A wrapper called by path (`/usr/bin/nice`, `./nohup`) was not peeled. |
| R7-ADV-6, R7-CR-12 | `timeout --sig KILL 5 …`, `nice --a 5 …`, `xargs --a FILE`: one-character and abbreviated long options; `coproc`. |
| R7-ADV-7 | A client run in a fresh container (`docker run IMG psql -h <host>`, `compose run`, `podman`, `nerdctl`, `--entrypoint`, `-e PGHOST=`) was never read. |
| R7-ADV-10, R7-ADV-11 | `parallel` data read as arguments, quoted commands and `::::` files unread, 11 value options missing. |
| R7-ADV-12 | `ssh localhost sed -i … CLAUDE.md`: the remote command's dash words were read as ssh options. |
| R7-ADV-13, R7-CR-8 | `pnpm -r|-w|-c exec`, `yarn workspace(s)`, `bun exec`: one manager regex with flags listed as values. |
| R7-ADV-15, R7-CR-13 | `uv`, `uvx`, `pipx`, `poetry`, `nix`, `flox`, `devbox`, `kubectl exec`, `autossh`, … hid their command; booleans listed as valued (`env-cmd --fallback`). |
| R7-CR-15 | `flock`/`runuser` stayed the program when the inner command had a `-c` of its own. |
| R7-ADV-18 | `bun <live env file>` and `bun run <live env file>`: the runner peel made the secret name the program (wave-8 regression). |
| R7-CR-16, R7-CR-17 | Wave-9 miscounted the duplicated `isOption` readers (four, five before this wave); dead `isEditor` removed. |
