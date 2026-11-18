/**
 * Wave 13 part B, A6 (round-10 adversarial review): psql runs several backslash commands on one line. Parsing of a command's
 * arguments "stops at the end of the line, or when another unquoted backslash is found" (the psql manual), so `\x\c db user H`
 * is `\x` and then `\c db user H`. `metaCommands` ended a command's arguments at a double backslash only, so the `\c` after `\x`
 * was swallowed into the arguments of `\x` and the reconnect to another host was never read.
 * Words are built from parts so the repo guard does not read this file as a command.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { metaCommands } from "../harness/postgres-commands";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const H = ["prod", "example", "com"].join(".");
const B = "\\";

describe("metaCommands: arguments end at the first unquoted backslash", () => {
  it.each<[string, Array<[string, string]>]>([
    [
      `${B}x${B}c db user ${H}`,
      [
        ["x", ""],
        ["c", `db user ${H}`],
      ],
    ],
    [
      `${B}t${B}c db user ${H}`,
      [
        ["t", ""],
        ["c", `db user ${H}`],
      ],
    ],
    [
      `${B}timing${B}c db user ${H}`,
      [
        ["timing", ""],
        ["c", `db user ${H}`],
      ],
    ],
    [
      `${B}a${B}c db user ${H}`,
      [
        ["a", ""],
        ["c", `db user ${H}`],
      ],
    ],
    [
      `${B}set x 1${B}c db user ${H}`,
      [
        ["set", "x 1"],
        ["c", `db user ${H}`],
      ],
    ],
    [
      `${B}x${B}x${B}x${B}c ${H}`,
      [
        ["x", ""],
        ["x", ""],
        ["x", ""],
        ["c", H],
      ],
    ],
    [
      `${B}x\n${B}c ${H}`,
      [
        ["x", ""],
        ["c", H],
      ],
    ],
    [
      `${B}o X${B}${B} select 1 ${B}g Y`,
      [
        ["o", "X"],
        ["g", "Y"],
      ],
    ],
    // A backslash inside a quoted argument is not a command: single quotes take it as an escape, double and back quotes as text.
    [`${B}echo 'a${B}c b'`, [["echo", `'a${B}c b'`]]],
    [`${B}echo 'it${B}'s ${B}c ${H}'`, [["echo", `'it${B}'s ${B}c ${H}'`]]],
    [
      `${B}echo "a${B}c b" ${B}c ${H}`,
      [
        ["echo", `"a${B}c b"`],
        ["c", H],
      ],
    ],
    [
      `${B}set x 'a${B}'b${B}c ${H}'${B}c db`,
      [
        ["set", `x 'a${B}'b${B}c ${H}'`],
        ["c", "db"],
      ],
    ],
    [`${B}! echo a ${B}c ${H}`, [["!", `echo a ${B}c ${H}`]]],
  ])("metaCommands %j", (text, expected) => {
    expect(metaCommands(text).map((c) => [c.name, c.rest])).toEqual(expected);
  });

  it("reads a 200,000-command single line in linear time", () => {
    const text = `${B}x`.repeat(200_000);
    const started = performance.now();
    expect(metaCommands(text)).toHaveLength(200_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("A6: a reconnect chained behind another backslash command is read", () => {
  it.each([
    `psql <<< '${B}x${B}c db user ${H}'`,
    `psql <<< '${B}t${B}c db user ${H}'`,
    `psql <<< '${B}timing${B}c db user ${H}'`,
    `echo '${B}a${B}c db user ${H}' | psql`,
    `psql -c '${B}x${B}c db user ${H}'`,
    `psql <<< '${B}set x 1${B}c db user ${H}'`,
    `psql -c '${B}x${B}x${B}x${B}c ${H}'`,
    `psql -c '${B}x' -c '${B}timing${B}connect postgresql://${H}/db'`,
    `psql <<< '${B}x${B}c host=${H}'`,
    `pgcli -c '${B}x${B}c db user ${H}'`,
    `usql -c '${B}x${B}c db user ${H}'`,
    // the shell reads two backslashes in a double-quoted word as one
    `psql -c "${B}${B}x${B}${B}c db user ${H}"`,
    // a literal backslash-n is a line break to the shells whose echo reads it
    `echo '${B}x${B}n${B}c db user ${H}' | psql`,
  ])("%s is denied", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});

describe("A6 neighbours: ordinary psql meta-commands stay allowed", () => {
  it.each([
    `psql -c '${B}x' -c 'select 1'`,
    `psql -h localhost -c '${B}timing${B}x'`,
    `psql <<< '${B}c db user localhost'`,
    `psql <<< '${B}x${B}c mydb'`,
    `psql <<< '${B}x${B}c db user 127.0.0.1'`,
    `psql -c '${B}dt'`,
    `psql -c '${B}d+ users'`,
    `psql -c '${B}x${B}dt'`,
    `psql -c '${B}set ON_ERROR_STOP on'`,
    `psql -c "${B}echo 'x${B}c db user ${H}'"`,
    `psql <<< "select '${B}x${B}c db user ${H}'"`,
    `psql -c "select 1; ${B}x"`,
    `psql <<< "${B}set x 'a${B}'b' ${B}timing"`,
    `psql -h localhost -U app -d app -c 'select count(*) from patients'`,
    `psql postgresql://localhost/app -c '${B}x${B}dt'`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
