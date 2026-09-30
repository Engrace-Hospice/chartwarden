// F-216 — unit tests for the PURE parts of M39's §4.9 expiration/reminder crons: the decision planners,
// the fan-out's failure isolation, the platform-job registration, and the cron tier's wiring into the
// composition root (a bound-but-not-wired cron is the failure this repo keeps finding). The DB behaviour
// (flip + same-tx publish + M5 snapshot + RLS) is the LIVE suite, `m39-consent-expiration-cron.live.test.ts`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlatformJobRegistered } from "@wardenx/tenancy";
import { describe, expect, it } from "vitest";
import {
  M39_CRON_BOUNDS,
  M39_JOB_SCHEDULES,
  M39_PLATFORM_JOB_ID,
  M39_QUEUES,
  planConsentExpiry,
  planConsentReminder,
  runConsentExpirationCron,
  wireM39Tenancy,
} from "../src/modules/39-consent/index";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

describe("planConsentExpiry", () => {
  it("expires only an active row whose expires_at has passed", () => {
    expect(planConsentExpiry({ status: "active", expiresAtMs: NOW - 1, nowMs: NOW })).toBe(true);
    expect(planConsentExpiry({ status: "active", expiresAtMs: NOW, nowMs: NOW })).toBe(true);
    expect(planConsentExpiry({ status: "active", expiresAtMs: NOW + 1, nowMs: NOW })).toBe(false);
  });
  it("never expires an indefinite consent", () => {
    expect(planConsentExpiry({ status: "active", expiresAtMs: null, nowMs: NOW })).toBe(false);
  });
  it.each(["draft", "revoked", "superseded", "expired"] as const)(
    "never touches a %s row even when lapsed",
    (status) => {
      expect(planConsentExpiry({ status, expiresAtMs: NOW - DAY, nowMs: NOW })).toBe(false);
    },
  );
});

describe("planConsentReminder", () => {
  const all = ["90_days", "30_days", "14_days", "7_days", "1_day"];
  it("fires nothing outside the 90-day look-ahead, for indefinite, or already-lapsed consents", () => {
    expect(planConsentReminder({ expiresAtMs: NOW + 91 * DAY, nowMs: NOW, cadenceFloor: all })).toBe(null);
    expect(planConsentReminder({ expiresAtMs: null, nowMs: NOW, cadenceFloor: all })).toBe(null);
    expect(planConsentReminder({ expiresAtMs: NOW - 1, nowMs: NOW, cadenceFloor: all })).toBe(null);
  });
  it("fires the widest window when first entering it, then steps inward", () => {
    const at = (days: number) =>
      planConsentReminder({ expiresAtMs: NOW + days * DAY, nowMs: NOW, cadenceFloor: all });
    expect(at(89)).toBe("90_days");
    expect(at(29)).toBe("30_days");
    expect(at(13)).toBe("14_days");
    expect(at(6)).toBe("7_days");
    expect(at(0.5)).toBe("1_day");
  });
  it("fires ONLY the most urgent open window when several are open (no 90/30/14/7/1 burst)", () => {
    expect(planConsentReminder({ expiresAtMs: NOW + 3 * DAY, nowMs: NOW, cadenceFloor: all })).toBe("7_days");
  });
  it("honours the consent type's cadence floor", () => {
    const floor = ["30_days", "1_day"];
    expect(planConsentReminder({ expiresAtMs: NOW + 6 * DAY, nowMs: NOW, cadenceFloor: floor })).toBe("30_days");
    expect(planConsentReminder({ expiresAtMs: NOW + 6 * 3600_000, nowMs: NOW, cadenceFloor: floor })).toBe("1_day");
    expect(planConsentReminder({ expiresAtMs: NOW + 50 * DAY, nowMs: NOW, cadenceFloor: floor })).toBe(null);
    expect(planConsentReminder({ expiresAtMs: NOW + 5 * DAY, nowMs: NOW, cadenceFloor: [] })).toBe(null);
  });
});

describe("cron tier wiring", () => {
  it("uses the package queue catalog names, hourly, with a bounded backlog", () => {
    expect(M39_QUEUES.consentExpiration).toBe("m39.consent_expiration");
    expect(M39_QUEUES.expirationReminder).toBe("m39.expiration_reminder");
    expect(M39_JOB_SCHEDULES.consentExpiration).toBe("0 * * * *");
    expect(M39_JOB_SCHEDULES.expirationReminder).toBe("0 * * * *");
    expect(M39_CRON_BOUNDS.pageSize * M39_CRON_BOUNDS.maxPagesPerOrg).toBeLessThanOrEqual(1000);
  });

  it("wireM39Tenancy allowlists the platform job id", () => {
    wireM39Tenancy();
    expect(isPlatformJobRegistered(M39_PLATFORM_JOB_ID)).toBe(true);
  });

  it("the composition root actually constructs, schedules and allowlists the crons", () => {
    const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(src).toContain("wireM39Tenancy()");
    expect(src).toContain("registerM39CronWorkers(m39WorkerDeps)");
    expect(src).toContain("scheduleM39Jobs(queueConnection)");
    expect(src).toContain("bindCallerModule(txOutboxPublisher, \"m39\")");
  });

  it("one org's failure does not stop later orgs, and the job still fails loudly", async () => {
    const seen: string[] = [];
    const db = {
      transaction: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      runConsentExpirationCron({
        db: db as never,
        outbox: { publish: async () => undefined },
        activeOrgs: {
          listActiveOrgs: async () => {
            seen.push("list");
            return [{ organizationId: "org-a" }, { organizationId: "org-b" }];
          },
        },
      }),
    ).rejects.toThrow(/2 of 2 org\(s\) failed/);
    expect(seen).toEqual(["list"]);
  });
});
