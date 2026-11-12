/**
 * Wave 4, T3. (a) `refuseHiddenPath`'s `bare === written` short-circuit: a line with no control or odd-space
 * character was judged as written by the caller, so it is neither refused nor resolved a second time; a line that
 * BECOMES a secret or protected path once those characters are removed is refused. (b) A budget spent while paths are
 * being resolved asks, never allows, and never turns a deny that is derivable without the budget into an ask: the
 * `psql` host deny below came back as an ask at the base of this wave, because the spent budget answered for the
 * whole command before the host check ran.
 */
import { describe, expect, it, vi } from "vitest";
import { refuseHiddenPath } from "../harness/guard-judge";
import { classifyBash } from "../harness/patterns";

/** A live env file's name, built so this file never spells it out. */
const ENV = [".", "env"].join("");
const NEL = "\u0085";

describe("refuseHiddenPath: the `bare === written` short-circuit", () => {
  const harness = () => ({ rel: vi.fn((p: string) => p), log: vi.fn() });

  it("returns at once for a line without odd characters, even a secret one: the caller judged it as written", () => {
    const { rel, log } = harness();
    expect(() => refuseHiddenPath(ENV, ENV, rel, log)).not.toThrow();
    expect(() =>
      refuseHiddenPath(
        "scripts/harness/pre-tool-guard.ts",
        "scripts/harness/pre-tool-guard.ts",
        rel,
        log,
      ),
    ).not.toThrow();
    expect(rel).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a line that becomes a secret path once its odd characters are taken out", () => {
    const { rel, log } = harness();
    const line = `${ENV}${NEL}`;
    expect(() => refuseHiddenPath(line, line.trim(), rel, log)).toThrow(/secret or protected path/);
    expect(log).toHaveBeenCalledWith(
      "deny",
      expect.stringMatching(/control or non-ASCII-space/),
      ENV,
      undefined,
    );
  });

  it("refuses a protected path hidden the same way, found by resolving the stripped line", () => {
    const { log } = harness();
    const rel = vi.fn((p: string) => `scripts/harness/${p}`);
    const line = `pre-tool-guard.ts${NEL}`;
    expect(() => refuseHiddenPath(line, line.trim(), rel, log)).toThrow(/secret or protected path/);
    expect(rel).toHaveBeenCalledWith("pre-tool-guard.ts");
  });

  it("resolves a line with odd characters that stays harmless, and lets it through", () => {
    const { rel, log } = harness();
    const line = `docs/naïve plan.md${NEL}`;
    expect(() => refuseHiddenPath(line, line.trim(), rel, log)).not.toThrow();
    expect(rel).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not resolve a line longer than a path can be", () => {
    const { rel, log } = harness();
    const line = `${"a".repeat(5000)}${NEL}`;
    expect(() => refuseHiddenPath(line, line.trim(), rel, log)).not.toThrow();
    expect(rel).not.toHaveBeenCalled();
  });
});

describe("a budget spent while paths are being resolved", () => {
  const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
  const v = (cmd: string) => classifyBash(cmd, ctx);
  /** 2,200 brace groups of two alternatives each: more than the 4,096 alternatives one command may expand. */
  const braces = Array.from({ length: 2200 }, () => "{a,b}").join(" ");
  /** 20,000 redirects: more than the 16,384 path resolutions one command may spend. */
  const redirects = " >a".repeat(20_000);
  const HOST = ["prod", "example", "com"].join(".");
  const psql = (host: string) => `psql -h ${host} -c 'select 1'`;

  it("asks, never allows, when the brace budget runs out", () => {
    const verdict = v(`touch ${braces}`);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too many|too big/);
  });

  it("asks, never allows, when the resolution budget runs out", () => {
    expect(v(`touch${" f".repeat(20_000)}`).decision).toBe("ask");
    expect(v(`${psql("localhost")}${redirects}`).decision).toBe("ask");
  });

  it("asks when the budget runs out inside a command that has nothing to deny", () => {
    expect(v(`${psql("localhost")} > ${braces}`).decision).toBe("ask");
  });

  it("never turns a deny into an ask: the production host is still refused", () => {
    expect(v(`${psql(HOST)} > ${braces}`).decision).toBe("deny");
    expect(v(`${psql(HOST)}${redirects}`).decision).toBe("deny");
    expect(v(`touch ${braces}; ${psql(HOST)}`).decision).toBe("deny");
  });

  it("keeps the ordinary answers: an unknown directory still asks, small commands still allow", () => {
    expect(v('cd "$X" && touch f').decision).toBe("ask");
    expect(v("touch a b").decision).toBe("allow");
    expect(v(`${psql("localhost")} > out.txt`).decision).toBe("allow");
    expect(v(`${psql(HOST)} > out.txt`).decision).toBe("deny");
  });
});
