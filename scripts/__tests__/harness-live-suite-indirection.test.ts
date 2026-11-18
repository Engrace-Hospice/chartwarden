/**
 * Wave 6, T5 (round-4 adversarial ADV-8, LOW): the live-suite ask looked at `vitest` as the program, or as the tool a
 * launcher (`bunx`, `npx`, `bun x`) starts. A runner reached through indirection ran a live suite unasked:
 * `node node_modules/.bin/vitest run x.live.test.ts`, `bun node_modules/vitest/vitest.mjs …`, `bun run test --
 * x.live.test.ts`, `npm test x.live.test.ts`, and a quoted glob (`"apps/backend/__tests__/*.live.*"`). They ask now.
 * The 1,022 false positives the wave-4 rule removed stay removed: a tool that only names the file (`bunx biome check`,
 * `tsc`, `prettier`, `eslint`; `rg`, `grep`, `cat`, `sed`, `git`, `wc`) still allows. There is no Makefile in this repo,
 * so `make live` names nothing; `xargs bunx vitest run < list` reads its files from standard input, which the guard cannot
 * read (a documented limit, pinned below as not asked).
 */
import { describe, expect, it } from "vitest";
import { runsLiveSuite } from "../harness/live-suite";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const LIVE = "apps/backend/__tests__/x.live.test.ts";
const GLOB = "apps/backend/__tests__/*.live.*";

describe("runsLiveSuite reaches a runner through indirection", () => {
  it.each<[string, string[], boolean]>([
    // The reviewer's repros.
    ["node", ["node_modules/.bin/vitest", "run", LIVE], true],
    ["node", ["node_modules/vitest/vitest.mjs", "run", LIVE], true],
    ["bun", ["node_modules/vitest/vitest.mjs", "run", LIVE], true],
    ["bun", ["run", "test", "--", LIVE], true],
    ["npm", ["test", LIVE], true],
    ["bunx", ["vitest", "run", GLOB], true],
    // The same shapes, other launchers and spellings.
    ["node", ["./node_modules/.bin/vitest", LIVE], true],
    ["node", ["--no-warnings", "node_modules/vitest/vitest.mjs", "run", LIVE], true],
    ["bun", ["--bun", "node_modules/.bin/vitest", "run", LIVE], true],
    ["bun", ["run", "node_modules/.bin/vitest", "run", LIVE], true],
    ["npm", ["run", "test", "--", LIVE], true],
    ["npm", ["t", LIVE], true],
    ["pnpm", ["test", LIVE], true],
    ["pnpm", ["run", "test", LIVE], true],
    ["yarn", ["test", LIVE], true],
    ["yarn", ["run", "test", LIVE], true],
    ["bun", ["run", "test", GLOB], true],
    ["vitest", ["run", GLOB], true],
    ["npx", ["vitest", "run", "apps/backend/__tests__/m?.live.test.ts"], true],
    ["bunx", ["vitest", GLOB.replace("/*.", "/{a,b}.")], true],
    // Not a runner, or not a live file.
    ["node", ["node_modules/.bin/vitest", "run", "scripts/__tests__/x.test.ts"], false],
    ["node", ["scripts/x.js", LIVE], false],
    ["bun", ["scripts/x.ts", LIVE], false],
    ["bun", ["run", "test"], false],
    ["bun", ["run", "test", "--", "scripts/__tests__/x.test.ts"], false],
    ["npm", ["test"], false],
    ["npm", ["install", LIVE], false],
    ["npm", ["run", "build", LIVE], false],
    ["pnpm", ["test", "scripts/__tests__/x.test.ts"], false],
    ["yarn", ["lint", LIVE], false],
    ["bunx", ["biome", "check", LIVE], false],
    ["bunx", ["biome", "check", GLOB], false],
    ["bunx", ["tsc", "-p", "tsconfig.json", LIVE], false],
    ["bunx", ["prettier", "--check", LIVE], false],
    ["bunx", ["eslint", LIVE], false],
    ["npx", ["eslint", GLOB], false],
    ["node", ["node_modules/.bin/tsc", LIVE], false],
    ["node", ["node_modules/.bin/biome", "check", LIVE], false],
    ["rg", ["foo", LIVE], false],
    ["grep", ["-r", "foo", GLOB], false],
    ["cat", [LIVE], false],
    ["sed", ["-n", "1,5p", LIVE], false],
    ["git", ["diff", "--", LIVE], false],
    ["wc", ["-l", LIVE], false],
  ])("%s %j -> %s", (prog, args, expected) => {
    expect(runsLiveSuite(prog, args)).toBe(expected);
  });
});

describe("the live-suite ask in the classifier, through indirection", () => {
  it.each([
    `node node_modules/.bin/vitest run ${LIVE}`,
    `node node_modules/vitest/vitest.mjs run ${LIVE}`,
    `bun node_modules/vitest/vitest.mjs run ${LIVE}`,
    `bun run test -- ${LIVE}`,
    `npm test ${LIVE}`,
    `bunx vitest run "${GLOB}"`,
    `bunx vitest run '${GLOB}'`,
    `cd apps/backend && node ../../node_modules/.bin/vitest run __tests__/x.live.test.ts`,
    `DATABASE_URL=postgres://localhost:55432/x npm run test -- ${LIVE}`,
    `bash -c 'node node_modules/.bin/vitest run ${LIVE}'`,
    `bun run test:rls:live`,
  ])("asks: %s", (cmd) => {
    const verdict = classifyBash(cmd, ctx);
    expect(verdict.decision, cmd).toBe("ask");
    expect(verdict.reason).toMatch(/DROP ROLE chartwarden_app/);
  });

  it.each([
    `bunx biome check ${LIVE}`,
    `bunx biome check ${GLOB}`,
    `bunx tsc --noEmit ${LIVE}`,
    `bunx prettier --check ${LIVE}`,
    `bunx eslint ${LIVE}`,
    `rg foo ${LIVE}`,
    `grep -n foo ${LIVE}`,
    `cat ${LIVE}`,
    `sed -n 1,20p ${LIVE}`,
    `git diff -- ${LIVE}`,
    `git log --oneline -- ${LIVE}`,
    `wc -l ${LIVE}`,
    `bun run test`,
    `bun run test -- scripts/__tests__/x.test.ts`,
    `npm test`,
    `node node_modules/.bin/vitest run scripts/__tests__/x.test.ts`,
    `bunx vitest run scripts/__tests__/harness-live-suite.test.ts`,
    // Standard input is a list the guard cannot read: documented, not asked.
    `xargs bunx vitest run < list.txt`,
    // No Makefile in this repo, so the target names nothing.
    `make live`,
  ])("allows: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
