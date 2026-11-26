// CW-MON-01 follow-up (#1177) — the security review's reader, the SQL it emits per scope (a recording executor, no database). The platform
// lane runs on a BYPASSRLS login that holds no privilege on `audit_event` (migration 1566), so its reads must reach the rows only
// through the three bounded SECURITY DEFINER readers; the org lane still reads its own rows directly under RLS. What only a real
// database can prove (the grants, the bounds, the owner's row-security floor) is proven in m4-security-review.live.test.ts.
// Identifiers are synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  MAX_CATCH_UP_MS,
  MAX_OVERLAP_ROWS,
  MAX_SIGNAL_ROWS,
  type ReviewSqlExecutor,
  SECURITY_RULES,
  TERMINAL_DELIVERY_STATUSES,
  maxRuleWindowMs,
  readBulkAccessHits,
  readRaisedAlerts,
  readReviewCursor,
  readSignalEvents,
  rulesForLane,
  signalEventTypes,
} from "../src/review";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const FROM = new Date("2026-11-26T11:00:00.000Z");
const TO = new Date("2026-11-26T12:00:00.000Z");
const dialect = new PgDialect();

interface Recorded {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** An executor that answers every statement with no rows and remembers what it was asked. */
function recorder(): { readonly db: ReviewSqlExecutor; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const db: ReviewSqlExecutor = {
    execute: async (query) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  return { db, calls };
}

const PLATFORM = { organizationId: null } as const;
const ORG_SCOPE = { organizationId: ORG } as const;
const SIGNAL_QUERY = { eventTypes: ["m2.auth.login_failed"], from: FROM, to: TO, limit: 100 };

describe("platform scope: only through the bounded definer readers, never audit_event", () => {
  it("reads the sign-in events through m4_review_platform_signals", async () => {
    const { db, calls } = recorder();
    await readSignalEvents(db, PLATFORM, SIGNAL_QUERY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("public.m4_review_platform_signals(");
    expect(calls[0]?.text).not.toMatch(/audit_event/);
    // event types, window, row limit (one more than asked, to learn whether the read was cut short) and direction
    expect(calls[0]?.params).toEqual([
      "m2.auth.login_failed",
      FROM.toISOString(),
      TO.toISOString(),
      101,
      false,
    ]);
  });

  it("asks for the newest rows when it is the look-back read, and orders them the way the caller relies on", async () => {
    const { db, calls } = recorder();
    await readSignalEvents(db, PLATFORM, { ...SIGNAL_QUERY, newestFirst: true });
    expect(calls[0]?.params.at(-1)).toBe(true);
    expect(calls[0]?.text).toMatch(/ORDER BY occurred_at DESC, event_id DESC/);
  });

  it("reads the cursor through m4_review_platform_cursor", async () => {
    const { db, calls } = recorder();
    await expect(readReviewCursor(db, PLATFORM)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("public.m4_review_platform_cursor()");
    expect(calls[0]?.text).not.toMatch(/audit_event/);
  });

  it("reads the alert memory through m4_review_platform_raised_alerts, asking for the terminal delivery statuses", async () => {
    const { db, calls } = recorder();
    await readRaisedAlerts(db, PLATFORM, FROM);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("public.m4_review_platform_raised_alerts(");
    expect(calls[0]?.text).not.toMatch(/audit_event/);
    expect(calls[0]?.params).toEqual([FROM.toISOString(), ...TERMINAL_DELIVERY_STATUSES]);
  });

  it("has no bulk-access reader: it refuses, it does not report an empty all-clear", async () => {
    const { db, calls } = recorder();
    await expect(
      readBulkAccessHits(db, PLATFORM, { from: FROM, to: TO, bucketMs: 900_000, threshold: 100 }),
    ).rejects.toThrow(/no bulk-access reader/);
    expect(calls).toEqual([]);
  });

  it("asks nothing when there is nothing to ask for", async () => {
    const { db, calls } = recorder();
    await expect(
      readSignalEvents(db, PLATFORM, { ...SIGNAL_QUERY, eventTypes: [] }),
    ).resolves.toEqual({ events: [], truncated: false });
    expect(calls).toEqual([]);
  });
});

describe("org scope: the organization's own rows, directly, under RLS", () => {
  it("reads audit_event with an explicit organization predicate and never calls a platform reader", async () => {
    const { db, calls } = recorder();
    await readSignalEvents(db, ORG_SCOPE, SIGNAL_QUERY);
    await readReviewCursor(db, ORG_SCOPE);
    await readRaisedAlerts(db, ORG_SCOPE, FROM);
    await readBulkAccessHits(db, ORG_SCOPE, {
      from: FROM,
      to: TO,
      bucketMs: 900_000,
      threshold: 100,
    });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.text).toMatch(/FROM audit_event/);
      expect(call.text).toMatch(/organization_id = \$\d+::uuid/);
      expect(call.text).not.toMatch(/m4_review_platform/);
      expect(call.params).toContain(ORG);
    }
  });
});

// The platform readers refuse (22023) anything outside bounds written in migration 1566; the review's own constants and platform rules
// must stay inside them, or the platform lane would start failing in production. This is the unit-level half of that coupling (the live
// suite proves the refusals and that the review's largest read is accepted): it fails on the PR that raises a constant or adds a
// platform rule, not on the night the lane stops.
describe("the platform lane stays inside the readers' bounds (migration 1566)", () => {
  const HOUR = 3_600_000;
  const migration = readFileSync(
    join(__dirname, "../../db/migrations/1566_m4_security_review_platform_audit_reader.sql"),
    "utf8",
  );
  const section = (fn: string): string =>
    migration.split("CREATE OR REPLACE FUNCTION ").find((s) => s.startsWith(`${fn}(`)) ?? "";
  const hours = (s: string, name: string): number =>
    Number(new RegExp(`${name} constant interval := interval '(\\d+) hours'`).exec(s)?.[1]);
  const count = (s: string, name: string): number =>
    Number(new RegExp(`${name} constant integer := (\\d+)`).exec(s)?.[1]);
  const signals = section("m4_review_platform_signals");
  const alerts = section("m4_review_platform_raised_alerts");
  const platformRules = rulesForLane(SECURITY_RULES, "platform");
  const lookbackMs = maxRuleWindowMs(platformRules);

  it("reads only the event types the signals reader allows, and has no bulk-access rule", () => {
    const allowed = /c_allowed constant text\[\] := ARRAY\[([^\]]*)\]/
      .exec(signals)?.[1]
      ?.split(",")
      .map((t) => t.trim().replace(/^'|'$/g, ""));
    expect(allowed?.length).toBeGreaterThan(0);
    expect(signalEventTypes(platformRules).filter((t) => !allowed?.includes(t))).toEqual([]);
    expect(platformRules.filter((r) => r.kind === "bulk_access")).toEqual([]);
  });

  it("keeps every window, reach and row cap of a run inside the signals reader's bounds", () => {
    expect(hours(signals, "c_max_span") * HOUR).toBeGreaterThanOrEqual(MAX_CATCH_UP_MS + lookbackMs);
    expect(hours(signals, "c_max_age") * HOUR).toBeGreaterThanOrEqual(MAX_CATCH_UP_MS + lookbackMs);
    // the reader's limit is the review's cap plus the one extra row it fetches to learn that a read was cut short
    expect(count(signals, "c_max_rows")).toBeGreaterThanOrEqual(
      Math.max(MAX_SIGNAL_ROWS, MAX_OVERLAP_ROWS) + 1,
    );
  });

  it("keeps the alert memory's reach inside the alert reader's bound", () => {
    expect(hours(alerts, "c_max_age") * HOUR).toBeGreaterThanOrEqual(
      MAX_CATCH_UP_MS + lookbackMs + ALERT_COOLDOWN_MS,
    );
  });
});
