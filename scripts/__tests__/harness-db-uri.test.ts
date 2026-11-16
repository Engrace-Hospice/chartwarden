/**
 * Wave 10, B1-B3: the two grammars of `db-uri.ts`, as libpq reads them. The unit tests pin the grammar; the differential
 * test asks the REAL libpq (`pg_isready -d STRING`) which host it would connect to, when the PostgreSQL 16 client programs
 * are installed. Every string in it names only loopback addresses (127.0.0.2 plays "the real host", `localhost` the decoy)
 * and port 1, a closed local port: no non-local host is ever contacted.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConninfo, uriReadings } from "../harness/db-uri";

describe("parseConninfo: libpq's conninfo_parse", () => {
  it.each([
    [
      "host=a port=1",
      [
        ["host", "a"],
        ["port", "1"],
      ],
    ],
    [
      "host = a  port =  1",
      [
        ["host", "a"],
        ["port", "1"],
      ],
    ],
    [
      "host='a b' port=1",
      [
        ["host", "a b"],
        ["port", "1"],
      ],
    ],
    ["host=a\\ b", [["host", "a b"]]],
    ["host=a\\\\b", [["host", "a\\b"]]],
    ["host='a\\'b'", [["host", "a'b"]]],
    ["host='a\\\\b'", [["host", "a\\b"]]],
    ["  host=a  ", [["host", "a"]]],
    ["HOST=a", [["host", "a"]]],
    ["host=", [["host", ""]]],
    [
      "host='' port=1",
      [
        ["host", ""],
        ["port", "1"],
      ],
    ],
    ["", []],
  ] as const)("%s", (text, pairs) => {
    expect(parseConninfo(text)).toEqual({ pairs });
  });

  it.each([
    ["host=a stray", "missing-equals"],
    ["host", "missing-equals"],
    ["host a", "missing-equals"],
    ["host='open", "open-quote"],
    ["host='a\\'", "open-quote"],
  ] as const)("%s is refused by libpq", (text, error) => {
    expect(parseConninfo(text).error).toBe(error);
  });
});

describe("uriReadings: the userinfo ends at the first @ before the first /", () => {
  const sections = (rest: string): string[] => uriReadings(rest).map((r) => r.hostSection);
  const queries = (rest: string): string[] => uriReadings(rest).map((r) => r.query);

  it("reads an ordinary URI", () => {
    expect(uriReadings("u:p@localhost:5433/db?sslmode=disable")).toEqual([
      { hostSection: "localhost:5433", query: "sslmode=disable" },
    ]);
    expect(uriReadings("/db?host=/var/run/postgresql")).toEqual([
      { hostSection: "", query: "host=/var/run/postgresql" },
    ]);
  });

  it("a ? or # in the userinfo does not end the authority", () => {
    expect(sections("localhost?@h2/db")).toContain("h2");
    expect(sections("localhost#@h2/db")).toContain("h2");
    expect(sections("localhost?x=1@h2/db")).toContain("h2");
  });

  it("a URL parser that ends the authority at ? or # is read too", () => {
    expect(sections("h1?@localhost/db")).toContain("h1");
    expect(sections("h1#@localhost/db")).toContain("h1");
  });

  it("# is not special: the query after it is still the query", () => {
    expect(queries("localhost/db#?host=h2")).toContain("host=h2");
    expect(queries("localhost#x?host=h2")).toContain("host=h2");
  });

  it("the first and the last @ are both read when the userinfo holds one", () => {
    expect(sections("u:p@w@localhost/db")).toEqual(
      expect.arrayContaining(["w@localhost", "localhost"]),
    );
  });

  it("at most three readings", () => {
    expect(uriReadings("a@b@c?d#e/f?g#h").length).toBeLessThanOrEqual(3);
  });
});

const PG_ISREADY = "/opt/homebrew/opt/postgresql@16/bin/pg_isready";
const REAL = "127.0.0.2";

describe.skipIf(!existsSync(PG_ISREADY))(
  "against the real libpq (pg_isready -d, loopback, port 1)",
  () => {
    /** The host libpq tries, from its `host:port - no response` line. */
    const libpqHost = (conn: string): string | undefined => {
      const run = spawnSync(PG_ISREADY, ["-t", "1", "-d", conn], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return /^(\S+):\d+ - /.exec(`${run.stdout}${run.stderr}`.trim())?.[1];
    };
    const URI_CASES = [
      `postgres://localhost?@${REAL}:1/db`,
      `postgres://localhost#@${REAL}:1/db`,
      `postgres://localhost?x=1@${REAL}:1/db`,
      `postgres://localhost/db#?host=${REAL}&port=1`,
      `postgres://localhost#x?host=${REAL}&port=1`,
      `postgres://localhost:1/db?host=${REAL}`,
      `postgres://u:p@${REAL}:1/db?sslmode=disable`,
      `postgres:///db?host=${REAL}&port=1`,
      `postgresql://u@${REAL}:1/db#frag`,
      `postgres://[::1]:1/db?host=${REAL}`,
    ];
    it.each(URI_CASES)("the host libpq tries is among the hosts read from %s", (uri) => {
      const host = libpqHost(uri);
      expect(host).toBe(REAL);
      const rest = uri.replace(/^postgres(?:ql)?:\/\//, "");
      const read = uriReadings(rest).flatMap((r) => [
        ...r.hostSection.split(",").map((h) => h.replace(/:\d+$/, "")),
        ...r.query.split("&").map((pair) => (pair.startsWith("host=") ? pair.slice(5) : "")),
      ]);
      expect(read).toContain(REAL);
    });

    const CONNINFO_CASES = [
      `host=localhost\\ x host=${REAL} port=1`,
      `dbname=x\\ y host=${REAL} port=1`,
      `user=a\\ b host=${REAL} port=1`,
      `host = ${REAL} port = 1`,
      `host='${REAL}' port=1`,
      `host=localhost host=${REAL} port=1`,
      `host='a\\'b' host=${REAL} port=1`,
    ];
    it.each(CONNINFO_CASES)("the last host= of %s is the host libpq tries", (text) => {
      expect(libpqHost(text)).toBe(REAL);
      const { pairs, error } = parseConninfo(text);
      expect(error).toBeUndefined();
      expect(pairs.filter(([key]) => key === "host").map(([, value]) => value)).toContain(REAL);
    });
  },
);
