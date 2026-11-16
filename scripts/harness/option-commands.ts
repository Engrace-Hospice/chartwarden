/**
 * Options that make a program run a command line of your choosing (wave 8, T4; round-6 ADV6-7). `ssh -o 'ProxyCommand cp x
 * CLAUDE.md' localhost` ran the local command (verified on scratch files: it ran, then ssh failed), and so do `scp`/`sftp -o
 * ProxyCommand=…`, `-o LocalCommand=…` (with PermitLocalCommand), `-o KnownHostsCommand=…`, scp's and sftp's `-S program`,
 * `sftp -D server`, rsync's `-e`/`--rsh`, `zip -T -TT cmd`, `rg --pre cmd` (and `--hostname-bin`), `man -P pager`/`--pager=pager`
 * and `less '+!cmd'`. The classifier judges each value as a command line of its own, so a harmless one (`-o 'ProxyCommand=nc
 * %h %p'` goes to the raw-socket rule) answers as it would typed. ssh's option names are case-insensitive, and its `-o` takes
 * `Key=Value`, `Key = Value` and `Key Value`, also attached (`-oKey=Value`). `-F config` reads a config file, which may hold
 * any of these: judged as a read of that path by the secret-file rule, not here. Pure.
 */

/** The ssh options whose value is a command line run on THIS machine. */
const LOCAL_COMMAND_OPTION =
  /^\s*(?:ProxyCommand|LocalCommand|KnownHostsCommand)\s*(?:=\s*|\s+)(.+)$/is;

/** The command line one `-o` value runs, or undefined: `ProxyCommand=cmd`, `proxycommand cmd`, `LocalCommand = cmd`. */
export const localCommandOfOption = (value: string): string | undefined =>
  LOCAL_COMMAND_OPTION.exec(value)?.[1]?.trim();

/** The values of `-o`: `-o VALUE` and `-oVALUE`. */
function dashOValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "-o") out.push(args[++k] ?? "");
    else if (a.startsWith("-o") && !a.startsWith("--")) out.push(a.slice(2));
  }
  return out;
}

/** The value of `-S`, `-D` and the like: the word after the short option, or attached to it (`-Sprog`). */
function shortValues(args: readonly string[], letters: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a.length === 2 && a[0] === "-" && letters.includes(a[1] as string))
      out.push(args[++k] ?? "");
    else if (/^-[A-Za-z]./.test(a) && letters.includes(a[1] as string) && !a.startsWith("--")) {
      out.push(a.slice(2));
    }
  }
  return out;
}

/** The value of each long option in `names`, as `--name VALUE` or `--name=VALUE`. */
function longValues(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    const eq = a.indexOf("=");
    const given = a.slice(2, eq < 0 ? undefined : eq);
    if (!a.startsWith("--") || !names.includes(given)) continue;
    out.push(eq < 0 ? (args[++k] ?? "") : a.slice(eq + 1));
  }
  return out;
}

/** The command lines `ssh`, `scp` and `sftp` run here through their options (scp and sftp also take `-S program`). */
export function sshLikeCommands(prog: string, args: readonly string[]): string[] {
  const fromO = dashOValues(args).map(localCommandOfOption);
  const programs =
    prog === "scp" ? shortValues(args, "S") : prog === "sftp" ? shortValues(args, "SD") : [];
  return [...fromO, ...programs].filter((c): c is string => c !== undefined && c.trim() !== "");
}

/** `zip -T -TT 'cmd' x.zip …`: the command that tests the archive. */
const zipTestCommand = (args: readonly string[]): string[] => {
  const at = args.indexOf("-TT");
  return at >= 0 && args[at + 1] !== undefined ? [args[at + 1] as string] : [];
};

/** The command lines a program that is NOT a remote-shell client runs through an option of its own; none for any other program. */
export function optionCommandStrings(prog: string, args: readonly string[]): string[] {
  const values = (() => {
    switch (prog) {
      case "zip":
        return zipTestCommand(args);
      case "rg":
        return longValues(args, ["pre", "hostname-bin"]);
      case "man":
        return [...shortValues(args, "P"), ...longValues(args, ["pager"])];
      case "less":
        return args.filter((a) => a.startsWith("+!")).map((a) => a.slice(2));
      default:
        return [];
    }
  })();
  return values.filter((c) => c.trim() !== "");
}

/**
 * scp's and sftp's `-S program` REPLACES the `ssh` they start, and sftp's `-D` is the sftp-server to run: any program but
 * `ssh` is arbitrary code run here, and the guard cannot judge a program it has no command line for. Why this asks, or null.
 */
export function programOptionReason(prog: string, args: readonly string[]): string | null {
  if (prog !== "scp" && prog !== "sftp") return null;
  const programs = shortValues(args, prog === "sftp" ? "SD" : "S");
  const unknown = programs.find((p) => p.replace(/^.*\//, "") !== "ssh");
  return unknown === undefined
    ? null
    : `\`${prog} -S|-D\` names a program (not ssh) to run on this machine in place of the one it starts, and the guard cannot tell what it does. A human decides.`;
}
