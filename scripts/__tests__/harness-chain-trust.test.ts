/**
 * Wave 3 (fixer W3b), CR-M3: the `&&` trust ("this command runs where the one before it `cd`-ed") was one flag
 * for the whole line, so an unrelated pipe, `$( )` or `&` LATER on the line made a safe `cd /tmp/x && sed -i …`
 * ask (50 of 7,391 real commands). It is per command now: only a group, pipe or `&` AT OR BEFORE a command
 * cancels it. Also pins the soundness half that no test covered (removing the `( )` rule left 390 tests green).
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { splitCommand } from "../harness/shell-lex";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const never = () => false;

describe("a later pipe, substitution or `&` does not cancel the `&&` trust of an earlier command", () => {
  it.each([
    "cd /tmp/x && sed -i s/a/b/ compliance/controls.yaml && git diff | head -3",
    "cd /tmp/x && touch compliance/controls.yaml | cat",
    "cd /tmp/x && touch compliance/controls.yaml && echo $(date)",
    "cd /tmp/x && touch compliance/controls.yaml && echo `date`",
    "cd /tmp/x && touch compliance/controls.yaml &",
    "cd /tmp/x && touch compliance/controls.yaml && sleep 1 &",
    "cd /tmp/x && cat <(echo a) && touch compliance/controls.yaml",
    "cd apps && echo $(pwd) > compliance-notes.txt && ls | wc -l",
  ])("allows %s", (cmd) => {
    const verdict = classifyBash(cmd, ctx);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("a group, pipe or `&` at or before the `cd` still cancels it", () => {
  it.each([
    // a group, closed or not, before the `&&` command
    "(cd apps) && touch compliance/controls.yaml",
    "( cd apps ) && touch compliance/controls.yaml",
    "(cd apps; true) && touch compliance/controls.yaml",
    "(cd apps && true) && touch compliance/controls.yaml",
    "true && (cd /tmp/x) && touch compliance/controls.yaml",
    // the `cd` is a stage of a pipeline: it moved a subshell, not this shell
    "cd apps | cat && touch compliance/controls.yaml",
    "true | cd apps && touch compliance/controls.yaml",
    "cd apps | cat; cd /tmp/x && touch compliance/controls.yaml && true",
    // backgrounded: the `cd` did not move this shell
    "cd apps & touch compliance/controls.yaml",
    "cd apps & cd /tmp/x && touch compliance/controls.yaml",
    // an `||` before the `&&`: the `cd` may not have run
    "true || cd apps && touch compliance/controls.yaml",
    // a script body a shell reads is a subshell: its `cd` does not move this shell
    "bash <<'EOF' && touch compliance/controls.yaml\ncd apps\nEOF",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it("still trusts a plain chain, so the target of the `cd` is where the write lands", () => {
    expect(d("cd apps && touch compliance/controls.yaml")).toBe("allow");
    expect(d("cd apps && cd .. && touch compliance/controls.yaml")).toBe("ask");
    expect(d("cd scripts && touch harness/x")).toBe("ask");
  });
});

describe("the splitter reports, per command, whether the `&&` before it can be trusted", () => {
  const chained = (cmd: string) => splitCommand(cmd, never).parts.map((p) => p.chained);

  it("is true along a plain `;` / `&&` / `||` / newline sequence", () => {
    expect(chained("a && b; c || d\ne && f")).toEqual([true, true, true, true, true, true]);
  });

  it("goes false after a pipe or `&`, but not for a command before it", () => {
    expect(chained("a && b | c && d")).toEqual([true, true, false, false]);
    expect(chained("a && b & c && d")).toEqual([true, true, false, false]);
  });

  it("goes false at a group, and stays false after it", () => {
    expect(chained("(a) && b && c")).toEqual([true, false, false]);
    expect(chained("a && (b) && c")).toEqual([true, true, false]);
  });

  it("is not cancelled by a substitution or a brace", () => {
    expect(chained("a && echo $(b) && c")).toEqual([true, true, true]);
    expect(chained("a && echo {x,y} && c")).toEqual([true, true, true]);
  });

  it("is false for the commands of a script body and everything after it", () => {
    const run = (cmd: string) => splitCommand(cmd, (s) => s.startsWith("sh")).parts;
    const parts = run("a\nsh <<EOF\nb && c\nEOF\nd && e");
    expect(parts.map((p) => p.text)).toEqual(["a", "sh <<EOF", "b", "c", "d", "e"]);
    expect(parts.map((p) => p.chained)).toEqual([true, true, false, true, false, false]);
  });
});
