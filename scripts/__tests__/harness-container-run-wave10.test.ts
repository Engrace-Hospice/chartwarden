/**
 * Wave 10 part A, A4 (R7-ADV-7, R7-CR-15). A client run in a FRESH container was never read: `containerRun` returned null unless a
 * writable bind mount let it map paths back, so `docker run --rm postgres:16 psql -h <host>` and `docker compose run --rm migrate
 * psql -h <host>` passed every rule while `docker exec db psql -h <host>` was denied. The command behind the image (or the
 * compose service) is now judged with every rule, for docker, podman and nerdctl `run`/`create`, `compose run` and
 * `docker-compose run`; `--entrypoint X` makes X the program and `-e NAME=VALUE` is an assignment for it. Both hosts and
 * the live env file name are built from parts.
 */
import { describe, expect, it } from "vitest";
import { COMPOSE_RUN_GRAMMAR, RUN_GRAMMAR, containerCommand } from "../harness/container-run";
import { classifyBash } from "../harness/patterns";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const NO_VERIFY = "git commit --no-verify -m x";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("the command behind the image is judged", () => {
  it.each([
    `docker run --rm postgres:16 psql -h ${HOST} -U x -c 'select 1'`,
    `docker compose run --rm migrate psql -h ${HOST}`,
    `docker-compose run postgres psql -h ${HOST}`,
    `podman-compose run db psql -h ${HOST}`,
    `podman run postgres psql -h ${HOST}`,
    `nerdctl run postgres psql -h ${HOST}`,
    `podman compose run db psql -h ${HOST}`,
    `docker container run postgres psql -h ${HOST}`,
    `docker create postgres psql -h ${HOST}`,
    `docker run --entrypoint psql postgres -h ${HOST}`,
    `docker run --entrypoint=psql postgres -h ${HOST}`,
    `docker compose run --entrypoint psql db -h ${HOST}`,
    `docker run -e PGHOST=${HOST} postgres psql`,
    `docker run --env PGHOST=${HOST} postgres psql`,
    `docker run -ePGHOST=${HOST} postgres psql`,
    `docker run --env=PGHOST=${HOST} postgres psql -c 'select 1'`,
    `docker compose run -e PGHOST=${HOST} db psql`,
    `docker -H unix:///var/run/docker.sock run postgres psql -h ${HOST}`,
    `docker --context default run postgres psql -h ${HOST}`,
    `docker compose -f x.yml -p proj run --rm db psql -h ${HOST}`,
    `docker --host tcp://x:1 compose --profile p run db psql -h ${HOST}`,
    `docker run --rm -it --network host -v data:/d -p 5432:5432 -w /w -u 0 postgres psql -h ${HOST}`,
    `docker run --rm --name n --cpus 2 --memory 1g --platform linux/amd64 postgres psql -h ${HOST}`,
    // the other guarded commands behind an image
    "docker run --rm img git push origin main",
    `docker run --rm img ${NO_VERIFY}`,
    `docker run --rm img cat ${ENV_FILE}`,
    `docker compose run --rm api cat ${ENV_FILE}`,
    `docker run --rm img sh -c 'cat ${ENV_FILE}'`,
    `docker run --rm img bash -c "cat \\"${ENV_FILE}\\""`,
    "docker run --rm img cp /tmp/x .claude/settings.json",
    `docker run --rm img env`,
    `docker run --rm img printenv DATABASE_URL`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("an option the table does not know asks: the image cannot be told from the option's value", () => {
    expect(rank("docker run --no-such-option x img ls")).toBeGreaterThanOrEqual(1);
    expect(rank("docker compose run --no-such-option x api ls")).toBeGreaterThanOrEqual(1);
  });
});

describe("the everyday container commands stay allowed", () => {
  it.each([
    "docker run --rm hello-world",
    "docker run --rm -it ubuntu bash",
    "docker run --rm node:20 npm test",
    "docker run --rm img echo hi",
    "docker run -d --name db -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:16",
    "docker run --rm -e PGHOST=localhost postgres psql -c 'select 1'",
    "docker run --rm postgres:16 psql -h localhost -U x -c 'select 1'",
    "docker run --rm postgres:16 psql -h host.docker.internal -U x",
    "docker run --rm postgres:16 pg_isready -h 127.0.0.1",
    "docker compose run --rm api bun run test",
    "docker compose run --rm migrate bun run db:migrate",
    "docker compose run --rm -T api bun test",
    "docker-compose run --rm api ls",
    "docker compose -f deploy/compose.yml run --rm api ls",
    "docker run --rm -v data:/var/lib alpine rm /var/lib/x",
    "docker compose up -d",
    "docker ps",
    "docker build -t x .",
    "docker compose exec api ls",
    "docker run --rm img ls",
    "docker run --rm img cp a b",
    "docker compose run --rm api rm -rf dist",
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("containerCommand reads the options the way the tools list them", () => {
  const behind = (prog: string, ...args: string[]) => containerCommand(prog, args)?.command;

  it("the image is the first word that is no option or option value", () => {
    expect(behind("docker", "run", "--rm", "img", "ls", "-l")).toBe("ls -l");
    expect(behind("docker", "run", "-v", "a:b", "-p", "1:1", "img", "ls")).toBe("ls");
    expect(behind("docker", "run", "-va:b", "-p1:1", "img", "ls")).toBe("ls");
    expect(behind("docker", "run", "--name=x", "--rm", "img", "ls")).toBe("ls");
    expect(behind("docker", "run", "-it", "img", "ls")).toBe("ls");
    expect(behind("docker", "run", "-itv", "a:b", "img", "ls")).toBe("ls");
  });

  it("an entrypoint is the program, and -e NAME=VALUE an assignment in front of it", () => {
    expect(behind("docker", "run", "--entrypoint", "psql", "img", "-h", "x")).toBe("psql -h x");
    expect(behind("docker", "run", "-e", "A=1", "-e", "B", "img", "ls")).toBe("A=1 ls");
    expect(behind("docker", "compose", "run", "--entrypoint", "psql", "db", "-h", "x")).toBe(
      "psql -h x",
    );
  });

  it("names no command when nothing follows the image, and is null for anything but a run", () => {
    expect(behind("docker", "run", "img")).toBeUndefined();
    expect(behind("docker", "run", "-e", "A=1", "img")).toBeUndefined();
    expect(containerCommand("docker", ["ps"])).toBeNull();
    expect(containerCommand("docker", ["exec", "api", "ls"])).toBeNull();
    expect(containerCommand("docker", ["compose", "up"])).toBeNull();
    expect(containerCommand("git", ["run", "img", "ls"])).toBeNull();
    expect(containerCommand("docker-compose", ["up"])).toBeNull();
  });

  it("global options before the subcommand are skipped", () => {
    expect(behind("docker", "-H", "h", "run", "img", "ls")).toBe("ls");
    expect(behind("docker", "--context", "c", "run", "img", "ls")).toBe("ls");
    expect(
      behind("docker", "compose", "-f", "x.yml", "--project-name", "p", "run", "db", "ls"),
    ).toBe("ls");
    expect(behind("docker-compose", "-f", "x.yml", "run", "db", "ls")).toBe("ls");
  });
});

describe("MONOTONICITY over the run grammars: a guarded command behind any spelling of any run option is judged", () => {
  const GUARDED: ReadonlyArray<readonly [string, string]> = [
    ["a push", "git push origin main"],
    ["a hook bypass", NO_VERIFY],
    ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
    ["a secret read", `cat ${ENV_FILE}`],
  ];
  const variants = (g: typeof RUN_GRAMMAR): string[][] => {
    const out: string[][] = [[]];
    for (const l of g.flags) out.push([`-${l}`]);
    for (const v of g.values) out.push([`-${v}`, "arg"], [`-${v}arg`]);
    for (const f of g.longFlags) out.push([`--${f}`]);
    for (const v of g.longValues) out.push([`--${v}`, "arg"], [`--${v}=arg`]);
    return out.filter(
      (w) =>
        !w.some((x) => x === "--entrypoint" || x.startsWith("--entrypoint=") || x === "--help"),
    );
  };
  const cases: ReadonlyArray<readonly [string, string[], typeof RUN_GRAMMAR]> = [
    ["docker run", ["docker", "run"], RUN_GRAMMAR],
    ["podman run", ["podman", "run"], RUN_GRAMMAR],
    ["docker compose run", ["docker", "compose", "run"], COMPOSE_RUN_GRAMMAR],
    ["docker-compose run", ["docker-compose", "run"], COMPOSE_RUN_GRAMMAR],
  ];
  for (const [name, prefix, grammar] of cases) {
    it(name, () => {
      const failures: string[] = [];
      let checked = 0;
      for (const options of variants(grammar)) {
        for (const [label, command] of GUARDED) {
          const alone = rank(command);
          const cmd = [...prefix, ...options, "img", command].join(" ");
          checked++;
          if (rank(cmd) < alone) failures.push(`${label}: ${cmd}`);
        }
      }
      expect(checked).toBeGreaterThan(100);
      expect(failures.slice(0, 5), `${failures.length} of ${checked}`).toEqual([]);
    });
  }
});

describe("the escaped-quote producer of A1 also reaches a fresh container", () => {
  it.each([
    `docker run --rm img sh -c "cat \\".e${"nv"}\\""`,
    `docker run --rm img sh -c "cp /tmp/x \\"CLAUDE.md\\""`,
    `docker run --rm img sh -c "git push --force origin \\"main\\""`,
    `docker run --rm img sh -c "${NO_VERIFY}"`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });
});
