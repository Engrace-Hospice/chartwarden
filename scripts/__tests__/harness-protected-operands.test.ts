/**
 * Wave 7, T3(b) (round-5 ADV5-2, the generic backstop). Five review rounds keep finding another program that writes
 * to a path the agent names; a table can never be complete. So a Bash command whose text NAMES a protected path (a
 * literal operand, an option value or `key=value`, as written or through any alias spelling) as an argument of a
 * program that is neither on the read/check list nor a writer the classifier models precisely ASKS (Codex: denies):
 * `sd 's/a/b/' scripts/harness/hard-deadline.ts`, `prettier --write scripts/harness/x.ts`, `shfmt -w`, a tool
 * invented next year. It never turns a deny into an ask, and it does not read a quoted sentence (a word with
 * whitespace is prose) or a program that only reads. A limit, not a boundary: a computed name, a variable or an encoded
 * name stays unseen; the sandbox is the real boundary. `classifyBash` is pure: root, home, cwd and "exists" are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { pathCandidates, writeCapable } from "../harness/protected-operands";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string, c: object = ctx) => classifyBash(cmd, c).decision;
const G = "scripts/harness/hard-deadline.ts";

describe("pathCandidates: the words that could be a path", () => {
  it.each<[string[], string[]]>([
    [
      ["a/b.ts", "c"],
      ["a/b.ts", "c"],
    ],
    [["--output=a/b", "-x"], ["a/b"]],
    [
      ["of=a/b", "if=c"],
      ["a/b", "c"],
    ],
    [["-oa/b"], ["a/b"]],
    [["a sentence with scripts/harness/x"], []],
    [["--message=fix scripts/harness/x"], []],
    [["-w", "--write", "-"], []],
    [[""], []],
  ])("%j", (args, expected) => {
    expect(pathCandidates(args)).toEqual(expected);
  });
});

describe("writeCapable: which programs the backstop applies to", () => {
  it.each<[string, string[]]>([
    ["sd", ["a", "b", "f"]],
    ["prettier", ["--write", "f"]],
    ["prettier", ["-w", "f"]],
    ["bunx", ["prettier", "--write", "f"]],
    ["biome", ["check", "--write", "f"]],
    ["bunx", ["biome", "check", "--fix", "f"]],
    ["bunx", ["biome", "format", "--unsafe", "f"]],
    ["eslint", ["--fix", "f"]],
    ["npx", ["eslint", "--fix", "f"]],
    ["shfmt", ["-w", "f"]],
    ["gofmt", ["-w", "f"]],
    ["black", ["f"]],
    ["mkfifo", ["f"]],
    ["gawk", ["-i", "inplace", "{print}", "f"]],
    ["ruby", ["-i", "-pe", "x", "f"]],
    ["somenewtool", ["f"]],
  ])("%s %j", (prog, args) => {
    expect(writeCapable(prog, args)).toBe(true);
  });

  it.each<[string, string[]]>([
    ["cat", ["f"]],
    ["head", ["-n", "5", "f"]],
    ["ls", ["-la", "d"]],
    ["rg", ["foo", "d"]],
    ["grep", ["-rn", "foo", "d"]],
    ["wc", ["-l", "f"]],
    ["diff", ["a", "b"]],
    ["stat", ["f"]],
    ["sed", ["-n", "1,5p", "f"]],
    ["jq", [".", "f"]],
    ["git", ["diff", "f"]],
    ["biome", ["check", "f"]],
    ["bunx", ["biome", "check", "f"]],
    ["bunx", ["biome", "lint", "f"]],
    ["eslint", ["f"]],
    ["prettier", ["--check", "f"]],
    ["bunx", ["tsc", "--noEmit"]],
    ["bunx", ["vitest", "run", "f"]],
    ["bun", ["run", "harness:phi-scan", "f"]],
    ["bun", ["test", "f"]],
    ["bun", ["f.ts"]],
    ["node", ["f.js"]],
    ["python3", ["f.py"]],
    ["bash", ["f.sh"]],
    ["echo", ["f"]],
    ["printf", ["%s", "f"]],
    ["cd", ["d"]],
    ["test", ["-f", "f"]],
    ["cp", ["a", "b"]],
    ["mv", ["a", "b"]],
    ["rm", ["f"]],
    ["tee", ["f"]],
    ["docker", ["compose", "-f", "f", "config", "--quiet"]],
    ["for", ["f", "in", "a", "b"]],
    ["while", ["read", "l"]],
    ["shellcheck", ["f.sh"]],
    ["bunx", ["--bun", "shellcheck@latest", "f.sh"]],
    ["-x", ["/mnt/a.sh"]],
    ["gh", ["pr", "view", "5"]],
    ["gawk", ["{print}", "f"]],
    ["ruby", ["f.rb"]],
  ])("%s %j is not", (prog, args) => {
    expect(writeCapable(prog, args)).toBe(false);
  });
});

describe("the backstop asks for an unmodelled program that names a protected path", () => {
  it.each([
    `sd 's/a/b/' ${G}`,
    `sd -p a b ${G}`,
    `prettier --write ${G}`,
    `bunx prettier -w scripts/harness/*.ts`,
    `bunx biome check --write ${G}`,
    `bunx biome format --write scripts/harness`,
    `bunx biome check --fix scripts/harness/patterns.ts`,
    `bunx eslint --fix ${G}`,
    `shfmt -w .githooks/pre-commit`,
    `gofmt -w ${G}`,
    `black ${G}`,
    `mkfifo ${G}`,
    `gawk -i inplace '{print}' ${G}`,
    `ruby -i -pe 'x' ${G}`,
    `somenewtool --target=${G}`,
    `somenewtool of=${G}`,
    `somenewtool --config ${G}`,
    `somenewtool .claude/settings.json`,
    `somenewtool compliance/controls.yaml`,
    `somenewtool .github/workflows/ci.yml`,
    `somenewtool deploy/production/compose.yml`,
    `somenewtool CLAUDE.md`,
    `cd scripts/harness && somenewtool hard-deadline.ts`,
    `cd scripts && somenewtool harness/hard-deadline.ts`,
    `somenewtool /repo/${G}`,
    `somenewtool ./${G}`,
    `somenewtool scripts/../${G}`,
    `somenewtool SCRIPTS/HARNESS/hard-deadline.ts`,
    "somenewtool scripts/harneß/x",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("names the program and the limit in its reason", () => {
    const v = classifyBash(`somenewtool ${G}`, ctx);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/`somenewtool`/);
    expect(v.reason).toMatch(/not a program the guard knows to be read-only/);
  });

  it("a nested command line is judged too", () => {
    expect(d(`bash -c "somenewtool ${G}"`)).toBe("ask");
    expect(d(`echo x | somenewtool ${G}`)).toBe("ask");
    expect(d(`true && somenewtool ${G}`)).toBe("ask");
  });
});

describe("it does not ask when the program only reads, is modelled, or the text is prose", () => {
  it.each([
    `cat ${G}`,
    `head -n 20 ${G}`,
    `tail -f ${G}`,
    `less ${G}`,
    `wc -l ${G}`,
    `ls -la scripts/harness`,
    `stat ${G}`,
    `diff ${G} /tmp/x`,
    `cmp ${G} /tmp/x`,
    `rg foo scripts/harness`,
    `rg -n foo ${G}`,
    `grep -n foo ${G}`,
    `grep -rn foo scripts/harness`,
    `sed -n '1,40p' ${G}`,
    `awk '{print $1}' ${G}`,
    `git diff ${G}`,
    `git log -- scripts/harness`,
    `git show HEAD:${G}`,
    `git add ${G}`,
    `git status --short scripts/harness`,
    `bunx biome check ${G}`,
    `bunx biome check scripts/harness`,
    `bunx biome lint ${G}`,
    `bunx prettier --check ${G}`,
    `bunx eslint ${G}`,
    `bunx tsc --noEmit -p scripts/tsconfig.json`,
    `bunx vitest run scripts/__tests__/harness-patterns.test.ts`,
    `bun run harness:phi-scan ${G}`,
    `bun scripts/check-compliance-controls.ts`,
    `bun ${G}`,
    `node ${G}`,
    `python3 ${G}`,
    `bash scripts/harness/x.sh`,
    `echo ${G}`,
    `printf '%s\\n' ${G}`,
    `cd scripts/harness`,
    `cd scripts/harness && ls`,
    `test -f ${G}`,
    `[ -f ${G} ]`,
    `source ${G}`,
    `jq . .claude/settings.json`,
    `docker compose -f deploy/production/compose.yml config --quiet`,
    `cat .github/workflows/ci.yml`,
    `file ${G}`,
    `realpath ${G}`,
    `shasum -a 256 ${G}`,
    `bat ${G}`,
    `gawk '{print}' ${G}`,
    `for f in scripts/harness/*.ts; do cat "$f"; done`,
    `shellcheck .githooks/pre-commit`,
    `bunx --bun shellcheck@latest .githooks/pre-commit`,
    `docker run --rm -v "$PWD":/mnt koalaman/shellcheck:stable -x /mnt/${G}`,
    "gh pr diff 5 -- scripts/harness",
    `ruby ${G}`,
    `somenewtool --version`,
    `somenewtool apps/backend/src/index.ts`,
    `somenewtool "see scripts/harness/hard-deadline.ts for details"`,
    `somenewtool --message="fix scripts/harness/hard-deadline.ts"`,
    `somenewtool x > /dev/null`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("gh has no `api --output` (gh 2.87.3 refuses the flag), so it writes nothing there and is allowed", () => {
    expect(d(`gh api repos/o/r --output ${G}`)).toBe("allow");
  });

  it("the modelled writers keep their own precise answer (a protected SOURCE is not a write)", () => {
    expect(d(`cp ${G} /tmp/x`)).toBe("allow");
    expect(d(`cp /tmp/x ${G}`)).toBe("ask");
    expect(d(`curl -o /tmp/x https://example.com`)).toBe("allow");
    expect(d(`tar tf /tmp/x.tar`)).toBe("allow");
    expect(d(`rsync -a ${G} /tmp/x`)).toBe("allow");
  });

  it("an unknown directory does not make every unknown program ask", () => {
    expect(d("cd $SOMEWHERE && somenewtool apps/x.ts")).toBe("allow");
  });
});

describe("it never turns a deny into an ask", () => {
  it.each([
    "somenewtool apps/backend/.env",
    "somenewtool --config apps/backend/.env",
    `psql -h db.example.com -c 'select 1' ${G}`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});
