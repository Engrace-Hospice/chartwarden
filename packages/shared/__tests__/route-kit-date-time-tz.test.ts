import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `Date.parse` reads an offset-less date-time as LOCAL time, so the 0001-01-01 / 9999-12-31 bounds of the `date-time`
// route format used to move with the process time zone. A time zone is fixed when the process starts, so each zone
// runs the real validator in its own `bun` process.
const FORMATS_PATH = fileURLToPath(new URL("../src/route-kit/formats.ts", import.meta.url));

const ZONES = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"] as const;

/** [input, storable]: the answer must be the same in every time zone. */
const CASES: readonly (readonly [string, boolean])[] = [
  ["9999-12-31T23:59:59", true],
  ["9999-12-31T23:59:59.999", true],
  ["9999-12-31T24:00:00", false],
  ["0001-01-01T00:00:00", true],
  ["0001-01-01 00:00:00", true],
  ["0001-01-01T00:00", true],
  ["0000-12-31T23:59:59", false],
  ["2026-11-19T14:00", true],
  ["2026-02-30T10:00:00", false],
  // With an offset the instant never depended on the zone; pinned so normalising offset-less text leaves it alone.
  ["0001-01-01T00:00:00Z", true],
  ["0001-01-01T00:00:00+05:00", false],
  ["9999-12-31T23:59:59-05:00", false],
  ["9999-12-31T23:59:59+05:00", true],
];

interface Probe {
  readonly utcOffsetMinutes: number;
  readonly results: readonly boolean[];
}

function probeIn(zone: string): Probe {
  const script = [
    `import { ROUTE_FORMATS } from ${JSON.stringify(FORMATS_PATH)};`,
    `const check = ROUTE_FORMATS["date-time"];`,
    `const inputs = ${JSON.stringify(CASES.map(([input]) => input))};`,
    `console.log(JSON.stringify({ utcOffsetMinutes: new Date(2026, 5, 1).getTimezoneOffset(), results: inputs.map((i) => check(i)) }));`,
  ].join("\n");
  const run = spawnSync("bun", ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: zone },
  });
  if (run.status !== 0) throw new Error(`bun probe failed in ${zone}: ${run.stderr}`);
  return JSON.parse(run.stdout) as Probe;
}

describe("date-time route format is independent of the process time zone", () => {
  const expected = CASES.map(([, storable]) => storable);

  it.each(ZONES)("accepts and refuses the same offset-less values in %s", (zone) => {
    const probe = probeIn(zone);
    expect(probe.results).toEqual(expected);
  });

  it("really ran in different zones", () => {
    const offsets = new Set(ZONES.map((zone) => probeIn(zone).utcOffsetMinutes));
    expect(offsets.size).toBe(ZONES.length);
  });
});
