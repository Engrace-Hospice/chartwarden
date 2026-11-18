/**
 * Wave 3 (fixer W3b), ADV-M9 and ADV-L1: ways to read a secret that no file name gives away. Every payload under an
 * "asks" or "denies" heading answered `allow` at the base of this wave (the bare key-file names read after a `cd`
 * were already closed by the second wave; they are pinned here for the shapes the review listed). `classifyBash`
 * is pure: `exists` stands for the machine's files, here the live env files and a few keys.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import {
  environmentLeak,
  isSecretVariable,
  reachesLiveEnv,
  storedSecretVerdict,
} from "../harness/secret-reads";

const FILES = new Set([
  "/repo/.env",
  "/repo/apps/backend/.env",
  "/repo/deploy/production/.env.production",
  "/repo/deploy/production/tls/server.pem",
  "/repo/deploy/production/tls/tls.key",
  "/repo/apps/backend/id_rsa",
  "/repo/data/prod.dump",
]);
const exists = (p: string) => FILES.has(p.startsWith("/") ? p : `/repo/${p}`);
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;
const allowed = (cmd: string) => {
  const verdict = v(cmd);
  expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
};

describe("a recursive read, copy or archive of a directory that holds a live env file asks", () => {
  it.each([
    "grep -r . deploy/production",
    "grep -r x apps/",
    "grep -rn foo apps/backend",
    "grep --rec x apps",
    "grep --recur x apps",
    "grep --recursive x apps",
    "grep -d recurse x deploy",
    "grep --directories=recurse x apps",
    "rg -u foo deploy/production",
    "rg --hidden foo apps",
    "rg --no-ignore foo deploy/production",
    "cd deploy/production && grep -r x .",
    "cd apps && grep -rn foo .",
    "find apps -type f -exec cat {} +",
    "find deploy -type f -exec grep x {} +",
    "find . -type f -exec cat {} +",
    "find . -type f -exec grep x {} +",
    "cp -R . /tmp/x",
    "cp -r deploy/production /tmp/x",
    "cp -a apps /tmp/x",
    "rsync -a deploy/production /tmp/x",
    "rsync -avt deploy/production /tmp/x",
    "ditto deploy/production /tmp/x",
    "tar cf /tmp/x.tar deploy/production",
    "zip -r /tmp/x.zip apps",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "grep -r x docs",
    "grep -rn foo apps/web/src",
    "grep -rn foo apps/backend/src",
    "rg -u foo apps/web",
    "rg foo apps",
    "rg foo deploy/production",
    "cp -r docs /tmp/x",
    "cp -r apps/web /tmp/x",
    "cp apps /tmp/x",
    "rsync deploy/production /tmp/x",
    "cp deploy/production/compose.yml /tmp/x",
    "find apps/web -type f -exec cat {} +",
    "find . -type f -name '*.ts' -exec cat {} +",
    "find . -name '*.md' -exec grep x {} +",
    "tar cf /tmp/x.tar docs",
    "tar xf a.tar -C /tmp/x",
    "zip -r /tmp/x.zip docs",
  ])("keeps the everyday %s allowed", (cmd) => {
    allowed(cmd);
  });

  it("does not ask for a directory whose live env file is not there", () => {
    const none = { ...ctx, exists: () => false };
    expect(classifyBash("grep -r x apps", none).decision).toBe("allow");
    expect(classifyBash("cp -r deploy/production /tmp/x", none).decision).toBe("allow");
    expect(classifyBash("grep -r x .", none).decision).toBe("ask");
    // No way to look at all (a unit test, a caller without `exists`): a directory below the root is not asked about.
    const blind = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
    expect(classifyBash("grep -r x apps", blind).decision).toBe("allow");
  });

  it("knows which directories reach a live env file", () => {
    expect(reachesLiveEnv("", exists)).toBe(true);
    expect(reachesLiveEnv("apps", (f) => f === "apps/backend/.env")).toBe(true);
    expect(reachesLiveEnv("apps/", (f) => f === "apps/backend/.env")).toBe(true);
    expect(reachesLiveEnv("apps/backend", (f) => f === "apps/backend/.env")).toBe(true);
    expect(reachesLiveEnv("apps/backend/src", (f) => f === "apps/backend/.env")).toBe(false);
    expect(reachesLiveEnv("apps/web", (f) => f === "apps/backend/.env")).toBe(false);
    expect(reachesLiveEnv("app", (f) => f === "apps/backend/.env")).toBe(false);
  });
});

describe("the environment, the keychain and a CLI's stored token are not for the transcript", () => {
  it.each([
    "printenv DATABASE_URL",
    "printenv BETTER_AUTH_SECRET",
    "printenv API_KEY",
    "printenv GITHUB_TOKEN",
    "printenv HOME DATABASE_URL",
    'python3 -c "import os;print(os.environ)"',
    'python3 -c "print(dict(os.environ))"',
    "python3 -c \"import os;print(os.environ['DATABASE_URL'])\"",
    "python3 -c \"import os;print(os.getenv('API_TOKEN'))\"",
    'node -e "console.log(process.env)"',
    'node -e "console.log(JSON.stringify(process.env))"',
    'node -e "console.log(process.env.DATABASE_URL)"',
    "perl -e 'print %ENV'",
    "ruby -e 'p ENV.to_h'",
    "ruby -e 'puts ENV[\"API_TOKEN\"]'",
    "python3 -c \"import os;print(os.environ.get('API_TOKEN'))\"",
    "python3 - <<'EOF'\nimport os\nprint(os.environ)\nEOF",
    "security find-generic-password -ga foo",
    "security find-generic-password -w -s foo",
    "security find-internet-password -w",
    "security dump-keychain",
    "security export -t certs",
    "security find-key -a",
    "gh auth token",
    "gh auth status --show-token",
    "gh auth status -t",
    "docker exec api env",
    "docker compose exec api env",
    "docker-compose exec api printenv",
    "docker exec -it api printenv DATABASE_URL",
    "docker exec api sh -c 'echo $DATABASE_URL'",
    "docker exec -e X=1 api cat /app/.env",
    "docker exec -u root api printenv DATABASE_URL",
    "docker exec -w /app --user root api printenv API_KEY",
    "podman exec api env",
    "cat ~/.gnupg/secring.gpg",
    "cat ~/.gnupg/private-keys-v1.d/x.key",
  ])("denies %s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "docker inspect api",
    "docker inspect -f '{{json .}}' api",
    "docker inspect --format '{{.Config.Env}}' api",
  ])("asks before %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "printenv HOME",
    "printenv PATH NODE_ENV",
    "python3 -c \"import os;print(os.environ.get('HOME'))\"",
    "python3 -c \"import os;print(os.environ['HOME'])\"",
    'node -e "console.log(process.env.NODE_ENV)"',
    "gh auth status",
    "gh pr list",
    "security find-identity -v",
    "docker inspect --format '{{.State.Status}}' api",
    "docker inspect api --format '{{.Config.Image}} {{.Created}}'",
    'bun -e "new Pool({connectionString: process.env.DATABASE_URL})"',
    'node -e "run(process.env)"',
    "python3 - <<'EOF'\ns = open('a.ts').read().replace('x', 'connect(process.env)')\nEOF",
    "docker exec api psql -h /var/run/postgresql -U postgres -c 'select 1'",
    "docker exec api ls /app",
    "docker compose exec api bun run test",
    "docker ps",
    "gpg --list-keys",
  ])("keeps the everyday %s allowed", (cmd) => {
    allowed(cmd);
  });

  it("tells a secret variable name, a dump and a lookup apart", () => {
    expect(isSecretVariable("DATABASE_URL")).toBe(true);
    expect(isSecretVariable("STRIPE_API_KEY")).toBe(true);
    expect(isSecretVariable("HOME")).toBe(false);
    expect(environmentLeak("print(os.environ)")).toBe("dump");
    expect(environmentLeak("print(os.environ['X_TOKEN'])")).toBe("secret");
    expect(environmentLeak("os.environ['X_TOKEN']")).toBeNull();
    expect(environmentLeak('puts ENV["API_TOKEN"]')).toBe("secret");
    expect(environmentLeak("connect(process.env)")).toBeNull();
    expect(environmentLeak("os.environ['HOME']")).toBeNull();
    expect(environmentLeak("process.env.NODE_ENV")).toBeNull();
    expect(storedSecretVerdict("gh", ["auth", "token"])?.decision).toBe("deny");
    expect(storedSecretVerdict("gh", ["auth", "status"])).toBeNull();
    expect(storedSecretVerdict("docker", ["inspect", "a"])?.decision).toBe("ask");
  });
});

describe("a key file read after a cd is judged where the cd landed", () => {
  it.each([
    "cd deploy/production/tls && cat server.pem",
    "cd deploy/production/tls; cat server.pem",
    "(cd deploy/production/tls && cat tls.key)",
    "pushd deploy/production/tls && cat tls.key",
    "bash -c 'cd deploy/production/tls && cat tls.key'",
    "env -C deploy/production/tls cat tls.key",
    "sudo -D deploy/production/tls cat tls.key",
    "cd deploy/production/tls && head -1 tls.key",
    "cd deploy/production/tls && openssl rsa -in tls.key",
    "cd deploy/production/tls && cp tls.key /tmp/k",
    "cd deploy/production/tls && python3 -c \"print(open('tls.key').read())\"",
    "cd apps/backend && cat id_rsa",
    "cd data && cat prod.dump",
    "cd data && gunzip -c prod.dump",
    "cd data && strings prod.dump",
  ])("denies %s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "cat tls.key",
    "cat server.pem",
    "cd data && ls prod.dump",
    "cd docs && cat server.pem",
    "jq '.key' package.json",
  ])("keeps %s allowed: no such file where it runs, or it only lists", allowed);
});
