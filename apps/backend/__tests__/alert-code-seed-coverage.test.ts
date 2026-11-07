// GAP-035 — every alert code a cron/consumer hands to AlertEmitter.emit needs a seeded platform alert_rule,
// or the alert is persisted with zero recipients (alert-emitter-impl.ts: "no rule -> recipientCount 0").
// Static scan of the emit sites in M23/M25/M26/M27 against PLATFORM_DEFAULT_ALERT_RULES.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";
import { DEACTIVATED_ALERT } from "../src/modules/12-dosespot/tenant-config/effects";
import { M36_DOSESPOT_ALERT_EVENT_TYPES } from "../src/modules/36-messaging/outbox-consumers/dosespot-alerts";

const SRC = join(__dirname, "..", "src", "modules");
const EMIT_SITES = [
  "23-billing-medicare/jobs/m23-jobs.ts",
  "23-billing-medicare/outbox-consumers/m25-taxonomy-unmapped-code-observed.ts",
  "25-remittance/jobs/m25-jobs.ts",
  "26-cap/jobs/index.ts",
  "27-cost-report/jobs/m27-jobs.ts",
];
/** The §4.9 filing-deadline tiers the m27 template literal `m27.filing_deadline.${tier}_due` expands over. */
const M27_TIERS = ["t4_months", "t4_5_months", "t4_75_months"];
const CODE_LITERAL = /"((?:m2[3-7]|denial|appeal)\.[a-z0-9_.]+)"/g;

function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const rel of EMIT_SITES) {
    const text = readFileSync(join(SRC, rel), "utf8");
    // `alertCode: <expr>,` (possibly multi-line) and the M25 pure watchers' `kind: "<code>"` emissions.
    const exprs = [...text.matchAll(/alertCode:\s*([^;]*?),\s*\n\s*severity/g)].map((m) => m[1]);
    const kinds = [...text.matchAll(/kind:\s*("(?:denial|appeal)\.[a-z0-9_.]+")/g)].map(
      (m) => m[1],
    );
    const taxonomy = text.includes("M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_ALERT_CODE =")
      ? ['"m23.taxonomy.unmapped_taxonomy_alert"']
      : [];
    for (const expr of [...exprs, ...kinds, ...taxonomy]) {
      for (const m of (expr ?? "").matchAll(CODE_LITERAL)) codes.add(m[1] as string);
      if (expr?.includes("${tier}"))
        for (const t of M27_TIERS) codes.add(`m27.filing_deadline.${t}_due`);
    }
  }
  return codes;
}

describe("cron alert codes have seeded platform rules", () => {
  const seeded = new Set(PLATFORM_DEFAULT_ALERT_RULES.map((r) => r.eventType));

  it("finds the emit sites (guards against the scan silently matching nothing)", () => {
    const codes = emittedCodes();
    expect(codes.size).toBeGreaterThanOrEqual(15);
    expect(codes).toContain("m23.noe.window_breached");
    expect(codes).toContain("m27.filing_deadline.t4_75_months_due");
  });

  it("seeds a rule for every emitted code", () => {
    const missing = [...emittedCodes()].filter((c) => !seeded.has(c));
    expect(missing).toEqual([]);
  });
});

// Review of slice 4, M3: the DoseSpot alert codes are raised by an M36 outbox consumer (degraded / recovered) and by the clinic service
// directly (deactivated). The scan above reads M23-M27 emit sites only, and a missing rule persists the alert with ZERO recipients, so
// the codes are pinned here from the modules' own constants.
describe("DoseSpot alert codes have seeded platform rules", () => {
  const seeded = new Map(PLATFORM_DEFAULT_ALERT_RULES.map((r) => [r.eventType, r]));
  const codes = [...M36_DOSESPOT_ALERT_EVENT_TYPES, DEACTIVATED_ALERT];

  it("names the three codes", () => {
    expect([...codes].sort()).toEqual([
      "m12.dosespot_config.deactivated",
      "m12.dosespot_degraded",
      "m12.dosespot_recovered",
    ]);
  });

  it.each(codes)("%s is seeded, enabled, and addressed to the tenant's administrators", (code) => {
    const rule = seeded.get(code);
    expect(rule).toBeDefined();
    expect(rule?.enabled).toBe(true);
    expect(rule?.recipientResolver).toBe("tenant_admins");
  });
});
