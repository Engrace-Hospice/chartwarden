/**
 * Programs that open a shell or a tunnel on another machine (wave 10, A9; round-7 R7-ADV-15; wave 12 part E2). A non-local `ssh` asks, and so does
 * `docker exec`; the same access through `kubectl exec POD -- CMD`, `kubectl port-forward|cp|debug|attach|proxy`, `docker -H host`, `podman --connection|--url|-r`,
 * `DOCKER_HOST=ssh://…` and `CONTAINER_HOST=…` (set for the command or exported earlier), `docker context use`, `autossh` and `cloudflared access` was never read.
 * The hosted-service CLIs (`heroku`, `railway`, `render`, `az`, `doctl`, `aws`, `supabase`, `gcloud`, `fly`) are NAMED SUBCOMMANDS, kept in `cloud-cli-sessions.ts`
 * (`heroku run`, `heroku config`, `gcloud sql connect`, `aws ssm send-command`, `supabase db dump`, …: other spellings pass); a jump host, forward or proxy of ssh,
 * scp, sftp, mosh and et that names another machine is `ssh-hops.ts`. What runs on the other side is not the guard's to read (a remote command names that machine's
 * files, and a database reached through a tunnel is a database), so each of these ASKS, whatever the command behind it: a human decides, like a non-local ssh. A text
 * heuristic: a spelling this table does not know passes. Pure.
 */

import { cloudCliReason } from "./cloud-cli-sessions";
import { remoteHopReason } from "./ssh-hops";

/** The value options that stand before a subcommand and must not be read as one (`kubectl -n prod exec …`). */
const VALUE_OPTION: ReadonlyMap<string, RegExp> = new Map([
  [
    "kubectl",
    /^(?:-n|--namespace|--context|--kubeconfig|-s|--server|--cluster|--user|--as|--as-group|--token|--certificate-authority|--client-certificate|--client-key|--request-timeout|--cache-dir|--tls-server-name|--profile|--profile-output|-v|--v)$/,
  ],
  [
    "gcloud",
    /^--(?:project|account|configuration|billing-project|impersonate-service-account|verbosity|format|filter)$/,
  ],
  [
    "aws",
    /^--(?:profile|region|endpoint-url|output|query|ca-bundle|cli-read-timeout|cli-connect-timeout)$/,
  ],
  ["fly", /^(?:-a|--app|-c|--config|-o|--org|-r|--region|-t|--access-token)$/],
  ["flyctl", /^(?:-a|--app|-c|--config|-o|--org|-r|--region|-t|--access-token)$/],
  ["heroku", /^(?:-a|--app|-r|--remote)$/],
  ["az", /^(?:--subscription|-o|--output|--query)$/],
  ["doctl", /^(?:-t|--access-token|--context|-o|--output|--format|-c|--config)$/],
  ["railway", /^(?:-s|--service|-e|--environment|-p|--project)$/],
  ["render", /^(?:-o|--output|--config|--profile)$/],
  ["supabase", /^(?:--workdir|--experimental|-o|--output|--db-url|--project-ref)$/],
  ["cloudflared", /^(?:--config|--origincert|--loglevel|--logfile)$/],
]);

/** The words of `args` that are not options and not the value of one the tool takes. */
function positionals(prog: string, args: readonly string[]): string[] {
  const valued = VALUE_OPTION.get(prog);
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") break;
    if (!a.startsWith("-")) out.push(a);
    else if (valued?.test(a) === true) k++;
  }
  return out;
}

const reason = (what: string): string =>
  `${what} opens a shell, a tunnel or a database session on another machine, which is the access a non-local ssh is. Agents do not reach production from a session; a human decides.`;

const KUBECTL_REMOTE = new Set(["exec", "port-forward", "cp", "debug", "attach", "run", "proxy"]);
const isRawOption = (a: string): boolean => a === "--raw" || a.startsWith("--raw=");
/** A raw API path that names secrets (`/api/v1/namespaces/x/secrets`, `…/secrets/name`). */
const RAW_SECRET_PATH = /\/secrets?(?:\/|$|\?)/;
/** `kubectl get secret`, `secrets`, `secret/NAME`, `pods,secrets`: the values of a cluster's secrets are printed (base64). */
const SECRET_RESOURCE = /(?:^|,)secrets?(?:\/|,|$)/;
const DOCKER_ENGINES = new Set(["docker", "podman", "nerdctl", "docker-compose", "podman-compose"]);
const COMPOSE_ENGINES = new Set(["docker-compose", "podman-compose"]);
/** `DOCKER_HOST` and podman's `CONTAINER_HOST` that point away from this machine (R9-ADV-13). */
const REMOTE_ENGINE_HOST = /^(?:DOCKER|CONTAINER)_HOST=(?:ssh|tcp):\/\//i;
/** podman's `--url URL`, docker's and podman's `-H HOST` and `--host HOST`: the engine is somewhere else. */
const ENGINE_HOST_OPTION = /^(?:-H|--host|--url)(?:=|$)|^-H.+/;
/** podman's `-r` and `--remote`: talk to the service of a named (usually remote) connection. */
const ENGINE_REMOTE_FLAG = /^(?:-r|--remote)$/;
/** podman's `--connection NAME` and `CONTAINER_CONNECTION=NAME`: a named service; the machine's own default connection is this machine. */
const CONNECTION_OPTION = /^--connection(?:=(.*))?$/;
const CONNECTION_VARIABLE = /^CONTAINER_CONNECTION=(.*)$/;
const LOCAL_CONNECTION = /^podman-machine-default(?:-root)?$/;

/** The statement words that set one of the engine variables: `export NAME=v`, `declare -x NAME=v`, `NAME=v` as a statement. */
const ENGINE_VARIABLE = /^(?:DOCKER_HOST|CONTAINER_HOST|DOCKER_CONTEXT|CONTAINER_CONNECTION)\+?=/;
const ENGINE_SETTERS = /^(?:export|declare|typeset|readonly|local)$/;

/**
 * The engine variables a command line's own statements set (`export DOCKER_HOST=ssh://H; docker exec …`), read from the commands themselves with no cap
 * on how many statements come first (the variable tracker keeps 256 words: a 3,000-statement padding must not hide this one). Pure.
 */
export function engineVariableWords(
  parts: ReadonlyArray<{ prog: string; args: readonly string[]; assigns: readonly string[] }>,
): string[] {
  const words: string[] = [];
  for (const part of parts) {
    if (ENGINE_SETTERS.test(part.prog)) words.push(...part.assigns, ...part.args);
    else if (part.prog === "") words.push(...part.assigns);
  }
  return words.filter((w) => ENGINE_VARIABLE.test(w));
}

/** The options that take a value and stand before the subcommand (docker, podman, nerdctl `--help`), so the value is not read as the subcommand. */
const DOCKER_VALUE_OPTION =
  /^(?:-c|--context|-l|--log-level|--config|--tlscacert|--tlscert|--tlskey|-n|--namespace|-a|--address|--identity|--root|--runroot|--storage-driver|--storage-opt|--tmpdir|--cgroup-manager|--conmon|--events-backend|--hooks-dir|--imagestore|--module|--network-cmd-path|--network-config-dir|--out|--ssh|--cloud)$/;
/** `docker-compose`'s own value options before the subcommand. */
const COMPOSE_VALUE_OPTION =
  /^(?:-f|--file|-p|--project-name|--project-directory|--env-file|--profile|--ansi|--parallel|--progress)$/;
/** The contexts that name the engine on THIS machine (Docker Desktop, colima, OrbStack, Rancher Desktop, the default). */
const LOCAL_CONTEXT =
  /^(?:default|desktop-linux|desktop-windows|colima(?:-.*)?|orbstack|rancher-desktop)$/;
const CONTEXT_OPTION = /^(?:-c|--context)(?:=(.*))?$/;
const CONTEXT_VARIABLE = /^DOCKER_CONTEXT=(.*)$/;
/**
 * `docker -H host …`, `docker --context prod …`, `DOCKER_HOST=ssh://… docker …`, `DOCKER_CONTEXT=prod docker …`, `docker context use X`: the
 * options before the subcommand are read (nerdctl's `-n NAMESPACE` and `-a ADDRESS` take a value too).
 */
function dockerReason(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
): string | null {
  return engineVariableReason(assigns) ?? engineOptionReason(prog, args);
}

/** `DOCKER_HOST=ssh://…`, `CONTAINER_HOST=…`, `DOCKER_CONTEXT=prod`, `CONTAINER_CONNECTION=prod`: set for the command or exported earlier. */
function engineVariableReason(assigns: readonly string[]): string | null {
  if (assigns.some((a) => REMOTE_ENGINE_HOST.test(a))) {
    return reason("A container command on a remote DOCKER_HOST or CONTAINER_HOST");
  }
  for (const assign of assigns) {
    const context = CONTEXT_VARIABLE.exec(assign)?.[1];
    if (context !== undefined && !LOCAL_CONTEXT.test(context)) return reason("`DOCKER_CONTEXT`");
    const connection = CONNECTION_VARIABLE.exec(assign)?.[1];
    if (connection !== undefined && connection !== "" && !LOCAL_CONNECTION.test(connection)) {
      return reason("`CONTAINER_CONNECTION`");
    }
  }
  return null;
}

/** The engine's own options before the subcommand: `-H`, `--host`, `--url`, `--connection`, `-r`, `--remote`, `--context`, and `context use`. */
function engineOptionReason(prog: string, args: readonly string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (ENGINE_HOST_OPTION.test(a)) return reason(`\`${prog} ${a.split("=")[0]}\``);
    if (ENGINE_REMOTE_FLAG.test(a)) return reason(`\`${prog} ${a}\``);
    const connection = CONNECTION_OPTION.exec(a);
    if (connection !== null) {
      const named = connection[1] ?? args[k + 1] ?? "";
      if (!LOCAL_CONNECTION.test(named)) return reason(`\`${prog} --connection\``);
    }
    const context = CONTEXT_OPTION.exec(a);
    if (context !== null) {
      const named = context[1] ?? args[k + 1] ?? "";
      if (!LOCAL_CONTEXT.test(named) && !LOCAL_CONNECTION.test(named)) {
        return reason(`\`${prog} --context\``);
      }
    }
    if (!a.startsWith("-")) {
      return a === "context" && args[k + 1] === "use" ? reason(`\`${prog} context use\``) : null;
    }
    if (
      DOCKER_VALUE_OPTION.test(a) ||
      (COMPOSE_ENGINES.has(prog) && COMPOSE_VALUE_OPTION.test(a))
    ) {
      k++;
    }
  }
  return null;
}

/** Tools that open a shell or run a command in a virtual machine or a container somewhere else: the first words that do it. */
const SESSION_TOOLS: ReadonlyMap<
  string,
  (first: string | undefined, second: string | undefined) => boolean
> = new Map([
  ["limactl", (first) => first === "shell"],
  ["colima", (first) => first === "ssh"],
  ["docker-machine", (first) => first === "ssh" || first === "scp"],
  ["minikube", (first) => first === "ssh"],
  ["multipass", (first) => first === "exec" || first === "shell" || first === "transfer"],
  ["vagrant", (first) => first === "ssh" || first === "winrm"],
  [
    "lxc",
    (first) => first === "exec" || first === "shell" || first === "console" || first === "file",
  ],
  [
    "incus",
    (first) => first === "exec" || first === "shell" || first === "console" || first === "file",
  ],
  [
    "oc",
    (first) =>
      ["exec", "rsh", "debug", "attach", "port-forward", "cp", "rsync"].includes(first ?? ""),
  ],
  ["ctr", (first, second) => first === "run" || (first === "task" && second === "exec")],
  ["crictl", (first) => ["exec", "attach", "port-forward", "run"].includes(first ?? "")],
  ["buildah", (first) => first === "run"],
  ["apptainer", (first) => ["exec", "run", "shell", "instance"].includes(first ?? "")],
  ["singularity", (first) => ["exec", "run", "shell", "instance"].includes(first ?? "")],
  // OrbStack runs ANY word that is no management subcommand in its Linux machine (`orb psql -h H`).
  ["orb", (first) => first !== undefined && !ORB_MANAGEMENT.has(first)],
  ["orbctl", (first) => first !== undefined && !ORB_MANAGEMENT.has(first)],
]);
const ORB_MANAGEMENT = new Set(
  "help version status list ls info create delete rm start stop restart config update logs reset default docker k8s kubernetes".split(
    " ",
  ),
);

const secretsReason = (what: string): string =>
  `${what} prints the secrets or credentials of a cluster, which is another machine. Agents do not read secrets or reach production from a session; a human decides.`;

/** `kubectl exec|run|…` opens a session, `get secret` and `config view --raw` print what the cluster keeps secret. */
function kubectlReason(words: readonly string[], args: readonly string[]): string | null {
  const [first, second] = words;
  if (first === "get" && words.slice(1).some((w) => SECRET_RESOURCE.test(w))) {
    return secretsReason("`kubectl get secret`");
  }
  if (first === "config" && second === "view" && args.includes("--raw")) {
    return secretsReason("`kubectl config view --raw`");
  }
  // `kubectl create token` mints a service-account token; `kubectl get --raw /api/v1/namespaces/x/secrets` reads the API path directly (kubectl --help, v1.36.1).
  if (first === "create" && second === "token") return secretsReason("`kubectl create token`");
  if (first === "get" && args.some((a) => RAW_SECRET_PATH.test(a)) && args.some(isRawOption)) {
    return secretsReason("`kubectl get --raw` of a secrets path");
  }
  return first !== undefined && KUBECTL_REMOTE.has(first) ? reason(`\`kubectl ${first}\``) : null;
}

/**
 * Why this command opens a remote session, or null. `assigns` are the `NAME=value` words in front of the program.
 */
export function remoteAccessReason(
  prog: string,
  args: readonly string[],
  assigns: readonly string[] = [],
  isLocalHost: (host: string) => boolean = () => false,
): string | null {
  const hop = remoteHopReason(prog, args, isLocalHost);
  if (hop !== null) return reason(hop);
  if (prog === "podman" && args[0] === "machine" && args[1] === "ssh")
    return reason("`podman machine ssh`");
  if (DOCKER_ENGINES.has(prog)) return dockerReason(prog, args, assigns);
  if (prog === "autossh") return reason("`autossh`");
  const words = positionals(prog, args);
  const [first, second] = words;
  const session = SESSION_TOOLS.get(prog);
  if (session?.(first, second) === true) return reason(`\`${prog} ${first}\``);
  // The named subcommands of the hosted-service CLIs (`cloud-cli-sessions.ts`).
  const cloud = cloudCliReason(prog, words, args);
  if (cloud !== null) return reason(cloud);
  switch (prog) {
    case "kubectl":
      return kubectlReason(words, args);
    case "supabase":
      return first === "db" && args.some((a) => /^--(?:db-url|linked)(?:=|$)/.test(a))
        ? reason("`supabase db` against a remote database")
        : null;
    case "cloudflared":
      return first === "access" ? reason("`cloudflared access`") : null;
    default:
      return null;
  }
}
