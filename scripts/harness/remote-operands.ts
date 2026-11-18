/**
 * Hosts named by the operands of the copy and key tools of the ssh family (wave 13 part B; round-10 A10, B12).
 * ------------------------------------------------------------------------------------------------
 * `scp localhost:f H:g` copies between two machines and `H` is the second operand: the rule that judged the FIRST operand holding a `:` or an
 * `@` saw only `localhost`. Every operand is read here, as the tool reads it: `[user@]host:path` (the colon comes before any slash, so
 * `./a:b` is a local file), `[user@][[ipv6]]:path`, `scp://[user@]host[:port]/path`, rsync's `host::module` and `rsync://host/module`. A host that is
 * not this machine, or cannot be placed (`$`, a backtick, a brace), asks. Also read: `ssh-keyscan HOST...` (every host, a comma list too, and
 * `-f FILE` of hosts the guard cannot see), `ssh-copy-id [options] HOST` (the last word is the host: `getopts "io:p:F:t:fnsxh?"`, read
 * from the installed script) and `sshfs HOST:DIR MOUNT` (not installed here: every operand with a colon before a slash is read). The option letters come from the usage lines of the installed OpenSSH_10.6p1 (the fixture test compares them). A text heuristic. Pure.
 */
import { hostOf, place, scanShortOptions } from "./ssh-hops";

type IsLocalHost = (host: string) => boolean;

const URL_SIDE = /^(?:scp|ssh|sftp|rsync):\/\//i;

/** The host an operand of scp, rsync or sshfs names, or null when it is a local path. */
export function remoteSideHost(operand: string): string | null {
  if (URL_SIDE.test(operand)) {
    return hostOf(operand.replace(/^(?:scp|sftp|rsync):\/\//i, "ssh://")) ?? "";
  }
  const head = operand.split("/", 1)[0] ?? "";
  if (!head.includes(":")) return null;
  const bracket = /^(?:[^@]*@)?(\[[^\]]*\])/.exec(head);
  if (bracket !== null) return bracket[1] ?? "";
  const host = head.slice(0, head.indexOf(":"));
  return host.slice(host.lastIndexOf("@") + 1);
}

const isElsewhere = (host: string, isLocalHost: IsLocalHost): boolean =>
  place(host === "" ? undefined : host, isLocalHost) !== "local";

/** The first operand that names a machine other than this one (or cannot be placed). */
function firstRemote(operands: readonly string[], isLocalHost: IsLocalHost): string | undefined {
  return operands.find((operand) => {
    const host = remoteSideHost(operand);
    return host !== null && isElsewhere(host, isLocalHost);
  });
}

function keyscanReason(args: readonly string[], isLocalHost: IsLocalHost): string | null {
  const { options, operands } = scanShortOptions("ssh-keyscan", args);
  if (options.some((o) => o.letter === "f")) return "`ssh-keyscan -f` (a file of hosts)";
  const hosts = operands.flatMap((operand) => operand.split(","));
  return hosts.some((host) => isElsewhere(host, isLocalHost))
    ? "`ssh-keyscan` of another host"
    : null;
}

/** The reason an scp/rsync/sshfs/ssh-keyscan/ssh-copy-id operand list names another machine, or null. */
export function remoteOperandReason(
  prog: string,
  args: readonly string[],
  isLocalHost: IsLocalHost,
): string | null {
  switch (prog) {
    case "scp": {
      const remote = firstRemote(scanShortOptions(prog, args).operands, isLocalHost);
      return remote === undefined ? null : "`scp` to or from another host";
    }
    case "rsync":
    case "sshfs": {
      const words = args.filter((a) => !a.startsWith("-"));
      return firstRemote(words, isLocalHost) === undefined
        ? null
        : `\`${prog}\` to or from another host`;
    }
    case "ssh-keyscan":
      return keyscanReason(args, isLocalHost);
    case "ssh-copy-id": {
      const host = scanShortOptions(prog, args).operands.at(-1);
      if (host === undefined) return null;
      return place(hostOf(host), isLocalHost) === "local" ? null : "`ssh-copy-id` to another host";
    }
    default:
      return null;
  }
}
