/**
 * M41 Billing - Commercial, claim assembly and validation (issue #722) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Scenarios from docs/audits/billing-e2e (the assembly, validation and pre-authorization slice of each):
 *   S15  a valid commercial hospice claim assembles to a correct 837I (SBR09, payer id, TOB, revenue code, charges) and
 *        becomes READY. Sending, the payer-stage acknowledgment and 835 matching belong to the submission and remittance
 *        issues (ADR-0100 D10 steps 4 and 6).
 *   S16  commercial primary with Medicare or Medicaid secondary: the claim carries the COB data (loop 2320) and NO Medicare
 *        claim is created as primary; M23 refuses the same patient exactly as this lane refuses a Medicare-primary one.
 *   S17  pre-authorization missing or expired: a hard stop with an actionable message, the claim stays a draft, nothing becomes
 *        ready, and a hard block cannot be overridden. An unconfirmed requirement is a soft block with an audited override.
 *
 * Also proves: effective periods of plan, route and rate are intersected with the claim window; a merged payer is caught; the
 * override follows the m23-validation-override rules (step-up, reason floor, no AI, one per result, audit rows, bound to the
 * facts); RLS isolates tenants on all seven tables; the REAL catalog-validating outbox publisher is used (not NOOP_OUTBOX).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:commercial-claim:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { StepUpRequiredError } from "@chartwarden/types";
import { checkStediEdits } from "@chartwarden/x12-837-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM41OverrideAuditPort } from "../src/m41-override-audit";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { buildClaimAssemblyService } from "../src/modules/23-billing-medicare/services/claim-assembly";
import { buildM23PatientPayerAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import {
  type CommercialActor,
  type CommercialClaimSeams,
  M41_OUTBOX_EVENTS,
  buildCommercial837iRenderer,
  buildCommercialAuthorizationService,
  buildCommercialClaimAssemblyService,
  buildCommercialClaimLifecycleService,
  buildCommercialClaimReadService,
} from "../src/modules/41-billing-commercial";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "00000000-0000-4000-8000-0000000042a1";
const ORG_B = "00000000-0000-4000-8000-0000000042b1";
const USER = "00000000-0000-4000-8000-0000000042c1";
const REASON =
  "The payer confirmed by telephone that no authorization is needed for this hospice plan.";
const FROM = "2026-03-01";
const TO = "2026-03-31";

describe.skipIf(!DB_URL)("M41 commercial claim assembly and validation - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId: string;
  let otherProviderEntityId: string;
  let membershipId: string;
  let medicarePayer: string;
  let medicaidPayer: string;
  let advantagePayer: string;
  let actor: CommercialActor;
  let assembly: ReturnType<typeof buildCommercialClaimAssemblyService>;
  let lifecycle: ReturnType<typeof buildCommercialClaimLifecycleService>;
  let authorizations: ReturnType<typeof buildCommercialAuthorizationService>;
  let renderer: ReturnType<typeof buildCommercial837iRenderer>;
  let coverageReader: ReturnType<typeof buildPatientCoverageReader>;

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    return (await admin.query(sql, params)).rows[0]?.n as T;
  }

  // ── seeding (as the superuser; the code under test runs as chartwarden_app) ──────────────────────────────────────
  type Scenario = {
    patientId: string;
    payerId: string;
    planId: string;
    admissionId: string;
    primaryCoverageId: string;
  };
  async function seedScenario(
    opts: {
      authorization?: string;
      lead?: number | null;
      filing?: string;
      routeFrom?: string | null;
      rates?: {
        loc: string;
        code: string;
        basis: string;
        cents: number | null;
        from: string;
        to: string | null;
      }[];
      planFrom?: string;
      planTo?: string | null;
      siteHcpcs?: boolean;
      group?: string | null;
    } = {},
  ): Promise<Scenario> {
    const payerId = (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('commercial'::payer_kind, $1) RETURNING id",
        [`Synthetic Commercial Health ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    const planId = (
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement,
           authorization_lead_days, effective_from, effective_to, site_of_service_hcpcs_required)
         VALUES ($1,$2,'Synthetic PPO',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          ORG,
          payerId,
          opts.filing ?? "CI",
          opts.authorization ?? "not_required",
          opts.lead ?? null,
          opts.planFrom ?? "2026-01-01",
          opts.planTo ?? null,
          opts.siteHcpcs ?? false,
        ],
      )
    ).rows[0].id as string;
    if (opts.routeFrom !== null) {
      await admin.query(
        `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
         VALUES ($1,$2,'stedi','SYNTH01',$3)`,
        [ORG, planId, opts.routeFrom ?? "2026-01-01"],
      );
    }
    for (const r of opts.rates ?? [
      {
        loc: "routine_home_care",
        code: "0651",
        basis: "per_diem",
        cents: 20_000,
        from: "2026-01-01",
        to: null,
      },
    ]) {
      await admin.query(
        `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ORG, planId, r.loc, r.code, r.basis, r.cents, r.from, r.to],
      );
    }
    const patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,'Jane','Doe','1950-01-01','female','active') RETURNING id`,
        [ORG, `mrn-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id as string;
    const primaryCoverageId = await coverage(
      patientId,
      payerId,
      1,
      "commercial",
      "MEM-0001234",
      opts.group === undefined ? "GRP100" : opts.group,
    );
    return { patientId, payerId, planId, admissionId: randomUUID(), primaryCoverageId };
  }

  async function coverage(
    patientId: string,
    payerId: string,
    rank: number,
    kind: string,
    subscriber: string,
    group: string | null = null,
    from = "2026-01-01",
    to: string | null = null,
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, group_number, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5::patient_payer_coverage_kind,$6,$7,$8,$9) RETURNING id`,
        [patientId, ORG, payerId, rank, kind, subscriber, group, from, to],
      )
    ).rows[0].id as string;
  }

  /** Fake clinical reader seams (M6/M7/M40 own those tables); coverage is the REAL M5 reader over real rows. */
  function seamsFor(s: Scenario, over: Partial<CommercialClaimSeams> = {}): CommercialClaimSeams {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
    return {
      coverage: coverageReader,
      caseload: { isInCaseload: async () => true },
      admission: {
        resolveForRange: async () => ({
          admissionId: s.admissionId,
          providerEntityId,
          hospiceAdmissionDate: "2026-03-01",
          admissionTypeCode: "1",
          admissionSourceCode: "1",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      electionPeriods: {
        coveringRange: async () => [
          {
            electionPeriodId: randomUUID(),
            sequence: 1,
            effectiveFrom: "2026-03-01",
            effectiveTo: null,
            revoked: false,
            revocationDate: null,
          },
        ],
      },
      levelOfCare: {
        periodsInRange: async () => [
          {
            levelOfCarePeriodId: randomUUID(),
            levelOfCare: "routine_home_care" as const,
            from: "2026-03-01",
            to: "2026-03-31",
            chcDocumentedHours: null,
            gipAdmissionCriteriaDocumented: null,
          },
        ],
      },
      diagnoses: {
        forRange: async () => ({
          sequence: [{ position: 1, code: "C34.90", relationship: "terminal" as const }],
          withheldForConsentCount: 0,
          terminalWithheldForConsent: false,
        }),
      },
      clinicalParticipants: {
        resolveClinicalParticipants: async () => ({
          attending: {
            npi: "1245319599",
            firstName: "Alan",
            lastName: "Smith",
            status: "active" as const,
            licenseUnexpiredOnServiceDates: true,
          },
          hospicePhysician: null,
          placeOfService: "home",
        }),
      },
      outbox: {
        publish: (tx, e) =>
          publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
            ...e,
            callerModule: "m41",
          }),
      },
      audit: buildM41OverrideAuditPort(),
      ...over,
    };
  }

  /** Rebuild the three services over the scenario's seams (admission id differs per scenario). */
  function wire(s: Scenario, over: Partial<CommercialClaimSeams> = {}) {
    const seams = seamsFor(s, over);
    return {
      assembly: buildCommercialClaimAssemblyService(handle.db, seams),
      lifecycle: buildCommercialClaimLifecycleService(handle.db, seams),
    };
  }

  const input = (s: Scenario, extra: Record<string, unknown> = {}) => ({
    providerEntityId,
    patientId: s.patientId,
    serviceFrom: FROM,
    serviceTo: TO,
    ...extra,
  });

  const ruleOf = (
    v: {
      results: readonly {
        ruleKey: string;
        outcome: string;
        overridable: boolean;
        message: string;
      }[];
    },
    key: string,
  ) => v.results.find((r) => r.ruleKey === key);

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; statusCode?: number; message?: string; name?: string }) => e,
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG, "m41c-a"],
      [ORG_B, "m41c-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m41claim@x.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'123456','Synthetic Hospice','1234567893','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    const mk = async (kind: string, name: string) =>
      (
        await admin.query(
          "INSERT INTO payer (kind, name) VALUES ($1::payer_kind,$2) RETURNING id",
          [kind, name],
        )
      ).rows[0].id as string;
    medicarePayer = await mk("medicare", "Synthetic Medicare");
    medicaidPayer = await mk("medicaid", "Synthetic Medicaid");
    advantagePayer = await mk("medicare_advantage", "Synthetic Advantage");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    coverageReader = buildPatientCoverageReader(handle.db);
    actor = {
      organizationId: ORG,
      userId: USER,
      membershipId,
      actorKind: "user",
      stepUpRecent: true,
      billingScope: { all: false, providerEntityIds: [providerEntityId] },
    };
    otherProviderEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'654321','Synthetic Hospice Two','1245319599','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    const dummy = await seedScenario();
    const seams = seamsFor(dummy);
    assembly = buildCommercialClaimAssemblyService(handle.db, seams);
    lifecycle = buildCommercialClaimLifecycleService(handle.db, seams);
    authorizations = buildCommercialAuthorizationService(handle.db, seams);
    renderer = buildCommercial837iRenderer(handle.db, {
      coverage: coverageReader,
      caseload: seams.caseload,
      identity: {
        identityFor: async () => ({
          lastName: "Doe",
          firstName: "Jane",
          dateOfBirth: "1950-01-01",
          sex: "F",
          address: { line1: "200 Oak Ave", city: "Salem", state: "OR", postalCode: "97301" },
        }),
      },
      parties: {
        partiesFor: async ({ secondaryPayerKind }) => ({
          submitter: {
            name: "Example Hospice",
            id: "CHARTWARDEN01",
            contactName: "Billing Office",
            contactPhone: "5035550100",
          },
          receiver: { name: "Stedi Test Payer", id: "STEDI", applicationCode: "STEDI" },
          billingProvider: {
            organizationName: "Example Hospice",
            npi: "1234567893",
            taxId: "931234567",
            address: { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201" },
          },
          payerName: "Synthetic Commercial Health",
          secondaryPayer:
            secondaryPayerKind === null
              ? null
              : {
                  name:
                    secondaryPayerKind === "medicare" ? "Synthetic Medicare" : "Synthetic Medicaid",
                  payerId: secondaryPayerKind === "medicare" ? "MEDI01" : "MCD01",
                },
        }),
      },
    });
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  // ── S15 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("S15 valid commercial hospice claim", () => {
    it("assembles, validates clean, becomes ready and renders a correct 837I", async () => {
      const s = await seedScenario();
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      expect(out.state).toBe("draft");
      expect(out.tob).toBe("812"); // first interim bill of a stay still in progress
      expect(out.lineCount).toBe(1);
      expect(out.totalChargeCents).toBe(31 * 20_000);
      expect(out.expectedPaymentCents).toBe(31 * 20_000);
      expect(out.validation.blocking).toEqual([]);

      const ready = await w.lifecycle.assertReady(actor, out.claimId);
      expect(ready.state).toBe("ready");

      const rendered = await renderer.render(actor, {
        claimId: out.claimId,
        interchangeControlNumber: 1,
        usage: "T",
        createdAt: new Date("2026-04-02T15:00:00Z"),
      });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const segs = rendered.x12.split("~");
      expect(segs).toContain("SBR*P*18*GRP100******CI");
      expect(segs).toContain("NM1*IL*1*DOE*JANE****MI*MEM-0001234");
      expect(segs).toContain("NM1*PR*2*SYNTHETIC COMMERCIAL HEALTH*****PI*SYNTH01");
      expect(segs.some((x) => x.startsWith("CLM*") && x.includes("*6200.00***81:A:2"))).toBe(true);
      expect(segs).toContain("SV2*0651**6200.00*UN*31");
      expect(segs).toContain("DTP*472*RD8*20260301-20260331");
      expect(segs.some((x) => x.startsWith("SBR*S"))).toBe(false); // no other payer on a claim without COB
      expect(checkStediEdits(rendered.x12)).toEqual([]);
      // no HCPCS lines, so the JSON route cannot carry it: the raw X12 stands
      expect(rendered.stediJson).toBeNull();

      // draft -> ready history, the real catalog-validating publisher wrote both events, ids only
      const history = await admin.query(
        "SELECT from_state, to_state FROM commercial_claim_state_history WHERE claim_id=$1 ORDER BY created_at, to_state",
        [out.claimId],
      );
      expect(history.rows.map((r) => `${r.from_state}>${r.to_state}`)).toEqual([
        "null>draft",
        "draft>ready",
      ]);
      const events = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE event_type LIKE 'm41.%' AND payload->>'claimId'=$1",
        [out.claimId],
      );
      expect(events.rows.map((r) => r.event_type).sort()).toEqual([
        "m41.claim.draft_created",
        "m41.claim.ready_for_submission",
      ]);
      expect(JSON.stringify(events.rows)).not.toMatch(/MEM-0001234|GRP100|Doe|Jane/);
      // the row-level write audit fired and scrubbed the clinical snapshot
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='commercial_claim' AND resource_id=$1",
          [out.claimId],
        ),
      ).toBeGreaterThan(0);
      const stored = await admin.query("SELECT * FROM commercial_claim WHERE id=$1", [out.claimId]);
      expect(JSON.stringify(stored.rows[0])).not.toMatch(/MEM-0001234|GRP100/); // the member id is never stored
    });

    it("renders HCPCS site-of-service lines through the Stedi JSON route when the plan requires them", async () => {
      const s = await seedScenario({ siteHcpcs: true, group: null });
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      await w.lifecycle.assertReady(actor, out.claimId);
      const rendered = await renderer.render(actor, {
        claimId: out.claimId,
        interchangeControlNumber: 2,
        usage: "T",
        createdAt: new Date("2026-04-02T15:00:00Z"),
      });
      expect(rendered.ok && rendered.stediJson?.claimInformation.claimFilingCode).toBe("CI");
      expect(rendered.ok && /SV2\*0651\*HC:Q50\d\d\*6200\.00\*UN\*31/.test(rendered.x12)).toBe(
        true,
      ); // a CMS hospice site Q-code
    });

    it("intersects the contract rate periods with the claim window: a mid-month rate change makes two priced lines", async () => {
      const s = await seedScenario({
        rates: [
          {
            loc: "routine_home_care",
            code: "0651",
            basis: "per_diem",
            cents: 20_000,
            from: "2026-01-01",
            to: "2026-03-15",
          },
          {
            loc: "routine_home_care",
            code: "0651",
            basis: "per_diem",
            cents: 22_000,
            from: "2026-03-16",
            to: null,
          },
        ],
      });
      const out = await wire(s).assembly.assemble(actor, input(s));
      expect(out.lineCount).toBe(2);
      expect(out.totalChargeCents).toBe(15 * 20_000 + 16 * 22_000);
      expect(out.validation.blocking).toEqual([]);
    });

    it("blocks a stretch with no contract rate in effect (the database does not bound rates by the window)", async () => {
      const s = await seedScenario({
        rates: [
          {
            loc: "routine_home_care",
            code: "0651",
            basis: "per_diem",
            cents: 20_000,
            from: "2026-03-10",
            to: null,
          },
        ],
      });
      const out = await wire(s).assembly.assemble(actor, input(s));
      const rule = ruleOf(out.validation, "contract_rate_in_effect");
      expect(rule).toMatchObject({ outcome: "fail", overridable: false });
      expect(rule?.message).toContain("2026-03-01 to 2026-03-09");
      expect(out.expectedPaymentCents).toBeNull();
    });

    it("blocks a plan that ends inside the window and a route that is not in effect", async () => {
      const ended = await seedScenario({ planTo: "2026-03-20" });
      const a = await wire(ended).assembly.assemble(actor, input(ended));
      expect(ruleOf(a.validation, "plan_in_effect")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });
      const noRoute = await seedScenario({ routeFrom: "2026-04-01" });
      const b = await wire(noRoute).assembly.assemble(actor, input(noRoute));
      expect(ruleOf(b.validation, "payer_route_in_effect")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });
      const none = await seedScenario({ routeFrom: null });
      const c = await wire(none).assembly.assemble(actor, input(none));
      expect(ruleOf(c.validation, "payer_route_in_effect")?.outcome).toBe("fail");
    });

    it("blocks a plan whose payer was merged after the plan was created, naming the survivor", async () => {
      const s = await seedScenario();
      const survivor = (
        await admin.query(
          "INSERT INTO payer (kind, name) VALUES ('commercial','Synthetic Survivor') RETURNING id",
        )
      ).rows[0].id as string;
      await admin.query("UPDATE payer SET status='merged', merged_into_id=$2 WHERE id=$1", [
        s.payerId,
        survivor,
      ]);
      const out = await wire(s).assembly.assemble(actor, input(s));
      const rule = ruleOf(out.validation, "plan_payer_active");
      expect(rule).toMatchObject({ outcome: "fail", overridable: false });
      expect(rule?.message).toContain(survivor);
      await admin.query("UPDATE payer SET status='deactivated', merged_into_id=NULL WHERE id=$1", [
        s.payerId,
      ]);
      const again = await wire(s).lifecycle.validate(actor, out.claimId);
      expect(again.results.find((r) => r.ruleKey === "plan_payer_active")?.message).toContain(
        "deactivated",
      );
    });

    it("prices per-hour continuous care only from whole documented hours and blocks otherwise", async () => {
      const s = await seedScenario({
        rates: [
          {
            loc: "continuous_home_care",
            code: "0652",
            basis: "per_hour",
            cents: 5_000,
            from: "2026-01-01",
            to: null,
          },
        ],
      });
      const chc = (hours: number | null) => ({
        levelOfCare: {
          periodsInRange: async () => [
            {
              levelOfCarePeriodId: randomUUID(),
              levelOfCare: "continuous_home_care" as const,
              from: FROM,
              to: "2026-03-03",
              chcDocumentedHours: hours,
              gipAdmissionCriteriaDocumented: null,
            },
          ],
        },
      });
      const blocked = await wire(s, chc(null)).assembly.assemble(actor, {
        ...input(s),
        serviceTo: "2026-03-03",
      });
      expect(ruleOf(blocked.validation, "charge_priceable")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });
      const s2 = await seedScenario({
        rates: [
          {
            loc: "continuous_home_care",
            code: "0652",
            basis: "per_hour",
            cents: 5_000,
            from: "2026-01-01",
            to: null,
          },
        ],
      });
      const priced = await wire(s2, chc(24)).assembly.assemble(actor, {
        ...input(s2),
        serviceTo: "2026-03-03",
      });
      expect(priced.totalChargeCents).toBe(24 * 5_000);
      expect(priced.validation.blocking).toEqual([]);
    });

    it("refuses a window with no level-of-care period instead of failing on an empty insert", async () => {
      const s = await seedScenario();
      const err = await failure(
        wire(s, { levelOfCare: { periodsInRange: async () => [] } }).assembly.assemble(
          actor,
          input(s),
        ),
      );
      expect(err).toMatchObject({ code: "ASSEMBLY_VALIDATION_FAILED", statusCode: 422 });
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_claim WHERE patient_id=$1",
          [s.patientId],
        ),
      ).toBe(0);
    });

    it("refuses an overlapping window, an AI actor, and a patient with no plan for the payer", async () => {
      const s = await seedScenario();
      const w = wire(s);
      await w.assembly.assemble(actor, input(s));
      expect((await failure(w.assembly.assemble(actor, input(s))))?.message).toMatch(
        /already covers/,
      );
      expect(
        (await failure(w.assembly.assemble({ ...actor, actorKind: "ai_agent" }, input(s))))?.code,
      ).toBe("AI_ACTOR_FORBIDDEN");
      const noPlan = await seedScenario({ planFrom: "2026-06-01" });
      const err = await failure(wire(noPlan).assembly.assemble(actor, input(noPlan)));
      expect(err).toMatchObject({ code: "COMMERCIAL_PLAN_NOT_FOUND", statusCode: 422 });
    });
  });

  // ── S16 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("S16 commercial primary with Medicare or Medicaid secondary", () => {
    it("carries the COB data, emits loop 2320, and creates NO Medicare claim as primary", async () => {
      const s = await seedScenario();
      const medicareCoverage = await coverage(
        s.patientId,
        medicarePayer,
        2,
        "medicare_ffs",
        "1EG4TE5MK73",
      );
      const claimsBefore = await scalar<number>("SELECT count(*)::int AS n FROM claim");
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      expect(out.secondaryPayerKind).toBe("medicare");
      const row = (
        await admin.query(
          "SELECT secondary_patient_payer_id, secondary_payer_kind, primary_patient_payer_id FROM commercial_claim WHERE id=$1",
          [out.claimId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        secondary_patient_payer_id: medicareCoverage,
        secondary_payer_kind: "medicare",
        primary_patient_payer_id: s.primaryCoverageId,
      });
      expect(ruleOf(out.validation, "cob_secondary_declared")?.outcome).toBe("info");

      await w.lifecycle.assertReady(actor, out.claimId);
      const rendered = await renderer.render(actor, {
        claimId: out.claimId,
        interchangeControlNumber: 3,
        usage: "T",
        createdAt: new Date("2026-04-02T15:00:00Z"),
      });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const segs = rendered.x12.split("~");
      expect(segs).toContain("SBR*P*18*GRP100******CI"); // the commercial plan stays the primary
      expect(segs).toContain("SBR*S*18*******MA");
      expect(segs).toContain("NM1*IL*1*DOE*JANE****MI*1EG4TE5MK73");
      expect(segs).toContain("NM1*PR*2*SYNTHETIC MEDICARE*****PI*MEDI01");
      expect(rendered.stediJson).toBeNull(); // the JSON route cannot carry loop 2320: fail closed, raw X12 stands
      // nothing was created in the Medicare lane
      expect(await scalar<number>("SELECT count(*)::int AS n FROM claim")).toBe(claimsBefore);
    });

    it("M23 refuses the same patient exactly as this lane refuses a Medicare-primary one", async () => {
      const s = await seedScenario();
      await coverage(s.patientId, medicarePayer, 2, "medicare_ffs", "1EG4TE5MK73");
      const m23 = buildClaimAssemblyService(
        handle.db as never,
        {
          patientPayer: buildM23PatientPayerAdapter(() => coverageReader as never),
        } as never,
      );
      const m23Err = await failure(
        m23.assemble({ organizationId: ORG, userId: USER, membershipId, actorKind: "user" }, {
          providerEntityId,
          patientId: s.patientId,
          serviceFrom: FROM,
          serviceTo: TO,
        } as never),
      );
      expect(m23Err).toMatchObject({ code: "NON_MEDICARE_PRIMARY_PAYER", statusCode: 409 });

      // the mirror: Medicare FFS primary, commercial secondary -> M23 takes it, this lane refuses it
      const medicarePrimary = await seedScenario();
      await admin.query("DELETE FROM patient_payer WHERE patient_id=$1", [
        medicarePrimary.patientId,
      ]);
      await coverage(medicarePrimary.patientId, medicarePayer, 1, "medicare_ffs", "1EG4TE5MK73");
      await coverage(medicarePrimary.patientId, medicarePrimary.payerId, 2, "commercial", "MEM-9");
      const gate = await buildM23PatientPayerAdapter(
        () => coverageReader as never,
      ).medicarePrimaryForRange(ORG, medicarePrimary.patientId, { from: FROM, to: TO });
      expect(gate?.medicarePrimary).toBe(true);
      const err = await failure(
        wire(medicarePrimary).assembly.assemble(actor, input(medicarePrimary)),
      );
      expect(err).toMatchObject({ code: "NON_COMMERCIAL_PRIMARY_PAYER", statusCode: 409 });
      expect(err?.message).toMatch(/Module 23/);
    });

    it("supports Medicaid as the secondary and refuses Medicaid, Medicare Advantage, and no coverage as primary", async () => {
      const s = await seedScenario();
      await coverage(s.patientId, medicaidPayer, 2, "medicaid", "MCD12345");
      const out = await wire(s).assembly.assemble(actor, input(s));
      expect(out.secondaryPayerKind).toBe("medicaid");

      const medicaid = await seedScenario();
      await admin.query("DELETE FROM patient_payer WHERE patient_id=$1", [medicaid.patientId]);
      await coverage(medicaid.patientId, medicaidPayer, 1, "medicaid", "MCD1");
      expect(
        (await failure(wire(medicaid).assembly.assemble(actor, input(medicaid))))?.message,
      ).toMatch(/Module 24/);

      const ma = await seedScenario();
      await admin.query("DELETE FROM patient_payer WHERE patient_id=$1", [ma.patientId]);
      await coverage(ma.patientId, advantagePayer, 1, "medicare_advantage", "MA1");
      const maErr = await failure(wire(ma).assembly.assemble(actor, input(ma)));
      expect(maErr).toMatchObject({ code: "NON_COMMERCIAL_PRIMARY_PAYER", statusCode: 409 });
      expect(maErr?.message).toMatch(/Medicare contractor/);

      const none = await seedScenario();
      await admin.query("DELETE FROM patient_payer WHERE patient_id=$1", [none.patientId]);
      expect((await failure(wire(none).assembly.assemble(actor, input(none))))?.code).toBe(
        "NON_COMMERCIAL_PRIMARY_PAYER",
      );
    });

    it("refuses a primary coverage that changes inside the window", async () => {
      const s = await seedScenario();
      await admin.query("UPDATE patient_payer SET effective_to='2026-03-15' WHERE id=$1", [
        s.primaryCoverageId,
      ]);
      expect((await failure(wire(s).assembly.assemble(actor, input(s))))?.code).toBe(
        "COVERAGE_CHANGES_IN_WINDOW",
      );
    });
  });

  // ── S17 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("S17 pre-authorization missing or expired", () => {
    const readyEvents = (claimId: string) =>
      scalar<number>(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m41.claim.ready_for_submission' AND payload->>'claimId'=$1",
        [claimId],
      );

    it("hard-stops a claim with no authorization: actionable message, still a draft, nothing ready, no override path", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      const rule = ruleOf(out.validation, "authorization_on_file");
      expect(rule).toMatchObject({ outcome: "fail", overridable: false });
      expect(rule?.message).toMatch(
        /Pre-authorization is required and none covers routine_home_care 2026-03-01 to 2026-03-31/,
      );
      expect(rule?.message).toMatch(/Obtain and record the authorization/);

      const err = await failure(w.lifecycle.assertReady(actor, out.claimId));
      expect(err).toMatchObject({ code: "COMMERCIAL_CLAIM_BLOCKED", statusCode: 409 });
      expect(err?.message).toContain("Pre-authorization is required");
      expect(
        (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId])).rows[0]
          .state,
      ).toBe("draft");
      expect(await readyEvents(out.claimId)).toBe(0);

      // a hard block has no override path, even for a person who holds the permission and a fresh step-up
      const resultId = out.validation.results.find((r) => r.ruleKey === "authorization_on_file")
        ?.id as string;
      const overrideErr = await failure(
        w.lifecycle.overrideValidationResult(actor, out.claimId, {
          validationResultId: resultId,
          reason: REASON,
        }),
      );
      expect(overrideErr).toMatchObject({ code: "FORBIDDEN" });
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_validation_override WHERE claim_id=$1",
          [out.claimId],
        ),
      ).toBe(0);
    });

    it("reports an expired authorization as expired, ignores denied and voided ones, and clears once a covering one is recorded", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      const w = wire(s);
      const base = {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
      };
      await authorizations.record(actor, {
        ...base,
        authorizationNumber: "AUTH-1",
        effectiveTo: "2026-03-15",
      });
      const denied = await authorizations.record(actor, {
        ...base,
        authorizationNumber: "AUTH-2",
        effectiveTo: null,
      });
      await authorizations.setStatus(actor, denied.id, "denied");
      const out = await w.assembly.assemble(actor, input(s));
      const rule = ruleOf(out.validation, "authorization_on_file");
      expect(rule?.outcome).toBe("fail");
      expect(rule?.message).toMatch(/expired before routine_home_care 2026-03-16 to 2026-03-31/);
      expect(rule?.message).not.toMatch(/AUTH-/); // the authorization number never appears in a message

      await authorizations.record(actor, {
        ...base,
        authorizationNumber: "AUTH-3",
        effectiveFrom: "2026-03-16",
        effectiveTo: null,
      });
      const rerun = await w.lifecycle.validate(actor, out.claimId);
      expect(rerun.blocking).toEqual([]);
      expect((await w.lifecycle.assertReady(actor, out.claimId)).state).toBe("ready");

      // voiding the authorization later drops a READY claim back to draft on the next validation
      const covering = (
        await authorizations.listForPatient(actor, providerEntityId, s.patientId)
      ).find((a) => a.effectiveFrom === "2026-03-16");
      await authorizations.setStatus(actor, covering?.id as string, "voided");
      await w.lifecycle.validate(actor, out.claimId);
      expect(
        (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId])).rows[0]
          .state,
      ).toBe("draft");
    });

    it("requires a matching level of care when the plan authorizes per level of care", async () => {
      const s = await seedScenario({ authorization: "required_per_level_of_care" });
      const w = wire(s);
      await authorizations.record(actor, {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-GIP",
        levelOfCare: "general_inpatient",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
      });
      const out = await w.assembly.assemble(actor, input(s));
      expect(ruleOf(out.validation, "authorization_on_file")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });
      await authorizations.record(actor, {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-RHC",
        levelOfCare: "routine_home_care",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
      });
      expect((await w.lifecycle.validate(actor, out.claimId)).blocking).toEqual([]);
    });

    it("treats an unconfirmed requirement as a soft block that only an audited override clears", async () => {
      const s = await seedScenario({ authorization: "confirm_with_payer" });
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      const soft = out.validation.results.find((r) => r.ruleKey === "authorization_on_file");
      expect(soft).toMatchObject({ outcome: "fail", overridable: true, severity: "warn" });
      expect((await failure(w.lifecycle.assertReady(actor, out.claimId)))?.code).toBe(
        "COMMERCIAL_CLAIM_BLOCKED",
      );

      const attempt = (over: Partial<CommercialActor> = {}, reason = REASON) =>
        w.lifecycle.overrideValidationResult({ ...actor, ...over }, out.claimId, {
          validationResultId: soft?.id as string,
          reason,
        });
      const overrides = () =>
        scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_validation_override WHERE claim_id=$1",
          [out.claimId],
        );
      expect(await failure(attempt({ stepUpRecent: false }))).toBeInstanceOf(StepUpRequiredError);
      expect((await failure(attempt({ actorKind: "ai_agent" })))?.code).toBe("AI_ACTOR_FORBIDDEN");
      expect(await failure(attempt({}, "too short"))).toMatchObject({
        code: "VALIDATION_FAILED",
        statusCode: 422,
      });
      expect(await overrides()).toBe(0);

      const done = await attempt({
        request: {
          correlationId: randomUUID(),
          requestId: "req-1",
          sourceIp: "203.0.113.5",
          userAgent: "vitest",
        },
      });
      expect(await overrides()).toBe(1);
      // audit rows landed: the prominent M4 event (ids, rule key, reason LENGTH only) and the row-level trigger event, same correlation id
      const audit = await admin.query(
        "SELECT id, context, correlation_id FROM audit_event WHERE event_type='m41.validation.override_applied' AND resource_id=$1",
        [soft?.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].id).toBe(done.auditEventId);
      expect(audit.rows[0].context).toMatchObject({
        ruleKey: "authorization_on_file",
        claimId: out.claimId,
        reasonLength: REASON.length,
      });
      const rowAudit = await admin.query(
        "SELECT correlation_id, after FROM audit_event WHERE event_type='commercial_validation_override.insert'",
      );
      expect(rowAudit.rows.some((r) => r.correlation_id === audit.rows[0].correlation_id)).toBe(
        true,
      );
      expect(
        JSON.stringify(
          await admin.query(
            "SELECT context, before, after FROM audit_event WHERE correlation_id=$1",
            [audit.rows[0].correlation_id],
          ),
        ),
      ).not.toContain("telephone");
      const ob = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m41.claim.override_applied' AND payload->>'claimId'=$1",
        [out.claimId],
      );
      expect(ob.rows).toHaveLength(1);
      expect(JSON.stringify(ob.rows[0].payload)).not.toContain("telephone");

      // one override per result
      expect((await failure(attempt()))?.message).toMatch(/already been overridden/);
      // the claim is now ready; the override is bound to those facts
      expect((await w.lifecycle.assertReady(actor, out.claimId)).state).toBe("ready");
    });

    it("does not carry an override to different facts, and refuses a stale result", async () => {
      const s = await seedScenario({ authorization: "confirm_with_payer" });
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      const first = out.validation.results.find((r) => r.ruleKey === "authorization_on_file");
      await w.lifecycle.overrideValidationResult(actor, out.claimId, {
        validationResultId: first?.id as string,
        reason: REASON,
      });
      // a partial authorization changes the uncovered days, so the evidence (and its hash) changes
      await authorizations.record(actor, {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-P",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
        effectiveTo: "2026-03-10",
      });
      const rerun = await w.lifecycle.validate(actor, out.claimId);
      const second = rerun.results.find((r) => r.ruleKey === "authorization_on_file");
      expect(second).toMatchObject({ outcome: "fail", overridden: false, blocking: true });
      expect(
        (
          await failure(
            w.lifecycle.overrideValidationResult(actor, out.claimId, {
              validationResultId: first?.id as string,
              reason: REASON,
            }),
          )
        )?.message,
      ).toMatch(/earlier validation run/);
    });

    it("applies the plan's authorization lead time as an overridable warning", async () => {
      const s = await seedScenario({ authorization: "required_at_admission", lead: 5 });
      const w = wire(s);
      await authorizations.record(actor, {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-L",
        obtainedOn: "2026-02-28",
        effectiveFrom: "2026-03-01",
      });
      const out = await w.assembly.assemble(actor, input(s));
      expect(ruleOf(out.validation, "authorization_lead_time")).toMatchObject({
        outcome: "fail",
        overridable: true,
      });
      expect(ruleOf(out.validation, "authorization_on_file")?.outcome).toBe("pass");
    });
  });

  // ── tenancy and constraints ──────────────────────────────────────────────────────────────────────────────────────
  // ── scope: the DATA is checked against the actor, not only the entity named in the request ──────────────────────
  describe("scope: provider entity, caseload and admission binding", () => {
    const scoped = (ids: string[], all = false): CommercialActor => ({
      ...actor,
      billingScope: { all, providerEntityIds: ids },
    });
    const elsewhere = (): CommercialActor => scoped([otherProviderEntityId]);
    const noCaseload = { isInCaseload: async () => false };
    const admissionFor = (s: Scenario, pe: string | null) => ({
      resolveForRange: async () => ({
        admissionId: s.admissionId,
        providerEntityId: pe,
        hospiceAdmissionDate: "2026-03-01",
        admissionTypeCode: "1",
        admissionSourceCode: "1",
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        placeOfDeath: null,
        transferOut: null,
      }),
    });
    const claimCount = (patientId: string) =>
      scalar<number>("SELECT count(*)::int AS n FROM commercial_claim WHERE patient_id=$1", [
        patientId,
      ]);
    const authCount = (patientId: string) =>
      scalar<number>(
        "SELECT count(*)::int AS n FROM commercial_authorization WHERE patient_id=$1",
        [patientId],
      );
    const notFound = (e: { code?: string } | null) =>
      expect(e).toMatchObject({ code: "NOT_FOUND" });
    const recordBody = (s: Scenario, over: Record<string, unknown> = {}) => ({
      providerEntityId,
      patientId: s.patientId,
      planId: s.planId,
      authorizationNumber: `AUTH-${randomUUID().slice(0, 8)}`,
      obtainedOn: "2026-02-20",
      effectiveFrom: "2026-03-01",
      ...over,
    });

    it("assemble refuses an entity outside scope, a patient outside the caseload, and an admission under another entity", async () => {
      const s = await seedScenario();
      notFound(await failure(wire(s).assembly.assemble(elsewhere(), input(s))));
      notFound(await failure(wire(s, { caseload: noCaseload }).assembly.assemble(actor, input(s))));
      // the actor reaches the NAMED entity, but the patient's admission belongs to the other one
      notFound(
        await failure(
          wire(s, { admission: admissionFor(s, otherProviderEntityId) }).assembly.assemble(
            actor,
            input(s),
          ),
        ),
      );
      // an admission with no recorded entity cannot be bound either
      notFound(
        await failure(
          wire(s, { admission: admissionFor(s, null) }).assembly.assemble(actor, input(s)),
        ),
      );
      expect(await claimCount(s.patientId)).toBe(0);
      // an organization-wide billing actor skips the caseload axis (and only that axis)
      const broad = scoped([], true);
      const ok = await wire(s, { caseload: noCaseload }).assembly.assemble(broad, input(s));
      expect(ok.state).toBe("draft");
      // no billingScope at all fails closed
      const none = { ...actor, billingScope: undefined } as CommercialActor;
      const s2 = await seedScenario();
      notFound(await failure(wire(s2).assembly.assemble(none, input(s2))));
    });

    it("recording an authorization needs the entity in scope, the patient in the caseload and admitted under that entity", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      const svc = (over: Partial<CommercialClaimSeams> = {}) =>
        buildCommercialAuthorizationService(handle.db, seamsFor(s, over));
      notFound(
        await failure(
          svc().record(elsewhere(), recordBody(s, { providerEntityId: otherProviderEntityId })),
        ),
      );
      notFound(
        await failure(
          svc().record(actor, recordBody(s, { providerEntityId: otherProviderEntityId })),
        ),
      );
      notFound(await failure(svc({ caseload: noCaseload }).record(actor, recordBody(s))));
      notFound(
        await failure(
          svc({ admission: admissionFor(s, otherProviderEntityId) }).record(actor, recordBody(s)),
        ),
      );
      expect(await authCount(s.patientId)).toBe(0);
      expect((await svc().record(actor, recordBody(s))).status).toBe("approved");
      // a concurrent duplicate number is a 409, never a 500
      const dup = recordBody(s, { authorizationNumber: "AUTH-DUPLICATE" });
      const both = await Promise.all(
        [svc().record(actor, dup), svc().record(actor, dup)].map(failure),
      );
      expect(both.filter((e) => e?.code === "CONFLICT")).toHaveLength(1);
    });

    it("listing authorizations is filtered by the entity and refused across entities and outside the caseload", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      const svc = (over: Partial<CommercialClaimSeams> = {}) =>
        buildCommercialAuthorizationService(handle.db, seamsFor(s, over));
      await svc().record(actor, recordBody(s));
      // another entity's authorization for the same patient never appears in this entity's list
      await admin.query(
        `INSERT INTO commercial_authorization (organization_id, provider_entity_id, patient_id, plan_id, authorization_number, obtained_on, effective_from, created_by_membership_id)
         VALUES ($1,$2,$3,$4,'AUTH-OTHER-ENTITY','2026-02-20','2026-03-01',$5)`,
        [ORG, otherProviderEntityId, s.patientId, s.planId, membershipId],
      );
      const mine = await svc().listForPatient(actor, providerEntityId, s.patientId);
      expect(mine).toHaveLength(1);
      // reaching entity B and naming B for a patient admitted under A: refused (the ABAC check on B alone would pass)
      notFound(
        await failure(svc().listForPatient(elsewhere(), otherProviderEntityId, s.patientId)),
      );
      // naming an entity outside scope
      notFound(await failure(svc().listForPatient(elsewhere(), providerEntityId, s.patientId)));
      // outside the caseload
      notFound(
        await failure(
          svc({ caseload: noCaseload }).listForPatient(actor, providerEntityId, s.patientId),
        ),
      );
    });

    it("another entity's authorization never satisfies a claim, and changing one needs scope and caseload", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      await admin.query(
        `INSERT INTO commercial_authorization (organization_id, provider_entity_id, patient_id, plan_id, authorization_number, obtained_on, effective_from, created_by_membership_id)
         VALUES ($1,$2,$3,$4,'AUTH-OTHER-ENTITY','2026-02-20','2026-03-01',$5)`,
        [ORG, otherProviderEntityId, s.patientId, s.planId, membershipId],
      );
      const out = await wire(s).assembly.assemble(actor, input(s));
      expect(ruleOf(out.validation, "authorization_on_file")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });

      const svc = (over: Partial<CommercialClaimSeams> = {}) =>
        buildCommercialAuthorizationService(handle.db, seamsFor(s, over));
      const mine = await svc().record(actor, recordBody(s));
      notFound(await failure(svc().setStatus(elsewhere(), mine.id, "voided")));
      notFound(await failure(svc({ caseload: noCaseload }).setStatus(actor, mine.id, "voided")));
      expect((await svc().setStatus(actor, mine.id, "denied")).status).toBe("denied");
      expect((await failure(svc().setStatus(actor, mine.id, "voided")))?.code).toBe("CONFLICT"); // final once denied
    });

    it("claim lifecycle, reads and the 837I render refuse another entity's claim and a patient outside the caseload", async () => {
      const s = await seedScenario();
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      const soft = wire(s, { caseload: noCaseload });
      const reads = buildCommercialClaimReadService(handle.db, seamsFor(s));
      const readsDenied = buildCommercialClaimReadService(
        handle.db,
        seamsFor(s, { caseload: noCaseload }),
      );
      for (const [label, svc, who] of [
        ["entity", w.lifecycle, elsewhere()],
        ["caseload", soft.lifecycle, actor],
      ] as const) {
        notFound(await failure(svc.validate(who, out.claimId)));
        notFound(await failure(svc.markReady(who, out.claimId)));
        notFound(await failure(svc.voidClaim(who, out.claimId)));
        notFound(
          await failure(
            svc.overrideValidationResult(who, out.claimId, {
              validationResultId: out.validation.results[0]?.id as string,
              reason: REASON,
            }),
          ),
        );
        expect(label).toBeTruthy();
      }
      notFound(await failure(reads.getClaim(elsewhere(), out.claimId)));
      notFound(await failure(readsDenied.getClaim(actor, out.claimId)));
      expect((await reads.getClaim(actor, out.claimId)).lines).toHaveLength(1);
      await w.lifecycle.assertReady(actor, out.claimId);
      const deniedRenderer = buildCommercial837iRenderer(handle.db, {
        coverage: coverageReader,
        caseload: noCaseload,
        identity: { identityFor: async () => null },
        parties: { partiesFor: async () => null },
      });
      const args = {
        claimId: out.claimId,
        interchangeControlNumber: 9,
        usage: "T" as const,
        createdAt: new Date(),
      };
      notFound(await failure(renderer.render(elsewhere(), args)));
      notFound(await failure(deniedRenderer.render(actor, args)));
      // the claim is untouched by every refusal
      expect(
        (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId])).rows[0]
          .state,
      ).toBe("ready");
    });

    it("a ready claim whose authorization is voided falls back to draft on the ready check and cannot be rendered", async () => {
      const s = await seedScenario({ authorization: "required_at_admission" });
      const w = wire(s);
      const authSvc = buildCommercialAuthorizationService(handle.db, seamsFor(s));
      const a = await authSvc.record(actor, recordBody(s));
      const out = await w.assembly.assemble(actor, input(s));
      await w.lifecycle.assertReady(actor, out.claimId);
      const args = {
        claimId: out.claimId,
        interchangeControlNumber: 10,
        usage: "T" as const,
        createdAt: new Date("2026-04-02T15:00:00Z"),
      };
      expect((await renderer.render(actor, args)).ok).toBe(true);
      // an unrelated authorization (other patient, same plan) changing leaves this claim ready
      const unrelated = await seedScenario({ authorization: "required_at_admission" });
      const otherAuth = await buildCommercialAuthorizationService(
        handle.db,
        seamsFor(unrelated),
      ).record(actor, recordBody(unrelated));
      await buildCommercialAuthorizationService(handle.db, seamsFor(unrelated)).setStatus(
        actor,
        otherAuth.id,
        "voided",
      );
      const stateOf = async () =>
        (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId])).rows[0]
          .state;
      expect(await stateOf()).toBe("ready");
      // voiding the authorization it depends on demotes it IN THE SAME TRANSACTION (before any other call touches the claim)
      await authSvc.setStatus(actor, a.id, "voided");
      expect(await stateOf()).toBe("draft");
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_claim_state_history WHERE claim_id=$1 AND from_state='ready' AND to_state='draft'",
          [out.claimId],
        ),
      ).toBe(1);
      expect((await failure(renderer.render(actor, args)))?.code).toBe("COMMERCIAL_CLAIM_BLOCKED");
      expect((await failure(w.lifecycle.assertReady(actor, out.claimId)))?.code).toBe(
        "COMMERCIAL_CLAIM_BLOCKED",
      );
      expect(
        (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId])).rows[0]
          .state,
      ).toBe("draft");
    });
  });

  // ── concurrency and integrity backstops ─────────────────────────────────────────────────────────────────────────
  describe("concurrency and integrity", () => {
    it("two concurrent assemblies of the same or overlapping windows: exactly one commits, the other is a 409", async () => {
      const s = await seedScenario();
      const w = wire(s);
      const same = await Promise.all(
        [w.assembly.assemble(actor, input(s)), w.assembly.assemble(actor, input(s))].map(failure),
      );
      expect(same.filter((e) => e === null)).toHaveLength(1);
      expect(same.find((e) => e !== null)?.code).toBe("CONFLICT");
      const t = await seedScenario();
      const wt = wire(t);
      const overlap = await Promise.all(
        [
          wt.assembly.assemble(actor, { ...input(t), serviceTo: "2026-03-20" }),
          wt.assembly.assemble(actor, { ...input(t), serviceFrom: "2026-03-10" }),
        ].map(failure),
      );
      expect(overlap.filter((e) => e === null)).toHaveLength(1);
      expect(
        await scalar<number>(
          "SELECT count(*)::int AS n FROM commercial_claim WHERE patient_id=$1",
          [t.patientId],
        ),
      ).toBe(1);
    });

    it("a void claim stays void: ready racing a void loses with a clean 409, and the database refuses void -> anything", async () => {
      for (const order of ["ready-first", "void-first"] as const) {
        const s = await seedScenario();
        const w = wire(s);
        const out = await w.assembly.assemble(actor, input(s));
        const readyCall = () => w.lifecycle.markReady(actor, out.claimId);
        const voidCall = () => w.lifecycle.voidClaim(actor, out.claimId);
        const [first, second] =
          order === "ready-first" ? [readyCall, voidCall] : [voidCall, readyCall];
        const results = await Promise.all([first, second].map((f) => failure(f())));
        for (const e of results) if (e !== null) expect(e.code).toBe("CONFLICT"); // never a raw trigger error (a 500)
        expect(
          (await admin.query("SELECT state FROM commercial_claim WHERE id=$1", [out.claimId]))
            .rows[0].state,
        ).toBe("void");
      }
      const s = await seedScenario();
      const out = await wire(s).assembly.assemble(actor, input(s));
      await wire(s).lifecycle.voidClaim(actor, out.claimId);
      const revive = await admin
        .query("UPDATE commercial_claim SET state='draft' WHERE id=$1", [out.claimId])
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(revive).toMatch(/M41_CLAIM_VOID_IS_FINAL/);
    });

    it("allows adjacent windows and re-assembly after a void (with the right bill type); the database refuses an overlapping live claim", async () => {
      const s = await seedScenario();
      const w = wire(s);
      const first = await w.assembly.assemble(actor, { ...input(s), serviceTo: "2026-03-15" });
      const adjacent = await w.assembly.assemble(actor, { ...input(s), serviceFrom: "2026-03-16" });
      expect([first.tob, adjacent.tob]).toEqual(["812", "813"]);
      await w.lifecycle.voidClaim(actor, first.claimId);
      // the first window again: it is the FIRST bill of the stay even though a later claim exists
      const again = await w.assembly.assemble(actor, { ...input(s), serviceTo: "2026-03-15" });
      expect(again.tob).toBe("812");
      const overlap = await admin
        .query(
          `INSERT INTO commercial_claim (id, organization_id, provider_entity_id, patient_id, admission_id, plan_id, primary_patient_payer_id, claim_filing_indicator, tob, frequency_code, service_from, service_to, admission_date, patient_status_code, claim_control_number, total_charge_cents, created_by_membership_id)
           SELECT gen_random_uuid(), organization_id, provider_entity_id, patient_id, admission_id, plan_id, primary_patient_payer_id, claim_filing_indicator, tob, frequency_code, '2026-03-10', '2026-03-20', admission_date, patient_status_code, 'OVERLAP-1', 0, created_by_membership_id
             FROM commercial_claim WHERE id=$1`,
          [adjacent.claimId],
        )
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(overlap).toMatch(/commercial_claim_no_overlap/);
    });

    it("tolerates an unbilled discharge day on a final bill, and only there", async () => {
      const s = await seedScenario();
      const period = {
        levelOfCarePeriodId: randomUUID(),
        levelOfCare: "routine_home_care" as const,
        from: "2026-03-01",
        to: "2026-03-30",
        chcDocumentedHours: null,
        gipAdmissionCriteriaDocumented: null,
      };
      const discharged = {
        resolveForRange: async () => ({
          admissionId: s.admissionId,
          providerEntityId,
          hospiceAdmissionDate: "2026-03-01",
          admissionTypeCode: "1",
          admissionSourceCode: "1",
          dischargeDate: "2026-03-31",
          dischargeReason: "no_longer_terminal",
          deceasedDate: null,
          placeOfDeath: null,
          transferOut: null,
        }),
      };
      const final = await wire(s, {
        admission: discharged,
        levelOfCare: { periodsInRange: async () => [period] },
      }).assembly.assemble(actor, input(s));
      expect(final.tob).toBe("811");
      expect(ruleOf(final.validation, "service_days_covered")?.outcome).toBe("pass");
      const interim = await seedScenario();
      const open = await wire(interim, {
        levelOfCare: { periodsInRange: async () => [period] },
      }).assembly.assemble(actor, input(interim));
      expect(ruleOf(open.validation, "service_days_covered")?.outcome).toBe("fail");
    });

    it("applies the plan's eligibility policy (#724): block turns a missing check into a hard stop, a recent active check clears it", async () => {
      const s = await seedScenario();
      await admin.query(
        "UPDATE commercial_payer_plan SET eligibility_staleness_policy='block' WHERE id=$1",
        [s.planId],
      );
      const w = wire(s);
      const out = await w.assembly.assemble(actor, input(s));
      expect(ruleOf(out.validation, "eligibility_freshness")).toMatchObject({
        outcome: "fail",
        overridable: false,
      });
      expect((await failure(w.lifecycle.assertReady(actor, out.claimId)))?.code).toBe(
        "COMMERCIAL_CLAIM_BLOCKED",
      );
      await admin.query(
        `INSERT INTO commercial_eligibility_check (organization_id, provider_entity_id, patient_id, plan_id, patient_payer_id, clearinghouse_key, clearinghouse_payer_id, service_date, outcome, as_of_date, request_id, idempotency_key, checked_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'stedi','SYNTH01','2026-03-01','active',current_date,$6,$7,$8)`,
        [
          ORG,
          providerEntityId,
          s.patientId,
          s.planId,
          s.primaryCoverageId,
          randomUUID(),
          `idem-${randomUUID()}`,
          USER,
        ],
      );
      expect((await w.lifecycle.assertReady(actor, out.claimId)).state).toBe("ready");
      // under the default policy (warn) a missing check is visible but never blocks
      const lenient = await seedScenario();
      const l = await wire(lenient).assembly.assemble(actor, input(lenient));
      expect(ruleOf(l.validation, "eligibility_freshness")).toMatchObject({
        outcome: "fail",
        severity: "info",
      });
      expect(l.validation.blocking).toEqual([]);
    });

    it("blocks a claim whose lines leave a day of the window unbilled or bill one twice", async () => {
      const hole = await seedScenario();
      const period = (from: string, to: string) => ({
        levelOfCarePeriodId: randomUUID(),
        levelOfCare: "routine_home_care" as const,
        from,
        to,
        chcDocumentedHours: null,
        gipAdmissionCriteriaDocumented: null,
      });
      const gap = await wire(hole, {
        levelOfCare: {
          periodsInRange: async () => [
            period("2026-03-01", "2026-03-10"),
            period("2026-03-20", "2026-03-31"),
          ],
        },
      }).assembly.assemble(actor, input(hole));
      const gapRule = ruleOf(gap.validation, "service_days_covered");
      expect(gapRule).toMatchObject({ outcome: "fail", overridable: false });
      expect(gapRule?.message).toContain("2026-03-11 to 2026-03-19");
      const dbl = await seedScenario();
      const twice = await wire(dbl, {
        levelOfCare: {
          periodsInRange: async () => [
            period("2026-03-01", "2026-03-20"),
            period("2026-03-15", "2026-03-31"),
          ],
        },
      }).assembly.assemble(actor, input(dbl));
      expect(ruleOf(twice.validation, "service_days_covered")?.message).toContain("Billed twice");
    });

    it("keeps a line's rate, an override's result and the run pointers inside their own organization and claim", async () => {
      const s = await seedScenario({ authorization: "confirm_with_payer" });
      const out = await wire(s).assembly.assemble(actor, input(s));
      const other = await seedScenario({ authorization: "confirm_with_payer" });
      const otherOut = await wire(other).assembly.assemble(actor, input(other));
      // a claim cannot point at another claim's run (composite FK on the run id plus the organization)
      const stray = await admin
        .query("UPDATE commercial_claim SET latest_validation_run_id=$2 WHERE id=$1", [
          out.claimId,
          randomUUID(),
        ])
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(stray).toMatch(/latest_run_fk|foreign key/);
      // an override row cannot name a result of different facts (claim / rule / evidence) than its own columns
      const resultId = otherOut.validation.results.find(
        (r) => r.ruleKey === "authorization_on_file",
      )?.id as string;
      const mismatched = await admin
        .query(
          `INSERT INTO commercial_validation_override (organization_id, provider_entity_id, claim_id, validation_result_id, rule_key, evidence_hash, override_membership_id, reason, m4_audit_event_id)
           VALUES ($1,$2,$3,$4,'authorization_on_file',repeat('a',64),$5,$6,$7)`,
          [ORG, providerEntityId, out.claimId, resultId, membershipId, REASON, randomUUID()],
        )
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(mismatched).toMatch(/override_result_fk|foreign key/);
      // the frequency code always matches the bill type
      const freq = await admin
        .query("UPDATE commercial_claim SET frequency_code='4' WHERE id=$1", [out.claimId])
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(freq).toMatch(/frequency_matches_tob/);
    });
  });

  describe("tenancy and constraints", () => {
    const TABLES = [
      "commercial_authorization",
      "commercial_claim",
      "commercial_claim_line",
      "commercial_claim_state_history",
      "commercial_validation_run",
      "commercial_validation_result",
      "commercial_validation_override",
    ];

    it("forces RLS, isolates tenants, and gives the app role no DELETE", async () => {
      const { rows } = await admin.query(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)",
        [TABLES],
      );
      expect(rows).toHaveLength(TABLES.length);
      for (const r of rows)
        expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([
          r.relname,
          true,
          true,
        ]);
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        for (const t of TABLES) {
          await app.query("BEGIN");
          await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
          expect((await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
          await app.query("ROLLBACK");
          await app.query("BEGIN");
          await app.query("SELECT set_config('app.org_id', $1, true)", [ORG]);
          const del = await app.query(`DELETE FROM ${t}`).then(
            () => "",
            (e: Error) => e.message,
          );
          expect(del).toMatch(/permission denied/);
          await app.query("ROLLBACK");
        }
      } finally {
        await app.end();
      }
    });

    it("keeps assembly output immutable for the app role and enforces the override reason floor in the database", async () => {
      const s = await seedScenario();
      const out = await wire(s).assembly.assemble(actor, input(s));
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id', $1, true)", [ORG]);
        const upd = await app
          .query("UPDATE commercial_claim SET total_charge_cents=1 WHERE id=$1", [out.claimId])
          .then(
            () => "",
            (e: Error) => e.message,
          );
        expect(upd).toMatch(/permission denied/);
        await app.query("ROLLBACK");
      } finally {
        await app.end();
      }
      const short = await admin
        .query(
          `INSERT INTO commercial_validation_override (organization_id, provider_entity_id, claim_id, validation_result_id, rule_key, evidence_hash, override_membership_id, reason, m4_audit_event_id)
           SELECT organization_id, provider_entity_id, claim_id, id, rule_key, evidence_hash, $2, 'short', $3 FROM commercial_validation_result WHERE claim_id=$1 LIMIT 1`,
          [out.claimId, membershipId, randomUUID()],
        )
        .then(
          () => "",
          (e: Error) => e.message,
        );
      expect(short).toMatch(/reason/);
    });
  });
});
