/**
 * WardenX — dependency-vulnerability audit gate (WX-PR-017 / SEC-003)
 * ---------------------------------------------------------------------
 * `bun audit` had no CI gate at all before this — a new vulnerable dependency could land and no
 * check would ever see it. This is a RATCHET, matching every other gate in this repo
 * (`report-openapi-coverage.ts`, `check-audit-denylist-sync.ts`): every advisory `bun audit` reports
 * must be in the reviewed `ACCEPTED_ADVISORIES` allowlist below, each with a written reason. A NEW,
 * unlisted advisory fails the build; a listed one that `bun audit` no longer reports (the dependency
 * got patched) is a STALE ENTRY this script also flags, so an accepted exception doesn't quietly
 * outlive the vulnerability it was excusing.
 *
 * Usage: `bun run arch:audit-exceptions` (wired into `arch:fitness`).
 */
import { spawnSync } from "node:child_process";

interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
}

/**
 * Every entry here is a REVIEWED, TIME-BOUNDED exception, not a permanent waiver — `until` records
 * what would make it obsolete, so a future maintainer knows when to re-check rather than assuming
 * "it's on the list, so it's fine forever."
 */
const ACCEPTED_ADVISORIES: ReadonlyArray<{
  readonly ghsaId: string;
  readonly reason: string;
  readonly until: string;
}> = [
  {
    ghsaId: "GHSA-qwww-vcr4-c8h2",
    reason:
      "react-router 'RSC Mode CSRF Bypass' (CVSS 7.1, CWE-352) is scoped to React Server Components " +
      "mode. WardenX's three SPAs (apps/web, apps/portal, apps/admin) are plain Vite client-rendered " +
      "apps built on react-router-dom — no RSC/framework-mode usage anywhere in the codebase (verified " +
      "2026-08-05: no `@react-router/dev`, `unstable_RSCStaticRouter`, or `renderToReadableStream` " +
      "usage). The vulnerable code path is not reachable.",
    until:
      "react-router-dom publishes a patched >=8.3.0 release (as of 2026-08-05 the latest published " +
      "version is still 7.18.2 — no fixed version exists yet to upgrade to). Re-run `bun audit` after " +
      "any react-router-dom bump and remove this entry once the range no longer matches.",
  },
];

const result = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
// bun audit exits 1 when it finds ANY advisory — that is not itself a failure for this gate; only an
// UNLISTED advisory is. A genuine tool failure (missing binary, network error) has no parseable JSON.
let report: Record<string, Advisory[]>;
try {
  report = JSON.parse(result.stdout.trim() || "{}");
} catch {
  console.error("FAIL check-audit-exceptions: `bun audit --json` did not return parseable JSON.");
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(1);
}

const found = new Set<string>();
for (const advisories of Object.values(report)) {
  for (const a of advisories) {
    const ghsaId = a.url.split("/").pop() ?? a.url;
    found.add(ghsaId);
  }
}

const accepted = new Set(ACCEPTED_ADVISORIES.map((a) => a.ghsaId));
const unaccepted = [...found].filter((id) => !accepted.has(id));
const stale = ACCEPTED_ADVISORIES.filter((a) => !found.has(a.ghsaId));

if (unaccepted.length > 0) {
  console.error(
    `FAIL check-audit-exceptions: ${unaccepted.length} advisory(ies) not in ACCEPTED_ADVISORIES:`,
  );
  for (const id of unaccepted) console.error(`  - ${id} — https://github.com/advisories/${id}`);
  console.error("\nEither fix the dependency, or add a reviewed exception to");
  console.error("scripts/check-audit-exceptions.ts with a written reason + expiry condition.");
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    `FAIL check-audit-exceptions: ${stale.length} accepted exception(s) no longer reported by bun audit — the dependency was patched. Remove the now-obsolete entry:`,
  );
  for (const a of stale) console.error(`  - ${a.ghsaId}`);
  process.exit(1);
}

console.log(
  `OK audit-exceptions: ${found.size} advisory(ies), all reviewed and accepted (see scripts/check-audit-exceptions.ts)`,
);
