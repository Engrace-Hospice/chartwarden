// GAP-043 - the expected-quiet-window parser/evaluator (DST-correct through Intl) and the TCP probe against a REAL
// ephemeral socket (open port, closed port, unresolvable host). No mocks of net.
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { inQuietWindow, inStoredQuietWindow, parseQuietWindows } from "../listener/quiet-window";
import { probeTcpPort } from "../listener/tcp-probe";

const weekdayNight = {
  days: [1, 2, 3, 4, 5],
  start: "20:00",
  end: "06:00",
  tz: "America/New_York",
};

describe("parseQuietWindows", () => {
  it("treats null/undefined as none and accepts a well-formed window", () => {
    expect(parseQuietWindows(null)).toEqual({ ok: true, windows: [] });
    expect(parseQuietWindows(undefined)).toEqual({ ok: true, windows: [] });
    expect(parseQuietWindows([weekdayNight])).toEqual({ ok: true, windows: [weekdayNight] });
  });
  it.each([
    ["a non-array", { not: "an array" }],
    ["an unknown key", [{ ...weekdayNight, extra: 1 }]],
    ["no days", [{ ...weekdayNight, days: [] }]],
    ["a bad weekday", [{ ...weekdayNight, days: [7] }]],
    ["duplicate days", [{ ...weekdayNight, days: [1, 1] }]],
    ["a malformed time", [{ ...weekdayNight, start: "8pm" }]],
    ["an out-of-range hour", [{ ...weekdayNight, end: "24:00" }]],
    ["equal start and end", [{ ...weekdayNight, start: "06:00", end: "06:00" }]],
    ["an unknown time zone", [{ ...weekdayNight, tz: "Mars/Olympus" }]],
    ["more than 14 windows", Array.from({ length: 15 }, () => weekdayNight)],
  ])("refuses %s", (_label, raw) => {
    expect(parseQuietWindows(raw).ok).toBe(false);
  });
});

describe("inQuietWindow", () => {
  const parse = (w: unknown) => {
    const parsed = parseQuietWindows([w]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.windows;
  };
  it("a same-day window is half-open [start, end) on its listed weekdays only", () => {
    const windows = parse({ days: [6], start: "12:00", end: "14:00", tz: "UTC" }); // Saturday
    expect(inQuietWindow(windows, new Date("2026-10-10T11:59:00Z"))).toBe(false);
    expect(inQuietWindow(windows, new Date("2026-10-10T12:00:00Z"))).toBe(true);
    expect(inQuietWindow(windows, new Date("2026-10-10T13:59:00Z"))).toBe(true);
    expect(inQuietWindow(windows, new Date("2026-10-10T14:00:00Z"))).toBe(false);
    // the same clock time on a Friday and a Sunday is not quiet
    expect(inQuietWindow(windows, new Date("2026-10-09T13:00:00Z"))).toBe(false);
    expect(inQuietWindow(windows, new Date("2026-10-11T13:00:00Z"))).toBe(false);
  });
  it("an overnight window runs into the NEXT weekday, which need not be listed", () => {
    const windows = parse(weekdayNight); // Mon-Fri 20:00 -> 06:00 New York (EDT in October = UTC-4)
    // Friday 22:00 EDT = Saturday 02:00 UTC -> inside (Friday started it)
    expect(inQuietWindow(windows, new Date("2026-10-10T02:00:00Z"))).toBe(true);
    // Saturday 03:00 EDT = 07:00 UTC -> still inside (Friday's window runs to 06:00 Saturday)
    expect(inQuietWindow(windows, new Date("2026-10-10T07:00:00Z"))).toBe(true);
    // Saturday 07:00 EDT = 11:00 UTC -> outside
    expect(inQuietWindow(windows, new Date("2026-10-10T11:00:00Z"))).toBe(false);
    // Saturday 22:00 EDT -> outside (Saturday does not start a window)
    expect(inQuietWindow(windows, new Date("2026-10-11T02:00:00Z"))).toBe(false);
    // Monday 03:00 EDT = 07:00 UTC -> outside (Sunday does not start a window)
    expect(inQuietWindow(windows, new Date("2026-10-12T07:00:00Z"))).toBe(false);
  });
  it("follows the wall clock across a DST change (no manual offsets)", () => {
    const windows = parse({
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "01:00",
      end: "02:00",
      tz: "America/New_York",
    });
    // 2026-03-08: spring forward at 02:00 EST -> 03:00 EDT. 01:30 EST is 06:30 UTC and is inside.
    expect(inQuietWindow(windows, new Date("2026-03-08T06:30:00Z"))).toBe(true);
    // 07:30 UTC is 03:30 EDT: outside, and the 01:00-02:00 hour is not "skipped forward" into it.
    expect(inQuietWindow(windows, new Date("2026-03-08T07:30:00Z"))).toBe(false);
    // 2026-10-31 (EDT) 01:30 EDT = 05:30 UTC is inside; 2026-11-01 01:30 EST = 06:30 UTC is inside again.
    expect(inQuietWindow(windows, new Date("2026-10-31T05:30:00Z"))).toBe(true);
    expect(inQuietWindow(windows, new Date("2026-11-01T06:30:00Z"))).toBe(true);
  });
  it("a stored value that no longer parses is NOT quiet (fail toward alerting)", () => {
    expect(
      inStoredQuietWindow([{ days: [1], start: "bad", end: "06:00", tz: "UTC" }], new Date()),
    ).toBe(false);
    expect(inStoredQuietWindow("garbage", new Date())).toBe(false);
    expect(inStoredQuietWindow(null, new Date())).toBe(false);
  });
});

describe("probeTcpPort (real sockets)", () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });
  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      const server = net.createServer((socket) => socket.destroy());
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });

  it("is true for a port that accepts connections", async () => {
    expect(await probeTcpPort("127.0.0.1", await listen())).toBe(true);
  });
  it("is false for a port nobody listens on", async () => {
    const port = await listen();
    await new Promise<void>((resolve) => servers[0]?.close(() => resolve()));
    servers.length = 0;
    expect(await probeTcpPort("127.0.0.1", port)).toBe(false);
  });
  it("is false (never rejects) for an unresolvable host", async () => {
    expect(await probeTcpPort("no-such-host.invalid", 2575, 1_500)).toBe(false);
  });
  it("is false when nothing completes the connect before the timeout", async () => {
    // 192.0.2.0/24 (TEST-NET-1) is reserved and unroutable: the SYN goes nowhere (or is refused at once on some
    // networks) - either way the probe must settle false inside its own timeout rather than hang.
    const started = Date.now();
    expect(await probeTcpPort("192.0.2.1", 2575, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
