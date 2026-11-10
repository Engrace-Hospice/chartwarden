/**
 * Wave 3 (fixer W3b): the three holes the lexer fixer found and left (report-f4-lexer.md). All three answered
 * `allow` at the base of this wave: a command word built around a substitution, a host built around one, and
 * a `function f { cmd; }` body (the `f() { cmd; }` form was already judged).
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;

describe("a command word built around a substitution is an unknown program", () => {
  it.each([
    "$(true)git push origin x",
    "`true`git push origin x",
    "git$(true) push origin x",
    "$(echo g)it status",
    "$(echo rm) -rf apps/web",
    "$(which node) -e 1",
    "FOO=1 $(true)git log",
    "sudo $(true)git log",
  ])("asks or denies %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "$(true)git push --no-verify",
    "`true`git push --no-verify",
    "$(true)git push origin main --force",
    "$(true)git commit --no-verify -m x",
    "$(true)cat apps/backend/.env",
  ])("denies %s: the rest of the word reads as a denied command", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "$(git rev-parse --show-toplevel)/scripts/build.sh",
    "$(pwd)/node_modules/.bin/vitest run",
    "`pwd`/node_modules/.bin/vitest run",
    "$HOME/.bun/bin/bun run test",
    "${PWD}/scripts/x.sh",
    'echo "$(date)"',
    'eval "$(ssh-agent -s)"',
    'eval "$(direnv export bash)"',
    "$($(echo hi))",
    '"${DC[@]}" build api',
    "echo $(git rev-parse HEAD)",
    "git log $(git rev-parse HEAD~3)..HEAD",
  ])(
    "keeps %s allowed: the substitution is a path or an argument, not the program's name",
    (cmd) => {
      const verdict = v(cmd);
      expect(verdict.decision, verdict.reason).toBe("allow");
    },
  );
});

describe("a host built around a substitution is not a known host", () => {
  it.each([
    "ssh h.example.com$(echo x)",
    "ssh $(echo prod.example.com)",
    "ssh `echo prod.example.com`",
    "ssh user@$(echo prod.example.com)",
    "ssh $PROD_HOST",
    "ssh ${PROD_HOST}",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "ssh localhost",
    "ssh 127.0.0.1 ls",
    "scp a.txt localhost:/tmp/a.txt",
    "ssh-keygen -l -f key.pub",
  ])("keeps %s allowed", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("a `function` body is judged like the body of `f() { … }`", () => {
  it.each([
    "function f { rm scripts/harness/x; }; f",
    "function f { echo x > compliance/controls.yaml; }",
    "function f() { rm scripts/harness/x; }; f",
    "function f ( ) { rm scripts/harness/x; }",
    "function f { true; rm scripts/harness/x; }",
    "function f {\n  rm scripts/harness/x\n}\nf",
    "f() { rm scripts/harness/x; }; f",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "function f { git push --no-verify; }; f",
    "function f { cat apps/backend/.env; }",
    "function f() { git push --no-verify; }",
  ])("denies %s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "function f { echo hi; }; f",
    "function greet { echo hello; }\ngreet",
    "f() { echo hi; }; f",
    "function f { cd apps; }; f; ls",
  ])("keeps %s allowed", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
