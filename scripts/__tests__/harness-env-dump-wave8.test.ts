/**
 * Wave 8, T5 (round-6 ADV6-8, CR6-12): more shapes of printing the environment, and one false positive. `bun -e
 * 'console.log(Bun.env)'`, `typeset -x`, `declare -px`, `export -px`, `jq -n 'env'`, perl `$ENV{…}` and `%ENV`, awk `ENVIRON`,
 * `ps eww`, `ps aux -E`, `launchctl getenv|export`, deno `Deno.env.toObject()`, python `os.environ` in any shape, node
 * `JSON.stringify({...process.env})`, ruby `ENV.to_h` all put DATABASE_URL and vendor secrets into the transcript and were
 * allowed. And `declare -x FOO=bar` ASSIGNS (a common idiom) yet was denied as a dump. Both directions are tested.
 * `classifyBash` is pure.
 */
import { describe, expect, it } from "vitest";
import { environmentDumpReason } from "../harness/env-dump";
import { environmentLeak } from "../harness/env-shapes";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

describe("commands that dump the environment are denied", () => {
  it.each([
    "printenv",
    "env",
    "set",
    "export",
    "export -p",
    "export -px",
    "export -xp",
    "declare",
    "declare -x",
    "declare -p",
    "declare -px",
    "declare -xp",
    "typeset",
    "typeset -x",
    "typeset -p",
    "ps eww $$",
    "ps ewww -p 1",
    "ps e",
    "ps auxe",
    "ps axe",
    "ps aux -E",
    "ps -E",
    "ps -ww -E",
    "launchctl export",
    "launchctl getenv DATABASE_URL",
    "launchctl getenv BETTER_AUTH_SECRET",
    "jq -n 'env'",
    "jq -n '$ENV'",
    "jq -n 'env.DATABASE_URL'",
    "jq -n '$ENV.API_KEY'",
    "jq 'env | keys' x.json",
    "jq -r 'env.X_TOKEN' x.json",
    "jq -n 'env | to_entries'",
    "jq -n '[env]'",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});

describe("assignments and everyday reads are not dumps (CR6-12)", () => {
  it.each([
    "declare -x FOO=bar",
    "typeset -x FOO=bar",
    "export FOO=bar",
    "export FOO",
    "export -n FOO",
    "export A=1 B=2",
    "declare -a arr=(a b)",
    "declare -r X=1",
    "declare -i n=3",
    "declare -A map",
    "set -e",
    "set -x",
    "set -euo pipefail",
    "set -- a b",
    "printenv HOME",
    "printenv PATH",
    "env FOO=1 true",
    "env -i true",
    "env -u FOO true",
    "ps aux",
    "ps -ef",
    "ps -p 1 -o comm=",
    "ps ax",
    "ps -eo pid,comm",
    "ps -u me",
    "ps -p 12 -o command=",
    "ps aux -u me",
    "ps -axo pid,command",
    "launchctl getenv LANG",
    "launchctl list",
    "jq . x.json",
    "jq -r '.a.b' x.json",
    "jq -n 'env.HOME'",
    "jq -n '$ENV.NODE_ENV'",
    "jq '.environment' x.json",
    "jq '.environment.name' x.json",
    "jq -n '$__loc__'",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("names which option makes export, declare and typeset list", () => {
    expect(environmentDumpReason("export", ["-px"])).not.toBeNull();
    expect(environmentDumpReason("declare", ["-n"])).toBeNull();
    expect(environmentDumpReason("declare", ["-x", "A=1"])).toBeNull();
    expect(environmentDumpReason("typeset", ["-p", "A"])).toBeNull();
    expect(environmentDumpReason("cat", [])).toBeNull();
  });
});

describe("inline code that prints the environment is denied", () => {
  it.each([
    "bun -e 'console.log(Bun.env)'",
    "bun -e 'console.log(JSON.stringify(Bun.env))'",
    "perl -e 'print $ENV{BETTER_AUTH_SECRET}'",
    "perl -E 'say for %ENV'",
    "perl -e 'print map {\"$_=$ENV{$_}\\n\"} keys %ENV'",
    "awk 'BEGIN{print ENVIRON[\"DATABASE_URL\"]}'",
    "awk 'BEGIN{for (k in ENVIRON) print k}'",
    "deno eval 'console.log(Deno.env.toObject())'",
    "deno eval 'console.log(Deno.env.get(\"X_TOKEN\"))'",
    "python3 -c 'print(os.environ.copy())'",
    "python3 -c 'print(*os.environ.items())'",
    "python3 -c 'print(dict(os.environ))'",
    "python3 -c 'print(list(os.environ.items()))'",
    "python3 -c 'import json,os;print(json.dumps(dict(os.environ)))'",
    "python3 -c 'import os\nfor k,v in os.environ.items(): print(k,v)'",
    "python3 -c 'print(os.environ)'",
    "python3 -c 'print(os.environ[\"BETTER_AUTH_SECRET\"])'",
    "python3 -c 'print(os.environ.get(\"X_API_KEY\"))'",
    "node -e 'console.log(JSON.stringify({...process.env}))'",
    "node -e 'console.log(Object.entries(process.env))'",
    "node -e 'console.log({...process.env})'",
    "node -e 'console.log(process.env)'",
    "node -e 'console.log(process.env.DATABASE_URL)'",
    "ruby -e 'puts ENV.to_h'",
    "ruby -e 'p ENV'",
    "ruby -e 'ENV.each { |k, v| puts k }'",
    "ruby -e 'puts ENV.inspect'",
    "ruby -e 'puts ENV[\"X_SECRET\"]'",
    "ruby -e 'puts ENV.fetch(\"X_TOKEN\")'",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "python3 -c 'import os; print(os.environ[\"HOME\"])'",
    "python3 -c 'print(os.environ.get(\"HOME\"))'",
    "python3 -c 'subprocess.run([\"ls\"], env=os.environ)'",
    "python3 -c 'print(os.environ[\"NODE_ENV\"])'",
    "node -e 'console.log(process.env.NODE_ENV)'",
    "node -e 'spawn(\"ls\", {env: process.env})'",
    "node -e 'connect(process.env)'",
    // a call whose name merely STARTS with a sink letter is no sink (corpus: three TS snippets in a python heredoc)
    "node -e 'partnerAccessAvailability(process.env)'",
    "node -e 'parseMode(process.env)'",
    "node -e 'pickConfig(process.env)'",
    "node -e 'writer(process.env)'",
    "python3 -c 'printer(os.environ)'",
    "node -e 'console.log(process.env.HOME)'",
    "bun -e 'console.log(Bun.env.NODE_ENV)'",
    "perl -e 'print $ENV{HOME}'",
    "awk 'BEGIN{print ENVIRON[\"HOME\"]}'",
    "ruby -e 'puts ENV[\"HOME\"]'",
    "deno eval 'console.log(Deno.env.get(\"HOME\"))'",
    "node -e 'console.log(1)'",
    "python3 -c 'print(1)'",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toMatch(/^(allow|ask)$/);
    expect(d(cmd), cmd).not.toBe("deny");
  });

  it("environmentLeak: dump, secret or neither", () => {
    expect(environmentLeak("print(os.environ)")).toBe("dump");
    expect(environmentLeak("print(os.environ['X_TOKEN'])")).toBe("secret");
    expect(environmentLeak("print(os.environ['HOME'])")).toBeNull();
    expect(environmentLeak("env")).toBeNull();
    expect(environmentLeak("env", "jq")).toBe("dump");
    expect(environmentLeak("env.HOME", "jq")).toBeNull();
    expect(environmentLeak("$ENV.X_KEY", "jq")).toBe("secret");
  });
});
