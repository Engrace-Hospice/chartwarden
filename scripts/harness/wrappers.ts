/**
 * Programs that run another command, and the command lines they hand to a shell or to a container.
 * -----------------------------------------------------------------------------------------------
 * `sudo rm x`, `caffeinate rm x`, `flock f rm x`, `chrt -f 1 rm x`: the guard judges the command, so each wrapper
 * says which of its words are options with a value and how many operands come before the command.
 * `watch 'rm x'`, `su -c 'rm x'`, `rsync -e 'sh …'`, `tar --checkpoint-action=exec=…`, `ssh h 'rm x'`: the command
 * is one string a shell runs, which is judged as a command line of its own. `docker run -v "$PWD":/w img rm
 * /w/x`: the command runs in a container that sees the repo under another name, which is mapped back. A text
 * heuristic: a wrapper this table does not know hides its command. Pure.
 */

import { localCommandOfOption, optionCommandStrings, sshLikeCommands } from "./option-commands";
import { commandOptionValues, suCommandStrings } from "./shell-command-string";
import { joinedAndQuoted, shellQuote } from "./shell-quote";

export { joinedAndQuoted, shellQuote };

/** Homebrew's GNU tools carry a `g` prefix on macOS (`gxargs -a FILE`, `gnice`): each is the wrapper it prefixes. */
const GNU_PREFIXED = /^g(xargs|nice|stdbuf|env|nohup|time|timeout|chroot)$/;
export const gnuName = (program: string): string => GNU_PREFIXED.exec(program)?.[1] ?? program;

/** The words of `args` after options (those in `valueFlag` take the next word as a value). */
function afterOptions(args: readonly string[], valueFlag: RegExp): string[] {
  let k = 0;
  while (k < args.length && (args[k] ?? "").startsWith("-") && args[k] !== "--") {
    k += valueFlag.test(args[k] ?? "") ? 2 : 1;
  }
  if (args[k] === "--") k++;
  return args.slice(k);
}

/** `-e CMD`, `-eCMD`, `--rsh=CMD`, `--rsh CMD` of rsync. */
function rshOption(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "-e" || a === "--rsh") out.push(args[++k] ?? "");
    else if (a.startsWith("--rsh=")) out.push(a.slice("--rsh=".length));
    else if (/^-[A-Za-z]*e.+/.test(a) && !a.startsWith("--")) out.push(a.slice(a.indexOf("e") + 1));
  }
  return out;
}

const SSH_VALUE_FLAG = /^-[BbcDEeFIiJLlmOopQRSWw]$/;

/**
 * The operands of an `ssh` command line (host, then the remote command), and the programs its options run here. OpenSSH reads
 * options up to the first word after the host; from there on every word belongs to the remote command, dash words included
 * (`ssh localhost sed -i x FILE`: `-i` is sed's, not ssh's identity file).
 */
function sshWords(args: readonly string[]): { operands: string[]; local: string[] } {
  const local: string[] = [];
  const operands: string[] = [];
  let optionsEnded = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (operands.length >= 2 || (optionsEnded && operands.length >= 1)) {
      operands.push(a);
      continue;
    }
    if (a === "--") {
      optionsEnded = true;
      continue;
    }
    const given = a === "-o" ? (args[++k] ?? "") : a.startsWith("-o") ? a.slice(2) : "";
    const command = localCommandOfOption(given);
    if (command !== undefined) local.push(command);
    else if (given !== "") continue;
    else if (SSH_VALUE_FLAG.test(a)) k++;
    else if (!a.startsWith("-") || optionsEnded) operands.push(a);
  }
  return { operands, local };
}

/** The host word of an `ssh` command line (`ssh -p 22 host cmd`), or undefined when it names none. */
export const sshHost = (args: readonly string[]): string | undefined => sshWords(args).operands[0];

/**
 * What an `ssh` command line runs HERE (its ProxyCommand, LocalCommand), and the command line it runs on the host
 * when that host is this machine: a command for another host names that host's files, not these.
 */
function sshCommands(args: readonly string[], isLocal: (host: string) => boolean): string[] {
  const { operands, local } = sshWords(args);
  const [host, ...remote] = operands;
  if (host === undefined || remote.length === 0 || !isLocal(host)) return local;
  // The remote shell reads the words joined by spaces (that is what ssh sends); what the user meant by quoting them is the same words
  // quoted back: both are judged, so `ssh localhost bash -c -- 'CMD'` is read as the user meant it and as the remote shell will.
  return [...local, ...joinedAndQuoted(remote)];
}

/** tar options that run a program: `--checkpoint-action=exec=CMD`, `--to-command=CMD`, `-I CMD`. */
function tarCommands(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    const exec = /^--checkpoint-action=exec=(.*)$/s.exec(a)?.[1];
    if (exec !== undefined) out.push(exec);
    else if (a.startsWith("--to-command=")) out.push(a.slice("--to-command=".length));
    else if (a === "--to-command" || a === "-I" || a === "--use-compress-program")
      out.push(args[++k] ?? "");
    else if (a.startsWith("--use-compress-program="))
      out.push(a.slice("--use-compress-program=".length));
  }
  return out;
}

/** The command lines `prog` hands to a shell, as strings to judge. */
export function shellStrings(
  prog: string,
  args: readonly string[],
  isLocalHost: (host: string) => boolean,
): string[] {
  switch (prog) {
    case "watch":
      return joinedAndQuoted(afterOptions(args, /^-(?:n|-interval)$|^--interval$/));
    case "entr":
      // `entr [-acdnprsxz] utility [args]` (`-s` makes the words one shell command): the words are a command line.
      return joinedAndQuoted(afterOptions(args, /^$/));
    case "su":
      return suCommandStrings(args);
    case "runuser":
    case "flock":
      return commandOptionValues(args);
    case "script": {
      // macOS `script [-q] FILE cmd args…` runs the command; Linux `script -c 'cmd' FILE`. FILE is written (writers.ts).
      const [, ...command] = afterOptions(args, /^-[tFcEIOBT]$/);
      return [...commandOptionValues(args), command.join(" ")];
    }
    case "ssh":
      return sshCommands(args, isLocalHost);
    case "scp":
    case "sftp":
      return sshLikeCommands(prog, args);
    case "rsync":
      return rshOption(args);
    case "tar":
    case "gtar":
    case "gnutar":
    case "bsdtar":
      return tarCommands(args);
    default:
      return optionCommandStrings(prog, args);
  }
}

// ---------------------------------------------------------------------------------------------------
// A command run in a container that mounts the repo
// ---------------------------------------------------------------------------------------------------

const CONTAINER_VALUE_FLAG =
  /^-(?:v|w|e|u|p|h|l|a|c|H|m)$|^--(?:volume|mount|workdir|env|env-file|user|publish|name|network|net|hostname|entrypoint|label|platform|cpus|memory|restart|pull|add-host|cap-add|cap-drop|device|dns|group-add|ipc|log-driver|mac-address|pid|security-opt|shm-size|tmpfs|ulimit|volumes-from)$/;

/** A writable bind mount: where it comes from on the host, and where the container sees it. */
interface Mount {
  readonly source: string;
  readonly target: string;
}

function mountOf(spec: string): Mount | null {
  const [source, target, mode] = spec.split(":");
  if (!source || !target?.startsWith("/") || target.length < 2) return null;
  if (/(^|,)ro(,|$)/.test(mode ?? "") || !/^[/.~$]/.test(source)) return null;
  return { source, target };
}

function mountOfMountFlag(spec: string): Mount | null {
  const fields = new Map(spec.split(",").map((f) => f.split("=") as [string, string | undefined]));
  const source = fields.get("source") ?? fields.get("src");
  const target = fields.get("target") ?? fields.get("destination") ?? fields.get("dst");
  if (fields.get("type") !== "bind" || fields.has("readonly") || fields.get("ro") === "true")
    return null;
  return source && target?.startsWith("/") ? mountOf(`${source}:${target}`) : null;
}

export interface ContainerRun {
  /** The command the container runs, with each mount's target written as its host source. */
  readonly command: string;
  /** The container's working directory, as a host path, when it is inside a mount. */
  readonly workdir?: string;
}

const retarget = (text: string, mounts: readonly Mount[]): string =>
  mounts.reduce((out, m) => {
    const escaped = m.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return out.replace(new RegExp(`(?<![\\w./-])${escaped}(?=/|$|[\\s'"])`, "g"), m.source);
  }, text);

/**
 * `docker run -v "$PWD":/w -w /w img rm scripts/harness/x`: the command, with the container's view of the repo
 * mapped back to the host, so a write to a protected file reads as the write it is. Null for anything that is not
 * a `run` with a writable bind mount.
 */
export function containerRun(prog: string, args: readonly string[]): ContainerRun | null {
  if (!/^(?:docker|podman|nerdctl)$/.test(prog)) return null;
  const run = args.indexOf("run");
  if (run < 0) return null;
  const mounts: Mount[] = [];
  let workdir: string | undefined;
  let entrypoint: string | undefined;
  let k = run + 1;
  for (; k < args.length && (args[k] ?? "").startsWith("-"); k++) {
    const a = args[k] ?? "";
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    const value = eq >= 0 ? a.slice(eq + 1) : CONTAINER_VALUE_FLAG.test(a) ? (args[++k] ?? "") : "";
    const attached = /^-[vwe]./.test(a) && !a.startsWith("--");
    const flag = attached ? a.slice(0, 2) : name;
    const val = attached ? a.slice(2) : value;
    if (flag === "-v" || flag === "--volume") {
      const m = mountOf(val);
      if (m) mounts.push(m);
    } else if (flag === "--mount") {
      const m = mountOfMountFlag(val);
      if (m) mounts.push(m);
    } else if (flag === "-w" || flag === "--workdir") workdir = val;
    else if (flag === "--entrypoint") entrypoint = val;
  }
  if (mounts.length === 0) return null;
  const words = [...(entrypoint ? [entrypoint] : []), ...args.slice(k + 1)];
  if (words.length === 0) return null;
  const command = retarget(words.map(shellQuote).join(" "), mounts);
  const mappedDir = workdir === undefined ? undefined : retarget(workdir, mounts);
  return mappedDir !== undefined && mappedDir !== workdir
    ? { command, workdir: mappedDir }
    : { command };
}
