/**
 * Wave 12 part E2, E2-6 (R9-COMP-3): remote-session tools are a list of NAMED SUBCOMMANDS, not whole tools. `heroku run bash`, `heroku ps:exec`,
 * `heroku pg:backups:download`, `heroku config`, `railway run`, `railway connect`, `render ssh`, `az webapp ssh`, `doctl databases connection`,
 * `aws ssm send-command`, `supabase db dump` (the linked project, unless `--local`) and their same-family spellings ask; `heroku logs`, `heroku apps`,
 * `railway status`, `aws s3 ls` and the like stay allowed. gcloud and kubectl are installed here, so their command names are proven against their own
 * `--help`; heroku, railway, render, az, doctl, aws, supabase and fly are not installed: their entries are from the tools' documentation (unverified).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudCliReason } from "../harness/cloud-cli-sessions";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

/** One row per command that must ask: the tool and the command line. */
const ASKS: Readonly<Record<string, readonly string[]>> = {
  heroku: [
    "heroku run bash",
    "heroku run -a myapp rails console",
    "heroku run:detached rake db:migrate",
    "heroku ps:exec",
    "heroku ps:exec -a myapp",
    "heroku ps:forward 8080",
    "heroku ps:copy /tmp/x",
    "heroku ps:socks",
    "heroku pg:backups:download",
    "heroku pg:backups:url b001",
    "heroku pg:psql",
    "heroku pg:pull DATABASE_URL local",
    "heroku pg:push local DATABASE_URL",
    "heroku pg:copy a b",
    "heroku pg:credentials DATABASE",
    "heroku pg:credentials:url DATABASE",
    "heroku redis:cli",
    "heroku config",
    "heroku config -a myapp",
    "heroku config:get DATABASE_URL",
    "heroku config:set X=1",
    "heroku config:unset X",
    "heroku auth:token",
    "heroku -a myapp config",
    "heroku --app myapp ps:exec",
  ],
  railway: [
    "railway run bash",
    "railway run npm start",
    "railway connect",
    "railway connect postgres",
    "railway shell",
    "railway ssh",
    "railway variables",
    "railway variables --kv",
    "railway vars",
  ],
  render: ["render ssh x", "render psql x"],
  az: [
    "az webapp ssh -n x",
    "az webapp create-remote-connection -n x",
    "az webapp config appsettings list -n x",
    "az webapp config connection-string list -n x",
    "az webapp deployment list-publishing-credentials -n x",
    "az functionapp ssh -n x",
    "az containerapp exec -n x",
    "az containerapp ssh -n x",
    "az aks command invoke -n x",
    "az vm run-command invoke -n x",
    "az ssh vm -n x",
    "az network bastion ssh -n x",
    "az network bastion tunnel -n x",
    "az postgres flexible-server connect -n x",
    "az postgres flexible-server execute -n x",
    "az mysql flexible-server connect -n x",
    "az keyvault secret show --name x",
    "az keyvault secret list --vault-name x",
    "az --subscription s webapp ssh -n x",
    "az --subscription s2 --output json webapp ssh -n x",
    "az --query x webapp ssh -n y",
    "az -o json webapp ssh -n x",
  ],
  doctl: [
    "doctl databases connection x",
    "doctl databases user list x",
    "doctl compute ssh d",
    "doctl kubernetes cluster kubeconfig save x",
    "doctl -t token databases connection x",
    "doctl --context c compute ssh d",
  ],
  aws: [
    "aws ssm send-command --instance-ids i-1 --document-name x",
    "aws ssm start-session --target i-1",
    "aws ssm start-automation-execution --document-name x",
    "aws ssm get-parameter --name x --with-decryption",
    "aws ssm get-parameters --names x",
    "aws ssm get-parameters-by-path --path /x",
    "aws ecs execute-command --cluster c --task t",
    "aws secretsmanager get-secret-value --secret-id x",
    "aws ec2-instance-connect send-ssh-public-key --instance-id i",
    "aws ec2-instance-connect open-tunnel --instance-id i",
    "aws ec2 get-password-data --instance-id i",
    "aws eks get-token --cluster-name c",
    "aws rds describe-db-instances",
    "aws rds-data execute-statement --sql x",
    "aws rds-data batch-execute-statement --sql x",
    "aws rds-data begin-transaction",
    "aws --profile p --region r ssm send-command --instance-ids i-1",
  ],
  supabase: [
    "supabase db dump",
    "supabase db dump -f x.sql",
    "supabase db dump --data-only",
    "supabase db pull",
    "supabase db push",
    "supabase db push --linked",
    "supabase secrets list",
    "supabase secrets set X=1",
    "supabase secrets unset X",
    "supabase projects api-keys",
    "supabase link --project-ref x",
    "supabase db diff --linked",
    "supabase db reset --db-url x",
  ],
  gcloud: [
    "gcloud compute ssh vm",
    "gcloud compute scp a vm:b",
    "gcloud compute config-ssh",
    "gcloud compute connect-to-serial-port vm",
    "gcloud compute start-iap-tunnel vm 22",
    "gcloud compute copy-files a vm:b",
    "gcloud compute reset-windows-password vm",
    "gcloud cloud-shell ssh",
    "gcloud cloud-shell scp a cloudshell:b",
    "gcloud workstations ssh w",
    "gcloud workstations start-tcp-tunnel w 22",
    "gcloud sql connect i",
    "gcloud sql generate-login-token",
    "gcloud sql export sql i gs://b/f",
    "gcloud sql import sql i gs://b/f",
    "gcloud secrets versions access latest --secret=x",
    "gcloud beta compute ssh vm",
    "gcloud alpha sql connect i",
    "gcloud --project p beta compute ssh vm",
    "gcloud --account a --project p sql connect i",
  ],
  kubectl: [
    "kubectl exec pod -- ls",
    "kubectl proxy",
    "kubectl proxy --port 8001",
    "kubectl create token sa",
    "kubectl -n x create token sa",
    "kubectl get secret x",
    "kubectl get --raw /api/v1/namespaces/x/secrets",
    "kubectl get --raw=/api/v1/namespaces/x/secrets",
    "kubectl get --raw /api/v1/secrets",
  ],
  fly: [
    "fly ssh console",
    "fly proxy 5432",
    "fly console",
    "fly sftp shell",
    "fly machine exec m ls",
    "fly postgres connect -a x",
    "flyctl ssh console",
    "fly pg connect -a x",
    "fly postgres proxy -a x",
    "flyctl postgres connect -a x",
    "flyctl pg proxy",
  ],
};

/** The everyday neighbours of each tool: they stay allowed. */
const ALLOWS: Readonly<Record<string, readonly string[]>> = {
  heroku: [
    "heroku logs --tail",
    "heroku logs -a myapp",
    "heroku apps",
    "heroku ps",
    "heroku ps -a myapp",
    "heroku ps:scale web=1",
    "heroku releases -a x",
    "heroku --version",
    "heroku help",
    "heroku configure",
    "heroku running",
  ],
  railway: [
    "railway status",
    "railway logs",
    "railway up",
    "railway whoami",
    "railway link",
    "railway running",
  ],
  render: ["render services", "render deploys list", "render --version", "render logs"],
  az: [
    "az account show",
    "az group list",
    "az webapp list",
    "az vm list",
    "az --version",
    "az login",
    "az keyvault list",
  ],
  doctl: [
    "doctl databases list",
    "doctl compute droplet list",
    "doctl account get",
    "doctl apps list",
  ],
  aws: [
    "aws s3 ls",
    "aws s3 cp a s3://b/c",
    "aws sts get-caller-identity",
    "aws ec2 describe-instances",
    "aws ssm describe-parameters",
    "aws secretsmanager list-secrets",
    "aws --version",
    "aws configure list",
    "aws lambda list-functions",
    "aws rdsx help",
  ],
  supabase: [
    "supabase start",
    "supabase stop",
    "supabase status",
    "supabase db dump --local",
    "supabase db pull --local",
    "supabase db push --local",
    "supabase db reset",
    "supabase db lint",
    "supabase migration new x",
    "supabase migration list",
    "supabase functions serve",
    "supabase init",
  ],
  gcloud: [
    "gcloud compute instances list",
    "gcloud auth list",
    "gcloud config list",
    "gcloud projects list",
    "gcloud sql instances list",
    "gcloud secrets list",
    "gcloud --version",
    "gcloud run services list",
  ],
  kubectl: [
    "kubectl get pods",
    "kubectl get pods -n x",
    "kubectl get --raw /healthz",
    "kubectl create namespace x",
    "kubectl describe pod x",
    "kubectl logs pod",
    "kubectl config get-contexts",
    "kubectl version --client",
  ],
  fly: ["fly status", "fly logs", "fly apps list", "fly version"],
};

describe("E2-6: the named subcommands of the hosted-service CLIs ask", () => {
  for (const [tool, commands] of Object.entries(ASKS)) {
    for (const command of commands) {
      it(`${command} asks`, () => {
        expect(decide(command), `${tool}: ${command}`).toBe("ask");
      });
    }
  }
});

describe("E2-6: a raw API read of one secret is refused, not allowed", () => {
  it("kubectl get --raw of a named secret is at least an ask (another rule denies a secrets path)", () => {
    expect(["ask", "deny"]).toContain(decide("kubectl get --raw /api/v1/namespaces/x/secrets/y"));
  });
});

describe("E2-6: the everyday neighbours of those tools stay allowed", () => {
  for (const [tool, commands] of Object.entries(ALLOWS)) {
    for (const command of commands) {
      it(`${command} is allowed`, () => {
        expect(decide(command), `${tool}: ${command}`).toBe("allow");
      });
    }
  }
});

describe("E2-6: the table reads a subcommand, not a tool", () => {
  it("the label names the tool and the first words of the command", () => {
    expect(cloudCliReason("heroku", ["run", "bash"], ["run", "bash"])).toBe("`heroku run bash`");
    expect(cloudCliReason("heroku", ["logs"], ["logs", "--tail"])).toBeNull();
    expect(cloudCliReason("gcloud", ["beta", "compute", "ssh", "vm"], [])).toBe(
      "`gcloud compute ssh`",
    );
    expect(cloudCliReason("unknown", ["run", "bash"], [])).toBeNull();
  });

  it("an option that makes supabase db dump local lifts the ask, and only that", () => {
    expect(cloudCliReason("supabase", ["db", "dump"], ["db", "dump", "--local"])).toBeNull();
    expect(cloudCliReason("supabase", ["db", "dump"], ["db", "dump", "--linked"])).not.toBeNull();
    expect(cloudCliReason("supabase", ["db", "dump"], ["db", "dump"])).not.toBeNull();
  });

  it("a command after `--`, and words past the fourth, do not make a neighbour ask", () => {
    expect(decide("heroku logs -- run bash")).toBe("allow");
    expect(decide("aws s3 ls s3://bucket/ssm/send-command")).toBe("allow");
  });

  it("another program with the same word is untouched", () => {
    expect(decide("echo heroku run bash")).toBe("allow");
    expect(decide("git config --get run")).toBe("allow");
    expect(decide("bun run test")).toBe("allow");
    expect(decide("make run")).toBe("allow");
  });
});

/** A scrubbed environment: no credentials, a scratch HOME and config directory, proxies at a closed local port. */
const SCRATCH = mkdtempSync(join(tmpdir(), "cw-cloud-help-"));
const scrubbed = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: SCRATCH,
  LANG: "C",
  CLOUDSDK_CONFIG: join(SCRATCH, "gcloud"),
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
  KUBECONFIG: join(SCRATCH, "none"),
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  PAGER: "cat",
};
const installed = (tool: string): boolean =>
  spawnSync(tool, ["--version"], { encoding: "utf8", env: scrubbed, timeout: 60_000 }).error ===
  undefined;
const helpOf = (tool: string, args: string[]): string =>
  spawnSync(tool, args, { encoding: "utf8", env: scrubbed, timeout: 120_000 })
    .stdout // biome-ignore lint/suspicious/noControlCharactersInRegex: strip the ANSI colour codes of gcloud's help
    .replace(/\x1b\[[0-9;]*m/g, "");

describe("E2-6: the command names are in the installed tools' own help (--help only; nothing runs)", () => {
  const GCLOUD = installed("gcloud");
  const KUBECTL = installed("kubectl");
  const GCLOUD_HELP: ReadonlyArray<readonly [string[], string[]]> = [
    [
      ["compute"],
      [
        "config-ssh",
        "connect-to-serial-port",
        "copy-files",
        "reset-windows-password",
        "scp",
        "ssh",
        "start-iap-tunnel",
      ],
    ],
    [["cloud-shell"], ["scp", "ssh"]],
    [["workstations"], ["ssh", "start-tcp-tunnel"]],
    [["sql"], ["connect", "generate-login-token", "export", "import"]],
  ];
  for (const [group, names] of GCLOUD_HELP) {
    it.skipIf(!GCLOUD)(
      `gcloud ${group.join(" ")} --help lists ${names.join(", ")} (skipped only without gcloud)`,
      () => {
        const help = helpOf("gcloud", [...group, "--help"]);
        for (const name of names)
          expect(help, `gcloud ${group.join(" ")} ${name}`).toMatch(
            new RegExp(`^\\s+${name}\\s*$`, "m"),
          );
      },
    );
  }
  it.skipIf(!KUBECTL)(
    "kubectl --help lists proxy, and kubectl create --help lists token (skipped only without kubectl)",
    () => {
      expect(helpOf("kubectl", ["--help"])).toMatch(/^\s+proxy\s/m);
      expect(helpOf("kubectl", ["create", "--help"])).toMatch(/^\s+token\s/m);
    },
  );
});
