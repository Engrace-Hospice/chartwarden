/**
 * Wave 8, T4 (round-6 ADV6-7): options that make a program run a command line of your choosing. `ssh -o 'ProxyCommand cp /tmp/x
 * .claude/settings.json' localhost` (the space form), `scp -o ProxyCommand=…`, `sftp -o ProxyCommand=…`, scp's `-S program`,
 * `zip -T -TT cmd`, `rg --pre cmd`, `man -P cmd` all ran a local command and were allowed; the doc claimed only `ssh -o
 * ProxyCommand=` (which asked). Each value is judged as a command line of its own, so a harmless one answers as typed. Both `-o
 * K=V`, `-o 'K V'` and `-oK=V` spellings, any case of the option name. `classifyBash` is pure.
 */
import { describe, expect, it } from "vitest";
import {
  localCommandOfOption,
  optionCommandStrings,
  programOptionReason,
  sshLikeCommands,
} from "../harness/option-commands";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const S = ".claude/settings.json";
const HARM = `cp /tmp/x ${S}`;

describe("localCommandOfOption: the command line one ssh -o value runs", () => {
  it.each<[string, string | undefined]>([
    ["ProxyCommand=cat x", "cat x"],
    ["ProxyCommand cat x", "cat x"],
    ["ProxyCommand = cat x", "cat x"],
    ["proxycommand=cat x", "cat x"],
    ["PROXYCOMMAND  cat x", "cat x"],
    ["LocalCommand=cat x", "cat x"],
    ["localcommand cat x", "cat x"],
    ["KnownHostsCommand=cat x", "cat x"],
    ["KnownHostsCommand /usr/bin/x %h", "/usr/bin/x %h"],
    ["ProxyJump=host", undefined],
    ["StrictHostKeyChecking=no", undefined],
    ["PermitLocalCommand=yes", undefined],
    ["ProxyCommandX=y", undefined],
    ["ProxyCommand=", undefined],
    ["", undefined],
  ])("%j", (value, expected) => {
    expect(localCommandOfOption(value)).toBe(expected);
  });
});

describe("ADV6-7: ssh, scp, sftp -o in every spelling", () => {
  it.each([
    `ssh -o 'ProxyCommand ${HARM}' localhost`,
    `ssh -o ProxyCommand='${HARM}' localhost`,
    `ssh -o 'ProxyCommand=${HARM}' localhost`,
    `ssh -oProxyCommand='${HARM}' localhost`,
    `ssh -o'ProxyCommand ${HARM}' localhost`,
    `ssh -o 'proxycommand ${HARM}' localhost`,
    `ssh -o 'PROXYCOMMAND = ${HARM}' localhost`,
    `ssh -o 'LocalCommand ${HARM}' -o PermitLocalCommand=yes localhost`,
    `ssh -o LocalCommand='${HARM}' -o PermitLocalCommand=yes localhost`,
    `ssh -o KnownHostsCommand='${HARM}' localhost`,
    `ssh -o 'KnownHostsCommand ${HARM}' localhost`,
    `ssh -o StrictHostKeyChecking=no -o 'ProxyCommand ${HARM}' localhost`,
    `scp -o ProxyCommand='${HARM}' localhost:/tmp/a /tmp/b`,
    `scp -o 'ProxyCommand ${HARM}' localhost:/tmp/a /tmp/b`,
    `scp -oProxyCommand='${HARM}' localhost:/tmp/a /tmp/b`,
    `scp -o 'LocalCommand ${HARM}' localhost:/tmp/a /tmp/b`,
    `scp -o KnownHostsCommand='${HARM}' localhost:/tmp/a /tmp/b`,
    `scp -S '${HARM}' localhost:/tmp/a /tmp/b`,
    `sftp -o ProxyCommand='${HARM}' localhost`,
    `sftp -o 'ProxyCommand ${HARM}' localhost`,
    `sftp -oLocalCommand='${HARM}' localhost`,
    `sftp -S '${HARM}' localhost`,
    `rsync -e '${HARM}' a b`,
    `rsync --rsh='${HARM}' a b`,
    `rsync -e 'ssh -o "ProxyCommand ${HARM}"' a b`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "ssh -o StrictHostKeyChecking=no localhost true",
    "ssh -o 'StrictHostKeyChecking no' localhost true",
    "ssh -o ConnectTimeout=5 -o BatchMode=yes localhost true",
    "ssh -o PermitLocalCommand=no localhost true",
    "ssh -o ProxyJump=localhost localhost true",
    "scp -P 22 localhost:/tmp/a /tmp/b",
    "scp -o ConnectTimeout=5 localhost:/tmp/a /tmp/b",
    "scp -o 'StrictHostKeyChecking no' localhost:/tmp/a /tmp/b",
    "scp -S ssh localhost:/tmp/a /tmp/b",
    "scp -S/usr/bin/ssh localhost:/tmp/a /tmp/b",
    "sftp -b /tmp/batch localhost",
    "sftp -o BatchMode=yes localhost",
    "sftp -S /usr/bin/ssh localhost",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("scp -S and sftp -S|-D replace a program: any but ssh asks", () => {
  it.each([
    "scp -S /tmp/evil localhost:/tmp/a /tmp/b",
    "scp -S/tmp/evil localhost:/tmp/a /tmp/b",
    "scp -S ./ssh2 localhost:/tmp/a /tmp/b",
    "sftp -S /tmp/evil localhost",
    "sftp -D /tmp/server localhost",
    "sftp -D/usr/lib/openssh/sftp-server localhost",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("programOptionReason is for scp and sftp only", () => {
    expect(programOptionReason("scp", ["-S", "/tmp/x"])).toMatch(/names a program/);
    expect(programOptionReason("scp", ["-S", "ssh"])).toBeNull();
    // wave 13: scp's usage line in OpenSSH_10.6p1 lists `-D sftp_server_path` (a program run here in place of ssh), so scp -D asks like sftp -D
    expect(programOptionReason("scp", ["-D", "x"])).not.toBeNull();
    expect(programOptionReason("scp", ["-D", "ssh"])).toBeNull();
    expect(programOptionReason("sftp", ["-D", "x"])).not.toBeNull();
    expect(programOptionReason("ssh", ["-S", "/tmp/ctl"])).toBeNull();
    expect(programOptionReason("cat", ["-S", "x"])).toBeNull();
  });
});

describe("zip -TT, rg --pre, man -P, less +!", () => {
  it.each([
    `zip -T -TT '${HARM}' /tmp/a.zip x`,
    `zip -TT '${HARM}' -T /tmp/a.zip x`,
    `rg --pre '${HARM}' foo .`,
    `rg --pre='${HARM}' foo .`,
    `rg --hostname-bin '${HARM}' foo .`,
    `rg --hostname-bin='${HARM}' foo .`,
    `man -P '${HARM}' ls`,
    `man -P'${HARM}' ls`,
    `man --pager '${HARM}' ls`,
    `man --pager='${HARM}' ls`,
    `less '+!${HARM}' /tmp/y`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "zip -r /tmp/a.zip src",
    "zip -T /tmp/a.zip",
    "zip -T -TT 'unzip -t' /tmp/a.zip x",
    "rg foo .",
    "rg --pre-glob '*.pdf' foo .",
    "rg --pre cat foo .",
    "rg --pre 'cat -n' foo .",
    "man ls",
    "man -k printf",
    "man -P cat ls",
    "man --pager=less ls",
    "less /tmp/y",
    "less +G /tmp/y",
    "less '+/pattern' /tmp/y",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("a harmful pager through git keeps its existing rule", () => {
    expect(d(`git -c core.pager='${HARM}' log`)).toBe("deny");
    expect(d(`GIT_PAGER='${HARM}' git log`)).toBe("ask");
  });
});

describe("the option readers on their own", () => {
  it("sshLikeCommands reads every -o and the program options of scp and sftp", () => {
    expect(sshLikeCommands("scp", ["-o", "ProxyCommand=a", "-oLocalCommand=b", "-S", "c"])).toEqual(
      ["a", "b", "c"],
    );
    expect(sshLikeCommands("sftp", ["-S", "c", "-D", "d", "-o", "KnownHostsCommand k"])).toEqual([
      "k",
      "c",
      "d",
    ]);
    expect(sshLikeCommands("ssh", ["-S", "ctl", "-o", "ProxyCommand=a"])).toEqual(["a"]);
    expect(sshLikeCommands("scp", ["-P", "22", "-o", "Compression=yes"])).toEqual([]);
    expect(sshLikeCommands("scp", ["-o"])).toEqual([]);
  });

  it("optionCommandStrings: zip, rg, man, less and nothing else", () => {
    expect(optionCommandStrings("zip", ["-TT", "c", "x.zip"])).toEqual(["c"]);
    expect(optionCommandStrings("zip", ["-T", "x.zip"])).toEqual([]);
    expect(optionCommandStrings("rg", ["--pre", "a", "--hostname-bin=b", "foo"])).toEqual([
      "a",
      "b",
    ]);
    expect(optionCommandStrings("rg", ["--pre-glob", "*.x", "foo"])).toEqual([]);
    expect(optionCommandStrings("man", ["-P", "a", "--pager=b", "-Pc"])).toEqual(["a", "c", "b"]);
    expect(optionCommandStrings("less", ["+!a", "+G"])).toEqual(["a"]);
    expect(optionCommandStrings("cat", ["-P", "x"])).toEqual([]);
  });
});
