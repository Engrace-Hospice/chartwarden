/**
 * The options that stand before the subcommand of `kubectl`, `gcloud` and `aws` (wave 13 part B2; round-10 B4 and CR-6).
 * ------------------------------------------------------------------------------------------------
 * `remote-access.ts` finds the subcommand of these tools (`kubectl exec`, `gcloud compute ssh`, `aws ssm start-session`) as the first word that is not an
 * option and not the value of one. A hand-written list of the valued options missed `kubectl --username u exec pod -- sh`, `--password`, `--as-uid`,
 * `--as-user-extra`, `--kuberc`, `--vmodule a=1`, `--log-flush-frequency 5s`, `gcloud --access-token-file x compute ssh vm`, `--flags-file`, `--trace-token`, and
 * `aws --cli-binary-format f ssm start-session`, `aws --color on ...`: the value of the missed option was read as the subcommand and the session passed.
 * The tables below are RECORDED (rule 12): kubectl from `kubectl options` (v1.36.1), gcloud from the GLOBAL FLAGS and OTHER FLAGS of `gcloud --help`
 * (Google Cloud SDK 561.0.0); the fixtures are in `scripts/__tests__/fixtures/harness-cloud-options/` and `helpers/record-cloud-options.ts` re-records them.
 * `aws` is NOT installed here: its list is from the AWS CLI documentation of the global options and UNVERIFIED against a binary.
 *
 * An option BEFORE the subcommand that the table does not know cannot be placed (is the next word its value or the subcommand?), so it ASKS: a human decides,
 * like every other case the guard cannot read. After the first subcommand word the options of the subcommand itself pass as flags (`kubectl get pods -o json`),
 * and the table's valued options still skip their value (`kubectl get pods -n prod`). Pure.
 */

export interface GlobalOptions {
  /** Options that take a value: `--name VALUE`, `--name=VALUE`, and for a short one `-nVALUE`. */
  readonly valued: ReadonlySet<string>;
  /** Options that take none (`--help`, `--debug`); `--name=VALUE` is read as one option either way. */
  readonly flags: ReadonlySet<string>;
  /** gcloud writes every boolean as `--flag` and `--no-flag`. */
  readonly negatable: boolean;
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(" ").filter(Boolean));

/** `kubectl options`, v1.36.1 (cobra adds `-h` and `--help`, which that list does not print). */
export const KUBECTL_OPTIONS: GlobalOptions = {
  valued: set(
    "-n --namespace -s --server -v --v --as --as-group --as-uid --as-user-extra --cache-dir --certificate-authority --client-certificate --client-key --cluster --context --kubeconfig --kuberc --log-flush-frequency --password --profile --profile-output --request-timeout --tls-server-name --token --user --username --vmodule",
  ),
  flags: set(
    "--disable-compression --insecure-skip-tls-verify --match-server-version --warnings-as-errors -h --help",
  ),
  negatable: false,
};

/** `gcloud --help`, Google Cloud SDK 561.0.0 (GLOBAL FLAGS and OTHER FLAGS), and `--filter`, which gcloud's listing commands take. */
export const GCLOUD_OPTIONS: GlobalOptions = {
  valued: set(
    "--account --billing-project --configuration --flags-file --flatten --format --project --verbosity --access-token-file --impersonate-service-account --trace-token --filter",
  ),
  flags: set("--help --quiet -q --version -v -h --log-http --user-output-enabled"),
  negatable: true,
};

/** The AWS CLI v2 documentation of the global options (UNVERIFIED: no aws binary is installed here). */
export const AWS_OPTIONS: GlobalOptions = {
  valued: set(
    "--profile --region --endpoint-url --output --query --ca-bundle --cli-read-timeout --cli-connect-timeout --cli-binary-format --color",
  ),
  flags: set(
    "--debug --no-verify-ssl --no-paginate --version --no-sign-request --no-cli-pager --cli-auto-prompt --no-cli-auto-prompt --help",
  ),
  negatable: false,
};

export const CLOUD_GLOBAL_OPTIONS: ReadonlyMap<string, GlobalOptions> = new Map([
  ["kubectl", KUBECTL_OPTIONS],
  ["gcloud", GCLOUD_OPTIONS],
  ["aws", AWS_OPTIONS],
]);

/** How a word relates to the table: it takes the next word, it stands alone, or the table does not know it. */
type Reading = "valued-next" | "complete" | "unknown";

function readOption(table: GlobalOptions, arg: string): Reading {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  const bare = table.negatable && name.startsWith("--no-") ? `--${name.slice(5)}` : name;
  if (table.valued.has(name)) return eq < 0 ? "valued-next" : "complete";
  if (table.flags.has(name) || table.flags.has(bare)) return "complete";
  // pflag and argparse read `-nprod` as `-n prod`: a short valued option with its value attached.
  if (/^-[A-Za-z]./.test(arg) && !arg.startsWith("--") && table.valued.has(arg.slice(0, 2))) {
    return "complete";
  }
  return "unknown";
}

/** The words of `args` that are not options and not the value of one the tool takes, and the first option before the subcommand the table does not know. */
export function readCloudWords(
  prog: string,
  args: readonly string[],
): { words: string[]; unknown: string | null } | null {
  const table = CLOUD_GLOBAL_OPTIONS.get(prog);
  if (table === undefined) return null;
  const words: string[] = [];
  let unknown: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") {
      words.push(a);
      continue;
    }
    const reading = readOption(table, a);
    if (reading === "valued-next") k++;
    else if (reading === "unknown" && words.length === 0) unknown ??= a;
  }
  return { words, unknown };
}
