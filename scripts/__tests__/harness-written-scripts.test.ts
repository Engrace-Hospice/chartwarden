/**
 * Wave 4, T5: a script written and run by ONE command line. The lexer treats a heredoc body as data, so
 * `cat > /tmp/x.sh <<'EOF' … EOF` followed by `bash /tmp/x.sh` hid the script from the guard (the heredoc and tee
 * shapes asked at PR #1005's head; the echo and printf shapes never did). The written text is now matched with the
 * command that runs the same path and judged as the script it is: shell text as a command line, other languages as
 * inline code. Each payload under an "asks" heading answered `allow` at the base of this wave. A file written by an
 * EARLIER tool call is still unread (a documented limit), and heredoc data that nothing runs stays allowed.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { fileRuns, heredocCount, isScriptText, writtenTexts } from "../harness/written-scripts";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;
const RM = "rm scripts/harness/pre-tool-guard.ts";
/** The same delete by absolute path, which a `cd` does not change. */
const ABS_RM = "rm /repo/scripts/harness/pre-tool-guard.ts";
/** A live env file's name, built so this file never spells it out. */
const ENV = ["apps/backend/", ".", "env"].join("");
const heredoc = (file: string, text: string, delimiter = "'EOF'") =>
  `cat > ${file} <<${delimiter}\n${text}\nEOF\n`;

describe("written-scripts: what a command writes and what a command runs", () => {
  const none = { outs: [], docs: [], strings: [] };
  it("reads the text a cat or tee is fed, and a printed literal, as the file's content", () => {
    expect(
      writtenTexts(
        { prog: "cat", args: [], outs: ["/tmp/a"], docs: ["EOF"], strings: [] },
        ["x\n"],
        null,
      ),
    ).toEqual([{ target: "/tmp/a", text: "x\n" }]);
    expect(
      writtenTexts(
        {
          prog: "tee",
          args: ["/tmp/a", "-a", "/tmp/b"],
          outs: ["/dev/null"],
          docs: ["EOF"],
          strings: [],
        },
        ["x"],
        null,
      ).map((w) => w.target),
    ).toEqual(["/tmp/a", "/tmp/b"]);
    expect(
      writtenTexts(
        { prog: "echo", args: ["rm x"], outs: ["/tmp/a"], docs: [], strings: [] },
        [],
        null,
      )[0]?.text,
    ).toBe("rm x");
    expect(
      writtenTexts(
        { prog: "printf", args: ["a\\nb\\n"], outs: ["/tmp/a"], docs: [], strings: [] },
        [],
        null,
      )[0]?.text,
    ).toBe("a\nb\n");
    expect(
      writtenTexts(
        { prog: "cat", args: [], outs: ["/tmp/a"], docs: ["<<<"], strings: ["rm x"] },
        [],
        null,
      )[0]?.text,
    ).toBe("rm x");
    expect(writtenTexts({ prog: "tee", args: ["/tmp/a"], ...none }, [], "rm x")[0]?.text).toBe(
      "rm x",
    );
  });

  it("reads nothing from a command that copies, or writes nowhere, or writes nothing", () => {
    expect(
      writtenTexts(
        { prog: "cat", args: ["/etc/hosts"], outs: ["/tmp/a"], ...{ docs: [], strings: [] } },
        [],
        null,
      ),
    ).toEqual([]);
    expect(
      writtenTexts(
        { prog: "echo", args: ["x"], outs: ["/dev/null"], docs: [], strings: [] },
        [],
        null,
      ),
    ).toEqual([]);
    expect(
      writtenTexts({ prog: "echo", args: [""], outs: ["/tmp/a"], docs: [], strings: [] }, [], null),
    ).toEqual([]);
    expect(
      writtenTexts({ prog: "sed", args: ["x"], outs: ["/tmp/a"], docs: [], strings: [] }, [], null),
    ).toEqual([]);
  });

  it("counts a command's heredocs, not its here-strings", () => {
    expect(heredocCount({ docs: ["EOF", "<<<"], strings: ["x"] })).toBe(1);
    expect(heredocCount({ docs: [], strings: [] })).toBe(0);
  });

  it.each<[string, string, string[], string[], Array<[string, string]>]>([
    ["bash", "bash", ["/tmp/x.sh"], [], [["/tmp/x.sh", "shell"]]],
    ["sh", "sh", ["-x", "-e", "x.sh", "arg"], [], [["x.sh", "shell"]]],
    ["bash", "bash", ["-o", "pipefail", "x.sh"], [], [["x.sh", "shell"]]],
    ["source", "source", ["x.sh"], [], [["x.sh", "shell"]]],
    [".", ".", ["x.sh"], [], [["x.sh", "shell"]]],
    ["bash", "bash", ["-s"], ["x.sh"], [["x.sh", "shell"]]],
    ["bash", "bash", ["-c", "echo hi"], [], []],
    ["python3", "python3", ["-u", "x.py", "a"], [], [["x.py", "script"]]],
    ["node", "node", ["x.js"], [], [["x.js", "script"]]],
    ["bun", "bun", ["run", "x.ts"], [], [["x.ts", "script"]]],
    ["bun", "bun", ["x.ts"], [], [["x.ts", "script"]]],
    ["deno", "deno", ["run", "-A", "x.ts"], [], [["x.ts", "script"]]],
    ["perl", "perl", ["x.pl"], [], [["x.pl", "script"]]],
    ["python3", "python3", ["-c", "print(1)"], [], []],
    ["x.sh", "./x.sh", ["a"], [], [["./x.sh", "direct"]]],
    ["x.sh", "/tmp/x.sh", [], [], [["/tmp/x.sh", "direct"]]],
    ["ls", "ls", ["x.sh"], [], []],
    ["cat", "cat", ["x.sh"], [], []],
    ["x.sh", "x.sh", [], [], []],
  ])("%s %j runs %j", (prog, word, args, ins, expected) => {
    expect(fileRuns(prog, word, args, ins).map((r) => [r.path, r.kind])).toEqual(expected);
  });

  it("tells interpreter code from shell by a first line that names an interpreter", () => {
    expect(isScriptText("#!/usr/bin/env python3\nprint(1)")).toBe(true);
    expect(isScriptText("#!/usr/bin/env node\n1")).toBe(true);
    expect(isScriptText("#!/bin/bash\necho hi")).toBe(false);
    expect(isScriptText("echo hi")).toBe(false);
  });
});

describe("a script this line writes and then runs is judged as the script it is", () => {
  it.each([
    ["bash", `${heredoc("/tmp/x.sh", RM)}bash /tmp/x.sh`],
    ["sh", `${heredoc("/tmp/x.sh", RM)}sh /tmp/x.sh`],
    ["zsh", `${heredoc("/tmp/x.sh", RM)}zsh /tmp/x.sh`],
    ["dash", `${heredoc("/tmp/x.sh", RM)}dash /tmp/x.sh`],
    ["bash with options", `${heredoc("/tmp/x.sh", RM)}bash -x -e /tmp/x.sh arg`],
    ["source", `${heredoc("/tmp/x.sh", RM)}source /tmp/x.sh`],
    ["dot", `${heredoc("/tmp/x.sh", RM)}. /tmp/x.sh`],
    ["stdin redirect", `${heredoc("/tmp/x.sh", RM)}bash < /tmp/x.sh`],
    ["chmod then direct", `${heredoc("/tmp/x.sh", RM)}chmod +x /tmp/x.sh && /tmp/x.sh`],
    ["relative direct", `${heredoc("x.sh", RM)}chmod +x x.sh && ./x.sh`],
    ["unquoted delimiter", `${heredoc("/tmp/x.sh", RM, "EOF")}bash /tmp/x.sh`],
    ["tee with heredoc", `tee /tmp/x.sh <<'EOF' >/dev/null\n${RM}\nEOF\nbash /tmp/x.sh`],
    ["tee -a", `tee -a /tmp/x.sh <<'EOF' >/dev/null\n${RM}\nEOF\nbash /tmp/x.sh`],
    ["printf", `printf '${RM}\\n' > /tmp/x.sh; bash /tmp/x.sh`],
    ["echo", `echo '${RM}' > /tmp/x.sh && sh /tmp/x.sh`],
    ["echo append", `echo '${RM}' >> /tmp/x.sh && sh /tmp/x.sh`],
    ["here-string", `cat > /tmp/x.sh <<< '${RM}'; bash /tmp/x.sh`],
    ["echo piped into tee", `echo '${RM}' | tee /tmp/x.sh; bash /tmp/x.sh`],
    ["heredoc after redirect", `cat <<'EOF' > /tmp/x.sh\n${RM}\nEOF\nbash /tmp/x.sh`],
    ["same file, relative", `cd /tmp && ${heredoc("x.sh", RM)}bash x.sh`],
    [
      "after other commands",
      `${heredoc("/tmp/x.sh", RM)}echo before; ls; bash /tmp/x.sh; echo after`,
    ],
    [
      "two writes, the first one bad",
      `${heredoc("/tmp/x.sh", RM)}echo ok >> /tmp/x.sh; bash /tmp/x.sh`,
    ],
  ])("asks about the shell script run by %s", (_name, cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    [
      "python3",
      `${heredoc("/tmp/x.py", `import os; os.remove("scripts/harness/pre-tool-guard.ts")`)}python3 /tmp/x.py`,
    ],
    [
      "python",
      `${heredoc("/tmp/x.py", `open("scripts/harness/pre-tool-guard.ts", "w").write("")`)}python -u /tmp/x.py`,
    ],
    [
      "node",
      `${heredoc("/tmp/x.js", `require("fs").unlinkSync("scripts/harness/pre-tool-guard.ts")`)}node /tmp/x.js`,
    ],
    [
      "bun run",
      `${heredoc("/tmp/x.ts", `await Bun.write("scripts/harness/pre-tool-guard.ts", "")`)}bun run /tmp/x.ts`,
    ],
    [
      "perl",
      `${heredoc("/tmp/x.pl", `unlink "scripts/harness/pre-tool-guard.ts";`)}perl /tmp/x.pl`,
    ],
    [
      "direct with a shebang",
      `${heredoc("/tmp/x.py", `#!/usr/bin/env python3\nimport os; os.remove("scripts/harness/pre-tool-guard.ts")`)}chmod +x /tmp/x.py && /tmp/x.py`,
    ],
  ])("asks about the interpreter script run by %s", (_name, cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("denies what the bare command would deny: a script that reads a live secret file", () => {
    expect(d(`${heredoc("/tmp/x.sh", `cat ${ENV}`)}bash /tmp/x.sh`)).toBe("deny");
    expect(d(`${heredoc("/tmp/x.py", `print(open("${ENV}").read())`)}python3 /tmp/x.py`)).toBe(
      "deny",
    );
    expect(d(`echo 'cat ${ENV}' > /tmp/x.sh; sh /tmp/x.sh`)).toBe("deny");
  });

  it("matches the two paths the way every path is matched: a `cd` between them separates the files", () => {
    expect(d(`${heredoc("x.sh", ABS_RM)}cd /tmp && bash x.sh`)).toBe("allow");
    expect(d(`${heredoc("/tmp/x.sh", ABS_RM)}cd /tmp && bash x.sh`)).toBe("ask");
    expect(d(`cd /tmp && ${heredoc("x.sh", ABS_RM)}cd /repo && bash /tmp/x.sh`)).toBe("ask");
    expect(d(`${heredoc("./x.sh", RM)}bash x.sh`)).toBe("ask");
    expect(d(`${heredoc("/tmp/a/../x.sh", RM)}bash /tmp/x.sh`)).toBe("ask");
  });

  it("judges the script in the directory it runs in", () => {
    expect(d(`${heredoc("/tmp/x.sh", "rm harness/pre-tool-guard.ts")}bash /tmp/x.sh`)).toBe(
      "allow",
    );
    expect(
      d(`${heredoc("/tmp/x.sh", "rm harness/pre-tool-guard.ts")}cd scripts && bash /tmp/x.sh`),
    ).toBe("ask");
  });
});

describe("what stays allowed", () => {
  it.each([
    ["heredoc data that nothing runs", `${heredoc("/tmp/x.sh", RM)}echo done`],
    ["a harmless script that is run", `${heredoc("/tmp/x.sh", "echo hello")}bash /tmp/x.sh`],
    [
      "a harmless python script that is run",
      `${heredoc("/tmp/x.py", 'print("hi")')}python3 /tmp/x.py`,
    ],
    ["a heredoc to a TS file and `bun run test`", `${heredoc("/tmp/a.ts", RM)}bun run test`],
    ["a different file is run", `${heredoc("/tmp/x.sh", RM)}bash /tmp/y.sh`],
    [
      "a different interpreter file is run",
      `${heredoc("/tmp/x.py", `import os; os.remove("scripts/harness/pre-tool-guard.ts")`)}python3 /tmp/y.py`,
    ],
    ["a bare name is not a path", `${heredoc("/tmp/x.sh", RM)}x.sh`],
    [
      "`bash -c` runs its string, not the file",
      `${heredoc("/tmp/x.sh", RM)}bash -c 'echo hi' /tmp/x.sh`,
    ],
    ["the file is only read", `${heredoc("/tmp/x.sh", RM)}cat /tmp/x.sh`],
    ["printf data that is never run", `printf '${RM}\\n' > /tmp/x.txt; cat /tmp/x.txt`],
    ["the run comes BEFORE the write", `bash /tmp/x.sh; ${heredoc("/tmp/x.sh", RM)}`],
    ["a script written by an earlier tool call (a documented limit)", "bash /tmp/x.sh"],
    [
      "a heredoc fed to a file and committed",
      `${heredoc("notes.md", "see scripts/harness/pre-tool-guard.ts")}git add notes.md`,
    ],
  ])("allows %s", (_name, cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
  });
});

describe('a wrapper script whose subcommand is its own argument (`docker compose … "$@"`)', () => {
  const DC = 'exec docker compose -p x --env-file ci.env -f docker-compose.yml "$@"';
  it("asks, since the subcommand is not known, where a known `config` is denied", () => {
    expect(d(`docker compose --env-file ci.env -f a.yml "$@"`)).toBe("ask");
    expect(d(`docker compose --env-file ci.env -f a.yml $1`)).toBe("ask");
    expect(d(`docker compose --env-file ci.env config`)).toBe("deny");
    expect(d(`docker compose --env-file ci.env up -d`)).toBe("allow");
  });

  it("asks when the wrapper is written and run by one command line", () => {
    expect(d(`${heredoc("/tmp/dc.sh", DC)}chmod +x /tmp/dc.sh && /tmp/dc.sh up -d`)).toBe("ask");
    expect(
      d(`${heredoc("/tmp/dc.sh", "exec docker compose --env-file ci.env up -d")}bash /tmp/dc.sh`),
    ).toBe("allow");
  });
});
