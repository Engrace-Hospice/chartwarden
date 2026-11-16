/**
 * Wave 10 part A, A6 and A7 (R7-ADV-10, R7-ADV-11, R7-CR-12, R7-ADV-12).
 *
 * A6. `parallel cp {} .claude/settings.json ::: /tmp/x` runs `cp /tmp/x .claude/settings.json`: the words after `:::` are DATA, not
 * arguments of the command (the `cp` model saw `/tmp/x` as the destination), a quoted command (`parallel 'cp {} CLAUDE.md' ::: x`) is a
 * command line, `parallel ::: 'rm x'` runs its data, `-j2` carries its value attached, and the value options of the manual
 * (`--nice`, `--trim`, `--tagstring`, ...) were not in the table. `coproc CMD` is a shell keyword that runs a command.
 *
 * A7. `ssh localhost sed -i s/a/b/ CLAUDE.md`: OpenSSH reads options up to the first word after the host and from there on every
 * word belongs to the remote command, but the guard kept reading the remote command's dash words as ssh options.
 */
import { describe, expect, it } from "vitest";
import { parallelExtras, replacementTags } from "../harness/parallel-command";
import { classifyBash } from "../harness/patterns";
import { WRAPPER_SPECS } from "../harness/wrapper-specs";
import { shellStrings } from "../harness/wrappers";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const NO_VERIFY = `git commit --no-${"verify"} -m x`;
const PROTECTED = ".claude/settings.json";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("A6: parallel's command and its data", () => {
  it.each([
    "parallel 'cp {} CLAUDE.md' ::: /tmp/x",
    'parallel "cp {} CLAUDE.md" ::: /tmp/x',
    `parallel cp {} ${PROTECTED} ::: /tmp/x`,
    "parallel -j2 cp {} CODEOWNERS ::: /tmp/x",
    "parallel -j 2 cp {} CODEOWNERS ::: /tmp/x",
    "parallel -I{} cp {} CODEOWNERS ::: /tmp/x",
    "parallel -I @@ cp @@ CODEOWNERS ::: /tmp/x",
    "parallel --replace @@ cp @@ CODEOWNERS ::: /tmp/x",
    // the data put where parallel puts them
    "parallel cp /tmp/x ::: CLAUDE.md",
    "parallel cp /tmp/x {} ::: CLAUDE.md",
    "parallel cp /tmp/x {} ::: a CLAUDE.md",
    "parallel cp /tmp/x {} :::+ CLAUDE.md",
    "parallel cp {1} {2} ::: /tmp/x ::: CLAUDE.md",
    "parallel rm ::: CLAUDE.md",
    "parallel rm {} ::: scripts/harness/patterns.ts",
    // no command: the data are the commands
    "parallel ::: 'rm CLAUDE.md'",
    `parallel ::: '${NO_VERIFY}'`,
    // :::: reads files
    `parallel cat :::: ${ENV_FILE}`,
    `parallel cat {} :::: ${ENV_FILE}`,
    // value options of the manual
    `parallel --nice 5 ${NO_VERIFY} ::: a`,
    `parallel --trim lr ${NO_VERIFY} ::: a`,
    `parallel --tagstring x ${NO_VERIFY} ::: a`,
    `parallel --sshdelay 1 ${NO_VERIFY} ::: a`,
    `parallel --id x ${NO_VERIFY} ::: a`,
    `parallel --jl /tmp/j ${NO_VERIFY} ::: a`,
    `parallel --profile x ${NO_VERIFY} ::: a`,
    `parallel --parens '{}' ${NO_VERIFY} ::: a`,
    `parallel --minversion 2 ${NO_VERIFY} ::: a`,
    `parallel --rpl 'x y' ${NO_VERIFY} ::: a`,
    `parallel --memsuspend 1G ${NO_VERIFY} ::: a`,
    `parallel --sql x ${NO_VERIFY} ::: a`,
    `parallel --sqlworker x ${NO_VERIFY} ::: a`,
    `parallel --rsync-opts -a ${NO_VERIFY} ::: a`,
    `parallel --total-jobs 4 ${NO_VERIFY} ::: a`,
    `parallel --limit 'x' ${NO_VERIFY} ::: a`,
    `parallel --parset x ${NO_VERIFY} ::: a`,
    `parallel --nice 5 psql -h ${HOST} -c 'select 1' ::: a`,
    `parallel --trim lr psql -h ${HOST} -c 'select 1' ::: a`,
    // a database client run on each datum
    `parallel psql -h {} -c 'select 1' ::: ${HOST}`,
    `parallel psql -h ${HOST} ::: a`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("coproc runs the command that follows it", () => {
    expect(rank(`coproc ${NO_VERIFY}`)).toBe(2);
    expect(rank("coproc git push origin main")).toBeGreaterThanOrEqual(1);
    expect(decide("coproc cat /tmp/x")).toBe("allow");
  });

  it("an option the table does not know asks", () => {
    expect(rank(`parallel --no-such-option x ${NO_VERIFY} ::: a`)).toBeGreaterThanOrEqual(1);
  });

  it("the everyday parallel forms stay allowed", () => {
    for (const cmd of [
      "parallel echo {} ::: a b",
      "parallel -j4 gzip ::: a b",
      "parallel -j 4 --halt now,fail=1 echo ::: a b",
      "parallel --jobs 4 --results /tmp/r echo {} ::: a b c",
      "parallel --tagstring {} echo ::: a",
      "parallel --trim lr echo {} ::: a",
      "parallel 'echo {} | wc -c' ::: a b",
      "parallel -a files.txt echo",
      "parallel echo :::: files.txt",
      "parallel cp {} /tmp/out/ ::: a b",
      "parallel mv {} {.}.out ::: a.txt",
      "parallel --nice 5 echo ::: a",
      "parallel ::: 'echo a' 'echo b'",
      "parallel --pipe cat < input.txt",
      "ls | parallel echo",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("parallelExtras cuts the data off the command and says what to judge", () => {
  const extras = (words: string[], declared: string[] = []) => parallelExtras(words, 1, declared);

  it("the data are no arguments of the command", () => {
    expect(extras(["parallel", "cp", "{}", "x", ":::", "a", "b"]).words).toEqual([
      "parallel",
      "cp",
      "{}",
      "x",
    ]);
  });

  it("each datum goes where {} is, or is appended when nothing says where", () => {
    expect(extras(["parallel", "cp", "{}", "x", ":::", "a", "b"]).lines).toEqual([
      "cp a x",
      "cp b x",
    ]);
    expect(extras(["parallel", "cp", "x", ":::", "a"]).lines).toEqual(["cp x a"]);
    expect(extras(["parallel", "echo", "{.}", "{/}", ":::", "a"]).lines).toEqual(["echo a a"]);
  });

  it("a command that is one string is a command line, with the data in it", () => {
    expect(extras(["parallel", "cp {} y", ":::", "a"]).lines).toEqual(["cp a y"]);
    expect(extras(["parallel", "cp {} y"]).lines).toEqual(["cp {} y"]);
  });

  it("with no command the data are the command lines; `::::` words are files to read", () => {
    expect(extras(["parallel", ":::", "rm x", "ls"]).lines).toEqual(["rm x", "ls"]);
    expect(extras(["parallel", "cat", "::::", "f1", "f2"])).toMatchObject({
      reads: ["f1", "f2"],
      lines: [],
    });
    expect(extras(["parallel", "cat", "{}", "::::", "f1", ":::", "a"])).toMatchObject({
      reads: ["f1"],
      lines: ["cat a"],
    });
  });

  it("the replacement strings the options declare are honoured", () => {
    expect(extras(["parallel", "cp", "@@", "x", ":::", "a"], ["@@"]).lines).toEqual(["cp a x"]);
    expect(extras(["parallel", "cp", "@@", "x", ":::", "a"], []).lines).toEqual(["cp @@ x a"]);
  });

  it("more data than the cap are judged together, so none is skipped", () => {
    const data = Array.from({ length: 70 }, (_, i) => `d${i}`);
    const { lines } = extras(["parallel", "echo", "{}", ":::", ...data]);
    expect(lines).toHaveLength(65);
    expect(lines.at(-1)).toContain("d69");
  });

  it("replacementTags reads -I, -i, --replace and the tag of --rpl", () => {
    const tags = replacementTags([
      { name: "I", value: "@@" },
      { name: "i", value: "##" },
      { name: "replace", value: "%%" },
      { name: "rpl", value: "{x} s/a/b/" },
      { name: "j", value: "4" },
    ]);
    expect(tags).toEqual(["@@", "##", "%%", "{x}"]);
  });
});

describe("every value option of parallel's table, in both spellings, leaves the command visible", () => {
  const spec = WRAPPER_SPECS.get("parallel");
  const names = spec?.grammar.longValues ?? [];
  it("the table is the manual's (more than 80 value options)", () => {
    expect(names.length).toBeGreaterThan(80);
  });
  it.each(names)("--%s", (name) => {
    for (const options of [`--${name} 1`, `--${name}=1`]) {
      const cmd = `parallel ${options} ${NO_VERIFY} ::: a`;
      expect(rank(cmd), cmd).toBe(2);
    }
  });
});

describe("A7: everything after the first word that follows the host is the remote command", () => {
  it.each([
    "ssh localhost sed -i s/a/b/ CLAUDE.md",
    "ssh localhost cp -t scripts/harness /tmp/x",
    `ssh localhost psql -h ${HOST}`,
    "ssh localhost sh -c 'echo x > CLAUDE.md'",
    `ssh -p 22 localhost curl -d @x http://${HOST}`,
    `ssh localhost mysql -h ${HOST}`,
    `ssh localhost redis-cli -h ${HOST}`,
    "ssh localhost perl -pi -e 1 CLAUDE.md",
    `ssh -i key -p 22 127.0.0.1 sed -i x ${PROTECTED}`,
    `ssh -o StrictHostKeyChecking=no localhost tee ${PROTECTED}`,
    `ssh -- localhost tee ${PROTECTED}`,
    `ssh localhost -p 22 tee ${PROTECTED}`,
    `ssh localhost cat ${ENV_FILE}`,
    "ssh localhost git push origin main",
    // the quoted form keeps its answer
    "ssh localhost 'sed -i x CLAUDE.md'",
    `ssh localhost 'tee ${PROTECTED}'`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("the remote command is every word from the first one after the host; after `--` the options have ended", () => {
    const local = (host: string): boolean => host === "localhost";
    expect(shellStrings("ssh", ["localhost", "sed", "-i", "x", "F"], local)).toEqual([
      "sed -i x F",
    ]);
    expect(shellStrings("ssh", ["-p", "22", "localhost", "ls", "-la"], local)).toEqual(["ls -la"]);
    expect(shellStrings("ssh", ["localhost", "-p", "22", "ls", "-la"], local)).toEqual(["ls -la"]);
    expect(shellStrings("ssh", ["--", "localhost", "-x", "y"], local)).toEqual(["-x y"]);
    expect(shellStrings("ssh", ["203.0.113.9", "sed", "-i", "x", "F"], local)).toEqual([]);
  });

  it("the everyday ssh commands stay allowed", () => {
    for (const cmd of [
      "ssh localhost ls",
      "ssh localhost ls -la /tmp",
      "ssh localhost uptime",
      "ssh -p 22 localhost 'uptime'",
      "ssh -i key -p 22 localhost uptime",
      "ssh -o StrictHostKeyChecking=no localhost true",
      "ssh localhost -t ls",
      "ssh localhost df -h",
      "ssh localhost sed -n 1p /etc/hosts",
      "ssh -- localhost ls",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
