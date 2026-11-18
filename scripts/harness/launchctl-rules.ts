/**
 * `launchctl` subcommands that change what every later process starts with or runs a job (wave 8, T7(b); round-6 ADV6-12):
 * `launchctl setenv BUN_OPTIONS --preload=/tmp/x.js` and `launchctl setenv PATH …` set a variable the next hook process
 * inherits (the guard's own `bun` reads them before it judges anything), and `load`, `bootstrap`, `enable`, `kickstart`,
 * `submit`, `bsexec` and `asuser` start or arm a launch job. Reading (`getenv`, `list`, `print`) is not. Pure.
 */
const CHANGING_SUBCOMMAND =
  /^(?:setenv|unsetenv|load|unload|bootstrap|bootout|enable|disable|kickstart|submit|bsexec|asuser)$/;

/** Why a `launchctl` command line asks, or null when it only reads. */
export function launchctlReason(prog: string, args: readonly string[]): string | null {
  if (prog !== "launchctl") return null;
  const subcommand = args.find((a) => !a.startsWith("-"));
  if (subcommand === undefined || !CHANGING_SUBCOMMAND.test(subcommand)) return null;
  return `\`launchctl ${subcommand}\` sets an environment variable for every process the session starts later (PATH, BUN_OPTIONS: the guard's own bun reads them before it judges anything) or starts and arms a launch job. A human decides.`;
}
