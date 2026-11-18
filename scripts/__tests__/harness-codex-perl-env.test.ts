/**
 * Wave 6, T2(b) (ADV-3): the pinned Codex command starts with `perl`, and perl reads `PERL5OPT`, `PERL5LIB`,
 * `PERLLIB` and `PERL5DB` BEFORE it runs the `-e` body. `PERL5OPT=-Mstrict;BEGIN{exit(0)}` (or a `Cwd.pm` that
 * exits in BEGIN, found through `PERL5LIB`/`PERLLIB`) made the wrapper exit 0 before bun ever ran, and Codex reads
 * exit 0 with no output as ALLOW. The command now runs perl through `env -u PERL5OPT -u PERL5LIB -u PERLLIB -u
 * PERL5DB`. (`perl -T` ignores the variables too, but it then refuses the `exec` of bun: "Insecure $ENV{PATH}".)
 *
 * Every test runs the REAL committed command on a COPY of the guard tree. The OLD command (the committed one without
 * the `env -u …` prefix) is kept as the negative control: it allows under the same poison, which proves the poison
 * works on this machine's perl and that the fix, not the setup, is what denies.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CODEX_HOOK,
  bashPayload,
  guardCopy,
  removeCopies,
  runCodex,
  scratchDir,
} from "./_guard-copy";

afterAll(removeCopies);

const ENV_PREFIX = "env -u PERL5OPT -u PERL5LIB -u PERLLIB -u PERL5DB ";
/** The command as it was before this fix: the same text without the `env -u …` prefix. */
const OLD_HOOK = CODEX_HOOK.replace(ENV_PREFIX, "");

const READS_SECRET = bashPayload("cat apps/backend/.env");
const EVERYDAY = bashPayload("git status --short");

/** A directory holding a `Cwd.pm` that exits 0 in BEGIN, so `use Cwd` ends the wrapper as an allow. */
function poisonedLib(): string {
  const dir = scratchDir("cw-perl-lib-");
  writeFileSync(join(dir, "Cwd.pm"), "package Cwd; BEGIN { exit(0) } 1;\n");
  return dir;
}

describe("the pinned Codex command is immune to perl's library and option variables", () => {
  it("the committed command is the old one behind `env -u` for the four variables", () => {
    expect(CODEX_HOOK.startsWith(`${ENV_PREFIX}perl -e 'alarm 8; `)).toBe(true);
    expect(OLD_HOOK.startsWith("perl -e 'alarm 8; ")).toBe(true);
  });

  it("control: with no poison, the real command denies a secret read and allows an everyday call", () => {
    const dir = guardCopy();
    expect(runCodex(dir, READS_SECRET).decision).toBe("deny");
    expect(runCodex(dir, EVERYDAY).decision).toBe("allow");
    expect(runCodex(dir, READS_SECRET, {}, OLD_HOOK).decision).toBe("deny");
  });

  const poisons: Array<[string, () => Record<string, string>]> = [
    ["PERL5OPT", () => ({ PERL5OPT: "-Mstrict;BEGIN{exit(0)}" })],
    ["PERL5LIB", () => ({ PERL5LIB: poisonedLib() })],
    ["PERLLIB", () => ({ PERLLIB: poisonedLib() })],
  ];

  it.each(poisons)(
    "%s: the OLD command exits 0 before bun runs (the negative control)",
    (_n, env) => {
      const dir = guardCopy();
      const r = runCodex(dir, READS_SECRET, env(), OLD_HOOK);
      expect(r.status).toBe(0);
      expect(r.decision).toBe("allow");
    },
  );

  it.each(poisons)("%s: the committed command still denies the secret read", (_n, env) => {
    const dir = guardCopy();
    const r = runCodex(dir, READS_SECRET, env());
    expect(r.decision).toBe("deny");
  });

  it.each(poisons)("%s: and still allows an everyday call", (_n, env) => {
    const dir = guardCopy();
    expect(runCodex(dir, EVERYDAY, env()).decision).toBe("allow");
  });

  it("PERL5DB is dropped too (it only matters with -d, but a hook must not trust it)", () => {
    const dir = guardCopy();
    const r = runCodex(dir, READS_SECRET, { PERL5DB: "BEGIN{exit(0)}", PERL5OPT: "-d" });
    expect(r.decision).toBe("deny");
  });

  it("an `env` or `perl` that cannot start still fails closed (exit 2)", () => {
    const dir = guardCopy();
    const r = runCodex(dir, EVERYDAY, { PATH: "/nonexistent" });
    expect(r.status).toBe(2);
  });
});
