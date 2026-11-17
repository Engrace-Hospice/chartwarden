/**
 * A command run in a fresh container (wave 10, A4; round-7 R7-ADV-7, R7-CR-15). `docker run --rm postgres:16 psql -h <host>`,
 * `docker compose run --rm migrate psql -h <host>`, `podman run IMAGE git push`, `docker run --entrypoint psql IMAGE -h <host>`,
 * `docker run -e PGHOST=<host> IMAGE psql`: the command behind the image runs here as far as the guard is concerned: a
 * client reaches the same database from a container as from the shell, and a push is a push. The old reader (`containerRun`
 * in `wrappers.ts`) judged the command only when a writable bind mount let it map paths back, so every other `run` passed
 * unread. This module finds the command behind the image (or the compose service) for `docker|podman|nerdctl [container]
 * run|create`, `docker|podman compose run` and `docker-compose|podman-compose run`, reading the options the way each tool's
 * own `--help` lists them (`option-grammar.ts`): the image is the first word that is no option or option value, an
 * `--entrypoint X` makes X the program, and `-e NAME=VALUE` becomes an assignment in front of the command so a database
 * variable set for the container is read like one set for the shell. An option the table does not know asks (rule 3 of
 * wave 10): the image word cannot be told from an option's value. `exec` (docker, podman, nerdctl, compose) is read here too since wave 11: the same options, the same `-e` assignments. Pure.
 */
import { type OptionGrammar, readOptions } from "./option-grammar";
import { shellQuote } from "./wrappers";

const grammar = (g: Partial<OptionGrammar>): OptionGrammar => ({
  flags: "",
  values: "",
  longFlags: [],
  longValues: [],
  ...g,
});

const words = (list: string): string[] => list.split(" ");

/**
 * `docker run --help` (read from the installed docker) united with `podman run --help`: nerdctl takes the same names. The first five value
 * options are older docker's (`--kernel-memory` is gone from docker 29, R8-CR-10): the installed docker rejects them, an older one reads them.
 */
export const RUN_GRAMMAR = grammar({
  exact: true,
  flags: "Pdiqt",
  values: "acehlmpuvw",
  longFlags: words(
    "detach help init interactive no-healthcheck oom-kill-disable privileged publish-all quiet read-only rm sig-proxy tty use-api-socket disable-content-trust http-proxy no-hostname no-hosts passwd read-only-tmpfs replace rmi rootfs tls-verify unsetenv-all",
  ),
  longValues: words(
    "kernel-memory cpu-count cpu-percent io-maxbandwidth io-maxiops add-host annotation arch attach authfile blkio-weight blkio-weight-device cap-add cap-drop cgroup-conf cgroup-parent cgroupns cgroups chrootdirs cidfile cpu-period cpu-quota cpu-rt-period cpu-rt-runtime cpu-shares cpus cpuset-cpus cpuset-mems creds detach-keys device device-cgroup-rule device-read-bps device-read-iops device-write-bps device-write-iops dns dns-option dns-search domainname entrypoint env env-file env-merge expose gidmap gpus group-add group-entry health-cmd health-interval health-log-destination health-max-log-count health-max-log-size health-on-failure health-retries health-start-interval health-start-period health-startup-cmd health-startup-interval health-startup-retries health-startup-success health-startup-timeout health-timeout hostname hosts-file hostuser image-volume init-path ip ip6 ipc isolation label label-file link link-local-ip log-driver log-opt mac-address memory memory-reservation memory-swap memory-swappiness mount name network network-alias oom-score-adj os passwd-entry personality pid pids-limit platform pod pod-id-file publish pull rdt-class requires restart retry retry-delay runtime sdnotify seccomp-policy secret security-opt shm-size shm-size-systemd stop-signal stop-timeout storage-opt subgidname subuidname sysctl systemd timeout tmpfs tz uidmap ulimit umask unsetenv user userns uts variant volume volume-driver volumes-from workdir",
  ),
});

/** `docker compose run --help`. */
export const COMPOSE_RUN_GRAMMAR = grammar({
  exact: true,
  flags: "PTdiq",
  values: "elpuvw",
  longFlags: words(
    "build detach dry-run interactive no-deps no-recreate no-tty quiet quiet-build quiet-pull remove-orphans rm service-ports use-aliases help",
  ),
  longValues: words(
    "cap-add cap-drop entrypoint env env-from-file label name publish pull user volume workdir",
  ),
});

/**
 * `docker exec --help`, `podman exec --help` (both installed here): nerdctl takes the same names. `-e NAME=VALUE` is read as an assignment in
 * front of the command exactly as it is for `run` (R8-ADV-5, R8-CR-4: `docker exec -e PGHOST=H db psql` reached the host unread).
 */
export const EXEC_GRAMMAR = grammar({
  exact: true,
  flags: "dit",
  values: "euw",
  longFlags: words("detach interactive privileged tty"),
  longValues: words("cidfile detach-keys env env-file preserve-fd user workdir"),
});

/** `docker compose exec --help`. */
export const COMPOSE_EXEC_GRAMMAR = grammar({
  exact: true,
  flags: "dT",
  values: "euw",
  longFlags: words("detach dry-run no-tty privileged"),
  longValues: words("env index user workdir"),
});

/** The options that come before the subcommand: `docker -H host run`, `docker compose -f x.yml run`, `podman --remote run`. */
const DOCKER_GLOBAL = grammar({
  flags: "Dv",
  // `-H HOST`, `-c CONTEXT`, `-l LEVEL`; nerdctl's `-n NAMESPACE` and `-a ADDRESS` (R8-ADV-10: `nerdctl -n k8s.io run IMG CMD`)
  values: "Hclna",
  lax: true,
  longFlags: words("debug tls tlsverify version help remote"),
  longValues: words(
    "cloud config context host log-level tlscacert tlscert tlskey connection identity url ssh root runroot storage-driver storage-opt tmpdir cgroup-manager conmon events-backend hooks-dir namespace network-cmd-path network-config-dir out imagestore module",
  ),
});

const COMPOSE_GLOBAL = grammar({
  values: "fp",
  lax: true,
  longFlags: words("all-resources compatibility dry-run"),
  longValues: words("ansi env-file file parallel profile progress project-directory project-name"),
});

const ENGINES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);
const COMPOSE_PROGRAMS: ReadonlySet<string> = new Set(["docker-compose", "podman-compose"]);

export interface ContainerCommand {
  /** The command the container runs, as one command line (`-e NAME=VALUE` assignments in front). */
  readonly command: string;
  /** Which subcommand it came from, for the question the guard asks about an option it cannot place. */
  readonly verb: "run" | "exec";
  /** A word of the run options the table could not place: the image cannot be told from an option's value. */
  readonly unplaced?: string;
}

/** The command behind the image of a `run`/`create` whose options start at `from`, or null when it names none. */
function commandBehind(
  options: OptionGrammar,
  args: readonly string[],
  from: number,
  verb: ContainerCommand["verb"] = "run",
): ContainerCommand | null {
  const read = readOptions(options, args, from);
  const image = args[read.end];
  if (image === undefined) return null;
  const entrypoint = read.options.filter((o) => o.name === "entrypoint").at(-1)?.value;
  const environment = read.options
    .filter((o) => (o.name === "e" || o.name === "env") && o.value?.includes("="))
    .map((o) => o.value as string);
  const behind = [
    ...environment,
    ...(entrypoint === undefined || entrypoint === "" ? [] : [entrypoint]),
    ...args.slice(read.end + 1),
  ];
  // Nothing after the image: the image's own command runs, which the guard cannot read.
  if (behind.length === environment.length) return null;
  return {
    command: behind.map(shellQuote).join(" "),
    verb,
    ...(read.unplaced === undefined ? {} : { unplaced: read.unplaced }),
  };
}

/**
 * `docker|podman|nerdctl run|create …`, `… container run|create …`, `… compose run …`, `docker-compose run …`: the command
 * behind the image or the service, or null for anything else.
 */
export function containerCommand(prog: string, args: readonly string[]): ContainerCommand | null {
  const compose = COMPOSE_PROGRAMS.has(prog);
  if (!compose && !ENGINES.has(prog)) return null;
  if (compose) return composeCommand(args, readOptions(COMPOSE_GLOBAL, args, 0).end);
  let at = readOptions(DOCKER_GLOBAL, args, 0).end;
  if (args[at] === "container") at++;
  const sub = args[at];
  if (sub === "run" || sub === "create") return commandBehind(RUN_GRAMMAR, args, at + 1);
  if (sub === "exec") return commandBehind(EXEC_GRAMMAR, args, at + 1, "exec");
  if (sub !== "compose") return null;
  return composeCommand(args, readOptions(COMPOSE_GLOBAL, args, at + 1).end);
}

/** `compose run|exec [options] SERVICE COMMAND…` with `at` at the subcommand. */
function composeCommand(args: readonly string[], at: number): ContainerCommand | null {
  if (args[at] === "run") return commandBehind(COMPOSE_RUN_GRAMMAR, args, at + 1);
  return args[at] === "exec" ? commandBehind(COMPOSE_EXEC_GRAMMAR, args, at + 1, "exec") : null;
}
