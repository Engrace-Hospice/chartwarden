/**
 * Wave 12 part E2, E2-4 (R9-ADV-13, R9-ADV-20 container half): a container engine that talks to another machine asks, however the engine is pointed
 * there. `podman --connection|--url|-r|--remote`, `CONTAINER_HOST=ssh://…`, an exported or statement-known DOCKER_HOST, CONTAINER_HOST, DOCKER_CONTEXT or
 * CONTAINER_CONNECTION, `docker-compose -H` and `DOCKER_HOST=… docker-compose exec` ask exactly like the already-asking `DOCKER_HOST=… docker exec`
 * and `docker -H`. An `--env-file` that names no file on disk (a process substitution, stdin, a descriptor) sets variables the guard cannot see: it asks.
 * The non-local host is built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const SSH = `ssh://u@${HOST}`;
const PSQL = "db psql -U postgres -c 'select 1'";

/** Every way an engine is pointed at another machine, before a subcommand that opens a session. */
const REMOTE_ENGINES: Record<string, string> = {
  "podman --connection NAME": `podman --connection prod exec ${PSQL}`,
  "podman --connection=NAME": `podman --connection=prod exec ${PSQL}`,
  "podman --url URL": `podman --url ${SSH} exec ${PSQL}`,
  "podman --url=URL": `podman --url=${SSH} exec ${PSQL}`,
  "podman -r": `podman -r exec ${PSQL}`,
  "podman --remote": `podman --remote exec ${PSQL}`,
  "podman --host": `podman --host ${SSH} exec ${PSQL}`,
  "podman -H": `podman -H ${SSH} exec ${PSQL}`,
  "podman -c NAME": `podman -c prod exec ${PSQL}`,
  "podman --context": `podman --context prod exec ${PSQL}`,
  "podman after an unlisted-by-docker valued option": `podman --root /tmp/x --connection prod exec ${PSQL}`,
  "podman after --identity": `podman --identity /tmp/k --connection prod exec ${PSQL}`,
  "podman after --log-level": `podman --log-level debug --url ${SSH} exec ${PSQL}`,
  "podman run": `podman --connection prod run --rm img psql -U postgres`,
  "podman -r ps (any command on the remote service)": "podman -r ps",
  "podman --remote images": "podman --remote images",
  "podman --runroot before --remote": `podman --runroot /tmp/x --remote exec ${PSQL}`,
  "podman --storage-driver before --url": `podman --storage-driver vfs --url ${SSH} exec ${PSQL}`,
  "podman --tmpdir before --connection": `podman --tmpdir /tmp/t --connection prod exec ${PSQL}`,
  "podman --cgroup-manager before --connection": `podman --cgroup-manager cgroupfs --connection prod ps`,
  "podman --network-cmd-path before -r": `podman --network-cmd-path /bin/x -r exec ${PSQL}`,
  "docker -H": `docker -H ${SSH} exec ${PSQL}`,
  "docker --host": `docker --host ${SSH} exec ${PSQL}`,
  "docker --context": `docker --context prod exec ${PSQL}`,
  "docker -c": `docker -c prod exec ${PSQL}`,
  "nerdctl -H": `nerdctl -H ${SSH} exec ${PSQL}`,
  "docker-compose -H": `docker-compose -H ${SSH} exec ${PSQL}`,
  "docker-compose --host": `docker-compose --host ${SSH} exec ${PSQL}`,
  "docker-compose -f x -H": `docker-compose -f x.yml -H ${SSH} exec ${PSQL}`,
  "docker-compose -f x -p y -H": `docker-compose -f x.yml -p y -H ${SSH} exec ${PSQL}`,
  "docker-compose --context": `docker-compose --context prod exec ${PSQL}`,
  "podman-compose --connection": `podman-compose --connection prod exec ${PSQL}`,
};

/** The variables that point an engine elsewhere, and the way each is set. */
const REMOTE_VARIABLES = [
  `DOCKER_HOST=${SSH}`,
  `DOCKER_HOST=tcp://${HOST}:2375`,
  `CONTAINER_HOST=${SSH}`,
  "DOCKER_CONTEXT=prod",
  "CONTAINER_CONNECTION=prod",
];
const WAYS_TO_SET: Record<string, (assignment: string, command: string) => string> = {
  "inline for the command": (a, c) => `${a} ${c}`,
  "export, then the command": (a, c) => `export ${a}; ${c}`,
  "a bare assignment": (a, c) => `${a}; ${c}`,
  "export on the same line with &&": (a, c) => `export ${a} && ${c}`,
  "declare -x": (a, c) => `declare -x ${a}; ${c}`,
};
const ENGINE_COMMANDS: Record<string, string> = {
  "docker exec": `docker exec ${PSQL}`,
  "podman exec": `podman exec ${PSQL}`,
  "nerdctl exec": `nerdctl exec ${PSQL}`,
  "docker-compose exec": `docker-compose exec ${PSQL}`,
  "docker compose exec": `docker compose exec ${PSQL}`,
  "docker run": "docker run --rm img psql -U postgres",
  "podman run": "podman run --rm img psql -U postgres",
};

describe("E2-4: a container engine pointed at another machine asks", () => {
  for (const [name, cmd] of Object.entries(REMOTE_ENGINES)) {
    it(`${name} asks`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }

  for (const [way, make] of Object.entries(WAYS_TO_SET)) {
    it(`a remote engine variable set by ${way} asks for every engine command`, () => {
      for (const assignment of REMOTE_VARIABLES) {
        for (const [engine, command] of Object.entries(ENGINE_COMMANDS)) {
          const cmd = make(assignment, command);
          expect(decide(cmd), `${engine}: ${cmd}`).toBe("ask");
        }
      }
    });
  }

  it("the two spellings that already asked still ask (control)", () => {
    expect(decide(`DOCKER_HOST=${SSH} docker exec ${PSQL}`)).toBe("ask");
    expect(decide(`docker -H ${SSH} exec ${PSQL}`)).toBe("ask");
  });

  it("the ask names the engine and does not print the host as a database host", () => {
    const verdict = classifyBash(`podman --url ${SSH} exec ${PSQL}`, ctx);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toContain("podman --url");
  });
});

describe("E2-4: an engine variable is read whatever comes before it, and into nested texts", () => {
  const pad = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}=1;`).join(" ");
  for (const n of [255, 256, 257, 300, 3000]) {
    it(`${n} statements before an exported DOCKER_HOST do not hide it`, () => {
      const cmd = `${pad(n)} export DOCKER_HOST=${SSH}; docker exec ${PSQL}`;
      expect(decide(cmd), `${n} statements`).toBe("ask");
    });
    it(`${n} statements before a CONTAINER_HOST assignment do not hide it`, () => {
      const cmd = `${pad(n)} CONTAINER_HOST=${SSH}; podman exec ${PSQL}`;
      expect(decide(cmd), `${n} statements`).toBe("ask");
    });
  }
  for (const [name, cmd] of Object.entries({
    "bash -c": `export DOCKER_HOST=${SSH}; bash -c 'docker exec ${PSQL}'`,
    eval: `export DOCKER_HOST=${SSH}; eval 'docker exec ${PSQL}'`,
    subshell: `export DOCKER_HOST=${SSH}; (docker exec ${PSQL})`,
    "sh -c with CONTAINER_HOST": `export CONTAINER_HOST=${SSH}; sh -c 'podman exec ${PSQL}'`,
    "bash -c with a bare assignment": `DOCKER_HOST=${SSH}; bash -c 'docker exec ${PSQL}'`,
    "nested twice": `export DOCKER_HOST=${SSH}; bash -c "bash -c 'docker exec ${PSQL}'"`,
  })) {
    it(`an engine variable exported outside reaches a command inside ${name}`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }
  for (const setter of ["declare -x", "typeset -x", "readonly", "local", "export -n"]) {
    it(`${setter} sets an engine variable the padding does not hide`, () => {
      const cmd = `${pad(300)} ${setter} DOCKER_HOST=${SSH}; docker exec ${PSQL}`;
      expect(decide(cmd), cmd).toBe("ask");
    });
  }
  it("a harmless variable among the padding is not an engine variable", () => {
    expect(decide(`${pad(300)} export DOCKER_BUILDKIT=1; docker build .`)).toBe("allow");
  });
});

describe("E2-4: everyday container work stays allowed", () => {
  const NEIGHBOURS = [
    `podman exec ${PSQL}`,
    "podman ps",
    "podman ps -a",
    "podman machine list",
    "podman images",
    "podman run --rm img echo hi",
    `podman --connection podman-machine-default exec ${PSQL}`,
    `podman --connection=podman-machine-default-root exec ${PSQL}`,
    `docker exec ${PSQL}`,
    "docker ps",
    "docker context ls",
    "docker context inspect default",
    `docker -c desktop-linux exec ${PSQL}`,
    `docker --context default exec ${PSQL}`,
    `docker-compose exec ${PSQL}`,
    `docker-compose -f x.yml -p p exec ${PSQL}`,
    `docker-compose -f x.yml up -d`,
    "docker-compose ps",
    `docker compose exec ${PSQL}`,
    "export DOCKER_HOST=unix:///var/run/docker.sock; docker ps",
    "export DOCKER_CONTEXT=default; docker ps",
    "export DOCKER_CONTEXT=desktop-linux; docker exec db ls",
    "export CONTAINER_CONNECTION=podman-machine-default; podman ps",
    "export DOCKER_BUILDKIT=1; docker build .",
    "DOCKER_BUILDKIT=1 docker build -t x .",
    "FOO=bar podman ps",
    "nerdctl -n k8s.io ps",
  ];
  for (const cmd of NEIGHBOURS) {
    it(`${cmd} is allowed`, () => {
      expect(decide(cmd), cmd).toBe("allow");
    });
  }
});

/** The operands an `--env-file` can take that name no file on disk. */
const HIDDEN_OPERANDS = [
  `<(echo PGHOST=${HOST})`,
  `<(printf 'PGHOST=%s\\n' ${HOST})`,
  "/dev/stdin",
  "/dev/fd/0",
  "/dev/fd/63",
  "/proc/self/fd/0",
  "-",
];
const ENV_FILE_COMMANDS: Record<string, (operand: string) => string> = {
  "docker run": (o) => `docker run --env-file ${o} img psql -U postgres`,
  "docker run =": (o) => `docker run --env-file=${o} img psql -U postgres`,
  "podman run": (o) => `podman run --env-file ${o} img psql -U postgres`,
  "nerdctl run": (o) => `nerdctl run --env-file ${o} img psql -U postgres`,
  "docker create": (o) => `docker create --env-file ${o} img psql -U postgres`,
  "docker container run": (o) => `docker container run --env-file ${o} img psql -U postgres`,
  "docker exec": (o) => `docker exec --env-file ${o} db psql -U postgres`,
  "docker exec -i": (o) => `docker exec -i --env-file=${o} db psql -U postgres`,
  "podman exec": (o) => `podman exec --env-file ${o} db psql -U postgres`,
  "compose run --env-from-file": (o) =>
    `docker compose run --env-from-file ${o} db psql -U postgres`,
  "docker-compose run --env-from-file": (o) =>
    `docker-compose run --env-from-file ${o} db psql -U postgres`,
  "docker run, image command only": (o) => `docker run --env-file ${o} img`,
  "podman run, image command only": (o) => `podman run --env-file ${o} img`,
  "nerdctl run, image command only": (o) => `nerdctl run --rm --env-file=${o} img`,
  "docker create, image command only": (o) => `docker create --env-file ${o} img`,
  "docker run -it, image command only": (o) => `docker run -it --env-file ${o} img`,
  "compose run, service command only": (o) => `docker compose run --env-from-file ${o} db`,
  "docker run, stdin text": (o) => `docker run -i --env-file ${o} img psql <<< 'PGHOST=${HOST}'`,
  "docker-compose --env-file": (o) => `docker-compose --env-file ${o} up -d`,
  "docker-compose --env-file run": (o) => `docker-compose --env-file ${o} run db psql`,
  "docker-compose --env-file ps": (o) => `docker-compose --env-file ${o} ps`,
  "docker-compose --env-file exec": (o) => `docker-compose --env-file ${o} exec db psql`,
  "docker-compose --env-file plugin form exec": (o) =>
    `docker compose --env-file ${o} exec db psql`,
  "docker-compose --env-file plugin form up": (o) => `docker compose --env-file=${o} up -d`,
};

describe("E2-4: an --env-file that names no file on disk asks (R9-ADV-20, container half)", () => {
  for (const [name, make] of Object.entries(ENV_FILE_COMMANDS)) {
    it(`${name}: a process substitution, stdin or a descriptor asks`, () => {
      for (const operand of HIDDEN_OPERANDS) {
        const cmd = make(operand);
        // another rule refuses a compose `--env-file` it cannot place outright (it can print resolved secrets): never an allow
        const allowed = name.startsWith("docker-compose --env-file") ? ["ask", "deny"] : ["ask"];
        expect(allowed, cmd).toContain(decide(cmd));
      }
    });
  }

  it("an --env-file that names a file, and a run without one, stay allowed", () => {
    for (const cmd of [
      "docker run --env-file ./local.txt img psql -U postgres",
      "docker run --env-file=./local.txt img ls",
      "docker exec --env-file ./local.txt db ls",
      "docker-compose --env-file ./compose.txt up -d",
      "docker run --rm img ls",
      "docker run -e FOO=bar img ls",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the live env file is still refused outright", () => {
    const live = `${"."}e${"nv"}`;
    expect(decide(`docker run --env-file ${live} img psql`)).toBe("deny");
  });
});
