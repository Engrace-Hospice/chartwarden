/**
 * Wave 13 part B2, B4 and CR-6 (round 10): the global options of kubectl, gcloud and aws before the subcommand. A hand-written list missed
 * `kubectl --username u exec pod -- sh`, `--password`, `--as-uid`, `--as-user-extra`, `--kuberc`, `--vmodule a=1`, `--log-flush-frequency 5s`,
 * `gcloud --access-token-file x compute ssh vm`, `--flags-file`, `--trace-token`, and `aws --cli-binary-format f ssm start-session`, `aws --color on ...`:
 * the value of the missed option was read as the subcommand and the session passed. The tables are now recorded from the installed tools (rule 12;
 * `fixtures/harness-cloud-options/`), and an option before the subcommand that the table does not know ASKS.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AWS_OPTIONS,
  CLOUD_GLOBAL_OPTIONS,
  GCLOUD_OPTIONS,
  KUBECTL_OPTIONS,
  readCloudWords,
} from "../harness/cloud-global-options";
import { classifyBash } from "../harness/patterns";
import {
  type CloudFixture,
  FIXTURE_DIR,
  gcloudVersion,
  kubectlVersion,
  parseGcloudLines,
  parseKubectlLines,
  recordGcloud,
  recordKubectl,
} from "./helpers/record-cloud-options";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

const fixtures: CloudFixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as CloudFixture);

/** What a fixture's lines mean: the kubectl and gcloud lines are read by the recorder's parsers, the aws list by `=`. */
function parsed(fixture: CloudFixture): { valued: string[]; flags: string[] } {
  if (fixture.source === "kubectl options") return parseKubectlLines(fixture.lines) as never;
  if (fixture.source === "gcloud --help") return parseGcloudLines(fixture.lines) as never;
  const valued = fixture.lines.filter((l) => l.includes("=")).map((l) => l.split("=")[0] as string);
  const flags = fixture.lines.filter((l) => !l.includes("=")).map((l) => l);
  return { valued, flags };
}

/** What the table lists beyond the recording, each with its reason (cobra's help flags; gcloud's listing filter). */
const EXTRAS: Record<string, readonly string[]> = {
  kubectl: ["-h", "--help"],
  gcloud: ["--filter"],
  aws: ["--help"],
};

describe("rule 12: the production tables are the recorded ones (no tool needed)", () => {
  it("there are recordings of kubectl, gcloud and a documented aws list", () => {
    expect(fixtures.map((f) => f.tool).sort()).toEqual(["aws", "gcloud", "kubectl"]);
    expect(fixtures.find((f) => f.tool === "aws")?.unverified).toBe(true);
  });

  for (const fixture of fixtures) {
    const table = CLOUD_GLOBAL_OPTIONS.get(fixture.tool);
    it(`${fixture.tool} ${fixture.version}: every recorded valued option is valued and every recorded flag is a flag`, () => {
      expect(table).toBeDefined();
      const { valued, flags } = parsed(fixture);
      expect(valued.length).toBeGreaterThan(0);
      for (const name of valued) expect(table?.valued.has(name), `${name} valued`).toBe(true);
      for (const name of flags) {
        const bare = name.replace(/^--no-/, "--");
        expect(table?.flags.has(name) || table?.flags.has(bare), `${name} flag`).toBe(true);
      }
    });
    it(`${fixture.tool}: the table lists nothing the recording lacks except its named extras`, () => {
      const { valued, flags } = parsed(fixture);
      const recorded = new Set([...valued, ...flags]);
      const listed = [...(table?.valued ?? []), ...(table?.flags ?? [])];
      const extra = listed.filter((o) => !recorded.has(o) && !EXTRAS[fixture.tool]?.includes(o));
      expect(
        extra.filter((o) => !o.startsWith("--no-")),
        fixture.tool,
      ).toEqual(fixture.tool === "aws" ? [] : []);
    });
  }

  it("the three tables are the ones the module exports", () => {
    expect(CLOUD_GLOBAL_OPTIONS.get("kubectl")).toBe(KUBECTL_OPTIONS);
    expect(CLOUD_GLOBAL_OPTIONS.get("gcloud")).toBe(GCLOUD_OPTIONS);
    expect(CLOUD_GLOBAL_OPTIONS.get("aws")).toBe(AWS_OPTIONS);
  });
});

describe("rule 12 live: the installed tools still print the recorded options", () => {
  const live: Array<[string, () => string | undefined, () => CloudFixture | undefined]> = [
    ["kubectl", kubectlVersion, recordKubectl],
    ["gcloud", gcloudVersion, recordGcloud],
  ];
  for (const [tool, version, record] of live) {
    it(`${tool}`, (skipContext) => {
      const installed = version();
      const recorded = fixtures.find((f) => f.tool === tool);
      if (installed === undefined || recorded?.version !== installed) {
        skipContext.skip(
          `${tool} is ${installed ?? "not installed"} and the recording is ${recorded?.version}: run bun scripts/__tests__/helpers/record-cloud-options.ts --write`,
        );
        return;
      }
      expect(record()?.lines).toEqual(recorded.lines);
    });
  }
});

const SESSION = {
  kubectl: "exec pod -- sh",
  gcloud: "compute ssh vm",
  aws: "ssm start-session --target i-1",
} as const;

/** Each row: global options before a session subcommand. Every one placed the value of the option as the subcommand before this wave. */
const MISSED: Array<[string, keyof typeof SESSION]> = [
  ["--username u", "kubectl"],
  ["--password p", "kubectl"],
  ["--as-uid 1", "kubectl"],
  ["--as-user-extra k=v", "kubectl"],
  ["--kuberc f", "kubectl"],
  ["--vmodule a=1", "kubectl"],
  ["--log-flush-frequency 5s", "kubectl"],
  ["--cache-dir /tmp/c", "kubectl"],
  ["--tls-server-name x", "kubectl"],
  ["--disable-compression", "kubectl"],
  ["--as-group g", "kubectl"],
  ["-v 6", "kubectl"],
  ["-v=6", "kubectl"],
  ["-nprod", "kubectl"],
  ["--access-token-file x", "gcloud"],
  ["--flags-file f.yaml", "gcloud"],
  ["--trace-token t", "gcloud"],
  ["--flatten k", "gcloud"],
  ["--verbosity debug", "gcloud"],
  ["--no-user-output-enabled", "gcloud"],
  ["--log-http", "gcloud"],
  ["--quiet", "gcloud"],
  ["--cli-binary-format raw-in-base64-out", "aws"],
  ["--color on", "aws"],
  ["--no-cli-pager", "aws"],
  ["--debug", "aws"],
  ["--profile p --region r", "aws"],
];

describe("every recorded global option before a session subcommand still finds the subcommand", () => {
  it.each(MISSED)("%s: %s ... asks", (options, tool) => {
    expect(d(`${tool} ${options} ${SESSION[tool]}`)).toBe("ask");
  });

  it.each(MISSED)("%s: %s with the option after the program name and = form", (options, tool) => {
    const eq = options.replace(/^(--[\w-]+) (\S+)$/, "$1=$2");
    expect(d(`${tool} ${eq} ${SESSION[tool]}`)).toBe("ask");
  });

  it.each(Object.keys(SESSION) as Array<keyof typeof SESSION>)(
    "%s: the words are the subcommand, whichever options stand before it",
    (tool) => {
      const first = tool === "gcloud" ? "compute" : tool === "kubectl" ? "exec" : "ssm";
      for (const [options, t] of MISSED) {
        if (t !== tool) continue;
        const words = readCloudWords(tool, [...options.split(" "), ...SESSION[tool].split(" ")]);
        expect(words?.unknown, options).toBeNull();
        expect(words?.words[0], options).toBe(first);
      }
    },
  );
});

describe("an option before the subcommand that no table knows asks", () => {
  it.each([
    "kubectl --newopt x get pods",
    "kubectl --newopt=x get pods",
    "kubectl -Z get pods",
    "gcloud --newopt x config list",
    "gcloud --brand-new-flag config list",
    "aws --new-global x s3 ls",
    "aws --cli-new-option s3 ls",
  ])("%s", (command) => {
    expect(d(command)).toBe("ask");
  });

  it("the reason names the option and says the subcommand cannot be placed", () => {
    const reason = classifyBash("kubectl --newopt x get pods", ctx).reason;
    expect(reason).toMatch(/kubectl --newopt/);
    expect(reason).toMatch(/cannot tell which word is the subcommand/);
  });

  it("an unknown option after the subcommand is a flag of the subcommand and passes", () => {
    for (const command of [
      "kubectl get pods --show-labels --newopt",
      "kubectl get pods -o json -l app=web",
      "gcloud config list --format=json --newopt",
      "aws s3 ls --recursive --human-readable",
    ]) {
      expect(d(command), command).toBe("allow");
    }
  });
});

describe("everyday neighbours stay allow", () => {
  it.each([
    "kubectl get pods",
    "kubectl get pods -n prod",
    "kubectl -n prod get pods",
    "kubectl --namespace=prod get pods -o wide",
    "kubectl --context=minikube get nodes",
    "kubectl --kubeconfig ./kube.yaml get pods",
    "kubectl describe pod web-1",
    "kubectl logs deploy/web --tail=50",
    "kubectl logs -f web-1 -c app",
    "kubectl apply -f deploy.yaml --dry-run=client",
    "kubectl config get-contexts",
    "kubectl config current-context",
    "kubectl version --client",
    "kubectl --help",
    "kubectl -h",
    "kubectl -v=6 get pods",
    "kubectl --request-timeout=5s get pods",
    "kubectl --insecure-skip-tls-verify get pods",
    "kubectl top pods",
    "kubectl rollout status deploy/web",
    "gcloud config list",
    "gcloud --version",
    "gcloud --help",
    "gcloud --project my-proj compute instances list",
    "gcloud --format=json projects list",
    "gcloud --format json projects list",
    "gcloud --quiet components list",
    "gcloud auth list",
    "gcloud --account a@b.invalid config list",
    "gcloud --verbosity=debug config list",
    "gcloud --no-user-output-enabled config list",
    "gcloud --no-log-http config list",
    "gcloud --log-http config list",
    "gcloud --access-token-file ./t config list",
    "gcloud --flags-file ./f.yaml config list",
    "aws s3 ls",
    "aws --profile dev s3 ls",
    "aws --region us-east-1 ec2 describe-instances",
    "aws --version",
    "aws --debug s3 ls",
    "aws --color off s3 ls",
    "aws --no-cli-pager sts get-caller-identity",
    "aws --output json --query 'Reservations[]' ec2 describe-instances",
    "aws --endpoint-url http://localhost:4566 s3 ls",
    "aws --cli-read-timeout 5 s3 ls",
    "aws --no-sign-request s3 ls s3://bucket",
  ])("%s", (command) => {
    expect(d(command)).toBe("allow");
  });
});
