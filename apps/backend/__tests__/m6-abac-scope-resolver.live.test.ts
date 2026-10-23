/**
 * GAP-011 — the five NEW child-resource `admission.scope` loaders (deceased-db.ts's sibling in
 * admission-route-service-db.ts: `loadElectionPeriodScope`/`loadElectionStatementScope`/
 * `loadCtiScope`/`loadF2fScope`/`loadLocScope`), proven against real Postgres. Each does a real join
 * (election_period/level_of_care_period → admission directly; election_statement/certification_of_
 * terminal_illness/face_to_face_encounters → election_period → admission) — provable only against a
 * live cluster, not the in-memory slice admission-routes.test.ts already covers.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run \
 *   apps/backend/__tests__/m6-abac-scope-resolver.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ORG_WIDE_SCOPE_ROLES, hasOrgWideScope } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";
import { buildAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
// #44 — the elected hospice this suite's setup admission elects. `draftElectionStatement` now
// PERSISTS the election (it used to validate its fields and forward one) and fails CLOSED when the
// org-check port is unbound, so the id has to be a real row of ORG_A's rather than a free uuid.
const PROVIDER_ENTITY = "99999999-9999-4999-8999-999999999999";
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)(
  "M6 admission.scope child-resource resolvers — LIVE Postgres (GAP-011)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;
    let resolver: ReturnType<typeof createDbAdmissionAbacResolver>;

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

    /**
     * Referral → triage → qualify → accept → NOR ack → election sign → CTI hospice+attending sign → activate: a
     * FULLY ACTIVE admission (the `changeLoc` write below requires active/on_hold — the m6-discharge-
     * f2f-loc-write.live.test.ts `activeAdmission` precedent, condensed to what THIS suite needs: the
     * election-statement/CTI/LOC ids to resolve scope through, not a fresh CTI/F2F/LOC state-machine
     * proof of its own).
     */
    async function activeAdmission(
      patientId: string,
    ): Promise<{ admissionId: string; periodId: string; electionStatementId: string }> {
      // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: ORG_A,
        actorUserId: USER,
        patientId,
      });
      const periods = await svc.listElectionPeriods(ORG_A, admissionId);
      const periodId = periods![0].id;
      const nor = await svc.acknowledgeNor(
        ORG_A,
        admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
      await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      const cti = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
      expect(active.state).toBe("active");
      return { admissionId, periodId, electionStatementId: es.id };
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6gap011@x.test')`, [USER]);
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'CCN-GAP011','GAP-011 Hospice','NPI-GAP011','enc','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
      });
      registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult
      // Bound to the REAL predicate over the seeded entity, exactly as the T3/T4 suites do. The
      // deliberately-unbound 503 stays asserted in T3, where it is the subject rather than setup.
      svc = createDbAdmissionRouteService(handle.db, undefined, undefined, {
        async belongsToOrg(organizationId, providerEntityId) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      });
      resolver = createDbAdmissionAbacResolver(handle.db);
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("resolves the SAME {patientId, providerEntityId} as loadAdmission for every child resource kind", async () => {
      const { admissionId, periodId, electionStatementId } = await activeAdmission(randomUUID());
      // The CTI activation used above is voided/superseded by nothing — draft a SECOND (recert) CTI on a
      // fresh period so this test also proves the cti/f2f/loc loaders independently of the activation CTI.
      const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
      const cti = await svc.draftCti(
        ORG_A,
        { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
        USER,
      );
      const f2f = await svc.scheduleF2f(ORG_A, {
        admissionId,
        electionPeriodId: periodId,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_md",
        actor: SYSTEM_F2F_ACTOR,
      });
      const loc = await svc.changeLoc(ORG_A, admissionId, "routine_home_care");

      const admissionFacts = await resolver.loadAdmission(ORG_A, admissionId);
      expect(admissionFacts).not.toBeNull();

      await expect(resolver.loadElectionPeriodScope(ORG_A, periodId)).resolves.toEqual(
        admissionFacts,
      );
      await expect(
        resolver.loadElectionStatementScope(ORG_A, electionStatementId),
      ).resolves.toEqual(admissionFacts);
      await expect(resolver.loadCtiScope(ORG_A, cti.id)).resolves.toEqual(admissionFacts);
      await expect(resolver.loadF2fScope(ORG_A, f2f.id)).resolves.toEqual(admissionFacts);
      await expect(resolver.loadLocScope(ORG_A, loc.id)).resolves.toEqual(admissionFacts);
    });

    // #605 — list/detail agreement. The census lists every admission to any role in ORG_WIDE_SCOPE_ROLES
    // (`readScopeOf` → hasOrgWideScope), so the detail + readiness reads (`admission.scope`, real resolver, real
    // NOBYPASSRLS connection) must open that admission too — unless the role is NAMED below with a reason.
    // A role with no site match and no caseload row, on a SITED admission, is the failing shape.
    const LIST_DETAIL_DISAGREEMENTS: Readonly<Record<string, string>> = {
      // Deliberately NOT widened by #605 (ADR-0090 names only administrator / org_admin for M6). Each is listed by
      // the census but refused detail/readiness on a sited admission outside its caseload — a follow-up decision.
      // Facts: the census lists each via hasOrgWideScope; admission.scope has no role arm for any of them (only
      // medical_director, administrator/org_admin, and the UNSITED-only roles), so a SITED admission opens only
      // via a provider-entity match or a caseload row, neither of which these test contexts hold. See #613.
      compliance_officer: "census lists all via hasOrgWideScope; admission.scope has no org-wide arm for it and no entity/caseload match (#613)",
      director_of_nursing: "floor patient.read role: census lists all via hasOrgWideScope; admission.scope has no org-wide arm and no entity/caseload match (#613)",
      survey_coordinator: "census lists all via hasOrgWideScope; admission.scope has no org-wide arm for it and no entity/caseload match (#613)",
    };

    it("every ORG_WIDE_SCOPE_ROLES role that the census lists an admission to can open it (or is named)", async () => {
      const { admissionId, periodId } = await activeAdmission(randomUUID());
      const facts = await resolver.loadAdmission(ORG_A, admissionId);
      expect(facts?.providerEntityId).not.toBeNull(); // SITED — the shape #605 broke
      const predicates = buildAdmissionAbacPredicates({ resolver, isInCaseload: async () => false });
      const disagree: string[] = [];
      for (const role of ORG_WIDE_SCOPE_ROLES) {
        const ctx = {
          organizationId: ORG_A,
          userId: USER,
          roles: [role],
          providerEntityIds: [],
          locationIds: [],
          attributes: {},
        };
        expect(hasOrgWideScope([role])).toBe(true); // the census lists it
        const detail = await predicates["admission.scope"]!(ctx, { id: admissionId });
        const child = await predicates["admission.scope"]!(ctx, {
          id: periodId,
          resourceKind: "electionPeriod",
        });
        if (!(detail && child)) disagree.push(role);
      }
      // The named exceptions are exactly the disagreements: a stale entry fails as loudly as a new gap.
      expect(disagree.sort()).toEqual(Object.keys(LIST_DETAIL_DISAGREEMENTS).sort());
    });

    it("fails closed (null) for an absent id and for a cross-tenant id (RLS-backstopped)", async () => {
      const { admissionId } = await activeAdmission(randomUUID());
      const p2 = await svc.createElectionPeriod(ORG_A, admissionId);
      const cti = await svc.draftCti(
        ORG_A,
        { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
        USER,
      );

      const missing = randomUUID();
      await expect(resolver.loadElectionPeriodScope(ORG_A, missing)).resolves.toBeNull();
      await expect(resolver.loadElectionStatementScope(ORG_A, missing)).resolves.toBeNull();
      await expect(resolver.loadCtiScope(ORG_A, missing)).resolves.toBeNull();
      await expect(resolver.loadF2fScope(ORG_A, missing)).resolves.toBeNull();
      await expect(resolver.loadLocScope(ORG_A, missing)).resolves.toBeNull();

      // A real CTI id, but resolved under ORG_B's tenant context — RLS hides it, same as absent.
      await expect(resolver.loadCtiScope(ORG_B, cti.id)).resolves.toBeNull();
    });
  },
);
