/**
 * Wave 12 part E2, rule W2 and wave 11 rule 11: every new reader that loops over words gets an adversarially long input. What must hold: nothing throws, the
 * VERDICT is the one the short form gives (or an ask), never an allow where the short form refuses, and the time stays far below the 6.5 s hard deadline (the
 * bound guards a super-linear blow-up, not a micro-benchmark). The non-local host is built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const BOUND_MS = 4000;
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

/** The guard refuses a command over 64 KB outright: a heavy shape must stay under it, or it proves nothing about the readers. */
const MAX_CHARS = 64 * 1024;

function answer(cmd: string): { rank: number; ms: number } {
  expect(cmd.length, "the shape is over the 64 KB limit").toBeLessThan(MAX_CHARS);
  const started = performance.now();
  const verdict = classifyBash(cmd, ctx);
  return { rank: RANK[verdict.decision] ?? -1, ms: performance.now() - started };
}
const repeat = (text: string, n: number): string => Array.from({ length: n }, () => text).join(" ");
const numbered = (make: (i: number) => string, n: number): string =>
  Array.from({ length: n }, (_, i) => make(i)).join(" ");

describe("heavy shapes of the wave-12 part E2 readers", () => {
  it("3,000 here-strings on one client answer with an ask (more texts than the guard carries), and a handful are read", () => {
    const many = answer(`psql -h localhost ${numbered((i) => `<<< 'select ${i}'`, 3000)}`);
    expect(many.rank).toBe(1);
    expect(many.ms).toBeLessThan(BOUND_MS);
    expect(answer(`psql -h localhost ${numbered((i) => `<<< 'select ${i}'`, 30)}`).rank).toBe(0);
    // a reconnection among a handful is still refused
    const hidden = `psql <<< 'select 1' <<< '\\c db user ${HOST}' <<< 'select 2'`;
    expect(answer(hidden).rank).toBe(2);
  });

  it("1,200 groups each carrying a here-string answer with an ask in linear time (every command of the line may read each of them)", () => {
    const cmd = numbered((i) => `{ psql -h localhost; } <<< 'select ${i}';`, 1200);
    const r = answer(cmd);
    expect(r.rank).toBe(1);
    expect(r.ms).toBeLessThan(BOUND_MS);
    expect(answer(numbered((i) => `{ psql -h localhost; } <<< 'select ${i}';`, 3)).rank).toBe(0);
  });

  it("2,500 functions and one call fed a reconnection still refuse it, quickly", () => {
    const defs = numbered((i) => `f${i}() { true; };`, 2500);
    const r = answer(`${defs} g() { psql; }; g <<< '\\c db user ${HOST}'`);
    expect(r.rank).toBe(2);
    expect(r.ms).toBeLessThan(BOUND_MS);
  });

  it("5,000 procsubs, and a long run of `|` stages around a shell, answer", () => {
    const procsubs = answer(`bash ${numbered((i) => `<(echo ${i})`, 5000)}`);
    expect(procsubs.ms).toBeLessThan(BOUND_MS);
    expect(procsubs.rank).toBeGreaterThanOrEqual(0);
    const shell = answer(`${repeat("echo x |", 3000)} bash`);
    expect(shell.rank).toBe(1);
    expect(shell.ms).toBeLessThan(BOUND_MS);
  });

  it("5,000 commands behind one a here-string cat chain: the reader at the end asks, the same chain into a plain filter is untouched", () => {
    const chain = `cat <<< '\\c db user ${HOST}' | ${repeat("cat |", 4999)} psql`;
    const r = answer(chain);
    expect(r.rank).toBe(1);
    expect(r.ms).toBeLessThan(BOUND_MS);
    expect(answer(`cat <<< 'x' | ${repeat("cat |", 4999)} wc -l`).rank).toBe(0);
  });

  it("2,000 ssh options in front of a jump host, and the jump host among 2,000 forwards, still ask", () => {
    const options = answer(
      `ssh ${repeat("-o StrictHostKeyChecking=no", 2000)} -J ${HOST} localhost ls`,
    );
    expect(options.rank).toBe(1);
    expect(options.ms).toBeLessThan(BOUND_MS);
    const forwards = answer(
      `ssh ${numbered((i) => `-L ${5000 + i}:localhost:22`, 2000)} -L 9:${HOST}:22 localhost -N`,
    );
    expect(forwards.rank).toBe(1);
    expect(forwards.ms).toBeLessThan(BOUND_MS);
    expect(answer(`ssh ${repeat("-o StrictHostKeyChecking=no", 2000)} localhost ls`).rank).toBe(0);
  });

  it("a clustered ssh option of 5,000 letters, and 5,000 mosh and et flags before the host, answer", () => {
    const cluster = answer(`ssh -${"N".repeat(5000)}L 5433:${HOST}:5432 localhost`);
    expect(cluster.rank).toBe(1);
    expect(cluster.ms).toBeLessThan(BOUND_MS);
    const mosh = answer(`mosh ${repeat("-n", 5000)} ${HOST}`);
    expect(mosh.rank).toBe(1);
    expect(mosh.ms).toBeLessThan(BOUND_MS);
    const et = answer(`et ${repeat("-N", 5000)} ${HOST}`);
    expect(et.rank).toBe(1);
  });

  it("5,000 words behind a hosted-service CLI, and 2,000 env-file options, answer with the short form's verdict", () => {
    expect(answer(`heroku run ${repeat("x", 5000)}`).rank).toBe(1);
    expect(answer(`heroku logs ${repeat("x", 5000)}`).rank).toBe(0);
    expect(answer(`aws s3 ls ${repeat("x", 5000)}`).rank).toBe(0);
    expect(answer(`aws ${repeat("--profile p", 2000)} ssm send-command`).rank).toBe(1);
    const envFiles = answer(
      `docker run ${repeat("--env-file ./local.txt", 2000)} --env-file <(echo PGHOST=${HOST}) img psql`,
    );
    expect(envFiles.rank).toBe(1);
    expect(envFiles.ms).toBeLessThan(BOUND_MS);
    expect(answer(`docker run ${repeat("--env-file ./local.txt", 2000)} img psql`).rank).toBe(0);
  });

  it("3,000 podman options, 3,000 compose options and 3,000 statements before an exported engine variable ask", () => {
    expect(
      answer(`podman ${repeat("--root /tmp/x", 3000)} --connection prod exec db ls`).rank,
    ).toBe(1);
    expect(
      answer(`docker-compose ${repeat("-f x.yml", 3000)} -H ssh://u@${HOST} exec db ls`).rank,
    ).toBe(1);
    const exported = `${numbered((i) => `export V${i}=1;`, 3000)} export DOCKER_HOST=ssh://u@${HOST}; docker exec db ls`;
    const r = answer(exported);
    // the variable tracker keeps 256 statement words; the engine variable is read from the commands themselves, so the padding hides nothing
    expect(r.rank).toBe(1);
    expect(r.ms).toBeLessThan(BOUND_MS);
  });

  it("a leading pipe in front of padding answers without throwing", () => {
    expect(() => classifyBash(`| ${repeat("cat |", 3000)} psql`, ctx)).not.toThrow();
    expect(answer(`| ${repeat("cat |", 3000)} psql`).rank).toBeGreaterThanOrEqual(1);
  });
});
