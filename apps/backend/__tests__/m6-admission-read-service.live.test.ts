/**
 * M6L-T01 — the Drizzle `createDbAdmissionRouteService` READ paths, proven against real Postgres.
 *
 * The unit suites exercise the in-memory slice; this drives the PRODUCTION read service (the one the
 * composition root now mounts) over the real M6 tables under `withOrgContext` — proving the census /
 * detail / election-period / compliance-window reads return the right rows, the R-AC-01 activation gate
 * is computed from the period-1 bundle, RLS scopes every read by tenant, and every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:read:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  AdmissionNotFoundError,
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const OTHER_PATIENT = "66666666-6666-4666-8666-666666666666";
const PHYSICIAN = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M6 Drizzle read service — LIVE Postgres (M6L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbAdmissionRouteService>;
  const seeded: Record<string, { admission: string; otherAdmission?: string }> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one admission chain for `org` (active admission, period 1, signed statement, hospice-signed CTI, NOR). */
  async function seedOrg(org: string, n: number) {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M6R${n}`, `M6R ${n}`, `NPI-M6R${n}`],
      )
    ).rows[0].id;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe, `Loc-M6R${n}`],
      )
    ).rows[0].id;
    const admission = (
      await admin.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
           admitted_by_physician_id, status, admission_at, activated_at)
         VALUES ($1,$2,$3,$4,$5,'active', now() - interval '1 day', now() - interval '1 day') RETURNING id`,
        [org, pe, loc, PATIENT, PHYSICIAN],
      )
    ).rows[0].id;
    const period = (
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status)
         VALUES ($1,$2,1,'ninety_day','active') RETURNING id`,
        [org, admission],
      )
    ).rows[0].id;
    // A SIGNED statement is `status = 'signed'` (migration 0124's drafted → signed → voided lifecycle;
    // the column defaults to 'drafted'). Only that status yields election-signature evidence
    // (backfillLegacyEvidenceForAdmission, and migration 0220's backfill: status='signed' AND signed_at).
    await admin.query(
      `INSERT INTO election_statement (organization_id, election_period_id, patient_id, signer_kind,
         patient_name_at_signing, hospice_name_at_signing, curative_care_acknowledgment, signed_at,
         signature_method, status)
       VALUES ($1,$2,$3,'patient','Jane Doe','M6R Hospice',true, now()::date, 'electronic_witnessed', 'signed')`,
      [org, period, PATIENT],
    );
    await admin.query(
      `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
         terminal_diagnosis_icd10, narrative, period_start, period_end, hospice_md_signed_at)
       VALUES ($1,$2,$3,'C34.90','Terminal', now()::date, now()::date + 90, now())`,
      [org, period, PHYSICIAN],
    );
    await admin.query(
      `INSERT INTO notice_of_rights_acknowledgment (organization_id, admission_id, patient_id, signer_kind,
         acknowledged_at, acknowledgment_method)
       VALUES ($1,$2,$3,'patient', now()::date, 'electronic_witnessed')`,
      [org, admission, PATIENT],
    );
    seeded[org] = { admission };
  }

  async function seedOtherAdmissionForOrgA() {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-M6R-OTHER','M6R Other','NPI-M6R-OTHER','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-M6R-Other','2 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id;
    seeded[ORG_A].otherAdmission = (
      await admin.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
           admitted_by_physician_id, status, admission_at)
         VALUES ($1,$2,$3,$4,$5,'active', now() - interval '2 days') RETURNING id`,
        [ORG_A, pe, loc, OTHER_PATIENT, PHYSICIAN],
      )
    ).rows[0].id;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m6r@x.test')`, [USER]);
    await seedOrg(ORG_A, 1);
    await seedOtherAdmissionForOrgA();
    await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role (a login role SET ROLEs to it); `withOrgContext`
    // deliberately does NOT SET ROLE. To exercise RLS faithfully here, connect the client AS chartwarden_app —
    // it is NOLOGIN in the migrations, so grant LOGIN for the throwaway run.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbAdmissionRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listAdmissions returns the org's admission (RLS-scoped), newest-first paging shape", async () => {
    // Newest-first is ORDER BY admission_at DESC: the primary admission (admitted 1 day ago) precedes
    // the other one (admitted 2 days ago — seeded strictly older so the order is deterministic).
    const page = await service.listAdmissions(ORG_A, {});
    expect(page.items.length).toBe(2);
    expect(page.items[0].id).toBe(seeded[ORG_A].admission);
    expect(page.items[1].id).toBe(seeded[ORG_A].otherAdmission);
    expect(page.items[0].state).toBe("active");
    expect(page.nextCursor).toBeNull();
  });

  it("listAdmissions filters by patientId inside the org scope", async () => {
    const page = await service.listAdmissions(ORG_A, { state: "active", patientId: PATIENT });
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(seeded[ORG_A].admission);
    expect(ids).not.toContain(seeded[ORG_A].otherAdmission);
    expect(page.nextCursor).toBeNull();
  });

  // F-195 (#248) — `holdReason`/`holdAt`/`releasedAt` were write-only until this round; `listAdmissions`
  // (M30's own `?state=on_hold` dashboard read) now projects them. Holds then resumes within one test so
  // later tests in this file still find the seeded admission `active`, as they assume.
  it("listAdmissions surfaces holdReason/holdAt/releasedAt after a real hold and resume", async () => {
    const before = await service.listAdmissions(ORG_A, { patientId: PATIENT });
    const preRow = before.items.find((i) => i.id === seeded[ORG_A].admission);
    expect(preRow?.holdReason ?? null).toBeNull();
    expect(preRow?.holdAt ?? null).toBeNull();
    expect(preRow?.releasedAt ?? null).toBeNull();

    const held = await service.holdAdmission(
      ORG_A,
      seeded[ORG_A].admission,
      "family request",
      preRow!.version,
    );
    expect(held.state).toBe("on_hold");

    const onHold = await service.listAdmissions(ORG_A, { patientId: PATIENT });
    const heldRow = onHold.items.find((i) => i.id === seeded[ORG_A].admission);
    expect(heldRow?.holdReason).toBe("family request");
    expect(heldRow?.holdAt).not.toBeNull();
    expect(heldRow?.releasedAt).toBeNull();

    const resumed = await service.resumeAdmission(ORG_A, seeded[ORG_A].admission, held.version);
    expect(resumed.state).toBe("active");

    const afterResume = await service.listAdmissions(ORG_A, { patientId: PATIENT });
    const resumedRow = afterResume.items.find((i) => i.id === seeded[ORG_A].admission);
    // holdReason/holdAt are never cleared by a resume (the D7-adjacent "what happened and when" facts
    // are historical, not a live status flag — `admission.status` is the live flag); releasedAt is set.
    expect(resumedRow?.holdReason).toBe("family request");
    expect(resumedRow?.holdAt).not.toBeNull();
    expect(resumedRow?.releasedAt).not.toBeNull();
  });

  it("getAdmission returns AdmissionDetail with the R-AC-01 activation gate computed from period-1", async () => {
    const detail = await service.getAdmission(ORG_A, seeded[ORG_A].admission);
    expect(detail).not.toBeNull();
    expect(detail?.state).toBe("active");
    // election signed + NOR ack + hospice-MD CTI signed → gate ready. R-AC-01
    // (intake/activation-gate.ts computeActivationGate): "the attending-physician CTI signature is not
    // an activation prerequisite" — the unsigned attending no longer blocks (no `attending_signed` gap).
    expect(detail?.activationGate.ready).toBe(true);
    expect(detail?.activationGate.missing).toEqual([]);
  });

  it("RLS: org B cannot see org A's admission through the read service", async () => {
    const page = await service.listAdmissions(ORG_B, {});
    expect(page.items.every((i) => i.id !== seeded[ORG_A].admission)).toBe(true);
    const cross = await service.getAdmission(ORG_B, seeded[ORG_A].admission);
    expect(cross).toBeNull();
  });

  it("AdmissionStatusReader reads with an explicit org scope without ambient request context", async () => {
    const reader = createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db));

    const summary = await reader.getAdmissionSummary(ORG_A, seeded[ORG_A].admission);
    expect(summary.admissionId).toBe(seeded[ORG_A].admission);
    expect(summary.organizationId).toBe(ORG_A);

    await expect(reader.getAdmissionSummary(ORG_B, seeded[ORG_A].admission)).rejects.toBeInstanceOf(
      AdmissionNotFoundError,
    );
  });

  it("listElectionPeriods returns the ladder for a real admission, null for an unknown one", async () => {
    const rows = await service.listElectionPeriods(ORG_A, seeded[ORG_A].admission);
    expect(rows?.length).toBe(1);
    expect(rows?.[0].state).toBe("active");
    expect(await service.listElectionPeriods(ORG_A, PATIENT /* not an admission id */)).toBeNull();
  });

  it("keeps pre-migration compliance facts explicitly unknown in detail reads", async () => {
    const admissionId = seeded[ORG_A].admission;
    expect(await service.getNor(ORG_A, admissionId)).toMatchObject({
      state: "acknowledged",
      acknowledgedAtInstant: null,
      acknowledgedByName: null,
    });
    expect(await service.getNor(ORG_B, admissionId)).toBeNull();
    const period = (await service.listElectionPeriods(ORG_A, admissionId))![0];
    const [statement] = (
      await admin.query("SELECT id FROM election_statement WHERE election_period_id=$1", [
        period.id,
      ])
    ).rows;
    const [cti] = (
      await admin.query(
        "SELECT id FROM certification_of_terminal_illness WHERE election_period_id=$1",
        [period.id],
      )
    ).rows;
    expect(await service.getElectionStatement(ORG_A, statement.id)).toMatchObject({
      effectiveDate: null,
      primaryDiagnosisIcd10: null,
    });
    expect(await service.getCti(ORG_A, cti.id)).toMatchObject({
      prognosisStatement: null,
      clinicalFindings: null,
    });
    expect(await service.getElectionStatement(ORG_B, statement.id)).toBeNull();
    expect(await service.getCti(ORG_B, cti.id)).toBeNull();
  });

  it("getPatientElectionCertification assembles the patient's admission + period ladder + cert bundles", async () => {
    const res = await service.getPatientElectionCertification(ORG_A, PATIENT);
    expect(res.admission).not.toBeNull();
    expect(res.admission?.id).toBe(seeded[ORG_A].admission);
    expect(res.admission?.state).toBe("active");
    expect(res.periods.length).toBe(1);
    const p = res.periods[0];
    expect(p.sequenceNumber).toBe(1);
    expect(p.status).toBe("active");
    // A signed election statement + hospice-signed CTI were seeded; the attending has not signed, and no
    // F2F exists on period 1 → the bundle reflects exactly that.
    expect(p.electionStatement?.signerKind).toBe("patient");
    expect(p.cti?.hospiceMdSigned).toBe(true);
    expect(p.cti?.attendingMdSigned).toBe(false);
    expect(p.faceToFace).toBeNull();
  });

  it("getPatientElectionCertification is a truthful empty (admission null) for a patient with no admission", async () => {
    const NO_ADMISSION_PATIENT = "99999999-9999-9999-9999-999999999999";
    const res = await service.getPatientElectionCertification(ORG_A, NO_ADMISSION_PATIENT);
    expect(res.admission).toBeNull();
    expect(res.periods).toEqual([]);
    expect(res.complianceWindows).toEqual([]);
  });

  it("RLS: getPatientElectionCertification scopes to the caller's org for a cross-tenant patient literal", async () => {
    // Both orgs seeded an admission for the SAME patient id; each caller must resolve ONLY its own row.
    const a = await service.getPatientElectionCertification(ORG_A, PATIENT);
    const b = await service.getPatientElectionCertification(ORG_B, PATIENT);
    expect(a.admission?.id).toBe(seeded[ORG_A].admission);
    expect(b.admission?.id).toBe(seeded[ORG_B].admission);
    expect(b.admission?.id).not.toBe(seeded[ORG_A].admission);
  });

  it("closeComplianceWindow closes an open window (T05 — the whole M6 write lifecycle is now live)", async () => {
    // Every M6 write is live now (T02–T05); seed one open window and prove the close path drives it to
    // `closed` under the unprivileged role. Override is exercised in the dedicated T05 write suite.
    const { rows } = await admin.query(
      `INSERT INTO compliance_window (organization_id, admission_id, window_kind, starts_at, must_complete_by)
       VALUES ($1,$2,'notice_of_rights', now(), now() + interval '48 hours') RETURNING id`,
      [ORG_A, seeded[ORG_A].admission],
    );
    const closed = await service.closeComplianceWindow(ORG_A, rows[0].id, 0);
    expect(closed.state).toBe("closed");
  });

  // Finding 9 — an assignee / note author is shown by NAME, resolved server-side through the IN-ORG membership
  // join (name only). A user with no membership in the caller's org must resolve to null, never leak a name.
  it("referral reads carry the assignee/author display name via the in-org membership, null across orgs", async () => {
    const OUTSIDER = "77777777-7777-4777-8777-777777777777";
    await admin.query(`UPDATE "user" SET name = 'Nora Visit, RN' WHERE id = $1`, [USER]);
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'outsider@x.test','Olivia Outsider')`,
      [OUTSIDER],
    );
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [USER, ORG_A],
    );
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [OUTSIDER, ORG_B],
    );
    const mk = async (assignee: string) =>
      (
        await admin.query(
          `INSERT INTO referral (organization_id, patient_name_at_receipt, source_channel, assigned_to_user_id)
           VALUES ($1,'Pat Ient','phone',$2) RETURNING id`,
          [ORG_A, assignee],
        )
      ).rows[0].id as string;
    const inOrg = await mk(USER);
    const outsider = await mk(OUTSIDER);
    await admin.query(
      `INSERT INTO referral_note (organization_id, referral_id, author_id, content)
      VALUES ($1,$2,$3,'called family')`,
      [ORG_A, inOrg, USER],
    );

    const page = await service.listReferrals(ORG_A, {}, undefined, undefined);
    expect(page.items.find((r) => r.id === inOrg)?.assignedToDisplayName).toBe("Nora Visit, RN");
    expect(page.items.find((r) => r.id === outsider)?.assignedToDisplayName).toBeNull();
    expect((await service.getReferral(ORG_A, inOrg))?.assignedToDisplayName).toBe("Nora Visit, RN");
    expect((await service.getReferral(ORG_A, outsider))?.assignedToDisplayName).toBeNull();
    const notes = await service.listReferralNotes(ORG_A, inOrg);
    expect(notes[0]?.authorDisplayName).toBe("Nora Visit, RN");
  });
});
