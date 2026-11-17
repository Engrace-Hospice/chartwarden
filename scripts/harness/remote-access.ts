/**
 * Programs that open a shell or a tunnel on another machine (wave 10, A9; round-7 R7-ADV-15). A non-local `ssh` asks, and so does
 * `docker exec`; the same access through `kubectl exec POD -- CMD`, `kubectl port-forward|cp|debug|attach`, `docker -H host`,
 * `DOCKER_HOST=ssh://…`, `docker context use`, `gcloud sql connect`, `gcloud compute ssh`, `aws rds …`, `aws ssm start-session`,
 * `fly postgres connect|proxy`, `fly ssh`, `heroku pg:psql`, `supabase db … --db-url|--linked`, `autossh` and `cloudflared access`
 * was never read. What runs on the other side is not the guard's to read (a remote command names that machine's files, and a
 * database reached through a tunnel is a database), so each of these ASKS, whatever the command behind it: a human decides, like
 * a non-local ssh. A text heuristic: a spelling this table does not know passes. Pure.
 */

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

const KUBECTL_REMOTE = new Set(["exec", "port-forward", "cp", "debug", "attach", "run"]);
/** `kubectl get secret`, `secrets`, `secret/NAME`, `pods,secrets`: the values of a cluster's secrets are printed (base64). */
const SECRET_RESOURCE = /(?:^|,)secrets?(?:\/|,|$)/;
const DOCKER_ENGINES = new Set(["docker", "podman", "nerdctl"]);
const REMOTE_DOCKER_HOST = /^DOCKER_HOST=(?:ssh|tcp):\/\//i;
const DOCKER_HOST_OPTION = /^(?:-H|--host)(?:=|$)|^-H.+/;

const DOCKER_VALUE_OPTION =
  /^(?:-c|--context|-l|--log-level|--config|--tlscacert|--tlscert|--tlskey|-n|--namespace|-a|--address)$/;
/** The contexts that name the engine on THIS machine (Docker Desktop, colima, OrbStack, Rancher Desktop, the default). */
const LOCAL_CONTEXT =
  /^(?:default|desktop-linux|desktop-windows|colima(?:-.*)?|orbstack|rancher-desktop)$/;
const CONTEXT_OPTION = /^(?:-c|--context)(?:=(.*))?$/;
const CONTEXT_VARIABLE = /^DOCKER_CONTEXT=(.*)$/;
/**
 * `docker -H host …`, `docker --context prod …`, `DOCKER_HOST=ssh://… docker …`, `DOCKER_CONTEXT=prod docker …`, `docker context use X`: the
 * options before the subcommand are read (nerdctl's `-n NAMESPACE` and `-a ADDRESS` take a value too).
 */
function dockerReason(args: readonly string[], assigns: readonly string[]): string | null {
  if (assigns.some((a) => REMOTE_DOCKER_HOST.test(a))) {
    return reason("A docker command on a remote DOCKER_HOST");
  }
  for (const assign of assigns) {
    const named = CONTEXT_VARIABLE.exec(assign)?.[1];
    if (named !== undefined && !LOCAL_CONTEXT.test(named)) return reason("`DOCKER_CONTEXT`");
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (DOCKER_HOST_OPTION.test(a)) return reason("`docker -H`");
    const context = CONTEXT_OPTION.exec(a);
    if (context !== null) {
      const named = context[1] ?? args[k + 1] ?? "";
      if (!LOCAL_CONTEXT.test(named)) return reason("`docker --context`");
    }
    if (!a.startsWith("-")) {
      return a === "context" && args[k + 1] === "use" ? reason("`docker context use`") : null;
    }
    if (DOCKER_VALUE_OPTION.test(a)) k++;
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

/**
 * Why this command opens a remote session, or null. `assigns` are the `NAME=value` words in front of the program.
 */
export function remoteAccessReason(
  prog: string,
  args: readonly string[],
  assigns: readonly string[] = [],
): string | null {
  if (prog === "podman" && args[0] === "machine" && args[1] === "ssh")
    return reason("`podman machine ssh`");
  if (DOCKER_ENGINES.has(prog)) return dockerReason(args, assigns);
  if (prog === "autossh") return reason("`autossh`");
  const words = positionals(prog, args);
  const [first, second] = words;
  const session = SESSION_TOOLS.get(prog);
  if (session?.(first, second) === true) return reason(`\`${prog} ${first}\``);
  switch (prog) {
    case "kubectl":
      if (first === "get" && words.slice(1).some((w) => SECRET_RESOURCE.test(w))) {
        return reason(
          "`kubectl get secret` prints a cluster's secrets, and the cluster is another machine, which",
        );
      }
      if (first === "config" && second === "view" && args.includes("--raw")) {
        return reason(
          "`kubectl config view --raw` prints the cluster credentials, and a cluster is another machine, which",
        );
      }
      return first !== undefined && KUBECTL_REMOTE.has(first)
        ? reason(`\`kubectl ${first}\``)
        : null;
    case "gcloud":
      return (first === "sql" && second === "connect") ||
        (first === "compute" && (second === "ssh" || second === "scp"))
        ? reason(`\`gcloud ${first} ${second}\``)
        : null;
    case "aws":
      return first === "rds" ||
        (first === "ssm" && second === "start-session") ||
        (first === "ecs" && second === "execute-command")
        ? reason(`\`aws ${first}${second === undefined ? "" : ` ${second}`}\``)
        : null;
    case "fly":
    case "flyctl":
      return first === "ssh" ||
        first === "proxy" ||
        ((first === "postgres" || first === "pg") && (second === "connect" || second === "proxy"))
        ? reason(`\`${prog} ${first}\``)
        : null;
    case "heroku":
      return words.some((w) => w === "pg:psql" || w === "pg:pull" || w === "pg:push")
        ? reason("`heroku pg:psql`")
        : null;
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
