/**
 * Wave 12 part E2, E2-5 (R9-ADV-15): jump hosts, forwards and proxies of ssh and its relatives. `ssh -J H localhost psql`, `-o ProxyJump=H`,
 * `-W H:5432 localhost`, `-L 5433:H:5432 localhost -N`, `-R`, `-o HostName=H`, `scp -J`, `sftp -J`, `sftp H`, `mosh H` and `et H` reach another machine
 * through a target that is this one: they ask. `ssh H psql` and `ssh -L 5433:localhost:5432 localhost` keep their verdicts. The ssh, scp and sftp rows are
 * proven against the INSTALLED OpenSSH with `ssh -G` (offline: it prints what the command line would configure and connects to nothing); mosh and et are
 * not installed here, so their rows are the manual's and unverified. The non-local host is built from parts and uses the reserved `.invalid` TLD.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { remoteHopReason } from "../harness/ssh-hops";

const HOST = `prod${"."}example${"."}invalid`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const isLocal = (h: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);

/** Spellings that make ssh, scp or sftp reach another machine although the target is local, and what the installed `ssh -G` prints for each. */
const HOPS: ReadonlyArray<{ name: string; args: string[]; shows: RegExp }> = [
  {
    name: "-J HOST",
    args: ["-J", HOST, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-JHOST",
    args: [`-J${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-J user@HOST:port",
    args: ["-J", `u@${HOST}:22`, "localhost"],
    shows: new RegExp(`^proxyjump u@${HOST}:22$`, "m"),
  },
  {
    name: "-J ssh://user@HOST:port",
    args: ["-J", `ssh://u@${HOST}:22`, "localhost"],
    shows: new RegExp(`^proxyjump u@${HOST}:22$`, "m"),
  },
  {
    name: "-J second hop",
    args: ["-J", `localhost,${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump localhost,${HOST}$`, "m"),
  },
  {
    name: "-o ProxyJump=HOST",
    args: ["-o", `ProxyJump=${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-oProxyJump=HOST",
    args: [`-oProxyJump=${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-o 'ProxyJump HOST'",
    args: ["-o", `ProxyJump ${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-o proxyjump = HOST (any case)",
    args: ["-o", `proxyjump = ${HOST}`, "localhost"],
    shows: new RegExp(`^proxyjump ${HOST}$`, "m"),
  },
  {
    name: "-L port:HOST:port",
    args: ["-L", `5433:${HOST}:5432`, "localhost", "-N"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-Lport:HOST:port",
    args: [`-L5433:${HOST}:5432`, "localhost", "-N"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-NL port:HOST:port (cluster)",
    args: ["-NL", `5433:${HOST}:5432`, "localhost"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-fNL port:HOST:port (cluster)",
    args: ["-fNL", `5433:${HOST}:5432`, "localhost"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-L bind:port:HOST:port",
    args: ["-L", `127.0.0.1:5433:${HOST}:5432`, "localhost", "-N"],
    shows: new RegExp(`^localforward \\[127.0.0.1\\]:5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-L after the host",
    args: ["localhost", "-L", `5433:${HOST}:5432`, "-N"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-R port:HOST:port",
    args: ["-R", `8080:${HOST}:80`, "localhost", "-N"],
    shows: new RegExp(`^remoteforward 8080 \\[${HOST}\\]:80$`, "m"),
  },
  {
    name: "-o LocalForward='port HOST:port'",
    args: ["-o", `LocalForward=5433 ${HOST}:5432`, "localhost", "-N"],
    shows: new RegExp(`^localforward 5433 \\[${HOST}\\]:5432$`, "m"),
  },
  {
    name: "-o RemoteForward='port HOST:port'",
    args: ["-o", `RemoteForward=8080 ${HOST}:80`, "localhost", "-N"],
    shows: new RegExp(`^remoteforward 8080 \\[${HOST}\\]:80$`, "m"),
  },
  {
    name: "-o HostName=HOST",
    args: ["-o", `HostName=${HOST}`, "localhost"],
    shows: new RegExp(`^hostname ${HOST}$`, "m"),
  },
];

const ssh = spawnSync("ssh", ["-V"], { encoding: "utf8" });
const SSH_INSTALLED = ssh.error === undefined;
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "cw-ssh-hops-"));

describe("E2-5: the spellings are what the installed ssh reads them as (ssh -G, offline)", () => {
  for (const { name, args, shows } of HOPS) {
    it.skipIf(!SSH_INSTALLED)(`${name}: ssh -G configures the hop`, () => {
      const out = spawnSync("ssh", ["-G", "-F", "/dev/null", ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: SCRATCH_HOME, LANG: "C" },
        timeout: 5000,
      });
      expect(out.stdout, `${name}: ${out.stderr}`).toMatch(shows);
    });
  }

  it.skipIf(!SSH_INSTALLED)(
    "an option after the first command word belongs to the command, not to ssh",
    () => {
      const out = spawnSync(
        "ssh",
        ["-G", "-F", "/dev/null", "localhost", "ls", "-L", `5433:${HOST}:5432`],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: SCRATCH_HOME, LANG: "C" },
          timeout: 5000,
        },
      );
      expect(out.stdout).not.toMatch(/^localforward /m);
    },
  );
  it.skipIf(!SSH_INSTALLED)("a forward to a socket on the far side names no host", () => {
    const out = spawnSync(
      "ssh",
      ["-G", "-F", "/dev/null", "-L", "127.0.0.1:5433:/tmp/sock", "localhost"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: SCRATCH_HOME, LANG: "C" },
        timeout: 5000,
      },
    );
    expect(out.stdout).toMatch(/^localforward \[127.0.0.1\]:5433 \/tmp\/sock$/m);
  });
});

/** A cluster ends at its first valued letter: the host is the first word after the option's value, not the value. */
const CLUSTERS: ReadonlyArray<{ name: string; args: string[]; shows: RegExp[] }> = [
  {
    name: "-qi KEY HOST",
    args: ["-qi", "/etc/hosts", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^identityfile \/etc\/hosts$/m],
  },
  {
    name: "-vo Option=x HOST",
    args: ["-vo", "StrictHostKeyChecking=no", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^stricthostkeychecking false$/m],
  },
  {
    name: "-tl USER HOST",
    args: ["-tl", "root", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^user root$/m],
  },
  {
    name: "-Nl USER HOST",
    args: ["-Nl", "root", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^user root$/m],
  },
  {
    name: "-p2222 HOST",
    args: ["-p2222", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^port 2222$/m],
  },
  {
    name: "-qp 2222 HOST",
    args: ["-qp", "2222", HOST],
    shows: [new RegExp(`^hostname ${HOST}$`, "m"), /^port 2222$/m],
  },
  {
    name: "-NL spec HOST",
    args: ["-NL", `localhost:5433:localhost:5432`, HOST],
    shows: [
      new RegExp(`^hostname ${HOST}$`, "m"),
      /^localforward \[localhost\]:5433 \[localhost\]:5432$/m,
    ],
  },
];

describe("E2-5: a clustered option does not make its value the host (ssh -G, offline)", () => {
  for (const { name, args, shows } of CLUSTERS) {
    it.skipIf(!SSH_INSTALLED)(`${name}: ssh reads the host after the value`, () => {
      const out = spawnSync("ssh", ["-G", "-F", "/dev/null", ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: SCRATCH_HOME, LANG: "C" },
        timeout: 5000,
      });
      for (const line of shows) expect(out.stdout, `${name}: ${out.stderr}`).toMatch(line);
    });
  }
});

describe("E2-5: a jump, forward or proxy that names another machine asks", () => {
  for (const { name, args } of HOPS) {
    it(`ssh ${name} asks`, () => {
      expect(remoteHopReason("ssh", args, isLocal), name).not.toBeNull();
      expect(
        decide(`ssh ${args.map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(" ")} psql -c 1`),
      ).toBe("ask");
    });
  }

  const SCP_SFTP: Record<string, string> = {
    "scp -J": `scp -J ${HOST} a localhost:b`,
    "scp -J after the files": `scp a localhost:b -J ${HOST}`,
    "scp -o ProxyJump": `scp -o ProxyJump=${HOST} a localhost:b`,
    "scp -oProxyJump": `scp -oProxyJump=${HOST} a localhost:b`,
    "scp -o HostName": `scp -o HostName=${HOST} a localhost:b`,
    "sftp -J": `sftp -J ${HOST} localhost`,
    "sftp -J user@host:port": `sftp -J u@${HOST}:22 localhost`,
    "sftp -o ProxyJump": `sftp -o ProxyJump=${HOST} localhost`,
    "sftp HOST": `sftp ${HOST}`,
    "sftp user@HOST": `sftp u@${HOST}`,
    "sftp HOST:path": `sftp ${HOST}:file`,
    "sftp sftp://HOST/path": `sftp sftp://${HOST}/file`,
    "sftp -P port HOST": `sftp -P 2222 ${HOST}`,
    "sftp -b batch HOST": `sftp -b /tmp/b ${HOST}`,
  };
  for (const [name, cmd] of Object.entries(SCP_SFTP)) {
    it(`${name} asks`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }

  const SESSION_TOOLS: Record<string, string> = {
    "mosh HOST": `mosh ${HOST}`,
    "mosh user@HOST": `mosh u@${HOST}`,
    "mosh user@HOST -- cmd": `mosh u@${HOST} -- ls`,
    "mosh --ssh= HOST": `mosh --ssh=ssh ${HOST}`,
    "mosh --family=inet HOST": `mosh --family=inet ${HOST}`,
    "mosh -p port HOST": `mosh -p 60001 ${HOST}`,
    "mosh --ssh with a jump": `mosh --ssh='ssh -J ${HOST}' localhost`,
    "mosh with an unlisted option": "mosh --no-such-option localhost",
    "et HOST": `et ${HOST}`,
    "et user@HOST": `et u@${HOST}`,
    "et HOST:port": `et ${HOST}:2022`,
    "et -p port HOST": `et -p 2022 ${HOST}`,
    "et --port=port HOST": `et --port=2022 ${HOST}`,
    "et -j HOST localhost": `et -j ${HOST} localhost`,
    "et --jumphost HOST localhost": `et --jumphost ${HOST} localhost`,
    "et -N HOST": `et -N ${HOST}`,
    "et with an unlisted option": "et --no-such-option localhost",
  };
  for (const [name, cmd] of Object.entries(SESSION_TOOLS)) {
    it(`${name} asks (mosh and et are not installed here: the option lists are from their manuals)`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }

  const MORE_ASKS: Record<string, string> = {
    "-W HOST:port": `ssh -W ${HOST}:22 localhost`,
    "-W [HOST]:port": `ssh -W [${HOST}]:22 localhost`,
    "-W after the host": `ssh localhost -W ${HOST}:22`,
    "-W with -N": `ssh -N -W ${HOST}:22 localhost`,
    "-L bind:port:HOST:port with an IPv6 bind": `ssh -L [::1]:5433:${HOST}:5432 localhost -N`,
    "-L port:[HOST]:port": `ssh -L 5433:[${HOST}]:5432 localhost -N`,
    "-L local_socket:HOST:port": `ssh -L /tmp/sock:${HOST}:5432 localhost -N`,
    "-R bind:port:HOST:port": `ssh -R 127.0.0.1:8080:${HOST}:80 localhost -N`,
    "-R port:HOST:port after the host": `ssh localhost -R 8080:${HOST}:80 -N`,
    "-J after the host": `ssh localhost -J ${HOST} ls`,
    "-o ProxyJump after the host": `ssh localhost -o ProxyJump=${HOST} -N`,
    "-J with a nested -o ProxyJump=none before it": `ssh -o ProxyJump=none -J ${HOST} localhost ls`,
    "-o HostName with a local alias": `ssh -o HostName=${HOST} dbserver ls`,
    "-o hostname (any case)": `ssh -o hostname=${HOST} dbserver ls`,
    "-o 'HostName HOST'": `ssh -o 'HostName ${HOST}' dbserver ls`,
    "-o LocalForward 'port HOST:port'": `ssh -o 'LocalForward 5433 ${HOST}:5432' localhost -N`,
    "-o localforward = 'port HOST:port'": `ssh -o 'localforward = 5433 ${HOST}:5432' localhost -N`,
    "-o LocalForward 'bind:port HOST:port'": `ssh -o 'LocalForward 127.0.0.1:5433 ${HOST}:5432' localhost -N`,
    "-o RemoteForward 'port HOST:port'": `ssh -o 'RemoteForward 8080 ${HOST}:80' localhost -N`,
    "-J with a local first hop": `ssh -J localhost,${HOST} localhost ls`,
    "-J IPv4 not loopback": "ssh -J 10.1.2.3 localhost ls",
    "-J host alias": "ssh -J bastion localhost ls",
    "-J host with a local-looking prefix": `ssh -J localhost.${HOST} localhost ls`,
    "mosh --ssh with a jump": `mosh --ssh 'ssh -J ${HOST}' localhost`,
    "et -j with an equals sign": `et --jumphost=${HOST} localhost`,
    "et -j IPv4": "et -j 10.1.2.3 localhost",
    "et --jport with a remote host": `et --jport 2022 ${HOST}`,
    "mosh after options": `mosh -n --family=inet ${HOST}`,
    "mosh with --": `mosh -- ${HOST}`,
    "et --host": `et --host ${HOST}`,
  };
  for (const [name, cmd] of Object.entries(MORE_ASKS)) {
    it(`${name} asks`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }

  it("a hop that cannot be placed asks", () => {
    for (const cmd of [
      "ssh -J $JUMP localhost ls",
      "ssh -J /$X localhost ls",
      "ssh -L 5433:/$(cat h):5432 localhost -N",
      "ssh -W /$X:22 localhost",
      'ssh -J "$(cat j)" localhost ls',
      "ssh -o ProxyJump=$J localhost ls",
      "ssh -L 5433:$H:5432 localhost -N",
      "ssh -L 5433:`cat h`:5432 localhost -N",
      "ssh -L bad localhost -N",
      "ssh -L 1:2:3:4:5 localhost -N",
      "ssh -W $H:22 localhost",
      "ssh -W nocolon localhost",
      "sftp -J {a,b} localhost",
      "scp -J $J a localhost:b",
      "mosh $H",
      "et $H",
    ]) {
      expect(decide(cmd), cmd).toBe("ask");
    }
  });
});

describe("E2-5: the verdicts that must not change", () => {
  const NEIGHBOURS = [
    "ssh localhost ls",
    "ssh -A -p 2222 localhost ls",
    "ssh -L 5433:localhost:5432 localhost",
    "ssh -L 5433:localhost:5432 -N localhost",
    "ssh -L 5433:127.0.0.1:5432 localhost -N",
    "ssh -L 127.0.0.1:5433:localhost:5432 localhost -N",
    "ssh -NL 5433:localhost:5432 localhost",
    "ssh -L 5433:/tmp/sock localhost -N",
    "ssh -L 127.0.0.1:5433:/tmp/sock localhost -N",
    "ssh -L 5433:[::1]:5432 localhost -N",
    "ssh -R 8080:localhost:80 localhost -N",
    "ssh -o 'LocalForward=5433 localhost:5432' localhost -N",
    "ssh -D 1080 localhost -N",
    "ssh -J localhost localhost ls",
    "ssh -o ProxyJump=none localhost ls",
    "ssh -J none localhost ls",
    "ssh -o ProxyJump=localhost localhost ls",
    "ssh -J [::1] localhost ls",
    "ssh -o StrictHostKeyChecking=no localhost ls",
    "ssh -o ServerAliveInterval=30 localhost ls",
    "ssh -i /tmp/key localhost ls",
    "ssh localhost ls -L 5433",
    "ssh localhost sed -i x file",
    "ssh -W localhost:22 localhost",
    "scp a.txt localhost:/tmp/b",
    "scp -P 2222 a.txt localhost:/tmp/b",
    "scp -J localhost a localhost:b",
    "sftp localhost",
    "sftp -P 2222 localhost",
    "sftp localhost:file",
    "mosh localhost",
    "mosh u@localhost",
    "mosh --family=inet localhost",
    "et localhost",
    "et -p 2022 localhost",
    "et u@localhost:2022",
  ];
  for (const cmd of NEIGHBOURS) {
    it(`${cmd} is allowed`, () => {
      expect(decide(cmd), cmd).toBe("allow");
    });
  }

  const CLUSTERED_TARGETS: Record<string, string> = {
    "-NL with a local-looking forward (the value was read as the host)": `ssh -NL localhost:5433:localhost:5432 ${HOST}`,
    "-fNL with a loopback bind": `ssh -fNL 127.0.0.1:5433:localhost:5432 ${HOST}`,
    "-qi KEY HOST (a path was read as the host)": `ssh -qi /tmp/k ${HOST} ls`,
    "-vo Option=value HOST": `ssh -vo StrictHostKeyChecking=no ${HOST} ls`,
    "-tl USER HOST": `ssh -tl root ${HOST} ls`,
    "-Nl USER HOST": `ssh -Nl root ${HOST}`,
    "-p2222 HOST": `ssh -p2222 ${HOST} ls`,
    "-qp 2222 HOST": `ssh -qp 2222 ${HOST} ls`,
    "-AqJ jump HOST (clustered jump)": `ssh -AqJ localhost ${HOST} ls`,
    "-qo ProxyCommand (judged as a command)": `ssh -qo 'ProxyCommand=nc ${HOST} 22' localhost ls`,
  };
  for (const [name, cmd] of Object.entries(CLUSTERED_TARGETS)) {
    it(`a clustered option does not hide the host: ${name}`, () => {
      expect(decide(cmd), cmd).toBe("ask");
    });
  }
  const MORE_ALLOWS: Record<string, string> = {
    "an option after the command word is the command's": `ssh localhost ls -J ${HOST}`,
    "-L after the command word": `ssh localhost sed -i x -L ${HOST}`,
    "-W after the command word": `ssh localhost grep -o foo -W ${HOST}:22`,
    "-o ProxyJump after the command word": `ssh localhost echo -o ProxyJump=${HOST}`,
    "-W to localhost": "ssh -W localhost:22 localhost",
    "-W to an IPv6 loopback": "ssh -W [::1]:22 localhost",
    "-L bind:port:localhost:port": "ssh -L 127.0.0.1:5433:localhost:5432 localhost -N",
    "-L local_socket:localhost:port": "ssh -L /tmp/sock:localhost:5432 localhost -N",
    "-R bind:port:localhost:port": "ssh -R 127.0.0.1:8080:localhost:80 localhost -N",
    "-o LocalForward with a local host": "ssh -o 'LocalForward 5433 localhost:5432' localhost -N",
    "-o RemoteForward with a local host": "ssh -o 'RemoteForward 8080 localhost:80' localhost -N",
    "-o HostName localhost": "ssh -o HostName=localhost localhost ls",
    "-J local, ssh:// form": "ssh -J ssh://u@localhost:22 localhost ls",
    "-J local with a port": "ssh -J localhost:2222 localhost ls",
    "-J IPv6 loopback with a port": "ssh -J [::1]:22 localhost ls",
    "mosh --ssh with a plain ssh": "mosh --ssh=ssh localhost",
    "et -j localhost": "et -j localhost localhost",
    "et --jumphost=localhost": "et --jumphost=localhost localhost",
    "mosh -n": "mosh -n localhost",
  };
  for (const [name, cmd] of Object.entries(MORE_ALLOWS)) {
    it(`${name} is allowed`, () => {
      expect(decide(cmd), cmd).toBe("allow");
    });
  }

  it("a clustered option before a local host is allowed", () => {
    for (const cmd of [
      "ssh -NL 5433:localhost:5432 localhost",
      "ssh -fNL 127.0.0.1:5433:localhost:5432 localhost",
      "ssh -qi /tmp/k localhost ls",
      "ssh -vo StrictHostKeyChecking=no localhost ls",
      "ssh -qp 2222 localhost ls",
      "ssh -Nl root localhost",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a remote target still asks, as it did", () => {
    expect(decide(`ssh ${HOST} psql -c 1`)).toBe("ask");
    expect(decide(`ssh u@${HOST} ls`)).toBe("ask");
    expect(decide(`scp a.txt u@${HOST}:/tmp/b`)).toBe("ask");
  });

  it("the reason names the option and does not echo the host", () => {
    const verdict = classifyBash(`ssh -J ${HOST} localhost ls`, ctx);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toContain("ssh -J");
    expect(verdict.reason).not.toContain(HOST);
  });

  it("a rsync -e command line is read as the ssh it runs", () => {
    expect(decide(`rsync -e 'ssh -J ${HOST}' a localhost:b`)).toBe("ask");
    expect(decide("rsync -e 'ssh -p 2222' a localhost:b")).toBe("allow");
  });
});
