/**
 * Wave 10, B1-B3: the two grammars of `db-uri.ts`, as libpq reads them. The unit tests pin the grammar; the differential
 * test asks the REAL libpq (`pg_isready -d STRING`) which host it would connect to, when the PostgreSQL 16 client programs
 * are installed. Every string in it names only loopback addresses (127.0.0.1 plays "the real host", `localhost` the decoy:
 * libpq prints the host as it was written) and port 1, a closed local port: no non-local host is ever contacted. Wave 11
 * (R8-CR-12): the real host was 127.0.0.2, which macOS does not alias: each probe then waited out pg_isready's 1 s connect
 * timeout and three of them failed the 5 s test limit under load. 127.0.0.1 is refused at once; the program is looked up on
 * PATH and in the package manager's directories, and a test timeout of its own bounds the probes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConninfo, uriReadings } from "../harness/db-uri";
import { findBinary } from "./helpers/record-pg-options";
import { scrubbedToolEnv } from "./helpers/scrubbed-env";

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

  it("a URL parser takes the userinfo to the LAST @ of an authority that a ? or # ends (wave 11: kills indexOf for lastIndexOf)", () => {
    // libpq reads `b@c` as the host (first @), the MongoDB reading takes `e` (last @ before the first /), a WHATWG URL
    // ends the authority at `?` and takes the host after ITS last @: `c`. With the first @ it would read `b@c` again.
    expect(sections("a@b@c?d@e/x")).toEqual(expect.arrayContaining(["b@c", "e", "c"]));
  });

  it("at most three readings", () => {
    expect(uriReadings("a@b@c?d#e/f?g#h").length).toBeLessThanOrEqual(3);
  });
});

const PG_ISREADY = findBinary("pg_isready");
// Wave 12 (R9-COMP-10): the probe runs with PATH, a scratch HOME and LANG=C, like the recorders: a developer's PGHOSTADDR,
// PGSERVICE or PGPASSFILE (and a service or password file in their home) must not reach libpq. pg_isready does not
// authenticate, and every string below names 127.0.0.1, ::1 or localhost.
const PROBE_HOME = mkdtempSync(join(tmpdir(), "cw-pg-isready-"));
afterAll(() => rmSync(PROBE_HOME, { recursive: true, force: true }));
const PROBE_ENV = scrubbedToolEnv(PROBE_HOME, { PGCONNECT_TIMEOUT: "2" });
const REAL = "127.0.0.1";
const PROBE_TEST_TIMEOUT_MS = 30_000;

describe.skipIf(PG_ISREADY === undefined)(
  "against the real libpq (pg_isready -d, loopback, port 1)",
  () => {
    // The developer's libpq environment, poisoned on purpose: PGHOSTADDR names another loopback address (127.0.0.3, never
    // routed off the machine), which libpq then prints as the host it tries, and a service and a password file that are
    // not there. A probe that inherited this would read 127.0.0.3 in every case below, so each case is also the proof that
    // PROBE_ENV keeps the parent's PG* variables out.
    beforeAll(() => {
      vi.stubEnv("PGHOSTADDR", "127.0.0.3");
      vi.stubEnv("PGSERVICE", "cw-no-such-service");
      vi.stubEnv("PGPASSFILE", join(PROBE_HOME, "no-such-passfile"));
    });
    afterAll(() => {
      vi.unstubAllEnvs();
    });
    /** The host libpq tries, from its `host:port - no response` line. */
    const libpqHost = (conn: string): string | undefined => {
      const run = spawnSync(PG_ISREADY ?? "pg_isready", ["-t", "1", "-d", conn], {
        encoding: "utf8",
        timeout: 10_000,
        cwd: PROBE_HOME,
        env: PROBE_ENV,
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
    it.each(URI_CASES)(
      "the host libpq tries is among the hosts read from %s",
      (uri) => {
        const host = libpqHost(uri);
        expect(host).toBe(REAL);
        const rest = uri.replace(/^postgres(?:ql)?:\/\//, "");
        const read = uriReadings(rest).flatMap((r) => [
          ...r.hostSection.split(",").map((h) => h.replace(/:\d+$/, "")),
          ...r.query.split("&").map((pair) => (pair.startsWith("host=") ? pair.slice(5) : "")),
        ]);
        expect(read).toContain(REAL);
      },
      PROBE_TEST_TIMEOUT_MS,
    );

    const CONNINFO_CASES = [
      `host=localhost\\ x host=${REAL} port=1`,
      `dbname=x\\ y host=${REAL} port=1`,
      `user=a\\ b host=${REAL} port=1`,
      `host = ${REAL} port = 1`,
      `host='${REAL}' port=1`,
      `host=localhost host=${REAL} port=1`,
      `host='a\\'b' host=${REAL} port=1`,
    ];
    it.each(CONNINFO_CASES)(
      "the last host= of %s is the host libpq tries",
      (text) => {
        expect(libpqHost(text)).toBe(REAL);
        const { pairs, error } = parseConninfo(text);
        expect(error).toBeUndefined();
        expect(pairs.filter(([key]) => key === "host").map(([, value]) => value)).toContain(REAL);
      },
      PROBE_TEST_TIMEOUT_MS,
    );
  },
);
