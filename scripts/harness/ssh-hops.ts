/**
 * Jump hosts, forwards and proxies of ssh and its relatives (wave 12 part E2, E2-5; round-9 R9-ADV-15).
 * ------------------------------------------------------------------------------------------------
 * `ssh H psql` asks because H is not this machine. The same reach hides behind a target that IS this machine: `ssh -J H localhost psql`
 * (the connection goes through H), `-o ProxyJump=H`, `-W H:5432 localhost` (stdio to H), `-L 5433:H:5432 localhost -N` and `-R` (a forward to
 * H), `-o HostName=H alias`; `scp -J`, `sftp -J` and `sftp H` (no `@` or `:` for the target rule to see); `mosh H` and `et H` (not read at
 * all). Each asks when the host it names is not this machine or cannot be placed (`$`, a backtick, a brace). `ssh H psql` and
 * `ssh -L 5433:localhost:5432 localhost` keep their verdicts. ssh, scp and sftp are read from the installed OpenSSH_10.6p1 (`ssh -G`
 * offline: options are parsed up to the first word after the host, a cluster ends at the first valued letter, `-L` and `-R` take
 * `[bind:]port:host:hostport` or a socket). mosh and et are NOT installed here: their option lists are from their manuals, unverified,
 * so an option they do not list asks. A text heuristic: `-F config` may hold a ProxyJump of its own (the secret-file rule judges the path). Pure.
 */

/** Option letters of each program that take a value (`ssh`, `scp`, `sftp` `-h` and the manual pages of OpenSSH_10.6p1). */
const VALUE_LETTERS: Readonly<Record<string, string>> = {
  ssh: "BbcDEeFIiJLlmOopQRSWw",
  scp: "cDFiJlOoPSX",
  sftp: "BbcDFiJloPRSsX",
};

interface ShortOption {
  readonly letter: string;
  readonly value: string;
}

/** The option letters of `ssh` that take a value (its own `-h`), for the readers outside this module. */
export const SSH_VALUE_LETTERS = VALUE_LETTERS.ssh as string;

/**
 * One option word read as ssh reads it: letters are flags until the first one that takes a value, and the rest of the word is its value, or the
 * next word when nothing is left (`-i KEY`, `-iKEY`, `-qi KEY`, `-NL spec`, `-vo Option=x`). Null when the word holds no valued letter.
 */
export function readCluster(
  letters: string,
  word: string,
  next: string | undefined,
): { letter: string; value: string; usedNext: boolean } | null {
  for (let at = 1; at < word.length; at++) {
    const letter = word[at] as string;
    if (!letters.includes(letter)) continue;
    const attached = word.slice(at + 1);
    if (attached !== "") return { letter, value: attached, usedNext: false };
    return { letter, value: next ?? "", usedNext: true };
  }
  return null;
}

/**
 * The valued short options of an ssh-family command line, with a cluster read letter by letter (`-NL spec`, `-L5433:…`). For `ssh` the options end at
 * the first word after the host (everything after belongs to the remote command); scp and sftp take options anywhere. Also the operands.
 */
function scanShortOptions(
  prog: string,
  args: readonly string[],
): { options: ShortOption[]; operands: string[] } {
  const letters = VALUE_LETTERS[prog] ?? "";
  const options: ShortOption[] = [];
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      if (prog === "ssh" && operands.length >= 1) break; // the remote command starts here
      operands.push(a);
      continue;
    }
    const cluster = readCluster(letters, a, args[k + 1]);
    if (cluster === null) continue;
    if (cluster.usedNext) k++;
    options.push({ letter: cluster.letter, value: cluster.value });
  }
  return { options, operands };
}

/** A host word the guard cannot place: `$`, a backtick, a brace, a glob or a space in it. */
const UNPLACEABLE = /[$`{}*?\s]/;

/** `[user@]host[:port]`, `ssh://[user@]host[:port]`, `[::1]:22`: the host alone (an IPv6 address keeps its brackets); undefined when nothing is left. */
function hostOf(spec: string): string | undefined {
  let rest = spec.replace(/^ssh:\/\//i, "").replace(/\/.*$/, "");
  rest = rest.slice(rest.lastIndexOf("@") + 1);
  const bracket = /^(\[[^\]]*\])/.exec(rest);
  if (bracket !== null) return bracket[1];
  if (rest.split(":").length === 2) rest = rest.slice(0, rest.indexOf(":"));
  return rest === "" ? undefined : rest;
}

/** What a host word means for the guard: this machine, another one, or not placeable. */
type Placement = "local" | "remote" | "unplaced";

function place(host: string | undefined, isLocalHost: (host: string) => boolean): Placement {
  if (host === undefined || UNPLACEABLE.test(host)) return "unplaced";
  return isLocalHost(host) ? "local" : "remote";
}

/** The worst placement of a list of hosts (`remote` and `unplaced` both ask). */
const asks = (placements: readonly Placement[]): boolean => placements.some((p) => p !== "local");

/** `a,b,c` of a ProxyJump or `-J`: every hop; `none` is no hop at all. */
function jumpPlacements(value: string, isLocalHost: (host: string) => boolean): Placement[] {
  if (value.trim().toLowerCase() === "none") return [];
  return value.split(",").map((hop) => place(hostOf(hop.trim()), isLocalHost));
}

/** Split on `:` outside square brackets (`[::1]:5433:h:22`). */
function colonParts(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of spec) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * The host a `-L`/`-R` forward (or LocalForward/RemoteForward) reaches: `port:host:hostport`, `bind:port:host:hostport`, `local_socket:host:hostport`; a
 * socket on the far side has no host (`port:/path`, `bind:port:/path`, `local_socket:remote_socket`). Anything else is a bad spec, so unplaced.
 */
function forwardPlacement(spec: string, isLocalHost: (host: string) => boolean): Placement[] {
  const parts = colonParts(spec.trim());
  if (parts.length === 2) return []; // `port:remote_socket`
  if (parts.length === 3 && (parts[2] ?? "").startsWith("/")) return []; // `bind:port:remote_socket`
  const host = parts.length === 3 ? parts[1] : parts.length === 4 ? parts[2] : undefined;
  return [place(host, isLocalHost)];
}

/** `ssh -W host:port`: the destination of the stdio forward. */
function stdioPlacement(spec: string, isLocalHost: (host: string) => boolean): Placement[] {
  const parts = colonParts(spec.trim());
  const host = parts.length === 2 ? parts[0] : undefined;
  return [place(host, isLocalHost)];
}

/** `-o Key=Value`, `-o "Key Value"`, `-o "Key = Value"` and the attached `-oKey=Value`: the key (lowercased) and the value. */
function keyValue(option: string): { key: string; value: string } | null {
  const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/s.exec(option);
  return m === null
    ? null
    : { key: (m[1] as string).toLowerCase(), value: (m[2] as string).trim() };
}

/** The placements an `-o` configuration option adds: a jump, a forward, or the real host name. */
function configPlacements(
  option: string,
  isLocalHost: (host: string) => boolean,
): { what: string; placements: Placement[] } | null {
  const kv = keyValue(option);
  if (kv === null) return null;
  const value = kv.value.replace(/^"(.*)"$/s, "$1");
  switch (kv.key) {
    case "proxyjump":
      return { what: "-o ProxyJump", placements: jumpPlacements(value, isLocalHost) };
    case "hostname":
      return { what: "-o HostName", placements: [place(hostOf(value), isLocalHost)] };
    case "localforward":
    case "remoteforward": {
      // ssh_config separates the two halves by whitespace: `LocalForward 5433 host:5432`
      const spec = value.replace(/\s+/, ":").replace(/\s+/g, "");
      return {
        what: kv.key === "localforward" ? "-o LocalForward" : "-o RemoteForward",
        placements: forwardPlacement(spec, isLocalHost),
      };
    }
    default:
      return null;
  }
}

/** What each valued short option of ssh, scp and sftp asks about (letter -> label and the placements it names). */
function optionPlacements(
  prog: string,
  option: ShortOption,
  isLocalHost: (host: string) => boolean,
): { what: string; placements: Placement[] } | null {
  switch (option.letter) {
    case "J":
      return { what: `${prog} -J`, placements: jumpPlacements(option.value, isLocalHost) };
    case "W":
      return prog === "ssh"
        ? { what: "ssh -W", placements: stdioPlacement(option.value, isLocalHost) }
        : null;
    case "L":
    case "R":
      return prog === "ssh"
        ? { what: `ssh -${option.letter}`, placements: forwardPlacement(option.value, isLocalHost) }
        : null;
    case "o": {
      const config = configPlacements(option.value, isLocalHost);
      return config === null ? null : { ...config, what: `${prog} ${config.what}` };
    }
    default:
      return null;
  }
}

/** ssh, scp, sftp: a jump, forward or proxy that names another machine; and `sftp HOST` (the host has no `@` or `:`). */
function sshFamilyHop(
  prog: string,
  args: readonly string[],
  isLocalHost: (host: string) => boolean,
): string | null {
  const { options, operands } = scanShortOptions(prog, args);
  for (const option of options) {
    const found = optionPlacements(prog, option, isLocalHost);
    if (found !== null && asks(found.placements)) return `\`${found.what}\``;
  }
  if (prog === "sftp" && operands[0] !== undefined) {
    const host = hostOf(operands[0].replace(/^sftp:\/\//i, "ssh://"));
    if (place(host, isLocalHost) !== "local") return "`sftp` to another host";
  }
  return null;
}

/** mosh: `[options] [--] [user@]host [command…]`. Options are from its manual (not installed here): one this table does not list is unplaced. */
const MOSH_VALUES = new Set([
  "--client",
  "--server",
  "--predict",
  "--family",
  "--port",
  "-p",
  "--bind-server",
  "--ssh",
  "--experimental-remote-ip",
]);
const MOSH_FLAGS = new Set([
  "-a",
  "-n",
  "--no-ssh-pty",
  "--no-init",
  "--local",
  "--help",
  "--version",
]);

/** et (Eternal Terminal): `[options] [user@]host[:port]`; `-j` names a jump host. From its manual (not installed here). */
const ET_VALUES = new Set([
  "-u",
  "--username",
  "-p",
  "--port",
  "-c",
  "--command",
  "-f",
  "--prefix",
  "-j",
  "--jumphost",
  "--jport",
  "-r",
  "--reversetunnel",
  "-t",
  "--tunnel",
  "-k",
  "--keepalive",
  "--ssh-option",
  "--serverfifo",
  "--host",
]);
const ET_FLAGS = new Set([
  "-h",
  "--help",
  "-x",
  "--kill-other-sessions",
  "-v",
  "--verbose",
  "-N",
  "--no-terminal",
  "--noratelimit",
  "--telemetry",
  "--silent",
  "--logtostdout",
  "-V",
  "--version",
]);

interface TableRead {
  readonly host: string | undefined;
  readonly values: ReadonlyMap<string, string>;
  /** An option the table does not list: the host cannot be placed. */
  readonly unknown: boolean;
}

/** The host operand and the valued options of a tool whose options come from a manual table (`--name=value` and `--name value` both read). */
function readTable(
  args: readonly string[],
  valued: ReadonlySet<string>,
  flags: ReadonlySet<string>,
): TableRead {
  const values = new Map<string, string>();
  let host: string | undefined;
  let unknown = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") {
      host ??= args[k + 1];
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      host = a;
      break;
    }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (valued.has(name)) values.set(name, eq < 0 ? (args[++k] ?? "") : a.slice(eq + 1));
    else if (!flags.has(name)) unknown = true;
  }
  return { host, values, unknown };
}

/** mosh and et: the host operand, an `et -j` jump host, and a `mosh --ssh` command line; an option no table lists asks. */
function sessionToolHop(
  prog: string,
  args: readonly string[],
  isLocalHost: (host: string) => boolean,
): string | null {
  const read =
    prog === "mosh"
      ? readTable(args, MOSH_VALUES, MOSH_FLAGS)
      : readTable(args, ET_VALUES, ET_FLAGS);
  if (read.unknown) return `\`${prog}\` with an option this guard does not read`;
  const jump = read.values.get("-j") ?? read.values.get("--jumphost");
  if (jump !== undefined && asks(jumpPlacements(jump, isLocalHost))) return "`et -j`";
  const viaSsh = read.values.get("--ssh");
  if (
    viaSsh !== undefined &&
    sshFamilyHop("ssh", viaSsh.split(/\s+/).slice(1), isLocalHost) !== null
  ) {
    return "`mosh --ssh`";
  }
  const target = read.values.get("--host") ?? read.host;
  if (target === undefined) return null;
  const host = hostOf(target);
  return place(host, isLocalHost) === "local" ? null : `\`${prog}\` to another host`;
}

/**
 * What names another machine through a jump, a forward, a proxy or a session tool, or null: the label of the option, for the reason the
 * guard gives. `isLocalHost` says whether a host word is this machine.
 */
export function remoteHopReason(
  prog: string,
  args: readonly string[],
  isLocalHost: (host: string) => boolean,
): string | null {
  if (prog === "ssh" || prog === "scp" || prog === "sftp") {
    return sshFamilyHop(prog, args, isLocalHost);
  }
  if (prog === "mosh" || prog === "et") return sessionToolHop(prog, args, isLocalHost);
  return null;
}
