/**
 * Named subcommands of hosted-service CLIs that open a session, hand over production data or print a credential (wave 12 part E2, E2-6; round-9 R9-COMP-3).
 * ------------------------------------------------------------------------------------------------
 * `remote-access.ts` read `kubectl exec`, `gcloud sql connect`, `aws ssm start-session`, `heroku pg:psql` and the like; `heroku run bash`, `heroku ps:exec`,
 * `heroku pg:backups:download`, `heroku config`, `railway run`, `railway connect`, `render ssh`, `az webapp ssh`, `doctl databases connection`,
 * `aws ssm send-command` and `supabase db dump` (it dumps the LINKED project unless `--local`) passed. Each entry below is a SUBCOMMAND of its tool, not the
 * whole tool: `heroku logs`, `heroku apps`, `railway status`, `aws s3 ls`, `az account show` stay allowed, and a spelling this table does not list passes (a text
 * heuristic, like the rest of `remote-access.ts`). Every entry asks; what runs on the other side is not the guard's to read.
 *
 * What was read from an installed tool: `gcloud` (`gcloud compute|sql|cloud-shell|workstations --help` of the installed SDK: compute ssh, scp, config-ssh,
 * connect-to-serial-port, start-iap-tunnel, copy-files, reset-windows-password; cloud-shell ssh and scp; workstations ssh and start-tcp-tunnel; sql connect,
 * generate-login-token, export, import) and `kubectl` v1.36.1 (`kubectl --help`: proxy, and `create token`). heroku, railway, render, az, doctl, aws, supabase
 * and fly are NOT installed here: their entries are from each tool's documentation and are UNVERIFIED against a binary. Pure.
 */

interface CloudRule {
  /** Tested on the first words after the tool's global options, joined by a space (a heroku `topic:command` is one word). */
  readonly words: RegExp;
  /** An option that makes the command local (`supabase db dump --local`). */
  readonly unless?: RegExp;
}

const rule = (words: RegExp, unless?: RegExp): CloudRule => ({
  words,
  ...(unless === undefined ? {} : { unless }),
});

/** fly: a shell or sftp session, a proxy, a machine console or exec, and `fly postgres|pg connect|proxy`. */
const FLY = /^(?:ssh|proxy|console|sftp|machines? exec|(?:postgres|pg) (?:connect|proxy))\b/;

const CLOUD_RULES: ReadonlyMap<string, readonly CloudRule[]> = new Map([
  [
    "heroku",
    [
      // a dyno shell or one-off dyno, a port forward or file copy out of a dyno, a production database client or its backup and credentials,
      // the config vars (they print the database URL), an API token, a redis client
      rule(
        /^(?:run(?::\S+)?|ps:(?:exec|forward|copy|socks)|pg:(?:psql|pull|push|copy|credentials(?::\S+)?|backups:(?:download|url)|connection-pooling:attach)|redis:(?:cli|credentials)|config(?::(?:get|set|unset|edit))?|auth:token|authorizations:create)\b/,
      ),
    ],
  ],
  [
    "railway",
    [rule(/^(?:run|connect|shell|ssh|variables?|vars?)\b/)], // run a command with the remote variables, a database shell, a service shell, the variables
  ],
  ["render", [rule(/^(?:ssh|psql)\b/)]],
  [
    "az",
    [
      rule(
        /^(?:(?:webapp|functionapp) ssh|webapp create-remote-connection|webapp deployment list-publishing-credentials|webapp config (?:appsettings|connection-string) list|containerapp (?:exec|ssh)|aks command|vm run-command|ssh (?:vm|arc)|network bastion (?:ssh|tunnel|rdp)|(?:postgres|mysql) flexible-server (?:connect|execute)|keyvault secret (?:show|list|download))\b/,
      ),
    ],
  ],
  [
    "doctl",
    [rule(/^(?:databases (?:connection|user)|compute ssh|kubernetes cluster kubeconfig)\b/)],
  ],
  [
    "aws",
    [
      // all of `rds`, `rds-data` (SQL over the Data API), a remote shell or command, secrets and parameters (decrypted on request), an instance-connect key, a token
      rule(
        /^(?:rds(?:-data)?(?= |$)|ssm (?:start-session|send-command|start-automation-execution|get-parameters?(?:-by-path)?)\b|ecs execute-command\b|secretsmanager get-secret-value\b|ec2-instance-connect (?:send-ssh-public-key|send-serial-console-ssh-public-key|open-tunnel)\b|ec2 get-password-data\b|eks get-token\b)/,
      ),
    ],
  ],
  [
    "supabase",
    [
      // a database command against the linked project (the default of dump, pull and push), its secrets and keys
      rule(/^db (?:dump|pull|push)\b/, /^--local$/),
      rule(/^(?:secrets (?:list|set|unset)|projects api-keys|link)\b/),
    ],
  ],
  [
    "gcloud",
    [
      rule(
        /^(?:compute (?:ssh|scp|config-ssh|connect-to-serial-port|start-iap-tunnel|copy-files|reset-windows-password)|cloud-shell (?:ssh|scp)|workstations (?:ssh|start-tcp-tunnel)|sql (?:connect|generate-login-token|export|import)|secrets versions access)\b/,
      ),
    ],
  ],
  ["fly", [rule(FLY)]],
  ["flyctl", [rule(FLY)]],
]);

/** gcloud's release tracks come before the group (`gcloud beta compute ssh`). */
const RELEASE_TRACK = /^(?:alpha|beta|preview)$/;

/** At most this many words are joined and tested: every entry is a group and a command, at most three words. */
const WORDS_READ = 4;

/**
 * The label of the command when `prog` with these words (its positionals after global options) is one of the named session subcommands, or null.
 * `args` are all the words, for an option that makes the command local.
 */
export function cloudCliReason(
  prog: string,
  words: readonly string[],
  args: readonly string[],
): string | null {
  const rules = CLOUD_RULES.get(prog);
  if (rules === undefined) return null;
  const read = prog === "gcloud" && RELEASE_TRACK.test(words[0] ?? "") ? words.slice(1) : words;
  const line = read.slice(0, WORDS_READ).join(" ");
  for (const entry of rules) {
    if (!entry.words.test(line)) continue;
    if (entry.unless !== undefined && args.some((a) => entry.unless?.test(a))) continue;
    return `\`${prog} ${read.slice(0, 2).join(" ")}\``;
  }
  return null;
}
