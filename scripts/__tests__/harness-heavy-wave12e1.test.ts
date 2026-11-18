/**
 * Wave 12 part E1, rule W2: every cap, depth limit and "cannot place" case of the readers of this part ends in an ASK or keeps the verdict of the short form,
 * and a test asserts that VERDICT at the cap (not only "no throw"): a 5,000-word payload yields the verdict the short form yields, or asks; it never allows
 * what the short form refuses. The 6.5 s hard deadline and the work budget stay intact (`hard-deadline.ts`, `work-budget.ts`): the wall-clock bound is a
 * safety net, not the assertion. The non-local host is built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const GUARDED = [
  "git push --force origin main",
  "git commit --no-verify -m x",
  `psql -h ${HOST} -c 'select 1'`,
];
const SAFETY_NET_MS = 6000;
const q = (c: string): string => `'${c.replace(/'/g, "'\\''")}'`;
const repeat = (word: string, n: number): string => Array.from({ length: n }, () => word).join(" ");

interface Payload {
  readonly name: string;
  readonly build: (n: number, command: string) => string;
}
const PAYLOADS: readonly Payload[] = [
  { name: "bash: n flags before -c", build: (n, c) => `bash ${repeat("-x", n)} -c ${q(c)}` },
  {
    name: "bash: n -o VALUE pairs before -c",
    build: (n, c) => `bash ${repeat("-o pipefail", n)} -c ${q(c)}`,
  },
  { name: "bash: n long options", build: (n, c) => `bash ${repeat("--norc", n)} -c ${q(c)}` },
  { name: "zsh: n clusters -oc", build: (n, c) => `zsh ${repeat("-f", n)} -c ${q(c)}` },
  { name: "ksh: n -o -x pairs", build: (n, c) => `ksh ${repeat("-o -x", n)} -c ${q(c)}` },
  { name: "csh: n -f flags", build: (n, c) => `csh ${repeat("-f", n)} -c ${q(c)}` },
  {
    name: "sh -c with n operands read by $@",
    build: (n, c) => `sh -c '"$@"' _ ${c} ${repeat("x", n)}`,
  },
  {
    name: "env -S: n leading -i inside the string",
    build: (n, c) => `env -S ${q(`${repeat("-i", n)} ${c}`)}`,
  },
  {
    name: "env: n assignments",
    build: (n, c) => `env ${Array.from({ length: n }, (_, i) => `A${i}=1`).join(" ")} ${c}`,
  },
  {
    name: "env: n odd-named assignments",
    build: (n, c) => `env ${Array.from({ length: n }, (_, i) => `A.${i}=1`).join(" ")} ${c}`,
  },
  { name: "env -S: n nested -S", build: (n, c) => `env -S ${q(`${repeat("-S", n)} ${c}`)}` },
  {
    name: "npm exec: n -c x before the guarded -c",
    build: (n, c) => `npm exec ${repeat("-c true", n)} -c ${q(c)}`,
  },
  {
    name: "bun run --parallel: n operands",
    build: (n, c) => `bun run --parallel ${repeat("'echo a'", n)} ${q(c)}`,
  },
  {
    name: "concurrently: n operands",
    build: (n, c) => `concurrently ${repeat("'echo a'", n)} ${q(c)}`,
  },
  {
    name: "npm: n unlisted flags before exec",
    build: (n, c) => `npm ${repeat("--no-fund", n)} exec ${c}`,
  },
  {
    name: "pnpm: n unlisted letters before exec",
    build: (n, c) => `pnpm ${repeat("-Z", n)} exec ${c}`,
  },
  { name: "wrapper chain: n lockf", build: (n, c) => `${repeat("lockf /tmp/l", n)} ${c}` },
  { name: "su: n words before the --", build: (n, c) => `su ${repeat("root", n)} -- -c ${q(c)}` },
];

describe("W2: at 9, 50 and 5,000 words a guarded command is never allowed where the short form refuses it", () => {
  for (const payload of PAYLOADS) {
    it(payload.name, () => {
      for (const command of GUARDED) {
        const short = RANK[classifyBash(payload.build(1, command), ctx).decision] as number;
        expect(short, `${payload.name}: the short form of ${command}`).toBeGreaterThanOrEqual(1);
        for (const n of [9, 50, 5000]) {
          const cmd = payload.build(n, command);
          const started = Date.now();
          const verdict = classifyBash(cmd, ctx);
          expect(Date.now() - started, `${payload.name} x${n}`).toBeLessThan(SAFETY_NET_MS);
          // the verdict of the short form, or an ask (a cap or a work budget): never the allow the short form does not give
          expect(
            RANK[verdict.decision],
            `${payload.name} x${n}: ${command}`,
          ).toBeGreaterThanOrEqual(Math.min(short, 1));
        }
      }
    }, 60_000);
  }

  it("a harmless command behind the same padding is never denied and never throws", () => {
    for (const payload of PAYLOADS) {
      for (const n of [9, 50, 5000]) {
        const verdict = classifyBash(payload.build(n, "echo hi"), ctx);
        expect(verdict.decision, `${payload.name} x${n}`).not.toBe("deny");
      }
    }
  }, 120_000);

  it("the nesting caps ask: nine rounds of env -S and nine of a wrapper chain are never an allow for a harmless command", () => {
    const deep = (n: number): string => `env -S ${q(`${repeat("-S", n)} echo hi`)}`;
    expect(classifyBash(deep(3), ctx).decision).toBe("allow");
    for (const n of [8, 9, 50, 5000])
      expect(classifyBash(deep(n), ctx).decision, `${n} rounds`).toBe("ask");
  });
});
