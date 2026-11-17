/**
 * Wave 11 part C, C8, C9 and C10 (R8-ADV-7, R8-ADV-10, R8-CR-9, R8-CR-10, R8-CR-11 and the weak kills of round 8).
 * C8: zsh precommand modifiers (`noglob`, `nocorrect`, a leading `-`, `repeat N`) and program words built by expansion (`=psql`, `{psql,-h,H}`,
 *     `psql${IFS}-h${IFS}H`) hid the command. C9: VM and container shells outside the ask list (`limactl shell`, `orb`, `podman machine ssh`, `oc exec`,
 *     `kubectl run`, `kubectl get secret`, `docker --context`, ...) ask like a non-local ssh. C10: parallel's `--transfer*`, a wrapper's FILE option
 *     (`sshpass -f F`, `xargs -a F`, `doas -C F`, `proxychains4 -f F`) is read whatever program runs behind it, and pins for mutants that survived round 8.
 * The non-local host and the live env file are built from parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { expandedProgramWord } from "../harness/program-words";
import { remoteAccessReason } from "../harness/remote-access";
import { gnuName } from "../harness/wrappers";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `.e${"nv"}`;
const KEY_FILE = `~/.ss${"h"}/id_${"rsa"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const NO_VERIFY = "git commit --no-verify -m x";
const PSQL = `psql -h ${HOST} -c 'select 1'`;

describe("C8: zsh precommand modifiers run the command after them", () => {
  const GUARDED = [
    PSQL,
    "git push --force origin main",
    NO_VERIFY,
    `cat ${ENV_FILE}`,
    "cp /tmp/x .claude/settings.json",
  ];
  const MODIFIERS = [
    "noglob",
    "nocorrect",
    "-",
    "repeat 1",
    "repeat 3",
    "builtin",
    "command",
    "command -p",
    "noglob nocorrect",
    "nocorrect noglob -",
    "sudo noglob",
    "env noglob",
    "nice nocorrect",
    "/usr/bin/noglob",
  ];
  it.each(MODIFIERS)("%s", (modifier) => {
    for (const inner of GUARDED) {
      const alone = rank(inner);
      const cmd = `${modifier} ${inner}`;
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(alone);
    }
  });

  const zsh = ["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"].find(existsSync);
  it.skipIf(zsh === undefined)(
    "held against the REAL zsh (echo only): each modifier runs the command that follows",
    () => {
      for (const line of [
        "noglob echo HIT",
        "nocorrect echo HIT",
        "true; - /bin/echo HIT",
        "repeat 1 echo HIT",
        "builtin echo HIT",
        "command echo HIT",
        "=echo HIT",
      ]) {
        const real = spawnSync(zsh as string, ["-f", "-c", line], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        expect(real.stdout, line).toBe("HIT\n");
        // and the guard reads the same command behind it
        expect(rank(line.replace(/(?:\/bin\/)?echo HIT/, PSQL)), line).toBe(2);
      }
    },
  );

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "noglob ls *.ts",
      "nocorrect ls",
      "- ls",
      "repeat 2 echo hi",
      "builtin cd /tmp",
      "command -v git",
      "command ls",
      "noglob git status",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("C8: a program word built by expansion", () => {
  it("zsh's =NAME is the program NAME; $IFS splits the word into program and arguments", () => {
    expect(expandedProgramWord("=psql")).toEqual({ prog: "psql", args: [], ifs: false });
    expect(expandedProgramWord(`psql\${IFS}-h\${IFS}${HOST}`)).toEqual({
      prog: "psql",
      args: ["-h", HOST],
      ifs: true,
    });
    expect(expandedProgramWord(`psql$IFS-h${"$"}{IFS}${HOST}`)).toEqual({
      prog: "psql",
      args: ["-h", HOST],
      ifs: true,
    });
    expect(expandedProgramWord("/usr/bin/psql${IFS}-l")).toEqual({
      prog: "psql",
      args: ["-l"],
      ifs: true,
    });
    expect(expandedProgramWord("psql")).toBeNull();
    expect(expandedProgramWord("=")).toBeNull();
    expect(expandedProgramWord("a=b")).toBeNull();
    expect(expandedProgramWord("$IFSX")).toBeNull();
  });

  it.each([
    `=psql -h ${HOST} -c 'select 1'`,
    `=git push --force origin main`,
    `psql\${IFS}-h\${IFS}${HOST}`,
    `psql$IFS-h\${IFS}${HOST}`,
    `git\${IFS}push\${IFS}--force\${IFS}origin\${IFS}main`,
    `{psql,-h,${HOST}}`,
    `{git,push,--force,origin,main}`,
    `{cat,${ENV_FILE}}`,
    `sudo =psql -h ${HOST}`,
  ])("%s is judged", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("a brace group word is kept whole by the lexer, a group that opens a command is not", () => {
    expect(rank("{ ls; }")).toBe(0);
    expect(rank("{ git push --force origin main; }")).toBe(2);
    expect(rank("{\ngit push --force origin main\n}")).toBe(2);
    expect(rank("(git push --force origin main)")).toBe(2);
    expect(rank("{ls,-l}")).toBeGreaterThanOrEqual(1);
  });

  it("an ordinary use of an equals sign or IFS stays allowed", () => {
    for (const cmd of [
      "FOO=bar ls",
      "echo $IFS",
      "echo a=b",
      "ls =x",
      "echo ${IFS}",
      "IFS=, read a b",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("C9: VM and container shells on another machine ask", () => {
  it.each([
    `limactl shell vm ${PSQL}`,
    `colima ssh -- ${PSQL}`,
    `orb ${PSQL}`,
    `orbctl run ${PSQL}`,
    `podman machine ssh ${PSQL}`,
    `podman machine ssh dev ${PSQL}`,
    `docker-machine ssh m ${PSQL}`,
    `minikube ssh "${PSQL}"`,
    `multipass exec vm -- ${PSQL}`,
    `multipass shell vm`,
    `vagrant ssh -c "${PSQL}"`,
    `lxc exec c -- ${PSQL}`,
    `incus exec c -- ${PSQL}`,
    `oc exec p -- ${PSQL}`,
    `oc rsh p`,
    `oc debug node/n`,
    `ctr run img c`,
    `ctr task exec --exec-id 1 c sh`,
    `crictl exec -it c sh`,
    `buildah run c -- ${PSQL}`,
    `apptainer exec img.sif ${PSQL}`,
    `singularity shell img.sif`,
    `kubectl run x --image=img -- ${PSQL}`,
    `kubectl -n prod run x --image=img -- sh`,
    "kubectl get secret -o yaml",
    "kubectl get secrets -A -o json",
    "kubectl get secret/db -o yaml",
    "kubectl get pods,secrets",
    "kubectl -n prod get secret db",
    "kubectl config view --raw",
    `nerdctl -n k8s.io run img ${PSQL}`,
    `docker --context prod run img ls`,
    `docker --context=prod exec c ls`,
    `docker -c prod ps`,
    `DOCKER_CONTEXT=prod docker run img ls`,
    "DOCKER_CONTEXT=prod docker ps",
    `aws ecs execute-command --cluster c --task t --command sh`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("management commands and local contexts stay allowed", () => {
    for (const cmd of [
      "limactl list",
      "limactl start default",
      "colima status",
      "colima start",
      "orb list",
      "orbctl status",
      "orb version",
      "podman machine list",
      "podman machine start",
      "docker-machine ls",
      "minikube status",
      "multipass list",
      "vagrant status",
      "lxc list",
      "oc get pods",
      "oc login",
      "ctr images ls",
      "crictl ps",
      "buildah images",
      "apptainer version",
      "kubectl get pods",
      "kubectl get svc -A",
      "kubectl config get-contexts",
      "kubectl config view",
      "kubectl describe pod x",
      "docker --context default ps",
      "docker --context desktop-linux ps",
      "docker --context=orbstack ps",
      "DOCKER_CONTEXT=colima docker ps",
      "docker ps",
      "nerdctl -n k8s.io ps",
      "aws ecs list-tasks --cluster c",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the reason says what the session is", () => {
    expect(remoteAccessReason("kubectl", ["get", "secret"])).toMatch(/secret/);
    expect(remoteAccessReason("kubectl", ["config", "view", "--raw"])).toMatch(/--raw/);
    expect(remoteAccessReason("limactl", ["shell", "vm"])).toMatch(/limactl shell/);
    expect(remoteAccessReason("docker", ["--context", "prod", "ps"])).toMatch(/--context/);
    expect(remoteAccessReason("docker", ["ps"], ["DOCKER_CONTEXT=prod"])).toMatch(/DOCKER_CONTEXT/);
    expect(remoteAccessReason("aws", ["ecs", "execute-command"])).toMatch(/ecs execute-command/);
    expect(remoteAccessReason("aws", ["ecs", "list-tasks"])).toBeNull();
  });
});

describe("C10: parallel's transfer options, and a wrapper's FILE option", () => {
  it("--transfer is a flag, --transferfile, --tf and --trc take a value: the command behind them is judged", () => {
    expect(rank(`parallel --transfer --sshlogin x ${NO_VERIFY} ::: a`)).toBe(2);
    expect(rank(`parallel --trc 1 ${NO_VERIFY} ::: a`)).toBe(2);
    expect(rank(`parallel --tf 1 ${NO_VERIFY} ::: a`)).toBe(2);
    expect(rank(`parallel --transferfile 1 ${NO_VERIFY} ::: a`)).toBe(2);
    expect(decide("parallel --transfer --sshlogin x echo ::: a")).toBe("allow");
  });

  it.each([
    `sshpass -f ${ENV_FILE} ls`,
    `sshpass -f ${KEY_FILE} ls`,
    `xargs -a ${ENV_FILE} ls`,
    `xargs --arg-file ${ENV_FILE} ls`,
    `doas -C ${ENV_FILE} ls`,
    `proxychains4 -f ${ENV_FILE} ls`,
    `proxychains -f ${ENV_FILE} ls`,
    `sshpass -f ${ENV_FILE} ssh host`,
    `xargs -a ${ENV_FILE} echo`,
    `nice xargs -a ${ENV_FILE} ls`,
    `sudo -n xargs -a ${ENV_FILE} wc -l`,
  ])("%s reads the file whatever runs behind it", (cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });
  it("a file that is no secret stays allowed", () => {
    for (const cmd of [
      "sshpass -f x.txt ls",
      "xargs -a list.txt ls",
      "doas -C doas.conf ls",
      "proxychains4 -f proxy.conf ls",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("pins for the mutants that survived round 8", () => {
  it.each(["xargs", "nice", "stdbuf", "env", "nohup", "time", "timeout", "chroot"])(
    "g%s is %s",
    (name) => {
      expect(gnuName(`g${name}`)).toBe(name);
    },
  );
  it.each([
    `gtimeout 5 ${NO_VERIFY}`,
    `gchroot /jail ${NO_VERIFY}`,
    `gnice -n 5 ${NO_VERIFY}`,
    `gxargs ${NO_VERIFY}`,
    `gstdbuf -oL ${NO_VERIFY}`,
    `genv A=1 ${NO_VERIFY}`,
    `gnohup ${NO_VERIFY}`,
    `gtime -p ${NO_VERIFY}`,
  ])("a g-prefixed GNU tool peels to its command: %s", (cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });
  it("a name that only starts with g is no GNU tool", () => {
    expect(gnuName("grep")).toBe("grep");
    expect(gnuName("gtimeoutx")).toBe("gtimeoutx");
    expect(gnuName("gtail")).toBe("gtail");
  });

  const DATA = Array.from({ length: 70 }, (_, i) => `x${i}`).join(" ");
  it.each([
    ["the datum is appended", `parallel touch ::: ${DATA} CLAUDE.md`],
    ["the datum is {}", `parallel cp {} /tmp/out ::: ${DATA} CLAUDE.md`],
    ["{} is part of a word", `parallel mv {}.bak /tmp/out ::: ${DATA} CLAUDE.md`],
    [
      "the protected name is the first datum past the cap",
      `parallel touch ::: ${DATA.split(" ").slice(0, 64).join(" ")} CLAUDE.md`,
    ],
  ])(
    "the data of parallel past the 64 judged one by one are judged together, each as a word: %s",
    (_label, cmd) => {
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
    },
  );
  it("the same data without a protected name stay allowed", () => {
    expect(rank(`parallel touch ::: ${DATA}`)).toBe(0);
    expect(rank(`parallel cp {} /tmp/out ::: ${DATA}`)).toBe(0);
  });

  it("an exact option name wins over a longer option it prefixes, in every wrapper that has such a pair", () => {
    expect(rank(`sudo --login ${NO_VERIFY}`)).toBe(2);
    expect(rank(`sudo --login-class x ${NO_VERIFY}`)).toBe(2);
    expect(rank(`timeout --kill-after 3 5 ${NO_VERIFY}`)).toBe(2);
    expect(rank(`timeout --kill 3 5 ${NO_VERIFY}`)).toBe(2);
  });
});
