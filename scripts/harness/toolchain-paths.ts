/**
 * Files outside the repo that the agent harness runs FROM or inherits its environment from: the `bun` that
 * every pinned hook command starts, and the shell startup files that decide what `PATH` and the harness
 * variables are in the next shell. A write to one of them switches the guard off for every later command
 * without touching a path the repo protects (`ln -sf /usr/bin/true ~/.bun/bin/bun` makes both hooks a no-op).
 * The classifier hands a path in the form it resolves to: `~/…` for the home directory, else absolute.
 *
 * Wave 8 (T7; round-6 ADV6-3, ADV6-12) widens it two ways. (1) A program the pinned commands and the guard call is
 * protected BY NAME in any directory: a copy of `/usr/bin/true` named `bun` in a user-writable directory that comes before
 * `~/.bun/bin` on PATH (`~/.kimi-code/bin`, `~/.local/bin`) made both hooks silent no-ops, and the fixed list could never
 * name every such directory. The names are `bun`, `bunx`, `perl`, `env`, `sh`, `node`, `git`, `python3`. The cost is an ask for
 * an ordinary write to a file or directory of that name (`mkdir env`, `cp x scripts/env`): rare, and counted on the real
 * commands in the wave-8 section of the doc. **Residual:** the guard runs under whatever `bun` the PATH of the hook resolves;
 * pinning an absolute path in a shared settings file is machine-specific and is not proposed. (2) The files a user-level
 * agent or git or launchd reads at start, which switch a hook off or run a program: `~/.gitconfig`, `~/.config/git/*`,
 * `~/.claude.json`, `~/Library/LaunchAgents/**`, `~/.claude/{rules,plugins,hooks,commands,agents,skills}/**`,
 * `~/.codex/{config.toml,hooks.json,AGENTS.md}` (the settings files, every `CLAUDE.md` and the whole `.codex/` are
 * protected by `protected-paths.ts` at any depth). NOT `~/.claude/projects/**` (the memory files the Write tool writes every
 * session), the caches or the history.
 */
const TOOLCHAIN_PATH = new RegExp(
  [
    // The bun install: its binary, its global packages and its config.
    String.raw`^~\/\.bun(?:\/|$)`,
    // Shell startup files of zsh, bash, sh and fish.
    String.raw`^~\/(?:\.z(?:sh[\w.-]*|profile|login|logout)|\.bash[\w.-]*|\.profile|\.config\/fish\/.*)$`,
    // The usual package-manager homes of the bun binary.
    String.raw`^\/(?:opt\/homebrew|usr\/local|usr)\/bin\/bunx?$`,
    // A program the hook commands and the guard call, by name, in any directory (a PATH shadow).
    String.raw`(?:^|\/)(?:bunx?|perl|env|sh|node|git|python3)$`,
    // What git, an agent or launchd reads at start: global git config, the user-level agent set-up, launch agents.
    String.raw`^~\/(?:\.gitconfig|\.config\/git\/.*|\.claude\.json|Library\/LaunchAgents\/.*|\.claude\/(?:rules|plugins|hooks|commands|agents|skills)\/.*|\.codex\/(?:config\.toml|hooks\.json|AGENTS\.md))$`,
  ].join("|"),
  // APFS and NTFS resolve `.ZSHENV` to the real file.
  "i",
);

/** Is this path (as the classifier resolves it) the harness's toolchain, a shell startup file or a user-level agent or git file? */
export const isToolchainPath = (rel: string): boolean => TOOLCHAIN_PATH.test(rel);
