/**
 * Wave 11 part C, rule 11: the new readers loop over words, so each gets an adversarially long input. A guard that runs out of time refuses
 * the call (`hard-deadline.ts`), so what must hold is that none of these throws, that each answers (never an allow for a guarded command
 * behind the padding), and that the time stays far below the 6.5 s deadline (the bound here guards a super-linear blow-up, not a micro-benchmark).
 */
import { describe, expect, it } from "vitest";
import { splitEnvString } from "../harness/env-split";
import { classifyBash } from "../harness/patterns";
import { shellCommandStrings } from "../harness/shell-command-string";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const BOUND_MS = 4000;
const NO_VERIFY = "git commit --no-verify -m x";
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

function answer(cmd: string): { rank: number; ms: number } {
  const started = performance.now();
  const verdict = classifyBash(cmd, ctx);
  return { rank: RANK[verdict.decision] ?? -1, ms: performance.now() - started };
}

const repeat = (text: string, n: number): string => Array.from({ length: n }, () => text).join(" ");

describe("heavy shapes of the wave-11 readers", () => {
  it("a shell with 5,000 options before its command string reads it in linear time", () => {
    const options = repeat("-x", 5000);
    const started = performance.now();
    const strings = shellCommandStrings("bash", ["-c", ...options.split(" "), NO_VERIFY]);
    expect(strings).toContain(NO_VERIFY);
    expect(performance.now() - started).toBeLessThan(500);
    const { rank, ms } = answer(`bash -c ${options} '${NO_VERIFY}'`);
    expect(rank).toBe(2);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("an env -S string of 60 KB, of escapes and of quotes, splits in linear time", () => {
    const heavy = [
      repeat("a\\_b", 12000),
      repeat("'a b'", 12000),
      repeat('"a${V}b"', 8000),
      `${"\\\\".repeat(20000)} x`,
    ];
    for (const text of heavy) {
      const started = performance.now();
      splitEnvString(text, () => "v");
      expect(performance.now() - started).toBeLessThan(500);
    }
    const { rank, ms } = answer(
      `env -S '${NO_VERIFY.replaceAll(" ", "\\_")}\\_${repeat("a\\_b", 3000)}'`,
    );
    expect(rank).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("14 levels of `bash -c --` with quoting, and 3,000 precommand modifiers in front of a guarded command, still answer", () => {
    let nested = NO_VERIFY;
    for (let level = 0; level < 14; level++)
      nested = `bash -c -- '${nested.replaceAll("'", `'\\''`)}'`;
    const deep = answer(nested);
    expect(deep.rank).toBeGreaterThanOrEqual(1);
    expect(deep.ms).toBeLessThan(BOUND_MS);
    const chain = answer(`${repeat("noglob", 3000)} ${NO_VERIFY}`);
    expect(chain.rank).toBeGreaterThanOrEqual(1);
    expect(chain.ms).toBeLessThan(BOUND_MS);
  });

  it("5,000 `-e` options of docker exec and docker run, and 5,000 words after `sudo -s`, answer", () => {
    for (const cmd of [
      `docker exec ${repeat("-e A=1", 5000)} c psql -c 'select 1'`,
      `docker run ${repeat("-e A=1", 5000)} img ${NO_VERIFY}`,
      `sudo -s ${repeat("x", 5000)} ${NO_VERIFY}`,
      `ssh localhost ${repeat("x", 5000)}`,
    ]) {
      const { rank, ms } = answer(cmd);
      expect(rank, cmd.slice(0, 40)).toBeGreaterThanOrEqual(0);
      expect(ms, cmd.slice(0, 40)).toBeLessThan(BOUND_MS);
    }
    expect(answer(`docker run ${repeat("-e A=1", 5000)} img ${NO_VERIFY}`).rank).toBe(2);
  });

  it("a here-string and a pipe of 60 KB behind a container wrapper, and 3,000 piped stages, answer", () => {
    const text = "x".repeat(60000);
    const a = answer(`docker exec -i db psql <<< '${text}'`);
    expect(a.ms).toBeLessThan(BOUND_MS);
    const b = answer(`${repeat("echo x |", 3000)} docker exec -i db psql`);
    expect(b.rank).toBeGreaterThanOrEqual(0);
    expect(b.ms).toBeLessThan(BOUND_MS);
  });

  it("pnpm and parallel with thousands of words answer, and the guarded command behind them is still judged", () => {
    const pnpm = answer(`pnpm ${repeat("--filter x", 2000)} ${NO_VERIFY}`);
    expect(pnpm.rank).toBe(2);
    expect(pnpm.ms).toBeLessThan(BOUND_MS);
    const data = repeat("d", 3000);
    const parallel = answer(`parallel ${NO_VERIFY} ::: ${data}`);
    expect(parallel.rank).toBe(2);
    expect(parallel.ms).toBeLessThan(BOUND_MS);
  });
});
