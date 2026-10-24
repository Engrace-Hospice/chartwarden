/**
 * F-178 (#248) — M6's `ComplianceWindowCountsProvider` seam, proven against real Postgres.
 *
 * M30's own spec has long claimed to consume a `ComplianceWindowReader` seam from M6 for F2F
 * (face-to-face encounter) compliance-window timeliness data — never actually built (verified nowhere in
 * the codebase as a real type or registered seam name; only referenced in comments). This is the real
 * replacement: a nightly-batch measure-computation pull over `compliance_window`, not an event-driven
 * consumer of M6's outbox events.
 *
 * Everything under test is driven as the NOBYPASSRLS `chartwarden_app` role (GAP-086) — a cross-tenant
 * assertion on a superuser connection proves nothing. Fixture rows are seeded directly (superuser) rather
 * than through the full referral/election/CTI ceremony: this seam reads `compliance_window` /
 * `admission` table STATE, and the write lifecycle (open/close/override) is already proven by
 * `m6-compliance-window-write.live.test.ts` (M6L-T05) — duplicating that ceremony here would only slow the
 * suite down without adding coverage of what this file actually exists to prove.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:t5:counts:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComplianceWindowCountsProvider } from "../src/modules/06-admission/seams/compliance-window-counts-provider";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-1111111178a0";
const ORG_B = "11111111-1111-1111-1111-1111111178b0";
const PE_A = "88888888-8888-8888-8888-888888887801";
const PE_B = "88888888-8888-8888-8888-888888887802";

/** The scope window every "main" scenario assertion below is pinned to. */
const MAIN = { fromIso: "2026-01-01T00:00:00.000Z", toIso: "2026-02-01T00:00:00.000Z" };
/** A SEPARATE window for the provider-entity filter scenario, so its fixtures never interact with MAIN's counts. */
const PE_SCOPE = { fromIso: "2026-04-01T00:00:00.000Z", toIso: "2026-05-01T00:00:00.000Z" };

describe.skipIf(!DB_URL)("M6 ComplianceWindowCountsProvider — LIVE Postgres (F-178, #248)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let provider: ReturnType<typeof createComplianceWindowCountsProvider>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed (superuser) a minimal-but-real admission row — `patientId` carries no DB FK (app-validated), so a
   *  fresh random id is fine; `providerEntityId` is nullable and only supplied when a scenario needs it. */
  async function seedAdmission(params: {
    id: string;
    organizationId: string;
    providerEntityId?: string;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO admission (id, organization_id, patient_id, status, provider_entity_id)
       VALUES ($1, $2, $3, 'active', $4)`,
      [params.id, params.organizationId, randomUUID(), params.providerEntityId ?? null],
    );
  }

  /** Seed (superuser) a `provider_entity` row — the minimal NOT NULL set. `ccn`/`npi` are globally
   *  unique, so each caller passes its own distinct pair. */
  async function seedProviderEntity(
    id: string,
    organizationId: string,
    ccn: string,
    npi: string,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO provider_entity
         (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, $2, $3, 'Test Provider', $4, 'enc:test', '1231')`,
      [id, organizationId, ccn, npi],
    );
  }

  /** Seed (superuser) a `compliance_window` row with explicit lifecycle fields — this suite's whole point
   *  is proving reads over table STATE, so fixtures are written directly rather than driven through the
   *  close/override write lifecycle `m6-compliance-window-write.live.test.ts` already proves. */
  async function seedWindow(params: {
    organizationId: string;
    admissionId: string;
    windowKind?: string;
    mustCompleteBy: string;
    closedAt?: string | null;
    overrideReason?: string | null;
    status?: string;
  }): Promise<void> {
    const startsAt = new Date(
      new Date(params.mustCompleteBy).getTime() - 30 * 86_400_000,
    ).toISOString();
    await admin.query(
      `INSERT INTO compliance_window
         (id, organization_id, admission_id, window_kind, starts_at, must_complete_by, closed_at,
          override_reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        params.organizationId,
        params.admissionId,
        params.windowKind ?? "f2f_recert_30d_prior",
        startsAt,
        params.mustCompleteBy,
        params.closedAt ?? null,
        params.overrideReason ?? null,
        params.status ?? (params.closedAt ? "closed" : "open"),
      ],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES
         ($1,'org-a-f178','A','A'), ($2,'org-b-f178','B','B')`,
      [ORG_A, ORG_B],
    );
    await seedProviderEntity(PE_A, ORG_A, "CCN-F178-A", "1178000001");
    await seedProviderEntity(PE_B, ORG_A, "CCN-F178-B", "1178000002");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    provider = createComplianceWindowCountsProvider(handle.db);

    // ── MAIN scenario fixtures (scope: MAIN, org A) ──────────────────────────────────────────────
    const onTimeAdm = randomUUID();
    const overriddenAdm = randomUUID();
    const stillOpenAdm = randomUUID();
    const outOfRangeAdm = randomUUID();
    const otherKindAdm = randomUUID();
    await seedAdmission({ id: onTimeAdm, organizationId: ORG_A });
    await seedAdmission({ id: overriddenAdm, organizationId: ORG_A });
    await seedAdmission({ id: stillOpenAdm, organizationId: ORG_A });
    await seedAdmission({ id: outOfRangeAdm, organizationId: ORG_A });
    await seedAdmission({ id: otherKindAdm, organizationId: ORG_A });

    // Closed ON TIME: closedAt before mustCompleteBy, no override.
    await seedWindow({
      organizationId: ORG_A,
      admissionId: onTimeAdm,
      mustCompleteBy: "2026-01-15T12:00:00.000Z",
      closedAt: "2026-01-14T00:00:00.000Z",
      status: "closed",
    });
    // Closed LATE via a documented override: closedAt AFTER mustCompleteBy, override_reason set — must
    // NOT count as on-time, must count in the override tally.
    await seedWindow({
      organizationId: ORG_A,
      admissionId: overriddenAdm,
      mustCompleteBy: "2026-01-15T12:00:00.000Z",
      closedAt: "2026-01-20T00:00:00.000Z",
      overrideReason: "assessment completed on paper during EHR outage; scanned to chart",
      status: "closed",
    });
    // Still open past its due date: in the denominator, in NEITHER numerator.
    await seedWindow({
      organizationId: ORG_A,
      admissionId: stillOpenAdm,
      mustCompleteBy: "2026-01-10T00:00:00.000Z",
      closedAt: null,
      status: "overdue",
    });
    // Due OUTSIDE the scope window entirely — excluded from both counters regardless of how it resolves.
    await seedWindow({
      organizationId: ORG_A,
      admissionId: outOfRangeAdm,
      mustCompleteBy: "2026-03-01T00:00:00.000Z",
      closedAt: "2026-02-28T00:00:00.000Z",
      status: "closed",
    });
    // Due IN the scope window but a DIFFERENT window kind — must not leak into the F2F-only counts.
    await seedWindow({
      organizationId: ORG_A,
      admissionId: otherKindAdm,
      windowKind: "comprehensive_assessment_5d",
      mustCompleteBy: "2026-01-18T00:00:00.000Z",
      closedAt: "2026-01-17T00:00:00.000Z",
      status: "closed",
    });

    // ── Cross-tenant fixture: an identical on-time-closed F2F window, but in ORG B ──────────────────
    const orgBAdm = randomUUID();
    await seedAdmission({ id: orgBAdm, organizationId: ORG_B });
    await seedWindow({
      organizationId: ORG_B,
      admissionId: orgBAdm,
      mustCompleteBy: "2026-01-15T12:00:00.000Z",
      closedAt: "2026-01-14T00:00:00.000Z",
      status: "closed",
    });

    // ── Provider-entity filter fixtures (scope: PE_SCOPE, org A, two different provider entities) ──
    const peAAdm = randomUUID();
    const peBAdm = randomUUID();
    await seedAdmission({ id: peAAdm, organizationId: ORG_A, providerEntityId: PE_A });
    await seedAdmission({ id: peBAdm, organizationId: ORG_A, providerEntityId: PE_B });
    await seedWindow({
      organizationId: ORG_A,
      admissionId: peAAdm,
      mustCompleteBy: "2026-04-15T00:00:00.000Z",
      closedAt: "2026-04-14T00:00:00.000Z",
      status: "closed",
    });
    await seedWindow({
      organizationId: ORG_A,
      admissionId: peBAdm,
      mustCompleteBy: "2026-04-16T00:00:00.000Z",
      closedAt: "2026-04-17T00:00:00.000Z",
      overrideReason: "PE-B override, out of on-time counts",
      status: "closed",
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("f2fWindowOnTimeCounts: on-time close counts in the numerator; denominator covers every due window", async () => {
    const counts = await provider.f2fWindowOnTimeCounts({ orgId: ORG_A, ...MAIN });
    // Denominator: onTime + overridden + stillOpen = 3 (outOfRange and the other-kind row excluded).
    expect(counts.denominator).toBe(3);
    // Numerator: only the plain on-time close.
    expect(counts.numerator).toBe(1);
  });

  it("f2fWindowOverrideCounts: SAME denominator as on-time, numerator counts only the documented override", async () => {
    const counts = await provider.f2fWindowOverrideCounts({ orgId: ORG_A, ...MAIN });
    expect(counts.denominator).toBe(3);
    expect(counts.numerator).toBe(1);
  });

  it("a still-open-past-due window counts in the denominator and in NEITHER numerator", async () => {
    const onTime = await provider.f2fWindowOnTimeCounts({ orgId: ORG_A, ...MAIN });
    const override = await provider.f2fWindowOverrideCounts({ orgId: ORG_A, ...MAIN });
    // 3 due windows total; on-time + override numerators together (1 + 1 = 2) are one short of the
    // denominator (3) — the missing one is exactly the still-open window, counted nowhere but the
    // denominator, matching the contract ("a window still stuck open past its due date correctly drags
    // the rate down, it does not disappear from the denominator").
    expect(onTime.numerator + override.numerator).toBe(onTime.denominator - 1);
  });

  it("a window due outside the scope range is excluded entirely, from both methods", async () => {
    const narrowedToExcludeOutOfRange = {
      orgId: ORG_A,
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-02-01T00:00:00.000Z",
    };
    const onTime = await provider.f2fWindowOnTimeCounts(narrowedToExcludeOutOfRange);
    const override = await provider.f2fWindowOverrideCounts(narrowedToExcludeOutOfRange);
    // The out-of-range window (due 2026-03-01) never appears — denominator stays 3, not 4, on both.
    expect(onTime.denominator).toBe(3);
    expect(override.denominator).toBe(3);
  });

  it("cross-tenant isolation: org B's identical window never counts toward org A's scope", async () => {
    const counts = await provider.f2fWindowOnTimeCounts({ orgId: ORG_A, ...MAIN });
    // If org B's on-time-closed window (identical shape, same due date) leaked in, the denominator would
    // be 4 instead of 3 and the numerator 2 instead of 1.
    expect(counts.denominator).toBe(3);
    expect(counts.numerator).toBe(1);

    const orgBCounts = await provider.f2fWindowOnTimeCounts({ orgId: ORG_B, ...MAIN });
    expect(orgBCounts.denominator).toBe(1);
    expect(orgBCounts.numerator).toBe(1);
  });

  it("providerEntityId narrows the F2F population to that provider's admissions only", async () => {
    const all = await provider.f2fWindowOnTimeCounts({ orgId: ORG_A, ...PE_SCOPE });
    expect(all.denominator).toBe(2); // PE_A's on-time window + PE_B's overridden window

    const peAOnly = await provider.f2fWindowOnTimeCounts({
      orgId: ORG_A,
      providerEntityId: PE_A,
      ...PE_SCOPE,
    });
    expect(peAOnly.denominator).toBe(1);
    expect(peAOnly.numerator).toBe(1);

    const peBOnly = await provider.f2fWindowOverrideCounts({
      orgId: ORG_A,
      providerEntityId: PE_B,
      ...PE_SCOPE,
    });
    expect(peBOnly.denominator).toBe(1);
    expect(peBOnly.numerator).toBe(1);
  });
});
