/**
 * Fourth adversarial review of the shell classifier: the splitter tracked only `'` and `"` as toggles, so a
 * quote, an escape, a comment or a heredoc body HID every later command from the guard. Every payload under
 * a "denies" or "asks" heading answered `allow` at a491dd563. `classifyBash` is pure (`root` and `home` are
 * injected). Each block pairs the payloads with the nearby everyday commands that must stay allowed, so the
 * lexer cannot quietly make Claude Code's own workflow noisy.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import {
  BARE,
  COMMENT,
  HEREDOC,
  MAX_RECORDED_SUBSTITUTIONS,
  scanShell,
  splitCommand,
  substitutions,
} from "../harness/shell-lex";

const ctx = { root: "/repo", home: "/Users/dev" };
const d = (cmd: string): string => classifyBash(cmd, ctx).decision;
const SECRET = [".", "env"].join("");

describe("1 — the eight reviewed payloads", () => {
  it("1. an escaped quote inside double quotes does not hide `--no-verify`", () => {
    expect(d('echo "a\\"b"; git push --no-verify')).toBe("deny");
  });
  it("2. ... nor a protected write", () => {
    expect(d('echo "a\\"b"; echo x > scripts/harness/p')).toBe("ask");
  });
  it("3. ... nor an environment dump (a deny, as without the quote)", () => {
    expect(d("env")).toBe("deny");
    expect(d('echo "a\\"b"; env')).toBe("deny");
  });
  it("4. a comment with an apostrophe does not open a quote", () => {
    expect(d("echo hi # it's\ngit commit --no-verify -m x")).toBe("deny");
  });
  it.each([
    ["env", "deny"],
    ["ssh prod.example.com", "ask"],
    ["git push origin main --force", "deny"],
  ])("5. the same comment line before `%s` changes nothing", (next, decision) => {
    expect(d(`echo hi # it's\n${next}`)).toBe(decision);
    expect(d(next)).toBe(decision);
  });
  it("6. an apostrophe in a heredoc body does not hide the next line", () => {
    expect(d("cat <<EOF\nit's\nEOF\necho x > scripts/harness/p")).toBe("ask");
  });
  it("7. an escaped quote does not open a quote", () => {
    expect(d(`echo \\"; cat ${SECRET}; echo \\"`)).toBe("deny");
  });
  it("8. a natural commit-message heredoc does not hide a following hook skip", () => {
    expect(
      d(
        "git commit -F - <<'EOF'\nfix: don't skip hooks\nEOF\ngit commit --amend --no-verify --no-edit",
      ),
    ).toBe("deny");
  });
});

describe("2 — quotes and escapes", () => {
  it.each([
    ["a single quote has no escapes", "echo 'a\\'; git push --no-verify"],
    ["a double-quoted backslash pair closes the quote", 'echo "a\\\\"; git push --no-verify'],
    ["an escaped quote is not a quote outside quotes", "echo \\'; git push --no-verify"],
    ["`$'...'` ends at an unescaped quote", "echo $'a\\\\'; git push --no-verify"],
    ["`$'...'` keeps an escaped quote inside", "echo $'it\\'s'; git push --no-verify"],
    [
      "a quote inside `$( )` inside double quotes is its own",
      'echo "$(echo "x")"; git push --no-verify',
    ],
    ["an apostrophe inside double quotes is literal", `echo "it's"; git push --no-verify`],
    ["a backslash-newline is a continuation, not a separator", "git push \\\n--no-verify"],
    ["a continuation inside double quotes joins the word", 'git push "--no-\\\nverify"'],
  ])("%s", (_name, cmd) => expect(d(cmd)).toBe("deny"));

  it.each([
    `echo "it's $(cat ${SECRET})"`,
    `echo "a'b" $(cat ${SECRET})`,
    `echo "$(cat ${SECRET})"`,
    `echo "x" "it's" \`cat ${SECRET}\``,
  ])("keeps a substitution after an apostrophe visible: %j", (cmd) => {
    expect(d(cmd)).toBe("deny");
  });

  it.each([
    "echo 'a;b'",
    'echo "a;b"',
    "echo $'a;b'",
    "echo a\\;b",
    "echo \\; git push --no-verify",
    `git commit -m "it's fine"`,
    'grep -rn "it\'s" src',
    "echo '$(cat x)'",
    "echo 'a\"b'; echo \"c'd\"",
  ])("allows the everyday quote %j", (cmd) => expect(d(cmd)).toBe("allow"));
});

describe("3 — comments start only at the start of a word", () => {
  it.each([
    ["a mid-word # is not a comment", "echo a#b; git push --no-verify"],
    ["a quoted # is not a comment", 'echo "x # y"; git push --no-verify'],
    ["`${#x}` is not a comment", "echo ${#x}; git push --no-verify"],
    ["`$#` is not a comment", "echo $#; git push --no-verify"],
    ["a comment ends at the newline", "echo hi # c\ngit push --no-verify"],
    [
      "a # after a separator is a comment up to the newline only",
      "echo a;# c\ngit push --no-verify",
    ],
    ["an escaped # is not a comment", "echo \\# ; git push --no-verify"],
  ])("%s", (_name, cmd) => expect(d(cmd)).toBe("deny"));

  it.each([
    "echo hi # git push --no-verify",
    `echo hi # $(cat ${SECRET})`,
    "# git push --no-verify",
    "echo hi # it's a \"comment",
    "echo a;# git push --no-verify",
  ])("never judges a comment as a command: %j", (cmd) => expect(d(cmd)).toBe("allow"));
});

describe("4 — heredoc bodies are data", () => {
  const BODY = 'it\'s a "body" with # hash, rm -rf x and git push --no-verify';
  it.each([
    ["<<EOF", "EOF"],
    ["<<-EOF", "\tEOF"],
    ["<<'EOF'", "EOF"],
    ['<<"EOF"', "EOF"],
    ["<<\\EOF", "EOF"],
    ["<<E'O'F", "EOF"],
  ])("%s: the body is text for `cat`, and the next line is judged", (op, end) => {
    const body = op === "<<EOF" ? "it's a body with # hash, rm -rf x" : BODY;
    expect(d(`cat ${op} > notes.md\n${body}\n${end}`)).toBe("allow");
    expect(d(`cat ${op}\n${body}\n${end}\nssh prod.example.com`)).toBe("ask");
    expect(d(`cat ${op}\n${body}\n${end}\ngit push --no-verify`)).toBe("deny");
  });

  it("the delimiter must be the whole line", () => {
    expect(d("cat <<EOF\nEOF x\nssh prod.example.com\nEOF")).toBe("allow");
    expect(d("cat <<EOF\nEOF\nssh prod.example.com")).toBe("ask");
  });

  it("two heredocs on one line, a command after the operator, and a pipeline", () => {
    expect(d("cat <<A <<B\nit's\nA\nb\nB\nssh prod.example.com")).toBe("ask");
    expect(d("cat <<EOF && ssh prod.example.com\nit's\nEOF")).toBe("ask");
    expect(d("cat <<EOF | wc -l\nit's\nEOF\ngit push --no-verify")).toBe("deny");
  });

  it("a here-string is not a heredoc", () => {
    expect(d("cat <<< hi\nssh prod.example.com")).toBe("ask");
    expect(d("cat <<< 'it'\"'\"'s'\ngit push --no-verify")).toBe("deny");
    expect(d("cat <<< hi")).toBe("allow");
  });

  it("an unquoted body still runs its `$( )` and backticks; a quoted one does not", () => {
    expect(d(`cat <<EOF\nx $(cat ${SECRET}) y\nEOF`)).toBe("deny");
    expect(d(`cat <<EOF\nx \`cat ${SECRET}\` y\nEOF`)).toBe("deny");
    expect(d(`cat <<'EOF'\nx $(cat ${SECRET}) y\nEOF`)).toBe("allow");
    expect(d(`cat <<EOF\nx \\$(cat ${SECRET}) y\nEOF`)).toBe("allow");
    for (const op of ['<<"EOF"', "<<\\EOF", "<<E'O'F"]) {
      expect(d(`cat ${op}\nx $(cat ${SECRET}) y\nEOF`)).toBe("allow");
    }
  });

  it.each([
    "git commit -F - <<'EOF'\nfix: it's got a \"quote\" and a # hash\n\nrm scripts/harness/x and 'single'\nEOF",
    `git commit -m "$(cat <<'EOF'\nfix: it's (done)\nrm scripts/harness/x\nEOF\n)"`,
    `gh pr create --title t --body "$(cat <<'EOF'\n## Summary\n- it's (done) \`code\`\nEOF\n)"`,
    "cat <<'EOF' > notes.md\nrm -rf x\ngit push --no-verify\nEOF",
  ])("allows the commit-message and notes heredoc %j", (cmd) => expect(d(cmd)).toBe("allow"));
});

describe("5 — a heredoc that feeds a shell or an interpreter is still a script", () => {
  it.each([
    "bash <<EOF\nssh prod.example.com\nEOF",
    "sh <<'EOF'\necho x > scripts/harness/p\nEOF",
    "zsh -s <<EOF\nssh prod.example.com\nEOF",
    "cat <<'EOF' | sh\necho x > scripts/harness/p\nEOF",
    "cat <<'EOF' | bash -s\nssh prod.example.com\nEOF",
    "bash -c \"$(cat <<'EOF'\nssh prod.example.com\nEOF\n)\"",
    "eval \"$(cat <<'EOF'\necho x > scripts/harness/p\nEOF\n)\"",
    "sudo bash <<EOF\nssh prod.example.com\nEOF",
    "docker exec -i c sh <<EOF\nssh prod.example.com\nEOF",
  ])("asks for %j", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "bash <<EOF\ngit push --no-verify\nEOF",
    "cat <<'EOF' | sh\ngit push --no-verify\nEOF",
    `bash <<'EOF'\ncat ${SECRET}\nEOF`,
  ])("denies %j", (cmd) => expect(d(cmd)).toBe("deny"));

  it.each([
    `python3 - <<'PY'\nprint(open('${SECRET}').read())\nPY`,
    `node - <<'JS'\nrequire('fs').readFileSync('${SECRET}')\nJS`,
    `cat <<'PY' | python3 -\nprint(open('${SECRET}').read())\nPY`,
  ])("still denies an interpreter script that opens a secret: %j", (cmd) => {
    expect(d(cmd)).toBe("deny");
  });

  it("asks for an interpreter script that touches a protected file", () => {
    expect(d("python3 - <<'PY'\nopen('scripts/harness/x', 'w')\nPY")).toBe("ask");
  });

  it("reads heredoc scripts nested several deep, and asks beyond the depth it reads", () => {
    const nested = (depth: number) =>
      [
        ...Array.from({ length: depth }, (_, k) => `bash <<L${k}`),
        "git push --no-verify",
        ...Array.from({ length: depth }, (_, k) => `L${depth - 1 - k}`),
      ].join("\n");
    expect(d(nested(8))).toBe("deny");
    expect(d(nested(40))).toBe("ask");
  });

  it("allows an interpreter script with an apostrophe and a comment", () => {
    expect(d("python3 - <<'PY'\n# it's fine\nprint(\"it's\")\nPY")).toBe("allow");
  });
});

describe("6 — an unbalanced quote, substitution or heredoc asks", () => {
  it.each([
    "echo 'abc",
    'echo "abc',
    "echo $'abc",
    "echo ${x:-it's}",
    "echo abc\\",
    "echo $(echo abc",
    "echo `abc",
    "echo ${x",
    "cat <<EOF\nbody",
    "cat <<'EOF'\nbody\nEOF2",
    "git status; echo 'abc",
    "echo hi # c\necho 'abc",
    "bash -c 'echo \"abc'",
  ])("asks for %j", (cmd) => expect(d(cmd)).toBe("ask"));

  it("a deny earlier in the command still wins over the unbalanced tail", () => {
    expect(d('git push --no-verify; echo "abc')).toBe("deny");
  });
});

describe("6b — more places a command hides from a splitter", () => {
  it.each([
    "case x in x) git push --no-verify;; esac",
    "case x in (x) git push --no-verify;; esac",
    "f() { git push --no-verify; }; f",
    "bash <<EOF\ngit push --no-verify",
    "$SHELL <<EOF\ngit push --no-verify\nEOF",
    "echo ${x:-$(git push --no-verify)}",
    'echo "${x:-$(git push --no-verify)}"',
    "echo $(( $(git push --no-verify) + 1 ))",
    "cat <<EOF # note\n$(git push --no-verify)\nEOF",
    "cat <<A <<B\nx'\nA\n$(git push --no-verify)\nB",
  ])("denies %j", (cmd) => expect(d(cmd)).toBe("deny"));

  it.each([
    "case x in x) echo hi;; esac",
    "f() { echo hi; }; f",
    "echo $((1 << 2))",
    'echo "${x:-it\'s}"',
    "arr=(a b c); echo ${arr[@]}",
    "(cd apps && ls)",
    "echo a # it's\necho b",
  ])("allows the everyday construct %j", (cmd) => expect(d(cmd)).toBe("allow"));
});

describe("6c — the lexer's own answers", () => {
  const never = () => false;
  const always = () => true;

  it("marks comments, heredoc bodies and quoted text, and leaves operators bare", () => {
    const text = "echo 'a;b' x # c;d\ncat <<EOF\nq;r\nEOF\nls";
    const { kind } = scanShell(text);
    expect(kind[text.indexOf("a;b") + 1]).not.toBe(BARE);
    expect(kind[text.indexOf("c;d") + 1]).toBe(COMMENT);
    expect(kind[text.indexOf("q;r") + 1]).toBe(HEREDOC);
    expect(kind[text.indexOf("\ncat")]).toBe(BARE);
  });

  it("splits on bare operators only and keeps a heredoc body out of the commands", () => {
    const { parts, sequential, incomplete } = splitCommand(
      "echo a && echo 'b;c' # d\ncat <<'EOF' > f\nrm x; ls\nEOF\nls | wc",
      never,
    );
    expect(parts.map((p) => p.text)).toEqual([
      "echo a",
      "echo 'b;c'",
      "cat <<'EOF' > f",
      "ls",
      "wc",
    ]);
    expect(parts.map((p) => p.joiner)).toEqual(["", "&&", "\n", "\n", "|"]);
    expect(sequential).toBe(false);
    expect(incomplete).toBeNull();
  });

  it("puts the body lines of a heredoc a reader runs after the command, as commands", () => {
    const { parts } = splitCommand("sh <<EOF\nrm x; ls\nEOF\necho done", always);
    expect(parts.map((p) => p.text)).toEqual(["sh <<EOF", "rm x", "ls", "echo done"]);
  });

  it("reports why a text is unfinished, and nothing for a finished one", () => {
    expect(splitCommand("echo 'a", never).incomplete).toMatch(/single quote/);
    expect(splitCommand('echo "a', never).incomplete).toMatch(/double quote/);
    expect(splitCommand("echo a\\", never).incomplete).toMatch(/backslash/);
    expect(splitCommand("cat <<EOF\nx", never).incomplete).toMatch(/here-document/);
    expect(splitCommand("echo 'a' \"b\" $(c) `d` $'e' ${f}", never).incomplete).toBeNull();
  });

  it("cuts an unfinished construct out of the commands, so the part before it is still judged", () => {
    expect(splitCommand("git status; echo 'a; ls", never).parts.map((p) => p.text)).toEqual([
      "git status",
      "echo",
    ]);
  });

  it("lists the outermost substitutions that run (judging one finds the rest), and none that is literal", () => {
    expect(substitutions("echo $(a $(b)) \"$(c)\" '$(d)' `e` \\$(f)", 33)).toEqual([
      "a $(b)",
      "c",
      "e",
    ]);
    expect(substitutions("echo $(( $(a) + `b` ))", 33)).toEqual(["a", "b"]);
    expect(substitutions("cat <<EOF\n$(a $(b)) `c` $(d `e`)\nEOF", 33)).toEqual([
      "a $(b)",
      "c",
      "d `e`",
    ]);
    expect(d(`echo $(echo $(echo $(cat ${SECRET})))`)).toBe("deny");
    expect(substitutions("cat <<EOF\n$(g) \\$(h)\nEOF", 33)).toEqual(["g"]);
    expect(substitutions("cat <<'EOF'\n$(g)\nEOF", 33)).toEqual([]);
    expect(substitutions("echo # $(i)", 33)).toEqual([]);
  });

  it("records no more substitutions than the classifier can judge", () => {
    const many = "$(a) ".repeat(500);
    expect(substitutions(many, 1000)).toHaveLength(MAX_RECORDED_SUBSTITUTIONS);
    expect(substitutions(many, 33)).toHaveLength(33);
  });
});

describe("7 — the lexer is linear and never throws", () => {
  const TOKENS = [
    "'",
    '"',
    "\\",
    "#",
    "<<",
    "<<-",
    "\n",
    ";",
    "&&",
    "|",
    "$(",
    ")",
    "`",
    "${",
    "}",
    "$'",
    "EOF",
    "a",
    " ",
    "(",
    "<<<",
    "<(",
  ];
  const lcg = (start: number) => {
    let state = start;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  it("answers 3,000 random token strings without throwing", () => {
    const rnd = lcg(7);
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(rnd() * 40);
      const cmd = Array.from({ length: len }, () => TOKENS[Math.floor(rnd() * TOKENS.length)]).join(
        "",
      );
      expect(["allow", "ask", "deny"]).toContain(d(cmd));
    }
  });

  it.each([
    ["quotes", "'\"".repeat(30_000)],
    ["backslashes", "\\".repeat(60_000)],
    ["unterminated heredocs", "cat <<A\n".repeat(7_000)],
    ["deep substitutions", "$(".repeat(30_000)],
    ["deep double quotes", '"$('.repeat(20_000)],
    ["hashes", "echo a #".repeat(8_000)],
    ["backticks", "`a".repeat(30_000)],
    ["heredoc lines", `cat <<EOF\n${"line\n".repeat(12_000)}`],
    ["braces", "${".repeat(30_000)],
  ])("stays fast on %s", (_name, cmd) => {
    const started = performance.now();
    const decision = d(cmd);
    // A wall-clock bound only guards against a super-linear blow-up (these inputs took seconds when a rule went quadratic), not a micro-benchmark: it is 3 s so a loaded CI machine cannot fail it.
    expect(performance.now() - started).toBeLessThan(3000);
    expect(["allow", "ask", "deny"]).toContain(decision);
  });
});
