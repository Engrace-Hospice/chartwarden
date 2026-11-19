// Visit-note closure clock stamping (M8, ADR-0113): the pure clamp + org-local day start, the idempotent
// `stampClockIfNull` write, and the consumer on `m17.visit.started`. The UPDATE ... WHERE semantics and RLS
// need a real database (the live suite owns them); here the WHERE predicate is serialised and pinned so a
// weakened guard cannot slip through, and the consumer is driven over the recording Drizzle fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  clampClockStart,
  clockStampWhere,
  isValidServiceDate,
  localDayStart,
  stampClockIfNull,
} from "../src/modules/08-encounters/closure/clock-stamp";
import { buildM8VisitStartedNoteClockConsumer } from "../src/modules/08-encounters/outbox-consumers/m17-visit-started-note-clock";
import { type FakeRows, fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER = "22222222-2222-4222-8222-222222222222";
const VISIT = "33333333-3333-4333-8333-333333333333";
const SERVICE_DATE = "2026-11-17";
// America/New_York is EST (UTC-5) on 2026-11-17: local midnight is 05:00Z.
const LOCAL_START = new Date("2026-11-17T05:00:00.000Z");
const DELIVERED = new Date("2026-11-17T15:00:00.000Z");

describe("clampClockStart", () => {
  it("keeps a candidate inside the window unchanged", () => {
    const candidate = new Date("2026-11-17T14:30:00.000Z");
    expect(clampClockStart(candidate, LOCAL_START, DELIVERED).toISOString()).toBe(
      candidate.toISOString(),
    );
  });

  it("keeps a candidate exactly on either boundary", () => {
    expect(clampClockStart(LOCAL_START, LOCAL_START, DELIVERED)).toEqual(LOCAL_START);
    expect(clampClockStart(DELIVERED, LOCAL_START, DELIVERED)).toEqual(DELIVERED);
  });

  it("raises a device clock that ran behind to the org-local start of the service date", () => {
    const behind = new Date("2026-11-16T22:00:00.000Z");
    expect(clampClockStart(behind, LOCAL_START, DELIVERED)).toEqual(LOCAL_START);
  });

  it("lowers a device clock that ran ahead to the delivery time", () => {
    const ahead = new Date("2026-11-17T18:00:00.000Z");
    expect(clampClockStart(ahead, LOCAL_START, DELIVERED)).toEqual(DELIVERED);
  });

  it("lets the delivery time win when the window is inverted (service date after delivery)", () => {
    const tomorrowStart = new Date("2026-11-18T05:00:00.000Z");
    const candidate = new Date("2026-11-17T14:00:00.000Z");
    expect(clampClockStart(candidate, tomorrowStart, DELIVERED)).toEqual(DELIVERED);
  });

  it("returns a copy and never mutates its inputs", () => {
    const candidate = new Date("2026-11-17T14:30:00.000Z");
    const before = candidate.getTime();
    const result = clampClockStart(candidate, LOCAL_START, DELIVERED);
    expect(result).not.toBe(candidate);
    expect(candidate.getTime()).toBe(before);
  });

  it("rejects an invalid instant", () => {
    const bad = new Date("not a date");
    expect(() => clampClockStart(bad, LOCAL_START, DELIVERED)).toThrow(RangeError);
    expect(() => clampClockStart(DELIVERED, bad, DELIVERED)).toThrow(RangeError);
    expect(() => clampClockStart(DELIVERED, LOCAL_START, bad)).toThrow(RangeError);
  });
});

describe("localDayStart", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["America/New_York", "2026-11-17", "2026-11-17T05:00:00.000Z"],
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z"], // spring-forward day: midnight is still EST
    ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z"], // fall-back day: midnight is still EDT
    ["UTC", "2026-11-17", "2026-11-17T00:00:00.000Z"],
    ["Pacific/Auckland", "2026-11-17", "2026-11-16T11:00:00.000Z"], // NZDT, UTC+13
    ["Asia/Kolkata", "2026-11-17", "2026-11-16T18:30:00.000Z"], // UTC+5:30
    ["Pacific/Kiritimati", "2026-11-17", "2026-11-16T10:00:00.000Z"], // UTC+14, the earliest zone
    ["Etc/GMT+12", "2026-11-17", "2026-11-17T12:00:00.000Z"], // UTC-12, the latest zone
  ];

  it.each(cases)("%s on %s starts at %s", (timeZone, serviceDate, expectedIso) => {
    expect(localDayStart(serviceDate, timeZone).toISOString()).toBe(expectedIso);
  });

  it("rejects a malformed service date", () => {
    expect(() => localDayStart("17/11/2026", "UTC")).toThrow(RangeError);
    expect(() => localDayStart("2026-13-40", "UTC")).toThrow(RangeError);
  });
});

describe("isValidServiceDate (the one rule a pre-check shares with localDayStart)", () => {
  // `Date.UTC` maps a year of 0-99 to 19xx and rolls 02-30 over to March: both must be refused, exactly as localDayStart refuses them
  const dates = [
    "2026-11-17",
    "2028-02-29",
    "2026-02-30",
    "2026-13-01",
    "0050-01-01",
    "17/11/2026",
    "",
  ];
  it.each(dates)("agrees with localDayStart about %j", (value) => {
    const accepted = (() => {
      try {
        localDayStart(value, "UTC");
        return true;
      } catch {
        return false;
      }
    })();
    expect(isValidServiceDate(value)).toBe(accepted);
  });

  it("accepts a real date and refuses a year Date.UTC would map to 19xx", () => {
    expect(isValidServiceDate("2026-11-17")).toBe(true);
    expect(isValidServiceDate("0050-01-01")).toBe(false);
  });
});

describe("clockStampWhere (the UPDATE predicate)", () => {
  const dialect = new PgDialect();
  const render = (input: Parameters<typeof clockStampWhere>[0]) => {
    const { sql, params } = dialect.sqlToQuery(clockStampWhere(input));
    return { sql: sql.toLowerCase(), params };
  };

  it("is org-scoped, never overwrites a clock and only touches open notes (by encounter id)", () => {
    const { sql, params } = render({ orgId: ORG, encounterId: ENCOUNTER });
    expect(sql).toContain('"encounter"."organization_id" = $1');
    expect(sql).toContain('"encounter"."id" = $2');
    expect(sql).toContain('"encounter"."clock_started_at" is null');
    expect(sql).toMatch(/"encounter"\."status" in \(\$3, \$4\)/);
    expect(params).toEqual([ORG, ENCOUNTER, "draft", "finalized"]);
  });

  it("keys on visit_id when stamping from the M17 visit start", () => {
    const { sql, params } = render({ orgId: ORG, visitId: VISIT });
    expect(sql).toContain('"encounter"."visit_id" = $2');
    expect(sql).not.toContain('"encounter"."id" = ');
    expect(params).toEqual([ORG, VISIT, "draft", "finalized"]);
  });
});

describe("stampClockIfNull", () => {
  const at = new Date("2026-11-17T14:00:00.000Z");
  const stamp = (db: DbClient, input: Parameters<typeof stampClockIfNull>[1]) =>
    withOrgContext(db as never, { organizationId: ORG, userId: "" }, (tx) =>
      stampClockIfNull(tx as unknown as DbClient, input),
    );

  it("sets both clock columns together and reports a stamp", async () => {
    const { db, rec } = fakeDb({ encounter: [{ id: ENCOUNTER }] });
    const stamped = await stamp(db, {
      orgId: ORG,
      encounterId: ENCOUNTER,
      at,
      source: "draft_opened",
    });
    expect(stamped).toBe(true);
    expect(rec.updates).toEqual([
      { table: "encounter", set: { clockStartedAt: at, clockStartSource: "draft_opened" } },
    ]);
  });

  it("reports false (and throws nothing) when the row was already clocked, closed or absent", async () => {
    const { db } = fakeDb({ encounter: [] });
    const stamped = await stamp(db, {
      orgId: ORG,
      visitId: VISIT,
      at,
      source: "visit_started",
    });
    expect(stamped).toBe(false);
  });

  it("does not touch version or updated_at (the author's optimistic lock is not ours to bump)", async () => {
    const { db, rec } = fakeDb({ encounter: [{ id: ENCOUNTER }] });
    await stamp(db, { orgId: ORG, encounterId: ENCOUNTER, at, source: "draft_opened" });
    expect(Object.keys(rec.updates[0]?.set ?? {}).sort()).toEqual([
      "clockStartSource",
      "clockStartedAt",
    ]);
  });
});

describe("m8 visit-started note-clock consumer", () => {
  const DELIVERED_AT = new Date("2026-11-17T15:00:00.000Z");
  const payload = (over: Record<string, unknown> = {}) => ({
    visitId: VISIT,
    startedAt: "2026-11-17T14:00:00.000Z",
    evvBracketState: "evv_present",
    ...over,
  });
  const event = (p: unknown, createdAt: Date = DELIVERED_AT) => ({
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: ORG,
    eventType: "m17.visit.started",
    aggregateKind: "visit",
    aggregateId: VISIT,
    payload: p,
    attemptCount: 0,
    createdAt,
  });
  const openRow = (over: Record<string, unknown> = {}) => ({
    id: ENCOUNTER,
    serviceDate: SERVICE_DATE,
    status: "draft",
    clockStartedAt: null,
    ...over,
  });
  const build = (rows: Record<string, FakeRows>) => {
    const { db, rec } = fakeDb({ organization: [], ...rows });
    const consumer = buildM8VisitStartedNoteClockConsumer({ db });
    return { consumer, rec };
  };

  it("is the m8 consumer of m17.visit.started", () => {
    const { consumer } = build({});
    expect(consumer.consumerModule).toBe("m8");
    expect(consumer.eventTypes).toEqual(["m17.visit.started"]);
  });

  it("stamps evv_check_in with the EVV capture instant when EVV bracketed the visit", async () => {
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload()));
    expect(rec.updates).toHaveLength(1);
    expect(rec.updates[0]?.set).toEqual({
      clockStartedAt: new Date("2026-11-17T14:00:00.000Z"),
      clockStartSource: "evv_check_in",
    });
  });

  it("stamps visit_started for a self-attested start (no EVV bracket)", async () => {
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload({ evvBracketState: "evv_missing_documented" })));
    expect(rec.updates[0]?.set).toMatchObject({ clockStartSource: "visit_started" });
  });

  it("clamps a device clock in the future to the event's server-side creation time", async () => {
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload({ startedAt: "2026-11-17T21:00:00.000Z" })));
    expect(rec.updates[0]?.set).toMatchObject({ clockStartedAt: DELIVERED_AT });
  });

  it("bounds the instant by when the event was CREATED, not when it is delivered: a late delivery cannot widen the window", async () => {
    // M17 recorded the start at 14:30; the consumer runs hours later (a backlog) with the device claiming 16:00.
    const createdAt = new Date("2026-11-17T14:30:00.000Z");
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload({ startedAt: "2026-11-17T16:00:00.000Z" }), createdAt));
    expect(rec.updates[0]?.set).toMatchObject({ clockStartedAt: createdAt });
  });

  it("keeps a device instant that is not after the event's creation time", async () => {
    const createdAt = new Date("2026-11-17T14:30:00.000Z");
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload({ startedAt: "2026-11-17T14:00:00.000Z" }), createdAt));
    expect(rec.updates[0]?.set).toMatchObject({
      clockStartedAt: new Date("2026-11-17T14:00:00.000Z"),
    });
  });

  it("clamps a device clock before the org-local service date to that day's local start", async () => {
    const { consumer, rec } = build({ encounter: [openRow()] });
    await consumer.handle(event(payload({ startedAt: "2026-11-10T14:00:00.000Z" })));
    expect(rec.updates[0]?.set).toMatchObject({ clockStartedAt: LOCAL_START });
  });

  it("reads the service date in the org's own timezone", async () => {
    const { consumer, rec } = build({
      organization: [{ settings: { org_timezone: "Pacific/Auckland" } }],
      encounter: [openRow()],
    });
    await consumer.handle(event(payload({ startedAt: "2026-11-10T14:00:00.000Z" })));
    expect(rec.updates[0]?.set).toMatchObject({
      clockStartedAt: new Date("2026-11-16T11:00:00.000Z"),
    });
  });

  it("does nothing on a second delivery once the note already has a clock", async () => {
    const { consumer, rec } = build({
      encounter: [openRow({ clockStartedAt: new Date("2026-11-17T13:00:00.000Z") })],
    });
    await consumer.handle(event(payload()));
    expect(rec.updates).toEqual([]);
  });

  it("is harmless when a concurrent stamp wins the UPDATE (zero rows returned)", async () => {
    const { consumer } = build({
      encounter: (op) => (op === "select" ? [openRow()] : []),
    });
    await expect(consumer.handle(event(payload()))).resolves.toBeUndefined();
  });

  it.each(["signed", "cosign_pending", "cosigned", "voided"])(
    "leaves a %s encounter untouched",
    async (status) => {
      const { consumer, rec } = build({ encounter: [openRow({ status })] });
      await consumer.handle(event(payload()));
      expect(rec.updates).toEqual([]);
    },
  );

  it("stamps a finalized (still open) note", async () => {
    const { consumer, rec } = build({ encounter: [openRow({ status: "finalized" })] });
    await consumer.handle(event(payload()));
    expect(rec.updates).toHaveLength(1);
  });

  it("is a no-op when the visit has no encounter (never seeded)", async () => {
    const { consumer, rec } = build({ encounter: [] });
    await consumer.handle(event(payload()));
    expect(rec.updates).toEqual([]);
  });

  it.each([
    ["a non-object payload", "nope"],
    ["a missing visitId", { startedAt: "2026-11-17T14:00:00.000Z", evvBracketState: "x" }],
    ["an unparseable startedAt", payload({ startedAt: "yesterday-ish" })],
  ])("rejects %s so the delivery retries instead of silently dropping", async (_name, bad) => {
    const { consumer } = build({ encounter: [openRow()] });
    await expect(consumer.handle(event(bad))).rejects.toThrow(/m8\.stamp-note-clock/);
  });
});

describe("composition root", () => {
  it("builds the consumer in the boot binding list (bound is not computing)", () => {
    const boot = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(boot).toMatch(/buildM8VisitStartedNoteClockConsumer\(\{\s*db: dbHandle\.db/);
  });
});
