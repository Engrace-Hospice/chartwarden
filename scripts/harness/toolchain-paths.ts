/**
 * Files outside the repo that the agent harness runs FROM or inherits its environment from: the `bun` that
 * every pinned hook command starts, and the shell startup files that decide what `PATH` and the harness
 * variables are in the next shell. A write to one of them switches the guard off for every later command
 * without touching a path the repo protects (`ln -sf /usr/bin/true ~/.bun/bin/bun` makes both hooks a no-op).
 * The classifier hands a path in the form it resolves to: `~/…` for the home directory, else absolute.
 */
const TOOLCHAIN_PATH = new RegExp(
  [
    // The bun install: its binary, its global packages and its config.
    String.raw`^~\/\.bun(?:\/|$)`,
    // Shell startup files of zsh, bash, sh and fish.
    String.raw`^~\/(?:\.z(?:sh[\w.-]*|profile|login|logout)|\.bash[\w.-]*|\.profile|\.config\/fish\/.*)$`,
    // The usual package-manager homes of the bun binary.
    String.raw`^\/(?:opt\/homebrew|usr\/local|usr)\/bin\/bunx?$`,
  ].join("|"),
  // APFS and NTFS resolve `.ZSHENV` to the real file.
  "i",
);

/** Is this path (as the classifier resolves it) the harness's toolchain or a shell startup file? */
export const isToolchainPath = (rel: string): boolean => TOOLCHAIN_PATH.test(rel);
