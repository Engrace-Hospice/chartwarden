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
  patch the parser cannot read or one over 256 KB (the scan must finish inside Codex's timeout). Through
  the shell only exactly one `apply_patch <<'EOF' … EOF` is accepted, run in the session directory or the
  call's `workdir`; `cd`, a pipe, a redirect or a second command is refused, because `apply_patch` is on
  PATH and each of those applies a patch the guard cannot place. Codex has no Read/Grep/Glob tools; its reads
  are shell commands. An interactive shell, language REPL or database client is refused even when it has
  login, quiet or connection flags: what is typed into it later reaches it through `write_stdin`, which
  Codex does not hook. A script, inline command, input file, or help/version invocation is terminating and
  remains available. A command or workdir that is present and not text is refused, never coerced with
  `String()` and judged.
- **MCP tools** arrive as `mcp__<server>__<tool>` with arbitrary JSON, and nothing says which field is a path
  or text. The guard therefore judges EVERY string in `tool_input`, object keys included, at any depth: each
  line as a secret path and as a protected path (as written, and resolved from the session directory with
  symlinks followed, exactly as an `apply_patch` path is), and the whole string through the PHI/credential
  scan. It guesses nothing else about the tool. An input that is not an object, nests 32 levels or deeper,
  holds more than 2,000 strings or 256 KB of text, or has more than 20,000 lines to resolve is refused (the
  scan has to finish inside Codex's timeout). A reason names a path only when the value is one short word;
  it never echoes prose.
- **The root is where the guard script lives**, not `CLAUDE_PROJECT_DIR`. The pinned command runs
  `$(git rev-parse --show-toplevel)/scripts/harness/pre-tool-guard.ts`, so the script's grandparent is the
  session's repo. An exported `CLAUDE_PROJECT_DIR` (from a Claude shell, pointing at another tree) used to
  override that and silently moved every protected-path match onto the wrong root. `CW_HARNESS_ROOT_FOR_TESTS`
  is the test-only seam; production never sets it, and a developer must not export it. Claude Code still
  takes its root from `CLAUDE_PROJECT_DIR`, which Claude Code itself sets.
- **The hook command is pinned byte for byte** (`CODEX_GUARD_COMMAND` in
  `scripts/check-compliance-controls.ts`), and each part matters. `bun --config=/dev/null --no-env-file`:
  a `bunfig.toml` `preload` in the session directory would otherwise run before the guard and could silence
  it (`bunfig.toml` is protected for that reason). `perl -e 'alarm 8; exec @ARGV or exit 127'`: Codex runs
  the call when a hook times out (10 s here) and when `exec` fails perl would exit 0, an allow. `|| exit 2`:
  exit 2 with a message blocks in Codex, so a guard that cannot start, crashes or times out blocks the call.
  `perl` and `bun` must be on the hook's PATH; without them every shell call and patch is refused, loudly.
  Claude's own three hooks (guard, ledger, Stop gate) are pinned the same way (`CLAUDE_GUARD_COMMAND`,
  `CLAUDE_LEDGER_COMMAND`, `CLAUDE_STOP_COMMAND`) and run with the same `--config=/dev/null --no-env-file`,
  for the same reason. They deliberately have no perl alarm and no `|| exit 2`: Claude Code has its own
  timeout, and a missing `perl` would otherwise lock out every Claude tool call.
- **The hook layer is a guardrail, not a boundary.** Each developer must trust the hook once (`/hooks`, tied
  to its hash, so a changed hook is skipped until re-trusted) and the project `.codex/` layer must be
  trusted. It can be switched off (`[features] hooks = false`, or a fresh `CODEX_HOME`) or bypassed
  (`--dangerously-bypass-hook-trust`), and OpenAI calls hooks "a useful guardrail, not a complete
  enforcement boundary". The shell layer is text heuristics, the same as Claude's: it does not understand an
  interpreter script (`python - <<EOF`), `git apply`, `git checkout <rev> -- <protected path>`, a directory
  move or copy, or an obfuscated command name. `write_stdin` is not hooked, and an MCP tool is judged only by
  the strings in its input, not by what the tool does with them. **Run Codex in its `workspace-write`
  sandbox: that, not this hook, is the boundary.** Codex has no ledger or Stop gate yet; only the guard's own
  deny entries reach `.claude/audit/`, tagged `codex/<tool>`, capped at 1000 characters a field, and carrying
  the decision actually answered (`deny`, never the `ask` Codex cannot honour).

`.codex/config.toml`, `bunfig.toml`, `AGENTS.override.md` and `.codex/{hooks,rules}/` are on the guard's
protected list at any depth (they are loaded from any directory, and `~/.codex/config.toml` can disable the
hook for a user); `.codex/config.toml` itself stays local and git-ignored, at any depth: `.gitignore` ignores
`**/.codex/*` and `**/.agents/*` (a nested `apps/x/.codex/` is local state too) and re-includes only the
root's shared pieces, each AFTER the ignore line (git's last match wins). `arch:compliance` fails if
`.codex/hooks.json` is missing or differs from the pinned command, matcher (`Bash|write_stdin|apply_patch|mcp__.*`), type
or timeout (1 to 30 s), if one of the three Claude hook commands differs from its pinned form, if the
`.claude/` and `.agents/` mirror reads as empty on either side or differs by a single byte (files are compared
by SHA-256 of their bytes, not decoded text), or if `.gitignore` or CODEOWNERS stop covering any of this or
`bunfig.toml`.

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
  `compliance/`, `.githooks/`, `.gitleaks.toml`, `CODEOWNERS`), which **ask** because the Edit-tool
  prompt does not see them;
- raw sockets and plain GETs that carry expanded values to a non-local host. "Local" means loopback,
  `host.docker.internal`, or a service named in `docker-compose.yml`; `*.internal` and bare host names
  are **not** local.

**Shell classifier limits and coverage.** `classifyBash` is a text heuristic for a cooperative agent, not a
sandbox. It tracks `cd`, `pushd` and `..` through a command, and expands `~`, `$HOME`, `$CODEX_HOME` and
`$PWD`. It resolves every write target before comparing it with the protected paths, and it treats a
directory that contains a protected path as protected when the command is a delete, move, or tree-merge
(`rm -r`, `mv`, `cp -R`, `rsync`, `tar x`, `unzip`). The writers it understands are redirections, `tee`,
`dd of=`, `sed -i`, `perl -i`, `find -delete/-exec`, `cp/mv/ln/install`, `chmod/chown -R`, `patch`, and
`git apply/am/checkout/restore/rm/mv/clean`. It reads inline interpreter code and heredoc or stdin script
bodies as text, with quotes and `+` removed. It cannot read a script file (`python3 /tmp/w.py`), computed
or encoded names, glob targets, symlinks, a `$VAR` path prefix, or anything fed through `xargs`. A `cd` it
cannot resolve followed by a write asks. Whole-tree reads that bypass `.gitignore` (`grep -r`,
`rg -u/--hidden`, `tar c .`, `docker compose config`) ask, as do file names built by command substitution
and agents started with approval prompts, the sandbox or hooks off. Reasons never echo URL userinfo and cap
any token they quote. Pathological input is bounded (32 substitutions per level, 300 judged command lines
per call) because a guard that times out lets the call through. Reading a protected file does not ask; only
a command that writes one does.

**Fails closed.** Empty or unparseable hook input, an internal error, and a write too large to scan
(over 8 MB) all answer `deny`. A human who needs the session back sets `CW_HARNESS_FAIL_OPEN=1` for it.
Codex PTY requests (`tty`, `pty`, or `use_pty`) also fail closed: later `write_stdin` input does not fire
the original command's PreToolUse check. The Codex hook therefore matches `write_stdin` itself and allows
only empty polling; every non-empty or malformed `chars` value is denied before reaching the process.
Agents use finite non-PTY commands instead; the interactive-process classifier remains a defence-in-depth
control for commands that can attach stdin without requesting a PTY.

Cannot cover:
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
