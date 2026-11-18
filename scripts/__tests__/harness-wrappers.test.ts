/**
 * Wave 3 (fixer W3b), ADV-M7 and ADV-M10: wrappers and indirect execution the classifier did not see through, and
 * nested coding agents started without the repo's hooks. Every payload under an "asks" heading answered `allow` at
 * the base of this wave. `classifyBash` is pure: root, home and cwd are injected, no file system is read.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { containerRun, shellStrings } from "../harness/wrappers";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const local = (host: string): boolean => /^(?:[^@]+@)?(?:localhost|127\.0\.0\.1)$/.test(host);
const v = (cmd: string, c: object = ctx) => classifyBash(cmd, c);
const d = (cmd: string, c: object = ctx) => v(cmd, c).decision;
const allowed = (cmd: string) => {
  const verdict = v(cmd);
  expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
};
const RM = "rm scripts/harness/pre-tool-guard.ts";

describe("a wrapper's own words are not the command", () => {
  it.each([
    `caffeinate ${RM}`,
    `caffeinate -t 5 ${RM}`,
    `caffeinate -i -w 123 ${RM}`,
    `arch -arm64 ${RM}`,
    `arch -arch arm64 ${RM}`,
    `arch -x86_64 ${RM}`,
    `flock /tmp/l ${RM}`,
    `flock -n /tmp/l ${RM}`,
    `flock -w 5 /tmp/l ${RM}`,
    `flock /tmp/l -c '${RM}'`,
    `flock -c '${RM}' /tmp/l`,
    `parallel ${RM} ::: a b`,
    `parallel -j4 ${RM} ::: a b`,
    `unbuffer ${RM}`,
    `strace ${RM}`,
    `strace -f -o /tmp/out ${RM}`,
    `doas ${RM}`,
    `doas -u root ${RM}`,
    `pkexec ${RM}`,
    `pkexec --user root ${RM}`,
    `taskset 1 ${RM}`,
    `taskset -c 0,1 ${RM}`,
    `chrt -f 1 ${RM}`,
    `busybox ${RM}`,
    `gtimeout 5 ${RM}`,
    `xcrun ${RM}`,
    `xcrun -sdk macosx ${RM}`,
    `lima ${RM}`,
    `lima --workdir /repo ${RM}`,
    `runuser -u dev -- ${RM}`,
    `sudo -r role ${RM}`,
    `sudo -t type ${RM}`,
    `sudo --user root ${RM}`,
    `sudo --user=root ${RM}`,
    `sudo --group wheel ${RM}`,
    `exec -a x ${RM}`,
    `stdbuf -o L ${RM}`,
    `stdbuf -oL ${RM}`,
    `env -P /usr/bin ${RM}`,
    `env -C /repo ${RM}`,
    `env -S '${RM}'`,
    `watch '${RM}'`,
    `watch -n 1 '${RM}'`,
    `watch -n1 ${RM}`,
    `su -c '${RM}'`,
    `su root -c '${RM}'`,
    `su -l root --command='${RM}'`,
    `runuser -l dev -c '${RM}'`,
    `script -q /tmp/log ${RM}`,
    `script -c '${RM}' /tmp/log`,
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "caffeinate -i bun run test",
    "caffeinate -t 5 sleep 1",
    "arch -arm64 bun run test",
    "arch -arch arm64 bun run test",
    "flock /tmp/l ls",
    "flock -n /tmp/l bun run test",
    "flock -c 'ls' /tmp/l",
    "parallel echo ::: a b",
    "parallel -j4 echo ::: a b",
    "unbuffer ls",
    "strace -o /tmp/out ls",
    "doas -u root ls",
    "taskset -c 0 ls",
    "taskset 1 ls",
    "chrt -f 1 ls",
    "busybox ls",
    "gtimeout 5 ls",
    "xcrun -sdk macosx clang --version",
    "lima ls",
    "sudo --user root ls",
    "exec -a x ls",
    "stdbuf -o L ls",
    "env -P /usr/bin ls",
    "watch -n 1 date",
    "watch 'git status'",
    "su -c 'ls' root",
    "runuser -l dev -c 'ls'",
    "script -q /tmp/log ls",
  ])("keeps the everyday %s allowed", allowed);
});

describe("a command string a program runs is judged as a command line", () => {
  it.each([
    `ssh localhost '${RM}'`,
    `ssh -p 22 localhost ${RM}`,
    `ssh -i key -p 22 127.0.0.1 ${RM}`,
    `ssh -o ProxyCommand='sh -c "${RM}"' localhost`,
    `ssh -oProxyCommand='sh -c "${RM}"' localhost`,
    `ssh -o LocalCommand='${RM}' localhost`,
    `rsync -e 'sh -c "${RM}"' a localhost:/tmp/b`,
    `rsync --rsh='sh -c "${RM}"' a localhost:/tmp/b`,
    `rsync -esh a localhost:/tmp/b`.replace("-esh", `-e'sh -c "${RM}"'`),
    `tar cf /tmp/x.tar a --checkpoint=1 --checkpoint-action=exec='${RM}'`,
    `tar -xf a.tar -C /tmp/x --to-command='${RM}'`,
    `gtar cf /tmp/x.tar a --checkpoint-action=exec='${RM}'`,
    `bsdtar -xf a.tar -C /tmp/x --to-command='${RM}'`,
    `tar -I '${RM}' -cf /tmp/x.tar a`,
    `tar --use-compress-program='${RM}' -cf /tmp/x.tar a`,
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "ssh localhost ls",
    "ssh -p 22 localhost 'uptime'",
    "ssh -o StrictHostKeyChecking=no localhost true",
    "rsync -e ssh a localhost:/tmp/b",
    "rsync -avz -e 'ssh -p 2222' a localhost:/tmp/b",
    "tar -I zstd -cf /tmp/x.tzst a",
    "tar --use-compress-program=pigz -cf /tmp/x.tgz a",
    "tar -czf /tmp/x.tgz a",
  ])("keeps the everyday %s allowed", allowed);

  it("lists the command lines a program hands to a shell", () => {
    expect(shellStrings("watch", ["-n", "1", "rm x"], local)).toEqual(["rm x"]);
    expect(shellStrings("su", ["root", "-c", "rm x"], local)).toEqual(["rm x"]);
    expect(shellStrings("ssh", ["-p", "22", "localhost", "rm", "x"], local)).toEqual(["rm x"]);
    expect(shellStrings("rsync", ["-e", "sh -c x", "a", "b"], local)).toEqual(["sh -c x"]);
    expect(shellStrings("tar", ["--checkpoint-action=exec=rm x"], local)).toEqual(["rm x"]);
    expect(shellStrings("gtar", ["--to-command=rm x"], local)).toEqual(["rm x"]);
    expect(shellStrings("cat", ["a"], local)).toEqual([]);
    // A command for another host names that host's files: only what the ssh runs here is read.
    expect(shellStrings("ssh", ["root@203.0.113.9", "cat", "notes.txt"], local)).toEqual([]);
    expect(shellStrings("ssh", ["-o", "ProxyCommand=nc x", "203.0.113.9", "ls"], local)).toEqual([
      "nc x",
    ]);
  });
});

describe("a command in a container that mounts the repo is judged with the container's paths mapped back", () => {
  it.each([
    `docker run -v "$PWD":/w img ${RM.replace("scripts", "/w/scripts")}`,
    `docker run --rm -v "$PWD":/w -w /w img ${RM}`,
    `docker run -v $PWD:/w -w /w img ${RM}`,
    `docker run -v "$PWD":/w:rw img sh -c 'rm /w/scripts/harness/x'`,
    `docker run -v /repo:/w img rm /w/scripts/harness/x`,
    `docker run --mount type=bind,source="$PWD",target=/w img rm /w/compliance/controls.yaml`,
    `docker run -v "$PWD":/w --entrypoint rm img /w/compliance/controls.yaml`,
    `podman run -v ./:/w img rm /w/compliance/controls.yaml`,
    `docker run -v "$PWD":/w img rm -rf /w`,
    `docker run -v "$PWD/scripts":/s img rm /s/harness/x`,
    `docker run -v "$PWD":/w -w /w/scripts img rm harness/x`,
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    'docker run -v "$PWD":/w img npm test',
    'docker run --rm -v "$PWD":/app -w /app node:20 bun run build',
    `docker run -v "$PWD":/w:ro img ${RM.replace("scripts", "/w/scripts")}`,
    `docker run --mount type=bind,source="$PWD",target=/w,readonly img rm /w/compliance/controls.yaml`,
    "docker run img echo hi",
    "docker run -v data:/var/lib img rm /var/lib/x",
    `docker run -v /tmp/x:/w img rm /w/scripts/harness/x`,
    'docker run -v "$PWD":/w -w /w img rm -rf /w/dist',
    "docker ps",
  ])("keeps the everyday %s allowed", allowed);

  it("maps a mount's target back to its source, and the working directory with it", () => {
    expect(containerRun("docker", ["run", "-v", "/h:/w", "img", "rm", "/w/x"])).toEqual({
      command: "rm /h/x",
    });
    expect(containerRun("docker", ["run", "-v", "/h:/w", "-w", "/w/d", "img", "ls"])).toEqual({
      command: "ls",
      workdir: "/h/d",
    });
    expect(containerRun("docker", ["run", "-v", "/h:/w:ro", "img", "rm", "/w/x"])).toBeNull();
    expect(containerRun("docker", ["run", "img", "ls"])).toBeNull();
    expect(containerRun("git", ["run", "-v", "/h:/w", "img"])).toBeNull();
    // Only the mount's own path is mapped, not a path that merely holds its name, and never a mount of `/`.
    expect(containerRun("docker", ["run", "-v", "/h:/w", "img", "rm", "/x/w/y", "/w2/y"])).toEqual({
      command: "rm /x/w/y /w2/y",
    });
    expect(containerRun("docker", ["run", "-v", "/h:/", "img", "rm", "/etc/x"])).toBeNull();
  });
});

describe("a nested coding agent started without the repo's hooks asks", () => {
  it.each([
    "claude --bare -p hi",
    "codex --disable codex_hooks exec hi",
    "codex --disable=codex_hooks exec hi",
    "codex -C /tmp exec hi",
    "codex --cd /tmp exec hi",
    "codex --cd=/tmp exec hi",
    "cd /tmp && claude -p hi --allowedTools Edit Write Bash",
    "cd /tmp/other && codex exec hi",
    "cd ../elsewhere && claude -p hi",
    "cd /repo && cd /tmp && claude -p hi",
    "claude --dangerously-skip-permissions -p hi",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "claude --version",
    "codex --help",
    "cd /tmp && claude --version",
    "claude -p 'summarise this'",
    "codex exec 'summarise this'",
    "cd apps && claude -p hi",
    "cd /repo && codex exec hi",
  ])("keeps %s allowed", allowed);
});
