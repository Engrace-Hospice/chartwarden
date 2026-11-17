/**
 * Wave 11 part C, C6 and C7 (R8-ADV-5, R8-CR-4, R8-CR-5, R8-CR-10): a command run with `docker|podman|nerdctl exec` and `compose exec` is read like
 * the one behind `run`. `-e NAME=VALUE` (and `--env`, `--env=`, `-eNAME=VALUE`, `-e=NAME=VALUE`) is an assignment in front of the command, so
 * `docker exec -e PGHOST=<host> db psql` reaches the host unread no more; the here-string, heredoc or pipe that feeds the process in the
 * container is what a client behind the wrapper reads (`docker exec -i db psql <<< '\c host=<host>'`). The non-local host is built from parts.
 */
import { describe, expect, it } from "vitest";
import { containerCommand } from "../harness/container-run";
import { classifyBash } from "../harness/patterns";

const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("C6: the environment of an exec is an assignment in front of the command it runs", () => {
  const ENGINES = [
    "docker exec",
    "podman exec",
    "nerdctl exec",
    "docker container exec",
    "docker compose exec",
    "docker-compose exec",
  ];
  const SPELLINGS = [
    (h: string) => `-e PGHOST=${h}`,
    (h: string) => `--env PGHOST=${h}`,
    (h: string) => `--env=PGHOST=${h}`,
    (h: string) => `-ePGHOST=${h}`,
    (h: string) => `-e=PGHOST=${h}`,
    (h: string) => `-i -e PGHOST=${h}`,
    (h: string) => `-it -e PGHOST=${h}`,
    (h: string) => `-u root -e PGHOST=${h}`,
    (h: string) => `-w /tmp -e PGHOST=${h} -i`,
  ];
  for (const engine of ENGINES) {
    it(`${engine}: a non-local PGHOST reaches psql and is refused`, () => {
      for (const spell of SPELLINGS) {
        const cmd = `${engine} ${spell(HOST)} db psql -c 'select 1'`;
        expect(rank(cmd), cmd).toBe(2);
      }
    });
    it(`${engine}: a local PGHOST, a name that is no assignment and an unrelated variable stay allowed`, () => {
      for (const cmd of [
        `${engine} -e PGHOST=localhost db psql -c 'select 1'`,
        `${engine} -e PGHOST db psql -c 'select 1'`,
        `${engine} -e FOO=bar db ls`,
        `${engine} ${engine.includes("compose") ? "-T" : "-it"} db psql -U postgres -c 'select 1'`,
        `${engine} db printenv HOME`,
      ]) {
        expect(decide(cmd), cmd).toBe("allow");
      }
    });
  }

  it("compose exec options come from compose's own list: -T, --index and --user are read", () => {
    expect(rank(`docker compose exec -T -e PGHOST=${HOST} api psql`)).toBe(2);
    expect(rank(`docker compose exec --index 2 -e PGHOST=${HOST} api psql`)).toBe(2);
    expect(rank(`docker compose exec -u root -T -e PGHOST=${HOST} api psql`)).toBe(2);
    expect(decide("docker compose exec -T api ls")).toBe("allow");
  });

  it("the command behind the container is judged with every rule, as it is for run", () => {
    expect(rank("docker exec c git push --force origin main")).toBe(2);
    expect(rank("docker exec c git commit --no-verify -m x")).toBe(2);
    expect(rank(`docker exec c psql -h ${HOST} -c 'select 1'`)).toBe(2);
    expect(rank("docker exec c printenv M34_TENANT_KEK")).toBeGreaterThanOrEqual(1);
  });

  it("an exec option the table does not know asks; the image of run keeps asking too", () => {
    expect(rank("docker exec --zz-unknown x c ls")).toBeGreaterThanOrEqual(1);
    expect(rank("docker exec --zz-unknown c ls")).toBeGreaterThanOrEqual(1);
    expect(rank("docker run --zz-unknown x img ls")).toBeGreaterThanOrEqual(1);
  });
});

describe("containerCommand reads exec the way it reads run (one shared function)", () => {
  const behind = (...args: string[]) => containerCommand(args[0] as string, args.slice(1))?.command;
  it("the environment comes first, then the command, quoted as one command line", () => {
    expect(behind("docker", "exec", "-e", "A=1", "c", "ls", "-l")).toBe("A=1 ls -l");
    expect(behind("docker", "exec", "--env=A=1", "c", "ls")).toBe("A=1 ls");
    expect(behind("docker", "exec", "-eA=1", "c", "ls")).toBe("A=1 ls");
    expect(behind("docker", "exec", "-e=A=1", "c", "ls")).toBe("A=1 ls");
    expect(behind("docker", "compose", "exec", "-T", "-e", "A=1", "svc", "ls")).toBe("A=1 ls");
    expect(behind("docker-compose", "exec", "-e", "A=1", "svc", "ls")).toBe("A=1 ls");
    expect(behind("podman", "exec", "-i", "c", "ls")).toBe("ls");
  });
  it("a container word with no command behind it names none, and a variable with no value is not an assignment", () => {
    expect(behind("docker", "exec", "-it", "c")).toBeUndefined();
    expect(containerCommand("docker", ["exec", "-it", "c", "ls"])?.verb).toBe("exec");
    expect(behind("docker", "exec", "-e", "A", "c", "ls")).toBe("ls");
  });
  it("an option value is not the container: `-u root`, `-w /tmp`, `--env-file F` are skipped", () => {
    expect(behind("docker", "exec", "-u", "root", "-w", "/tmp", "--env-file", "f", "c", "ls")).toBe(
      "ls",
    );
  });
});

describe("pins of wave 10 that no test held (round-8 weak kills)", () => {
  const behind = (...args: string[]) => containerCommand(args[0] as string, args.slice(1));
  it("`docker run -e=PGHOST=H` is the environment of the command, as pflag reads it", () => {
    expect(behind("docker", "run", "-e=PGHOST=h", "img", "psql")?.command).toBe("PGHOST=h psql");
    expect(rank(`docker run -e=PGHOST=${HOST} img psql -c 'select 1'`)).toBe(2);
  });
  it("`--name=value` is one word whatever the name; an unknown bare option leaves the image in doubt", () => {
    expect(behind("docker", "run", "--name=web", "img", "ls")?.command).toBe("ls");
    expect(behind("docker", "run", "--zz-unknown=1", "img", "ls")?.unplaced).toBeUndefined();
    expect(behind("docker", "run", "--zz-unknown", "img", "ls")?.unplaced).toBe("--zz-unknown");
  });
  it("older docker's --kernel-memory takes a value, so the image after it is the image", () => {
    expect(behind("docker", "run", "--kernel-memory", "1g", "img", "ls")).toEqual({
      command: "ls",
      verb: "run",
    });
    expect(decide("docker run --kernel-memory 1g img ls")).toBe("allow");
  });
});

describe("C7: the text that feeds a client behind a wrapper is read (R8-CR-5)", () => {
  const RECONNECT = [
    `\\c host=${HOST}`,
    `\\connect postgres://${HOST}/db`,
    `\\c db user ${HOST} 5432`,
  ];
  const WRAPPERS: ReadonlyArray<readonly [string, (text: string) => string]> = [
    ["docker exec here-string", (t) => `docker exec -i db psql -U x <<< '${t}'`],
    ["docker exec pipe", (t) => `echo '${t}' | docker exec -i db psql`],
    ["docker exec heredoc", (t) => `docker exec -i db psql <<EOF\n${t}\nEOF`],
    ["docker run here-string", (t) => `docker run -i img psql <<< '${t}'`],
    ["compose exec here-string", (t) => `docker compose exec -T db psql <<< '${t}'`],
    ["compose run here-string", (t) => `docker compose run -T db psql <<< '${t}'`],
    ["podman exec here-string", (t) => `podman exec -i db psql <<< '${t}'`],
    ["ssh here-string", (t) => `ssh localhost psql <<< '${t}'`],
    ["bash -c here-string", (t) => `bash -c psql <<< '${t}'`],
    ["sh -c pipe", (t) => `printf '%s' '${t}' | sh -c psql`],
  ];
  for (const [label, build] of WRAPPERS) {
    it(`${label}: a \\c to a non-local host is refused`, () => {
      for (const text of RECONNECT) expect(rank(build(text)), build(text)).toBe(2);
    });
  }

  it("the other clients: mysql connect, mongosh connect()", () => {
    expect(rank(`docker exec -i db mysql <<< 'connect db ${HOST}'`)).toBe(2);
    expect(rank(`docker exec -i m mongosh <<< 'connect("${HOST}")'`)).toBe(2);
    expect(rank(`echo 'connect("${HOST}")' | docker exec -i m mongosh`)).toBe(2);
  });

  it("the same text to a local client, and text for a program that is no client, stays allowed", () => {
    for (const cmd of [
      "docker exec -i db psql -U x <<< '\\c mydb'",
      "docker exec -i db psql <<< 'select 1'",
      "docker exec -i db psql <<< '\\c host=localhost'",
      `docker exec -i db cat <<< '${HOST}'`,
      `echo '${HOST}' | docker exec -i db cat`,
      "echo hello | docker exec -i db tee /tmp/x",
      `ssh localhost cat <<< '\\c host=${HOST}'`,
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
