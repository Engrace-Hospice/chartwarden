/**
 * Wave 12, part F, rule W2 and rule 11: every loop over words the part added (the statement cap, the binders and namerefs, the redirect targets, the
 * prefix resolver for git options, brace expansion of refspecs, the awk candidate programs, the psql variable scan, the redis command lines, the
 * connection strings of a variable) must stay linear on what an adversary can build in 64 KB, END IN AN ASK where it gives up, and never allow what
 * the short form refuses. Each shape must finish with a decision well inside the 6.5 s hard deadline (the bound is a guard against a blow-up, not a
 * micro-benchmark) and the VERDICT is asserted, not only "no throw". Hosts and file names are built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => false,
  branch: "feature",
};
const K = `M34_TENANT${"_"}KEK`;
const D = `DATABASE${"_"}URL`;
const H = `prod${"."}example.com`;
const E = `.e${"nv"}`;
const BOUND_MS = 4000;
const times = (n: number, text: (i: number) => string, sep = "; "): string =>
  Array.from({ length: n }, (_, i) => text(i)).join(sep);

/** shape name, command, the decisions it may end in. */
const SHAPES: ReadonlyArray<readonly [string, string, ReadonlyArray<"allow" | "ask" | "deny">]> = [
  [
    "1,500 read binders then a print",
    `${times(1500, (i) => `read r${i} <<< "$${K}"`)}; echo $r0`,
    ["ask"],
  ],
  [
    "1,500 namerefs of a guarded name",
    `${times(1500, (i) => `declare -n n${i}=${K}`)}; echo $n0`,
    ["ask"],
  ],
  [
    "printenv of 5,000 copies",
    `export X=$${D}; printenv ${times(5000, () => "X", " ")}`,
    ["ask", "deny"],
  ],
  [
    "a tainted print past 3,000 file redirects",
    `x=$${K}; ${times(3000, (i) => `echo a > /tmp/f${i}`)}; echo $x > /dev/stdout`,
    ["ask"],
  ],
  [
    "a tainted print read back after 3,000 writes",
    `x=$${K}; ${times(3000, (i) => `echo $x > /tmp/g${i}`)}; cat /tmp/g2999`,
    ["ask"],
  ],
  ["3,000 array indirections", `a=(HOME); ${times(3000, () => 'echo "${!a[0]}"')}`, ["allow"]],
  ["3,000 positional indirections", times(3000, () => 'echo "${!1}"'), ["ask"]],
  [
    "a forced push with 5,000 abbreviated options",
    `git push ${times(5000, () => "--forc", " ")} origin x`,
    ["ask"],
  ],
  [
    "a forced push of main behind 5,000 abbreviations",
    `git push ${times(5000, () => "--force-w", " ")} origin main`,
    ["deny"],
  ],
  [
    "a forced push of 3,000 brace groups",
    `git push -f origin ${times(3000, () => "{a,b}{c,d}", " ")}`,
    ["allow", "ask", "deny"],
  ],
  [
    "a forced push of 1,500 patterns",
    `git push -f origin ${times(1500, (i) => `'refs/tags/t${i}/*:refs/tags/t${i}/*'`, " ")}`,
    ["allow", "ask"],
  ],
  [
    "a forced push of 1,500 patterns and main",
    `git push -f origin ${times(1500, (i) => `'refs/tags/t${i}/*:refs/tags/t${i}/*'`, " ")} 'refs/heads/*:refs/heads/*'`,
    ["deny"],
  ],
  [
    "a forced add of 5,000 abbreviations",
    `git add ${times(5000, () => "--fo", " ")} ${E}`,
    ["deny"],
  ],
  [
    "a forced add of 5,000 valued options then a live name",
    `git add --fo ${times(5000, () => "--chmod +x", " ")} ${E}`,
    ["deny"],
  ],
  [
    "1,500 pathspec files",
    `git add ${times(1500, () => "--pathspec-from-file=-", " ")} <<< x`,
    ["ask"],
  ],
  [
    "an awk with 5,000 option pairs and a program",
    `gawk ${times(5000, () => "-i x", " ")} 'BEGIN{system("psql -h ${H} -c 1")}'`,
    ["deny", "ask"],
  ],
  [
    "an awk with 3,000 programs and a last one that runs",
    `gawk ${times(3000, () => "-e 'BEGIN{print 1}'", " ")} -e 'BEGIN{system("psql -h ${H} -c 1")}'`,
    ["deny", "ask"],
  ],
  [
    "an awk with 8,000 file operands",
    `awk '{print}' ${times(8000, (i) => `f${i}`, " ")}`,
    ["allow"],
  ],
  [
    "a URI with 3,000 substitution operators",
    `psql "post${"gres"}://localhost:${times(3000, () => "${P/x/y}", "")}/db" -c 1`,
    ["ask"],
  ],
  [
    "a psql text of 5,000 variable connects",
    `psql -c '${times(5000, () => "\\c :c", "\n")}'`,
    ["ask"],
  ],
  [
    "a psql text of 8,000 literal backslash-n pieces",
    `psql <<< '${times(8000, () => "a\\\\nb", "")}'`,
    ["allow"],
  ],
  [
    "a redis stdin of 5,000 lines and a replicaof",
    `redis-cli <<'EOF'\n${times(5000, () => "GET x", "\n")}\nREPLICAOF ${H} 6379\nEOF`,
    ["ask"],
  ],
  [
    "a redis command line of 5,000 words",
    `redis-cli get ${times(5000, (i) => `k${i}`, " ")}`,
    ["allow"],
  ],
  [
    "a connection string with 3,000 hosts",
    `DATABASE_URL="host=${times(3000, (i) => `h${i}.example.org`, ",")},${H}" bun run test`,
    ["deny"],
  ],
  [
    "a connection string with 2,000 duplicate keys",
    `DATABASE_URL="${times(2000, () => "host=chartwarden-postgres", " ")} host=${H}" bun run test`,
    ["deny"],
  ],
  [
    "3,000 service variables",
    `${times(3000, (i) => `S${i}=1`)}; PGSERVICE=prod bun run x`,
    ["ask"],
  ],
  [
    "a cap past the tracker in bash -c",
    `bash -c '${times(400, (i) => `p${i}=1`)}; export PGHOST=${H}; psql -c 1'`,
    ["ask", "deny"],
  ],
];

describe("wave 12 part F readers stay linear and end in an ask on the shapes an adversary can build", () => {
  it.each(SHAPES)("%s", (_name, cmd, expected) => {
    expect(cmd.length).toBeLessThanOrEqual(64 * 1024);
    const start = Date.now();
    const verdict = classifyBash(cmd, ctx);
    expect(Date.now() - start).toBeLessThan(BOUND_MS);
    expect(expected).toContain(verdict.decision);
  });
});
