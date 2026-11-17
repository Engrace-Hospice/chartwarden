/**
 * Wave 10, B4: the option tables of the PostgreSQL 16 client programs and redis-cli 8 (`db-target-flags.ts`) are read from
 * their real `--help`. This test re-reads that help when the programs are installed (and are the version the data was read
 * from) and fails on a difference, so a flag that is listed as a value option, or the reverse, is found by the machine and
 * not by a reviewer. It runs `--help` and `--version` only: nothing connects.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGET_CLIENTS } from "../harness/db-target-clients";
import { VERIFIED_OPTIONS } from "../harness/db-target-flags";

const PG_BIN = "/opt/homebrew/opt/postgresql@16/bin";
const REDIS_BIN = "/opt/homebrew/bin";
const binaryOf = (name: string): string =>
  name.startsWith("redis-") ? `${REDIS_BIN}/${name}` : `${PG_BIN}/${name}`;

const run = (binary: string, flag: string): string => {
  const result = spawnSync(binary, [flag], { encoding: "utf8", timeout: 10_000 });
  return `${result.stdout}${result.stderr}`;
};

interface ParsedHelp {
  readonly valueShort: Set<string>;
  readonly valueLong: Set<string>;
  readonly flagShort: Set<string>;
  readonly flagLong: Set<string>;
}

/** One help line: `  -c, --command=COMMAND  text`, `      --csv   text`, `  -h <hostname>  text`. */
function parseHelp(text: string): ParsedHelp {
  const parsed: ParsedHelp = {
    valueShort: new Set(),
    valueLong: new Set(),
    flagShort: new Set(),
    flagLong: new Set(),
  };
  for (const line of text.split("\n")) {
    if (!/^\s+-/.test(line)) continue;
    const head = line.trim().split(/\s{2,}/)[0] ?? "";
    const hasValue =
      /=|\s[A-Z<[]/.test(head.replace(/^-[A-Za-z0-9?],?\s*/, "")) ||
      /^-[A-Za-z0-9]\s+[<A-Z]/.test(head) ||
      /^-[A-Za-z0-9]\s*=/.test(head);
    for (const part of head.split(/,\s*/)) {
      const short = /^-([A-Za-z0-9])\b/.exec(part.trim())?.[1];
      const long = /^--([A-Za-z0-9_-]+)/.exec(part.trim())?.[1];
      if (short !== undefined) (hasValue ? parsed.valueShort : parsed.flagShort).add(short);
      if (long !== undefined) (hasValue ? parsed.valueLong : parsed.flagLong).add(long);
    }
  }
  return parsed;
}

const versionMatches = (name: string): boolean => {
  const out = run(binaryOf(name), "--version");
  return name.startsWith("redis-") ? /\b8\.\d+\.\d+/.test(out) : /\b16\.\d+/.test(out);
};

describe("the option tables agree with the real clients' --help", () => {
  for (const name of VERIFIED_OPTIONS.keys()) {
    const installed = existsSync(binaryOf(name)) && versionMatches(name);
    it.skipIf(!installed)(
      `${name}: no flag is a value option and no value option is a flag`,
      () => {
        const help = parseHelp(run(binaryOf(name), "--help"));
        const spec = TARGET_CLIENTS.get(name);
        expect(spec).toBeDefined();
        if (spec === undefined) return;
        const tableValueLong = new Set([
          ...spec.valueLong,
          ...spec.hostLong,
          ...spec.stringLong,
          ...(spec.aliasLong ?? []),
          ...(spec.indirectLong ?? []),
        ]);
        const tableValueShort = new Set(
          (
            spec.valueShort +
            (spec.hostShort ?? "") +
            (spec.stringShort ?? "") +
            (spec.aliasShort ?? "")
          ).split(""),
        );
        const realOnlyFlag = (long: string): boolean =>
          help.flagLong.has(long) && !help.valueLong.has(long);
        const realOnlyShortFlag = (c: string): boolean =>
          help.flagShort.has(c) && !help.valueShort.has(c);
        expect(
          [...tableValueLong].filter(realOnlyFlag),
          `${name}: flags the table reads as value options`,
        ).toEqual([]);
        expect(
          [...tableValueShort].filter(realOnlyShortFlag),
          `${name}: short flags the table reads as value options`,
        ).toEqual([]);
        for (const flag of spec.flagLong ?? []) {
          expect(
            help.valueLong.has(flag) && !help.flagLong.has(flag),
            `${name}: ${flag} is a value option`,
          ).toBe(false);
        }
        for (const real of help.valueLong) {
          if (real === "help") continue;
          expect(
            tableValueLong.has(real),
            `${name}: --${real} takes a value and the table does not say so`,
          ).toBe(true);
        }
      },
    );
  }

  it("the data file lists the same options the table reads", () => {
    for (const [name, real] of VERIFIED_OPTIONS) {
      const spec = TARGET_CLIENTS.get(name);
      for (const letter of real.valueShort)
        expect(spec?.valueShort, `${name} -${letter}`).toContain(letter);
      for (const flag of real.flagLong) expect(spec?.flagLong, `${name} --${flag}`).toContain(flag);
    }
  });
});
