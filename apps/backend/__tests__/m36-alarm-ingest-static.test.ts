// WP 6.10 (ADR-0102) - static guards: alarm ingest is WATCH ONLY. Its code (the module directory, the routes, the schemas, the migration) must
//   1. never touch the response-request ("acknowledgment") aggregate, the escalation router, the on-call or triage modules, a timer or a queue,
//   2. never name an urgent, emergency or SOS path or the urgency model,
//   3. never read or write a message (an alarm is an alert, not a conversation), and import no module outside the alert emitter seam,
//   4. map only to alarm_ingest.* catalog types that are NOT locked, NOT designated and never above `warn`,
//   5. be the only code that writes alarm tables.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DESIGNATED_EVENT_TYPES,
  PLATFORM_DEFAULT_ALERT_RULES,
  SUPERVISOR_PAGE_EVENT_TYPES,
  SYSTEM_LOCKED_EVENT_TYPES,
} from "@chartwarden/messaging";
import {
  ALARM_INGEST_ALERT_TYPES,
  ALARM_INGEST_KEY_ID_HEADER,
  ALARM_INGEST_SIGNATURE_HEADER,
  ALARM_INGEST_TIMESTAMP_HEADER,
  ALARM_SEVERITY_CEILINGS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const DIR = "apps/backend/src/modules/36-messaging/alarm-ingest";
const INGEST_FILES = [
  ...walk(join(ROOT, DIR)).map((f) => relative(ROOT, f)),
  "apps/backend/src/modules/36-messaging/routes/alarm-ingest-routes.ts",
  "apps/backend/src/modules/36-messaging/routes/alarm-ingest-typebox.ts",
  "packages/db/src/schema/messaging/alarm-ingest.ts",
  "packages/db/migrations/1250_m36_alarm_ingest.sql",
];

const FORBIDDEN_MACHINERY =
  /acknowledg|\back(ed|s)?\b|ack[-_]?request|escalat|oncall|on[-_ ]call|pager|triage|bullmq|setTimeout|setInterval|\bcron\b|from "@chartwarden\/(oncall|triage)|modules\/(19|11|12|13)-/i;
const FORBIDDEN_URGENCY = /urgen|emergenc|\bsos\b|life[- ]?safety|critical_alert|"critical"/i;

describe("alarm ingest is watch only: no response request, no routing, no page, no urgency", () => {
  it("scans the files it means to", () => {
    expect(INGEST_FILES.length).toBeGreaterThan(8);
  });

  it.each(INGEST_FILES)("%s", (file) => {
    const src = read(file);
    expect(src).not.toMatch(FORBIDDEN_MACHINERY);
    // `critical` appears only as a value a sender may REQUEST (and have capped): in the schema, the core cap and the CHECKs that forbid it.
    if (
      ![
        `${DIR}/alarm-ingest-schema.ts`,
        `${DIR}/alarm-ingest-core.ts`,
        "packages/db/src/schema/messaging/alarm-ingest.ts",
        "packages/db/migrations/1250_m36_alarm_ingest.sql",
      ].includes(file)
    )
      expect(src).not.toMatch(FORBIDDEN_URGENCY);
    else expect(src.replace(/'critical'|"critical"|critical:/g, "")).not.toMatch(FORBIDDEN_URGENCY);
  });

  it("never reads or writes a message, a channel, an urgency field or an ack table", () => {
    for (const file of INGEST_FILES.filter((f) => f.endsWith(".ts"))) {
      const src = read(file);
      expect(src, file).not.toMatch(
        /schema\.(message|channel|announcement|userNotification)|urgentRecipient|urgency/,
      );
    }
  });

  it("the module reaches the platform only through the alert emitter port, the cipher and the store", () => {
    const service = read(`${DIR}/alarm-ingest-service.ts`);
    const imports = [...service.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      [
        "../messaging-write-core",
        "./alarm-ingest-core",
        "./alarm-ingest-schema",
        "./alarm-ingest-store",
        "@chartwarden/messaging",
        "@chartwarden/types",
        "@sinclair/typebox/value",
      ].sort(),
    );
    // The only thing used from @chartwarden/messaging is the TYPE of the emitter.
    expect(service).toMatch(/import type \{ AlertEmitter \} from "@chartwarden\/messaging"/);
    expect(service).toMatch(/import type \{ MessageBodyCipher \} from "..\/messaging-write-core"/);
  });

  it("no other file writes the alarm tables", () => {
    const writers = ["apps/backend/src", "packages"]
      .flatMap((d) => walk(join(ROOT, d)))
      .map((f) => relative(ROOT, f))
      .filter(
        (f) =>
          !f.startsWith(DIR) &&
          f !== "packages/db/src/schema/messaging/alarm-ingest.ts" &&
          /schema\.alarm(Source|SourceMapping|IngestEvent)s?\b/.test(
            read(f),
          ),
      );
    // The seeds, permission mirrors and tests may name the tables or keys; nothing else may import the schema objects.
    expect(writers).toEqual([]);
  });
});

describe("the catalog the alarms may reach", () => {
  const rule = (t: string) => PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === t);

  it("every mappable alert type is a real, enabled, non-locked, info-floor, in-app-only, non-designated platform rule", () => {
    for (const type of ALARM_INGEST_ALERT_TYPES) {
      const r = rule(type);
      expect(r, type).toBeDefined();
      expect(r).toMatchObject({ systemLocked: false, enabled: true, severityFloor: "info" });
      expect(r?.channelsOverride).toEqual(["in_app"]);
      expect(SYSTEM_LOCKED_EVENT_TYPES).not.toContain(type);
      expect(DESIGNATED_EVENT_TYPES.has(type)).toBe(false);
      expect(SUPERVISOR_PAGE_EVENT_TYPES.has(type)).toBe(false);
    }
  });

  it("the ceiling set is info and warn only", () => {
    expect([...ALARM_SEVERITY_CEILINGS]).toEqual(["info", "warn"]);
  });

  it("the SQL CHECK lists are exactly the constants", () => {
    const sql = read("packages/db/migrations/1250_m36_alarm_ingest.sql").replace(/\s+/g, " ");
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
    expect(sql).toContain(`"alert_type" IN (${list(ALARM_INGEST_ALERT_TYPES)})`);
    expect(sql).toContain(`"severity_ceiling" IN (${list(ALARM_SEVERITY_CEILINGS)})`);
    expect(sql).toContain(`"effective_severity" IN ('info', 'warn')`);
  });
});

describe("the three request headers", () => {
  it("the route reads exactly the registered header names", () => {
    const route = read("apps/backend/src/modules/36-messaging/routes/alarm-ingest-routes.ts");
    for (const h of [
      ALARM_INGEST_KEY_ID_HEADER,
      ALARM_INGEST_TIMESTAMP_HEADER,
      ALARM_INGEST_SIGNATURE_HEADER,
    ])
      expect(route).toContain(`request.headers["${h}"]`);
    const reads = [...route.matchAll(/request\.headers\[/g)].length;
    expect(reads).toBe(3);
  });
});
