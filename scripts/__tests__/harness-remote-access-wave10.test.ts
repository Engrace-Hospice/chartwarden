/**
 * Wave 10 part A, A9 (R7-ADV-15, R7-CR-15). Two groups the round-7 reviewers showed to hide a command or a remote session:
 *
 * 1. Programs that open a shell, a tunnel or a database session on another machine (`kubectl exec POD -- CMD`, `kubectl port-forward|cp|
 *    debug|attach`, `docker -H`, `DOCKER_HOST=ssh://…`, `docker context use`, `gcloud sql connect`, `gcloud compute ssh`, `aws rds …`,
 *    `aws ssm start-session`, `fly postgres connect|proxy`, `fly ssh`, `heroku pg:psql`, `supabase db … --db-url|--linked`, `autossh`,
 *    `cloudflared access`) ask, whatever the command behind them, like a non-local ssh.
 * 2. The wrappers wave 9 listed as residual (`torify`, `tsocks`, `fakeroot`, `valgrind`, `setpriv`, `nsenter`, `sshpass`, `systemd-run`,
 *    `ltrace`, `dtruss`, `numactl`, `cpulimit`, `gdb --args`, `perf stat|record|trace`, `toybox`, `firejail`) are peeled; the property test
 *    of `harness-wrapper-grammar-wave10.test.ts` walks their tables too. `bwrap` (options with two values), `rlwrap`, `hyperfine`
 *    (every argument is a command line) and the stdin filters `ts` and `pv` stay residual.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { remoteAccessReason } from "../harness/remote-access";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("a remote session asks, whatever the command behind it", () => {
  it.each([
    "kubectl exec pod -- ls",
    "kubectl exec -it pod -- sh",
    "kubectl -n prod exec -it pod -- psql",
    "kubectl --namespace prod --context c exec pod -- true",
    "kubectl port-forward svc/db 5432:5432",
    "kubectl -n x port-forward pod 8080",
    "kubectl cp pod:/x /tmp/x",
    "kubectl debug pod -it --image=busybox",
    "kubectl attach pod -it",
    "docker -H ssh://host ps",
    "docker --host tcp://h:2375 ps",
    "docker -Htcp://h:2375 ps",
    "docker -H ssh://host compose up",
    "DOCKER_HOST=ssh://host docker ps",
    "DOCKER_HOST=tcp://h:2375 docker ps",
    "docker context use prod",
    "podman context use prod",
    "gcloud sql connect db",
    "gcloud --project p sql connect db",
    "gcloud compute ssh vm",
    "gcloud compute scp a vm:/tmp",
    "aws rds describe-db-instances",
    "aws --profile p rds modify-db-instance",
    "aws ssm start-session --target i-1",
    "aws ecs execute-command --cluster c --task t --command sh",
    "fly postgres connect -a x",
    "fly pg proxy -a x",
    "fly ssh console",
    "fly proxy 5432",
    "flyctl ssh console",
    "heroku pg:psql",
    "heroku pg:psql -a app",
    "supabase db push --linked",
    `supabase db dump --db-url postgres://${HOST}/x`,
    "autossh -M 0 host",
    "cloudflared access tcp --hostname x",
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("the read-only and local forms stay allowed", () => {
    for (const cmd of [
      "kubectl get pods",
      "kubectl -n x logs pod",
      "kubectl apply --dry-run=client -f x.yaml",
      "kubectl config get-contexts",
      "docker ps",
      "docker context ls",
      "docker context show",
      "docker exec api ls",
      "docker compose up -d",
      "docker -c default ps",
      "gcloud compute instances list",
      "gcloud sql instances list",
      "aws s3 ls",
      "aws sts get-caller-identity",
      "fly status",
      "fly logs",
      "heroku logs",
      "supabase db reset",
      "supabase start",
      "cloudflared tunnel list",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("remoteAccessReason is null for anything else and says what it is for the rest", () => {
    expect(remoteAccessReason("ls", ["-la"])).toBeNull();
    expect(remoteAccessReason("kubectl", ["get", "pods"])).toBeNull();
    expect(remoteAccessReason("kubectl", ["exec", "p"])).toContain("kubectl exec");
    expect(remoteAccessReason("docker", ["ps"], ["DOCKER_HOST=ssh://h"])).toContain("DOCKER_HOST");
  });
});

describe("the wrappers wave 9 listed as residual are peeled", () => {
  const GUARDED: ReadonlyArray<readonly [string, string]> = [
    ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
    ["a protected write", "cp /tmp/x .claude/settings.json"],
    ["a secret read", `cat ${ENV_FILE}`],
  ];
  it.each([
    "torify",
    "tsocks",
    "toybox",
    "firejail --noprofile",
    "valgrind --tool=memcheck",
    "valgrind -q",
    "fakeroot",
    "fakeroot -u",
    "fakeroot -i /tmp/save",
    "setpriv --reuid=1000",
    "setpriv --reuid 1000",
    "nsenter -t 1 -m",
    "nsenter --target 1",
    "sshpass -p x",
    "sshpass -e",
    "systemd-run --user",
    "systemd-run --property=Nice=5",
    "ltrace -o /tmp/l",
    "ltrace -f",
    "dtruss -f",
    "dtruss -t open",
    "numactl --cpunodebind=0",
    "numactl -C 0",
    "cpulimit -l 50 --",
    "cpulimit --limit 50 --",
    "gdb --args",
    "gdb -q --args",
    "gdb -ex run --args",
    "perf stat --",
    "perf stat",
    "perf record -o /tmp/p",
    "perf trace",
  ])("%s", (prefix) => {
    for (const [label, command] of GUARDED) {
      const alone = rank(command);
      const cmd = `${prefix} ${command}`;
      expect(rank(cmd), `${label}: ${cmd}`).toBeGreaterThanOrEqual(alone);
    }
  });

  it("sshpass reads the password file it is given like `cat`", () => {
    expect(decide(`sshpass -f ${ENV_FILE} ssh host ls`)).toBe("deny");
  });

  it("the everyday uses stay allowed", () => {
    for (const cmd of [
      "valgrind ./a.out",
      "fakeroot make",
      "numactl --hardware",
      "gdb prog core",
      // without --args the words are a program to debug and a core file, not a command that runs
      "gdb git push origin main",
      "gdb -q prog",
      "perf report",
      "perf stat ls",
      "perf record -o /tmp/p ls",
      "torify curl http://example.org",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
