/**
 * Wave 13 part B, A10 and B12 (round 10: R10-ADV A10, B12; R10-CR CR-1, CR-2, CR-3): the copy and key tools of the ssh family.
 * `scp localhost:f H:g` judged only the first operand holding a colon, so the second host was never read; `ssh -P tag H` read the tag as the host
 * (`-P` takes a value); `scp -O` is a FLAG and the table swallowed the next word. Every operand is read now (`remote-operands.ts`), the option letters
 * are compared with the usage lines of the INSTALLED OpenSSH builds (recorded in `fixtures/harness-ssh-options/`, rule 12), and ssh-keyscan,
 * ssh-copy-id, sshfs and the `-D`/`-S` program options of scp and sftp ask. Words are built from parts; hosts use the reserved `.invalid` TLD.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { remoteSideHost } from "../harness/remote-operands";
import { SSH_FAMILY_VALUE_LETTERS } from "../harness/ssh-hops";
import {
  FIXTURE_DIR,
  type SshUsageFixture,
  lettersOf,
  readUsage,
  sshDirectories,
  sshVersionIn,
} from "./helpers/record-ssh-usage";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const H = ["prod", "example", "invalid"].join(".");

const fixtures: Array<[string, SshUsageFixture]> = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as SshUsageFixture]);

describe("rule 12: the production option letters are the recorded ones (no tool needed)", () => {
  it("there is a recording of at least one OpenSSH build", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const [file, fixture] of fixtures) {
    for (const [program, usage] of Object.entries(fixture.usage)) {
      it(`${file}: ${program} reads every recorded valued letter as valued and no flag as valued`, () => {
        const recorded = lettersOf(usage);
        const table = SSH_FAMILY_VALUE_LETTERS[program] ?? "";
        const sorted = (letters: string) => [...letters].sort().join("");
        expect(sorted(table)).toBe(sorted(recorded.valued));
        for (const flag of recorded.flags) expect(table, `${program} -${flag}`).not.toContain(flag);
      });
    }
  }

  it("scp -O is a flag and ssh -P is valued (the two table errors of round 10)", () => {
    expect(SSH_FAMILY_VALUE_LETTERS.scp).not.toContain("O");
    expect(SSH_FAMILY_VALUE_LETTERS.ssh).toContain("P");
  });
});

describe("rule 12 live: the installed builds still print the recorded usage lines", () => {
  for (const dir of sshDirectories()) {
    it(`the ssh family in ${dir}`, (skipContext) => {
      const version = sshVersionIn(dir);
      const recorded = fixtures.find(([, f]) => f.version === version)?.[1];
      if (recorded === undefined) {
        skipContext.skip(
          `${dir}/ssh is ${version ?? "not answering"} and no recording of it exists: run bun scripts/__tests__/helpers/record-ssh-usage.ts --write`,
        );
        return;
      }
      for (const [program, usage] of Object.entries(recorded.usage)) {
        expect(readUsage(dir, program), `${dir}/${program} ${version}`).toBe(usage);
      }
    });
  }
});

describe("remoteSideHost: which operand names a machine", () => {
  it.each<[string, string | null]>([
    [`${H}:/tmp/a`, H],
    [`u@${H}:a`, H],
    ["localhost:f", "localhost"],
    ["./a:b", null],
    ["/tmp/a:b", null],
    ["plain.txt", null],
    ["[::1]:f", "[::1]"],
    [`u@[::1]:f`, "[::1]"],
    [`scp://u@${H}/f`, H],
    [`rsync://${H}:873/mod`, H],
    [`${H}::mod`, H],
    ["$HOST:dir", "$HOST"],
    [":path", ""],
  ])("%s", (operand, host) => {
    expect(remoteSideHost(operand)).toBe(host);
  });
});

describe("A10, CR-2, CR-3, CR-1: every operand that names a machine is judged", () => {
  it.each([
    `scp localhost:f ${H}:g`,
    `scp ./a:b ${H}:g`,
    `scp -3 localhost:f ${H}:g`,
    `scp 'localhost:f' u@${H}:g`,
    `scp a.txt localhost:/tmp ${H}:/tmp/`,
    `scp -P 22 localhost:f ${H}:g`,
    `scp -O ${H}:f ./g`,
    `scp -O localhost:a ${H}:b`,
    `scp -O -J ${H} localhost:a localhost:b`,
    `scp -O -o ProxyJump=${H} localhost:a localhost:b`,
    `scp scp://localhost/f ${H}:g`,
    `scp ./f $HOST:dir`,
    `scp ./f "$HOST:dir"`,
    `rsync -a localhost:a ${H}:b`,
    `rsync -av localhost:dir/ u@${H}:dir/`,
    `rsync -av rsync://${H}/mod ./x`,
    `rsync -av ${H}::mod ./x`,
    `ssh -P localhost ${H} true`,
    `ssh -P tag ${H}`,
    `ssh -qP tag ${H} id`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "scp ./file localhost:dir",
    'scp ./file "localhost:/home/u/dir"',
    "scp -r ./dir u@127.0.0.1:dir",
    "scp ./a:b ./c",
    "scp -P 2222 -i key ./f localhost:dir",
    "scp user@localhost:f ./g",
    "scp -o 'ProxyJump=localhost' ./f localhost:g",
    "scp -O ./f localhost:g",
    "scp [::1]:f ./g",
    "scp localhost:a localhost:b",
    "rsync -av ./src/ localhost:dir/",
    "rsync -av ./a/ ./b/",
    "rsync -av --exclude '*.log' ./a/ ./b/",
    "rsync -e 'ssh -p 22' ./a/ localhost:b",
    "rsync -av --delete ./dist/ ./out/",
    "ssh -P tag localhost true",
    "ssh -p 2222 localhost id",
    "ssh -i key -o BatchMode=yes localhost uptime",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("B12: other remote reach of the ssh family", () => {
  it.each([
    `ssh-keyscan ${H}`,
    `ssh-keyscan -t rsa ${H}`,
    `ssh-keyscan -p 22 localhost,${H}`,
    "ssh-keyscan -f hosts.txt",
    `ssh-copy-id ${H}`,
    `ssh-copy-id -i key.pub u@${H}`,
    `ssh-copy-id -i key.pub -p 22 ${H}`,
    `ssh-copy-id -f -n -i key.pub ${H}`,
    `ssh-copy-id -p 2222 -o StrictHostKeyChecking=no u@${H}`,
    `sshfs ${H}:/ /tmp/m`,
    `sshfs -p 22 u@${H}:/x /tmp/m`,
    `scp -D 'ssh ${H} sftp-server' f g`,
    "scp -D /usr/libexec/sftp-server ./f localhost:g",
    "scp -D./local-server ./f localhost:g",
    "scp -r -D ./local-server ./d localhost:g",
    `sftp -D 'ssh ${H} sftp-server' x`,
    "scp -S ./prog f g",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "ssh-keyscan localhost",
    "ssh-keyscan localhost,127.0.0.1",
    "ssh-keyscan localhost 127.0.0.1",
    "ssh-keyscan -t rsa,ed25519 127.0.0.1",
    "ssh-copy-id -p 2222 localhost",
    "ssh-copy-id -i key.pub u@localhost",
    "ssh-copy-id -f -i key.pub localhost",
    "ssh-copy-id -i other.pub -p 2222 127.0.0.1",
    "sshfs localhost:/ /tmp/m",
    "sshfs -p 22 localhost:/x /tmp/m",
    "sftp localhost",
    "scp -o StrictHostKeyChecking=no ./f localhost:g",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
