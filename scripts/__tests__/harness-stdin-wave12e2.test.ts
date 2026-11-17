/**
 * Wave 12 part E2, E2-1 .. E2-3 (R9-CR-2, R9-CR-3, R9-CR-15, R9-ADV-5, R9-ADV-12 stdin half, R9-ADV-14, R9-ADV-22 echo-var): the text a command is fed
 * on stdin. E2-1: a text handed to a shell is read as the shell hands it (an escaped quote is the quote), through every producer (`echo | bash`,
 * `bash <<<`, `printf | bash`, `source <(echo …)`, `bash /dev/stdin <<<`, `bash <(echo …)`, a known variable). E2-2: a client or a wrapper that runs one is
 * fed through filters, process substitutions, variables, compound commands and functions, and a pipeline longer than the guard reads ASKS (the verdict
 * is asserted at depth 8, 9, 50 and 5,000). E2-3: a leading pipe never throws. The non-local host and the live env file are built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { MAX_PIPE_STAGES } from "../harness/stdin-texts";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `${"."}e${"nv"}`;
const NO_VERIFY = "git commit --no-verify -m x";
const ctx = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => true,
  liveEnvFiles: () => [ENV_FILE],
};
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const rank = (cmd: string): number => RANK[decide(cmd)] ?? -1;

const sq = (t: string): string => `'${t.replaceAll("'", `'\\''`)}'`;
const dq = (t: string): string => `"${t.replace(/(["\\$`])/g, "\\$1")}"`;

/** Texts a shell must refuse when it runs them; two of them hide behind an escaped quote when the text is read as typed. */
const REFUSED_TEXTS: Record<string, string> = {
  "env -S hiding a secret read": `env -S 'cat\\_${ENV_FILE}'`,
  "dblink to a remote host": `psql -c "select dblink_connect('host=${HOST} dbname=x')"`,
  "psql to a remote host": `psql -h ${HOST} -c 1`,
  "a commit that skips the hooks": NO_VERIFY,
};

/** Every way a text reaches a shell: the shell reads it from stdin or from a process substitution. */
const PRODUCERS: Record<string, (text: string) => string> = {
  "echo with single quotes | bash": (t) => `echo ${sq(t)} | bash`,
  "echo with double quotes | bash": (t) => `echo ${dq(t)} | bash`,
  "echo | sh": (t) => `echo ${sq(t)} | sh`,
  "printf | bash": (t) => `printf '%s\\n' ${sq(t)} | bash`,
  "bash <<< single quotes": (t) => `bash <<< ${sq(t)}`,
  "bash <<< double quotes": (t) => `bash <<< ${dq(t)}`,
  "source <(echo)": (t) => `source <(echo ${sq(t)})`,
  ". <(echo)": (t) => `. <(echo ${sq(t)})`,
  "cat <<< | bash": (t) => `cat <<< ${sq(t)} | bash`,
  "cat - <<< | bash": (t) => `cat - <<< ${sq(t)} | bash`,
  "bash /dev/stdin <<<": (t) => `bash /dev/stdin <<< ${sq(t)}`,
  "bash -- /dev/stdin <<<": (t) => `bash -- /dev/stdin <<< ${sq(t)}`,
  "bash <(echo)": (t) => `bash <(echo ${sq(t)})`,
  "bash -- <(echo)": (t) => `bash -- <(echo ${sq(t)})`,
  "sh <(printf)": (t) => `sh <(printf '%s\\n' ${sq(t)})`,
  "a known variable | bash": (t) => `C=${sq(t)}; echo "$C" | bash`,
  "a known variable <<< bash": (t) => `C=${sq(t)}; bash <<< "$C"`,
  "a heredoc into bash (control)": (t) => `bash <<'EOF'\n${t}\nEOF`,
};

describe("E2-1: a text handed to a shell on stdin is read as the shell hands it", () => {
  for (const [producer, make] of Object.entries(PRODUCERS)) {
    it(`${producer}: every refused text is still refused`, () => {
      for (const [what, text] of Object.entries(REFUSED_TEXTS)) {
        const cmd = make(text);
        expect(rank(cmd), `${what}: ${cmd}`).toBe(2);
      }
    });
  }

  it("the same texts, handed on bare, are refused too (the table is a table of refused texts)", () => {
    for (const text of Object.values(REFUSED_TEXTS)) expect(rank(text), text).toBe(2);
  });

  it("the round-9 payloads, written out", () => {
    const cases = [
      String.raw`echo 'env -S '\''cat\_${ENV_FILE}'\''' | bash`,
      String.raw`bash <<< 'env -S '\''cat\_${ENV_FILE}'\'''`,
      String.raw`source <(echo 'env -S '\''cat\_${ENV_FILE}'\''')`,
      String.raw`printf '%s\n' 'env -S '\''cat\_${ENV_FILE}'\''' | bash`,
      String.raw`echo "psql -c \"select dblink_connect('host=${HOST} dbname=x')\"" | bash`,
      String.raw`bash <<< 'psql -c "select dblink_connect('\''host=${HOST} dbname=x'\'')"'`,
    ];
    for (const cmd of cases) expect(rank(cmd), cmd).toBe(2);
  });

  it("a shell reads a script from stdin or a process substitution only; its own -c string and a script file are not that", () => {
    expect(decide(`bash -c ${sq(NO_VERIFY)}`)).toBe("deny");
    expect(decide("bash script.sh")).toBe("allow");
    expect(decide("bash -x script.sh")).toBe("allow");
  });

  it("a process substitution that is no plain print, handed to a shell as its script, asks like curl into sh", () => {
    expect(decide("bash <(curl -s http://localhost:1/x)")).toBe("ask");
    expect(decide("sh <(cat install.sh)")).toBe("ask");
  });

  it("a text that is one unknown expansion, handed to a shell, asks; a known variable is read", () => {
    for (const cmd of ['echo "$X" | bash', 'bash <<< "$X"', 'echo "$(cat x.sh)" | bash']) {
      expect(decide(cmd), cmd).toBe("ask");
    }
    expect(decide(`C=${sq("echo hi")}; echo "$C" | bash`)).toBe("allow");
  });
});

describe("E2-1: the other places a typed text was read where the shell hands it decoded", () => {
  it("a script this line writes with echo, printf, cat or tee and then runs is read as the shell hands it", () => {
    for (const text of Object.values(REFUSED_TEXTS)) {
      for (const writer of [
        (t: string) => `echo ${sq(t)} > /tmp/x.sh`,
        (t: string) => `printf '%s\n' ${sq(t)} > /tmp/x.sh`,
        (t: string) => `cat <<< ${sq(t)} > /tmp/x.sh`,
        (t: string) => `printf '%s\n' ${sq(t)} | tee /tmp/x.sh`,
        (t: string) => `echo ${sq(t)} | tee /tmp/x.sh`,
      ]) {
        const cmd = `${writer(text)}; bash /tmp/x.sh`;
        expect(rank(cmd), cmd).toBe(2);
      }
    }
  });

  it("source and . of /dev/stdin run the text they are fed", () => {
    for (const text of Object.values(REFUSED_TEXTS)) {
      for (const cmd of [
        `source /dev/stdin <<< ${sq(text)}`,
        `. /dev/stdin <<< ${sq(text)}`,
        `echo ${sq(text)} | source /dev/stdin`,
        `source /dev/fd/0 <<< ${sq(text)}`,
      ]) {
        expect(rank(cmd), cmd).toBe(2);
      }
    }
    expect(decide("source /dev/stdin <<< 'export FOO=1'")).toBe("allow");
    expect(decide("source ./setup.sh")).toBe("allow");
  });
});

describe("E2-1: everyday neighbours stay allowed", () => {
  const NEIGHBOURS = [
    "echo hello | bash",
    "echo 'echo hi' | sh",
    "bash <<< 'echo hi'",
    "bash <(echo 'echo hi')",
    "bash -- <(echo 'ls -la')",
    "source <(echo 'export FOO=1')",
    "source <(kubectl completion bash)",
    "bash /dev/stdin <<< 'ls'",
    "printf '%s\\n' 'echo a' 'echo b' | bash",
    "cat <<< 'ls' | bash",
    "echo 'select 1' | psql -h localhost",
    "psql -h localhost <<< 'select 1'",
    "cat dump.sql | psql -h localhost -c 1",
    'psql -h localhost <<< "$(cat x.sql)"',
  ];
  for (const cmd of NEIGHBOURS) {
    it(`${cmd.replaceAll("\n", "\\n")} is allowed`, () => {
      expect(decide(cmd)).toBe("allow");
    });
  }
});

const RECONNECT = `\\c db user ${HOST}`;
const CONNECT_BY_CLIENT: Record<string, { client: string; text: string }> = {
  "psql \\c": { client: "psql", text: RECONNECT },
  "psql \\c conninfo": { client: "psql", text: `\\c host=${HOST} dbname=x` },
  "psql dblink": { client: "psql", text: `select dblink_connect('host=${HOST} dbname=x');` },
  "mysql connect": { client: "mysql", text: `connect db ${HOST}` },
  "mongosh connect": { client: "mongosh", text: `connect("${HOST}")` },
};

/** Every way text reaches a client behind a filter, a process substitution, a variable or a compound command (R9-CR-3, R9-ADV-14). */
const FEEDERS: Record<string, (client: string, text: string) => string> = {
  "cat <<< | client": (c, t) => `cat <<< ${sq(t)} | ${c}`,
  "cat - <<< | client": (c, t) => `cat - <<< ${sq(t)} | ${c}`,
  "tee /dev/null <<< | client": (c, t) => `tee /dev/null <<< ${sq(t)} | ${c}`,
  "sed <<< | client": (c, t) => `sed s/a/b/ <<< ${sq(t)} | ${c}`,
  "tr <<< | client": (c, t) => `tr a b <<< ${sq(t)} | ${c}`,
  "head <<< | client": (c, t) => `head -n 5 <<< ${sq(t)} | ${c}`,
  "tail <<< | client": (c, t) => `tail -n 5 <<< ${sq(t)} | ${c}`,
  "cat heredoc | client": (c, t) => `cat <<'EOF' | ${c}\n${t}\nEOF`,
  "cat - heredoc | client": (c, t) => `cat - <<'EOF' | ${c}\n${t}\nEOF`,
  "echo | cat | client": (c, t) => `echo ${sq(t)} | cat | ${c}`,
  "printf | tee | client": (c, t) => `printf '%s\\n' ${sq(t)} | tee /dev/null | ${c}`,
  "client < <(echo)": (c, t) => `${c} < <(echo ${sq(t)})`,
  "client -f <(echo)": (c, t) => `${c} -f <(echo ${sq(t)})`,
  "variable | client": (c, t) => `X=${sq(t)}; echo $X | ${c}`,
  "variable <<< client": (c, t) => `X=${sq(t)}; ${c} <<< "$X"`,
  "command substitution <<< client": (c, t) => `${c} <<< "$(echo ${sq(t)})"`,
  "command substitution | client": (c, t) => `echo "$(echo ${sq(t)})" | ${c}`,
  "brace group": (c, t) => `{ ${c}; } <<< ${sq(t)}`,
  subshell: (c, t) => `( ${c} ) <<< ${sq(t)}`,
  "while loop": (c, t) => `while read l; do ${c}; done <<< ${sq(t)}`,
  "function call": (c, t) => `f() { ${c}; }; f <<< ${sq(t)}`,
  "find -exec": (c, t) => `find . -maxdepth 0 -exec ${c} \\; <<< ${sq(t)}`,
  "docker exec": (c, t) => `cat <<< ${sq(t)} | docker exec -i db ${c}`,
  "docker exec here-string": (c, t) => `docker exec -i db ${c} <<< ${sq(t)}`,
  "compose exec": (c, t) => `cat <<< ${sq(t)} | docker compose exec -T db ${c}`,
  "ssh to localhost": (c, t) => `cat <<< ${sq(t)} | ssh localhost ${c}`,
  "bash -c": (c, t) => `cat <<< ${sq(t)} | bash -c ${sq(c)}`,
};

describe("E2-2: a client or a wrapper is fed through filters, substitutions, variables and compound commands", () => {
  for (const [feeder, make] of Object.entries(FEEDERS)) {
    it(`${feeder}: a reconnection to a remote host is refused for every client`, () => {
      for (const [what, { client, text }] of Object.entries(CONNECT_BY_CLIENT)) {
        const cmd = make(client, text);
        expect(rank(cmd), `${what}: ${cmd}`).toBe(2);
      }
    });
    it(`${feeder}: a local text and a plain client stay allowed`, () => {
      for (const client of ["psql", "mysql", "mongosh"]) {
        const cmd = make(client, "select 1;");
        expect(rank(cmd), cmd).toBeLessThanOrEqual(1);
        expect(decide(cmd), cmd).not.toBe("deny");
      }
    });
  }

  it("the round-9 rows, written out", () => {
    const rows = [
      `cat <<'EOF' | psql\n\\c db user ${HOST}\nEOF`,
      `cat <<< '\\c db user ${HOST}' | docker exec -i db psql`,
      `tee /dev/null <<< '\\c db user ${HOST}' | psql`,
      `sed s/a/b/ <<< '\\c db user ${HOST}' | psql`,
      `psql < <(echo '\\c db user ${HOST}')`,
      `X='\\c host=${HOST}'; echo $X | psql`,
      `X='\\c host=${HOST}'; psql <<< "$X"`,
      `psql <<< "$(echo '\\c host=${HOST}')"`,
      `{ psql; } <<< '\\c host=${HOST}'`,
      `find . -maxdepth 0 -exec psql \\; <<< '\\c host=${HOST}'`,
    ];
    for (const cmd of rows) expect(rank(cmd), cmd).toBe(2);
  });

  it("a variable the line binds to something it cannot place leaves the client allowed (an unset name is no evidence)", () => {
    expect(decide("echo $X | psql -h localhost")).toBe("allow");
    expect(decide('psql -h localhost <<< "$X"')).toBe("allow");
  });

  it("the stdin of one command does not leak into a sibling that is not a group or a function", () => {
    expect(decide(`echo ${sq(RECONNECT)} > /tmp/x; psql -h localhost -c 1`)).toBe("allow");
    expect(decide(`cat <<< ${sq(RECONNECT)} > /tmp/x; psql -h localhost -c 1`)).toBe("allow");
  });
});

/** `n` stages between the text and the reader. */
const chain = (n: number, filler = "cat"): string =>
  Array.from({ length: n }, () => filler).join(" | ");
const behind = (n: number, reader: string, text = RECONNECT): string =>
  `echo ${sq(text)} | ${n === 0 ? "" : `${chain(n)} | `}${reader}`;

const READERS: Record<string, string> = {
  psql: "psql",
  "docker exec -i db psql": "docker exec -i db psql",
  "ssh localhost psql": "ssh localhost psql",
  "bash -c psql": "bash -c psql",
  "compose exec": "docker compose exec -T db psql",
  mysql: "mysql",
  bash: "bash",
};
/** The text each reader refuses (a client's own reconnect command, a shell's refused command). */
const TEXT_OF: Record<string, string> = {
  mysql: `connect db ${HOST}`,
  bash: NO_VERIFY,
};

describe("E2-2: a pipeline longer than the guard reads asks, and the verdict holds at depth 8, 9, 50 and 5,000", () => {
  it("the cap is the documented one", () => {
    expect(MAX_PIPE_STAGES).toBe(8);
  });

  for (const [name, reader] of Object.entries(READERS)) {
    const text = TEXT_OF[name] ?? RECONNECT;
    it(`${name}: the text is read within ${MAX_PIPE_STAGES} commands back and refused`, () => {
      // echo is the first stage; the reader sees it MAX_PIPE_STAGES back at the farthest
      for (const filters of [0, 1, 3, MAX_PIPE_STAGES - 1]) {
        const cmd = behind(filters, reader, text);
        expect(rank(cmd), `${filters} filters: ${cmd.slice(0, 80)}`).toBe(2);
      }
    });
    it(`${name}: past the cap it asks and never allows, at depth 9, 50 and 5,000`, () => {
      for (const filters of [MAX_PIPE_STAGES, MAX_PIPE_STAGES + 1, 50, 5000]) {
        const cmd = behind(filters, reader, text);
        const decision = decide(cmd);
        expect(["ask", "deny"], `${filters} filters`).toContain(decision);
        // the text is out of reach, so the guard cannot know more than "ask"
        expect(decision, `${filters} filters`).toBe("ask");
      }
    });
    it(`${name}: a local text behind a long pipeline asks as well (the guard cannot read it)`, () => {
      for (const filters of [MAX_PIPE_STAGES, 50]) {
        const cmd = `echo 'select 1' | ${chain(filters)} | ${reader}`;
        expect(decide(cmd), `${filters} filters`).toBe("ask");
      }
    });
  }

  it("a long pipeline that no reader of text follows is untouched", () => {
    expect(decide(`echo ${sq(RECONNECT)} | ${chain(50)} | wc -l`)).toBe("allow");
    expect(decide(`ls | ${chain(50)} | grep x`)).toBe("allow");
  });

  it("5,000 clients in one pipeline answer with an ask, not an allow", () => {
    const cmd = Array.from({ length: 5000 }, () => "psql").join(" | ");
    expect(cmd.length).toBeLessThan(64 * 1024);
    expect(decide(cmd)).toBe("ask");
  });
});

describe("E2-3: a leading pipe never throws and is never an allow", () => {
  const MALFORMED = [
    "| psql",
    "| docker exec -i db psql <<< x",
    "| bash",
    "| bash <<< 'echo hi'",
    "| | psql",
    "| cat | psql",
    "| echo x | bash",
    "|psql",
    `| psql <<< ${sq(RECONNECT)}`,
    `| docker exec -i db psql <<< ${sq(RECONNECT)}`,
    `| ${"cat | ".repeat(20)}psql`,
  ];
  for (const cmd of MALFORMED) {
    it(`${cmd.slice(0, 60)} answers without throwing and is not allowed`, () => {
      let verdict = "throw";
      expect(() => {
        verdict = decide(cmd);
      }).not.toThrow();
      expect(["ask", "deny"]).toContain(verdict);
    });
  }

  it("a bare pipe or a leading `||` holds no command to run and answers without throwing", () => {
    for (const cmd of ["|", "| |", "||", "|| psql", "&& psql", "; psql"]) {
      expect(() => decide(cmd), cmd).not.toThrow();
    }
  });

  it("a leading pipe in front of a refused command is still refused", () => {
    expect(decide(`| psql -h ${HOST}`)).toBe("deny");
    expect(decide(`| bash <<< ${sq(NO_VERIFY)}`)).toBe("deny");
  });

  it("a pipe that has a command before it is not a leading pipe", () => {
    expect(decide("echo x | cat")).toBe("allow");
    expect(decide("true && echo x | cat")).toBe("allow");
  });
});
