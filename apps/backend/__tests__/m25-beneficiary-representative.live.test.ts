/**
 * M25 beneficiary-filed appeals and appointments of representative, milestone 13a (hospice ADR/TPE/QIC PRD) - LIVE Postgres as
 * the NOBYPASSRLS `chartwarden_app` role, through the real services, routes, seams and database triggers.
 *
 * Record-keeping only. Proves what the pure suites cannot: tenancy and provider-entity scope; the signed document is validated
 * against M22's ACTIVE version (another patient's, a Part 2, a superseded or another admission's document is refused) and the
 * validated version id is persisted; an appointment is activated only by a SECOND person (service, route with step-up, AND the
 * database trigger, atomically, under a race); a beneficiary appeal never touches appeal_case / denial_case and coexists with a
 * hospice appeal of the same tier; recorded deadlines on it alert once per boundary and never for a past date, with an ids-only
 * payload; the read audit lands with a resource id; an appointment writes no portal, consent or caregiver row; an auditor-style
 * read-only principal cannot read any of it; and migrations 1240-1242 re-apply idempotently.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:beneficiary-representative:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { FormatRegistry } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import {
  createDocumentReader,
  createDrizzleDocumentReaderStore,
} from "../src/modules/22-documents/index";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleAuditRequestService } from "../src/modules/25-remittance/routes/audit-request-service";
import { buildDrizzleBeneficiaryAppealService } from "../src/modules/25-remittance/routes/beneficiary-appeal-service";
import { registerBeneficiaryAppealRoutes } from "../src/modules/25-remittance/routes/beneficiary-appeal.routes";
import { buildDrizzleCaseViewService } from "../src/modules/25-remittance/routes/case-view-service";
import { registerCaseViewRoutes } from "../src/modules/25-remittance/routes/case-view.routes";
import { buildDrizzleLaterTierService } from "../src/modules/25-remittance/routes/later-tier-service";
import { buildSeamLinkedDocumentPort } from "../src/modules/25-remittance/routes/linked-document";
import { buildDrizzleRepresentativeService } from "../src/modules/25-remittance/routes/representative-service";
import { registerRepresentativeRoutes } from "../src/modules/25-remittance/routes/representative.routes";
import { type M7Fixture, ORG, ORG_B, daysAgo, daysAhead, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MBI = "1EG4-TE5-MK73";
const PRIVATE_NAME = "Fixture Representative Person";

describe.skipIf(!DB_URL)(
  "M25 beneficiary appeals and representatives (milestone 13a) - LIVE Postgres",
  () => {
    let fx: M7Fixture;
    let userR = "";
    let memberR = "";
    let userS = "";
    let memberS = "";
    let patient1 = "";
    let patient1b = "";
    let admission1 = "";

    const providerZones = (tx: DbClient, pe: string) =>
      buildFoundationSiteReader().providerEntityTimezones(tx, pe);
    const rep = () =>
      buildDrizzleRepresentativeService(fx.handle.db, { documents: buildSeamLinkedDocumentPort() });
    const ben = () =>
      buildDrizzleBeneficiaryAppealService(fx.handle.db, {
        documents: buildSeamLinkedDocumentPort(),
      });
    const tier = () =>
      buildDrizzleLaterTierService(fx.handle.db, {
        providerZones,
        sources: buildSeamAppealSourcePorts(),
      });
    const A = () => fx.actor();
    const R = () => ({ ...fx.actor(), userId: userR, membershipId: memberR });
    const S = () => ({ ...fx.actor(), userId: userS, membershipId: memberS });
    const B = () => fx.actor(ORG_B);
    const apptRow = async (id: string) =>
      (await fx.admin.query("SELECT * FROM representative_appointment WHERE id=$1", [id])).rows[0];
    const count = async (table: string) =>
      Number((await fx.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

    async function seedDoc(
      patientId: string | null,
      over: { retention?: string; status?: string; admissionId?: string | null } = {},
    ): Promise<{ documentId: string; versionId: string }> {
      const documentId = (
        await fx.admin.query(
          `INSERT INTO document (organization_id, patient_id, admission_id, retention_class, source_kind, aggregate_type,
             title, status, created_by_membership_id)
           VALUES ($1,$2,$3,$4,'user_upload','other','Fixture doc',$5,$6) RETURNING id`,
          [
            ORG,
            patientId,
            over.admissionId ?? null,
            over.retention ?? "clinical_record",
            over.status ?? "active",
            fx.memberA,
          ],
        )
      ).rows[0].id as string;
      const versionId = await addVersion(documentId, "1");
      return { documentId, versionId };
    }
    async function addVersion(documentId: string, n: string): Promise<string> {
      const versionId = (
        await fx.admin.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size,
             sha256_hex, uploaded_by_membership_id, uploaded_by_kind)
           VALUES ($1,$2,$3,$4,'application/pdf','10',$5,$6,'user') RETURNING id`,
          [ORG, documentId, n, `k-${randomUUID()}`, "a".repeat(64), fx.memberA],
        )
      ).rows[0].id as string;
      await fx.admin.query("UPDATE document SET active_version_id=$2 WHERE id=$1", [
        documentId,
        versionId,
      ]);
      return versionId;
    }

    async function formVersion(
      elements: string[] = ["Fixture element one", "Fixture element two"],
    ) {
      const f = await rep().createFormVersion(A(), {
        label: `Fixture form ${randomUUID().slice(0, 6)}`,
        formIdentifier: "as entered",
        editionText: "as entered",
        sourceNote: "fixture source",
        requiredElements: elements,
      });
      return f.id;
    }
    const draftBody = (formVersionId: string, over: Record<string, unknown> = {}) => ({
      instrumentKind: "org_form",
      formVersionId,
      representativeName: PRIVATE_NAME,
      relationshipLabel: "daughter",
      representativeKind: "family_or_friend",
      beneficiarySignedOn: daysAgo(5),
      representativeSignedOn: daysAgo(4),
      ...over,
    });
    /** A draft recorded by `actor` (default the billing user) from claim1, with its document and every element confirmed. */
    async function readyDraft(
      actor: ReturnType<typeof A> = A(),
      over: Record<string, unknown> = {},
    ): Promise<string> {
      const fv = await formVersion();
      const created = await rep().createDraft(actor, fx.claim1, draftBody(fv, over) as never);
      const doc = await seedDoc(patient1);
      let v = (
        await rep().attachDocument(
          actor,
          created.id,
          { documentId: doc.documentId, documentVersionId: doc.versionId },
          created.version,
        )
      ).version;
      v = (
        await rep().confirmElements(
          actor,
          created.id,
          ["Fixture element one", "Fixture element two"],
          v,
        )
      ).version;
      return created.id;
    }
    const ver = (id: string) => fx.ver("representative_appointment", id);
    const bver = (id: string) => fx.ver("beneficiary_appeal", id);
    const intake = (over: Record<string, unknown> = {}) => ({
      filerKind: "beneficiary",
      tierLabel: "redetermination",
      filedOn: daysAgo(3),
      externalReference: "ref-1",
      sourceNote: "family telephoned the office",
      ...over,
    });

    async function cron(nowFn: () => Date = () => new Date()) {
      const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
      await runAppealDeadlineCron({
        connection: {} as never,
        db: fx.handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
        alerts: { dispatch: async (a) => void dispatched.push(a) },
        now: nowFn,
      });
      return dispatched;
    }
    const recordedAlerts = (
      all: { alertCode: string; payload: Record<string, unknown> }[],
      id: string,
    ) =>
      all.filter(
        (a) => a.alertCode === "deadline.recorded_approaching" && a.payload.deadlineId === id,
      );

    function makeApp(keys: string[], opts: { stepUp?: boolean; asUserR?: boolean } = {}) {
      resetAuthorizationContract();
      resetRbacEngine();
      const userId = opts.asUserR ? userR : fx.userA;
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          {
            orgId: ORG,
            userId,
            grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
          },
        ]).store,
      );
      const registry = createPredicateRegistry();
      registry.register(
        "step_up_recent",
        async (context) => context.attributes.stepUpRecent === true,
      );
      registerAbacRegistry(registry);
      const app = buildServer({
        db: fx.handle.db as never,
        authenticate: (request: FastifyRequest) => {
          request.context.userId = userId;
          request.context.organizationId = ORG;
          request.context.roles = ["billing_manager"];
          request.context.providerEntityIds = [fx.pe1, fx.pe2];
          request.context.attributes = {
            ...request.context.attributes,
            membershipId: opts.asUserR ? memberR : fx.memberA,
            ...(opts.stepUp ? { stepUpRecent: true } : {}),
          };
        },
        security: { rateLimitEnabled: false },
      });
      registerRepresentativeRoutes(app, { representativeService: rep() });
      registerBeneficiaryAppealRoutes(app, {
        beneficiaryAppealService: ben(),
        laterTierService: tier(),
      });
      registerCaseViewRoutes(app, { caseViewService: buildDrizzleCaseViewService(fx.handle.db) });
      return app;
    }
    const WRITE = (version?: number) => ({
      "idempotency-key": randomUUID(),
      ...(version === undefined ? {} : { "if-match": String(version) }),
    });
    const ALL_KEYS = [
      "appeal.read",
      "beneficiary_appeal.read",
      "beneficiary_appeal.manage",
      "representative.read",
      "representative.manage",
      "representative.verify",
      "representative_form.configure",
    ];

    beforeAll(async () => {
      fx = await setupM7Fixture(DB_URL as string, "m25-m13a");
      registerM23PublishedSeams(fx.handle.db);
      registerSeam(
        "DocumentReader",
        createDocumentReader(createDrizzleDocumentReaderStore(fx.handle.db)),
      );
      const mk = async (tag: string) => {
        const user = (
          await fx.admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `m25-m13a-${tag}@x.test`,
          ])
        ).rows[0].id as string;
        const member = (
          await fx.admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [user, ORG],
          )
        ).rows[0].id as string;
        return { user, member };
      };
      ({ user: userR, member: memberR } = await mk("r"));
      ({ user: userS, member: memberS } = await mk("s"));
      const claimRow = async (claim: string) =>
        (await fx.admin.query("SELECT patient_id, admission_id FROM claim WHERE id=$1", [claim]))
          .rows[0];
      patient1 = (await claimRow(fx.claim1)).patient_id as string;
      admission1 = (await claimRow(fx.claim1)).admission_id as string;
      patient1b = (await claimRow(fx.claim1b)).patient_id as string;
    }, 300_000);

    afterAll(async () => {
      await fx?.close();
      resetAuthorizationContract();
      resetRbacEngine();
    });

    // ── schema posture ───────────────────────────────────────────────────────────────────────────────────
    it("registers the six keys, forces RLS on all five tables, denies the app role DELETE and re-applies 1240-1242 idempotently", async () => {
      const keys = (
        await fx.admin.query(
          `SELECT key FROM permission WHERE key LIKE 'beneficiary_appeal.%' OR key LIKE 'representative%' ORDER BY key`,
        )
      ).rows
        .map((r) => r.key as string)
        .sort();
      expect(keys).toEqual(
        [
          "beneficiary_appeal.manage",
          "beneficiary_appeal.read",
          "representative.manage",
          "representative.read",
          "representative.verify",
          "representative_form.configure",
        ].sort(),
      );
      for (const t of [
        "representative_form_version",
        "representative_appointment",
        "beneficiary_appeal",
        "beneficiary_appeal_document",
        "beneficiary_appeal_event",
      ]) {
        const forced = await fx.admin.query(
          "SELECT 1 FROM pg_class WHERE relname=$1 AND relrowsecurity AND relforcerowsecurity",
          [t],
        );
        expect(forced.rowCount, t).toBe(1);
        const msg = await fx.dbMessage(fx.asApp((tx) => tx.execute(sql.raw(`DELETE FROM ${t}`))));
        expect(msg, t).toMatch(/permission denied/i);
      }
      // the one-subject constraint now names all four subject columns
      const def = (
        await fx.admin.query(
          `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='recorded_deadline_one_subject'`,
        )
      ).rows[0].d as string;
      for (const col of [
        "appeal_case_id",
        "audit_request_id",
        "payer_appeal_case_id",
        "beneficiary_appeal_id",
      ]) {
        expect(def).toContain(col);
      }
      for (const f of [
        "1240_m25_beneficiary_representative.sql",
        "1241_m25_recorded_deadline_beneficiary_appeal.sql",
        "1242_m25_m13_role_grants.sql",
      ]) {
        const text = readFileSync(join(fx.migrationsDir, f), "utf8");
        await fx.admin.query(text);
        await fx.admin.query(text);
      }
    });

    it("grants the keys to roles holding appeal.read / appeal.create / mac_rule.manage / named compliance roles (1242) without copying an ABAC override or reaching an external_auditor role", async () => {
      const mkRole = async (key: string, sources: string[]) => {
        const roleId = (
          await fx.admin.query(
            `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'billing_finance',true) RETURNING id`,
            [ORG, key],
          )
        ).rows[0].id as string;
        for (const k of sources) {
          await fx.admin.query(
            `INSERT INTO role_permission (organization_id, role_id, permission_key, abac_override) VALUES ($1,$2,$3,'narrowed_predicate')`,
            [ORG, roleId, k],
          );
        }
        return roleId;
      };
      const biller = await mkRole("m13a-biller", ["appeal.read", "appeal.create"]);
      // a billing lead who edits MAC rules is NOT thereby a verifier; verify / configure are opt-in
      const lead = await mkRole("m13a-lead", ["mac_rule.manage"]);
      const compliance = await mkRole("compliance_officer", []);
      const admin = await mkRole("administrator", []);
      const auditor = await mkRole("m13a-external_auditor", ["audit.read"]);
      await fx.admin.query(
        readFileSync(join(fx.migrationsDir, "1242_m25_m13_role_grants.sql"), "utf8"),
      );
      const held = async (role: string) =>
        (
          await fx.admin.query(
            `SELECT permission_key, abac_override FROM role_permission WHERE role_id=$1 AND (permission_key LIKE 'beneficiary_appeal.%' OR permission_key LIKE 'representative%') ORDER BY 1`,
            [role],
          )
        ).rows.sort((a, b) => (a.permission_key < b.permission_key ? -1 : 1));
      expect((await held(biller)).map((r) => r.permission_key)).toEqual([
        "beneficiary_appeal.manage",
        "beneficiary_appeal.read",
        "representative.manage",
        "representative.read",
      ]);
      expect(await held(lead)).toEqual([]);
      for (const named of [compliance, admin]) {
        expect((await held(named)).map((r) => r.permission_key)).toEqual([
          "representative.read",
          "representative.verify",
          "representative_form.configure",
        ]);
      }
      expect((await held(biller)).every((r) => r.abac_override === null)).toBe(true);
      expect(await held(auditor)).toEqual([]);
    });

    // ── form versions: nothing seeded ────────────────────────────────────────────────────────────────────
    it("seeds no form version; a version needs a source note, is frozen once written and retires; a draft cannot use a retired version", async () => {
      expect((await rep().listFormVersions(B())).items).toEqual([]);
      expect(
        (
          await fx.refused(
            rep().createFormVersion(A(), { label: "L", sourceNote: " ", requiredElements: [] }),
          )
        )?.code,
      ).toBe("FORM_SOURCE_NOTE_REQUIRED");
      const fvId = await formVersion();
      const listed = (await rep().listFormVersions(A())).items.find((f) => f.id === fvId);
      expect(listed).toMatchObject({
        sourceNote: "fixture source",
        requiredElements: ["Fixture element one", "Fixture element two"],
        retiredAt: null,
      });
      // the database refuses an edit of anything but retiring
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE representative_form_version SET version = version + 1 WHERE id='${fvId}'`,
            ),
          ),
        ),
      );
      expect(msg).toMatch(/M25_REP_FORM_FROZEN/);
      const retired = await rep().retireFormVersion(A(), fvId, listed?.version as number);
      expect(retired.version).toBe(2);
      expect(
        (await fx.refused(rep().createDraft(A(), fx.claim1, draftBody(fvId) as never)))?.code,
      ).toBe("FORM_VERSION_UNAVAILABLE");
      // another tenant's version is invisible
      expect(
        (await fx.refused(rep().createDraft(A(), fx.claim1, draftBody(randomUUID()) as never)))
          ?.code,
      ).toBe("FORM_VERSION_UNAVAILABLE");
    });

    // ── an appointment: recorded from a claim ───────────────────────────────────────────────────────────
    it("records a draft from a claim: patient and provider entity come from the claim; free text rejects a Medicare number; the instrument rules hold", async () => {
      const fv = await formVersion();
      const created = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      const row = await apptRow(created.id);
      expect(row).toMatchObject({
        patient_id: patient1,
        provider_entity_id: fx.pe1,
        recorded_from_claim_id: fx.claim1,
        state: "draft",
        recorded_by_membership_id: fx.memberA,
      });
      expect(row.elements_confirmed).toEqual([
        { label: "Fixture element one", state: "missing" },
        { label: "Fixture element two", state: "missing" },
      ]);
      for (const field of [
        "representativeName",
        "relationshipLabel",
        "instrumentNote",
        "validitySourceNote",
      ]) {
        const refusal = await fx.refused(
          rep().createDraft(
            A(),
            fx.claim1,
            draftBody(fv, {
              validThroughOn: daysAhead(30),
              validitySourceNote: "form",
              [field]: `see ${MBI}`,
            }) as never,
          ),
        );
        expect(refusal?.code, field).toBe("APPOINTMENT_MBI_IN_FREE_TEXT");
      }
      expect(
        (
          await fx.refused(
            rep().createDraft(
              A(),
              fx.claim1,
              draftBody(fv, { representativeKind: "hospice_staff" }) as never,
            ),
          )
        )?.code,
      ).toBe("APPOINTMENT_KIND_INVALID");
      // another written instrument needs its note and carries no element list
      const other = await rep().createDraft(A(), fx.claim1, {
        instrumentKind: "other_written_instrument",
        instrumentNote: "signed letter",
        representativeName: "Fixture Person",
        representativeKind: "attorney",
      });
      expect((await apptRow(other.id)).elements_confirmed).toEqual([]);
      // a validity end needs its source note; never computed
      const withEnd = await rep().createDraft(
        A(),
        fx.claim1,
        draftBody(fv, {
          validThroughOn: daysAhead(100),
          validitySourceNote: "signed form, section 3",
        }) as never,
      );
      expect((await apptRow(withEnd.id)).valid_through_on).toBeTruthy();
      expect(
        (
          await fx.refused(
            rep().createDraft(
              A(),
              fx.claim1,
              draftBody(fv, { validThroughOn: daysAhead(100) }) as never,
            ),
          )
        )?.code,
      ).toBe("APPOINTMENT_VALIDITY_PAIR_REQUIRED");
      const noEnd = await rep().getAppointment(A(), created.id);
      expect(noEnd).toMatchObject({ validThroughOn: null, status: "draft", patientId: patient1 });
    });

    it("an out-of-scope claim reads as absent, and another tenant sees nothing", async () => {
      const fv = await formVersion();
      const outOfScope = fx.actor(ORG, [fx.pe2]);
      expect(
        (await fx.refused(rep().createDraft(outOfScope, fx.claim1, draftBody(fv) as never)))
          ?.statusCode,
      ).toBe(404);
      expect((await fx.refused(rep().listForClaim(outOfScope, fx.claim1)))?.statusCode).toBe(404);
      expect(
        (await fx.refused(ben().create(outOfScope, fx.claim1, intake() as never)))?.statusCode,
      ).toBe(404);
      expect((await fx.refused(ben().listForClaim(outOfScope, fx.claim1)))?.statusCode).toBe(404);
      const id = await readyDraft();
      expect(await rep().getAppointment(B(), id)).toBeNull();
      expect((await fx.refused(rep().listForClaim(B(), fx.claim1)))?.statusCode).toBe(404);
      expect(
        (await fx.refused(rep().revoke(B(), id, { revokedOn: daysAgo(0), note: "n" }, 1)))
          ?.statusCode,
      ).toBe(404);
      const rows = await fx.asApp(
        (tx) => tx.execute(sql.raw("SELECT id FROM representative_appointment")) as never,
        ORG_B,
      );
      expect((rows as unknown as { rows: unknown[] }).rows).toEqual([]);
    });

    // ── documents: the M22 active-version check ─────────────────────────────────────────────────────────
    it("validates the signed document against M22 before linking and persists the validated version id", async () => {
      const fv = await formVersion();
      const created = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      let v = created.version;
      const good = await seedDoc(patient1);
      const other = await seedDoc(patient1b);
      const part2 = await seedDoc(patient1, { retention: "compliance_42cfr_part2" });
      const noPatient = await seedDoc(null);
      const superseded = await seedDoc(patient1, { status: "superseded" });
      const refuse = (d: { documentId: string; versionId: string }) =>
        fx.refused(
          rep().attachDocument(
            A(),
            created.id,
            { documentId: d.documentId, documentVersionId: d.versionId },
            v,
          ),
        );
      expect((await refuse(other))?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
      expect((await refuse(other))?.message).toContain("other_patient");
      expect((await refuse(part2))?.message).toContain("part2_restricted");
      expect((await refuse(noPatient))?.message).toContain("other_patient");
      expect((await refuse(superseded))?.message).toContain("not_active");
      expect(
        (
          await fx.refused(
            rep().attachDocument(
              A(),
              created.id,
              { documentId: randomUUID(), documentVersionId: randomUUID() },
              v,
            ),
          )
        )?.message,
      ).toContain("not_found");
      // a stale version of an otherwise good document, and a version of a different document
      const stale = await seedDoc(patient1);
      const newer = await addVersion(stale.documentId, "2");
      expect(
        (await refuse({ documentId: stale.documentId, versionId: stale.versionId }))?.code,
      ).toBe("DOCUMENT_VERSION_UNAVAILABLE");
      expect((await refuse({ documentId: good.documentId, versionId: newer }))?.code).toBe(
        "DOCUMENT_VERSION_UNAVAILABLE",
      );
      expect((await apptRow(created.id)).document_id).toBeNull();
      v = (
        await rep().attachDocument(
          A(),
          created.id,
          { documentId: good.documentId, documentVersionId: good.versionId },
          v,
        )
      ).version;
      expect(await apptRow(created.id)).toMatchObject({
        document_id: good.documentId,
        document_version_id: good.versionId,
      });
      // a version superseded after attaching blocks activation until a person re-attaches the current one
      v = (
        await rep().confirmElements(
          A(),
          created.id,
          ["Fixture element one", "Fixture element two"],
          v,
        )
      ).version;
      await addVersion(good.documentId, "2");
      expect((await fx.refused(rep().activate(R(), created.id, v)))?.code).toBe(
        "DOCUMENT_VERSION_UNAVAILABLE",
      );
    });

    // ── activation: a second person, atomically ─────────────────────────────────────────────────────────
    it("refuses activation without a document, with a missing element, and by the recorder (service and database); no row changes on refusal", async () => {
      const fv = await formVersion();
      const created = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      expect((await fx.refused(rep().activate(R(), created.id, created.version)))?.code).toBe(
        "APPOINTMENT_NO_DOCUMENT",
      );
      const doc = await seedDoc(patient1);
      let v = (
        await rep().attachDocument(
          A(),
          created.id,
          { documentId: doc.documentId, documentVersionId: doc.versionId },
          created.version,
        )
      ).version;
      expect((await fx.refused(rep().activate(R(), created.id, v)))?.code).toBe(
        "APPOINTMENT_ELEMENTS_INCOMPLETE",
      );
      v = (await rep().confirmElements(A(), created.id, ["Fixture element one"], v)).version;
      expect((await fx.refused(rep().activate(R(), created.id, v)))?.code).toBe(
        "APPOINTMENT_ELEMENTS_INCOMPLETE",
      );
      v = (
        await rep().confirmElements(
          A(),
          created.id,
          ["Fixture element one", "Fixture element two"],
          v,
        )
      ).version;
      expect(
        (await fx.refused(rep().confirmElements(A(), created.id, ["nonsense"], v)))?.code,
      ).toBe("ELEMENT_UNKNOWN");
      // the recorder cannot activate it
      expect((await fx.refused(rep().activate(A(), created.id, v)))?.code).toBe(
        "APPOINTMENT_ACTIVATOR_IS_RECORDER",
      );
      // nor can SQL: the trigger decides it atomically on the UPDATE, whatever the application checked
      const sqlActivate = (verifier: string, id = created.id) =>
        fx.dbMessage(
          fx.asApp((tx) =>
            tx.execute(
              sql.raw(
                `UPDATE representative_appointment SET state='active', verified_by_membership_id='${verifier}', verified_at=now() WHERE id='${id}'`,
              ),
            ),
          ),
        );
      expect(await sqlActivate(fx.memberA)).toMatch(/M25_REP_VERIFIER/);
      expect(await sqlActivate(randomUUID())).toMatch(/not an active member of this organization/);
      const bare = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      expect(await sqlActivate(memberR, bare.id)).toMatch(/M25_REP_NO_DOCUMENT/);
      expect((await apptRow(created.id)).state).toBe("draft");
      // the same PERSON under another membership row is not a second person (compare users, not membership ids)
      const oldSeat = (
        await fx.admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'revoked') RETURNING id`,
          [userR, ORG],
        )
      ).rows[0].id as string;
      const bySamePerson = await readyDraft(R());
      await fx.admin.query(
        "UPDATE representative_appointment SET recorded_by_membership_id=$2 WHERE id=$1",
        [bySamePerson, oldSeat],
      );
      expect(await sqlActivate(memberR, bySamePerson)).toMatch(/different person \(user\)/);
      const revokedVerifier = (
        await fx.admin.query(`SELECT id FROM membership WHERE id=$1`, [oldSeat])
      ).rows[0].id as string;
      expect(await sqlActivate(revokedVerifier)).toMatch(/not an active member/);
      // a second person activates
      const ok = await rep().activate(R(), created.id, v);
      expect(ok.version).toBe(v + 1);
      expect(await apptRow(created.id)).toMatchObject({
        state: "active",
        verified_by_membership_id: memberR,
      });
      // an incomplete checklist cannot be activated through SQL either
      const half = await readyDraft();
      await fx.admin.query(
        `UPDATE representative_appointment SET elements_confirmed = '[{"label":"Fixture element one","state":"confirmed"},{"label":"Fixture element two","state":"missing"}]'::jsonb WHERE id=$1`,
        [half],
      );
      expect(await sqlActivate(memberR, half)).toMatch(/M25_REP_ELEMENTS_INCOMPLETE/);
    });

    it("lets exactly one of two concurrent activations win (service vs raw SQL), and the loser fails the way it should", async () => {
      const id = await readyDraft();
      // the racers are neither the recorder nor the last editor, so only the race decides
      const before = await apptRow(id);
      expect([before.recorded_by_membership_id, before.last_edited_by_membership_id]).not.toContain(
        memberS,
      );
      expect([before.recorded_by_membership_id, before.last_edited_by_membership_id]).not.toContain(
        memberR,
      );
      const v = await ver(id);
      const results = await Promise.allSettled([
        rep().activate(R(), id, v),
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE representative_appointment SET state='active', verified_by_membership_id='${memberS}', verified_at=now(), version=version+1 WHERE id='${id}' AND version=${v} AND state='draft'`,
            ),
          ),
        ),
      ]);
      const serviceWon = results[0].status === "fulfilled";
      const raw = results[1];
      expect(raw.status).toBe("fulfilled"); // a lost raw statement updates zero rows; it does not error
      const rawRows = (raw as PromiseFulfilledResult<unknown>).value as { rowCount: number };
      expect(Number(serviceWon) + rawRows.rowCount).toBe(1);
      if (!serviceWon) {
        expect(((results[0] as PromiseRejectedResult).reason as { code?: string }).code).toBe(
          "VERSION_CONFLICT",
        );
      }
      const row = await apptRow(id);
      expect(row.state).toBe("active");
      expect(row.verified_by_membership_id).toBe(serviceWon ? memberR : memberS);
    });

    it("the activation edge cannot be forged as the app role: stamp, evidence and membership ids are all checked", async () => {
      const id = await readyDraft(); // recorded and last edited by A
      const asApp = (setClause: string) =>
        fx.dbMessage(
          fx.asApp((tx) =>
            tx.execute(
              sql.raw(
                `UPDATE representative_appointment SET ${setClause} WHERE id='${id}' AND state='draft'`,
              ),
            ),
          ),
        );
      const activate = `state='active', verified_by_membership_id='${memberS}', verified_at=now()`;
      // forging the last-editor stamp in the activating statement
      expect(await asApp(`${activate}, last_edited_by_membership_id='${memberR}'`)).toMatch(
        /cannot change in the statement that activates/,
      );
      // editing evidence in the activating statement (with or without the stamp)
      expect(await asApp(`${activate}, representative_name='Swapped'`)).toMatch(
        /evidence cannot change/,
      );
      expect(
        await asApp(
          `${activate}, representative_name='Swapped', last_edited_by_membership_id='${memberR}'`,
        ),
      ).toMatch(/M25_REP_EDITOR/);
      // a nonexistent or foreign-organization membership as last editor is refused fail closed (activating or not)
      for (const bogus of [randomUUID(), fx.memberB]) {
        expect(await asApp(`last_edited_by_membership_id='${bogus}'`)).toMatch(
          /last editor is not a member of this organization/,
        );
        expect(await asApp(`${activate}, last_edited_by_membership_id='${bogus}'`)).toMatch(
          /last editor is not a member of this organization/,
        );
      }
      // a foreign or nonexistent verifier is refused too
      for (const bogus of [randomUUID(), fx.memberB]) {
        expect(
          await asApp(`state='active', verified_by_membership_id='${bogus}', verified_at=now()`),
        ).toMatch(/not an active member of this organization/);
      }
      expect((await apptRow(id)).state).toBe("draft");
      // the honest path still works: the stamp moves only through an edit
      const v = await ver(id);
      await rep().activate(S(), id, v);
      expect((await apptRow(id)).state).toBe("active");
    });

    it("the trigger, not the version check, decides concurrent activations written without a version predicate", async () => {
      const bare = (member: string, id: string) =>
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE representative_appointment SET state='active', verified_by_membership_id='${member}', verified_at=now() WHERE id='${id}'`,
            ),
          ),
        );
      // the recorder is refused by the trigger even with no version predicate
      const one = await readyDraft();
      expect((await apptRow(one)).recorded_by_membership_id).toBe(fx.memberA);
      expect((await apptRow(one)).last_edited_by_membership_id).toBe(fx.memberA);
      // (sequential: the recorder is refused by the trigger before anyone else activates)
      const recorder = await Promise.allSettled([bare(fx.memberA, one)]);
      expect(recorder[0].status).toBe("rejected");
      expect(
        String(
          ((recorder[0] as PromiseRejectedResult).reason as { cause?: { message?: string } }).cause
            ?.message,
        ),
      ).toMatch(/M25_REP_VERIFIER/);
      await bare(memberR, one);
      expect((await apptRow(one)).verified_by_membership_id).toBe(memberR);
      // two valid activators with no version predicate: the loser meets the frozen (already active) row
      const two = await readyDraft();
      const b = await Promise.allSettled([bare(memberR, two), bare(memberS, two)]);
      expect(b.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = b.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String((lost.reason as { cause?: { message?: string } }).cause?.message)).toMatch(
        /M25_REP_FROZEN/,
      );
    });

    it("the activator must not be the last editor of the evidence: B edits, attaches and ticks, then B cannot activate but C can", async () => {
      const fv = await formVersion();
      const created = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      expect((await apptRow(created.id)).last_edited_by_membership_id).toBe(fx.memberA);
      let v = (
        await rep().updateDraft(R(), created.id, { relationshipLabel: "niece" }, created.version)
      ).version;
      expect((await apptRow(created.id)).last_edited_by_membership_id).toBe(memberR);
      const doc = await seedDoc(patient1);
      v = (
        await rep().attachDocument(
          S(),
          created.id,
          { documentId: doc.documentId, documentVersionId: doc.versionId },
          v,
        )
      ).version;
      expect((await apptRow(created.id)).last_edited_by_membership_id).toBe(memberS);
      v = (
        await rep().confirmElements(
          R(),
          created.id,
          ["Fixture element one", "Fixture element two"],
          v,
        )
      ).version;
      expect((await apptRow(created.id)).last_edited_by_membership_id).toBe(memberR);
      // B (R) ticked last, so B may not activate: service and database
      expect((await fx.refused(rep().activate(R(), created.id, v)))?.code).toBe(
        "APPOINTMENT_ACTIVATOR_IS_EDITOR",
      );
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE representative_appointment SET state='active', verified_by_membership_id='${memberR}', verified_at=now() WHERE id='${created.id}'`,
            ),
          ),
        ),
      );
      expect(msg).toMatch(/last edited/);
      // the same PERSON under another membership row is still the last editor
      const oldSeat = (
        await fx.admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'revoked') RETURNING id`,
          [userR, ORG],
        )
      ).rows[0].id as string;
      await fx.admin.query(
        "UPDATE representative_appointment SET last_edited_by_membership_id=$2 WHERE id=$1",
        [created.id, oldSeat],
      );
      expect(
        await fx.dbMessage(
          fx.asApp((tx) =>
            tx.execute(
              sql.raw(
                `UPDATE representative_appointment SET state='active', verified_by_membership_id='${memberR}', verified_at=now() WHERE id='${created.id}'`,
              ),
            ),
          ),
        ),
      ).toMatch(/last edited/);
      await fx.admin.query(
        "UPDATE representative_appointment SET last_edited_by_membership_id=$2 WHERE id=$1",
        [created.id, memberR],
      );
      // C (S) neither recorded nor last edited it
      const ok = await rep().activate(S(), created.id, v);
      expect(ok.validityEndPassed).toBe(false);
      expect((await apptRow(created.id)).state).toBe("active");
    });

    it("freezes an active appointment except for revocation, which the recorder may do; a revoked one never changes", async () => {
      const id = await readyDraft();
      await rep().activate(R(), id, await ver(id));
      expect(
        (
          await fx.refused(
            rep().updateDraft(A(), id, { representativeName: "Changed" }, await ver(id)),
          )
        )?.code,
      ).toBe("APPOINTMENT_NOT_DRAFT");
      const edit = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE representative_appointment SET representative_name='x' WHERE id='${id}'`,
            ),
          ),
        ),
      );
      expect(edit).toMatch(/M25_REP_FROZEN/);
      expect(
        (
          await fx.refused(
            rep().revoke(A(), id, { revokedOn: daysAgo(0), note: MBI }, await ver(id)),
          )
        )?.code,
      ).toBe("APPOINTMENT_MBI_IN_FREE_TEXT");
      expect(
        (
          await fx.refused(
            rep().revoke(A(), id, { revokedOn: daysAhead(2), note: "n" }, await ver(id)),
          )
        )?.code,
      ).toBe("APPOINTMENT_REVOKED_ON_INVALID");
      // the recorder (not the activator) revokes: revocation is never blocked by a second person
      await rep().revoke(
        A(),
        id,
        { revokedOn: daysAgo(0), note: "revocation letter received" },
        await ver(id),
      );
      expect(await apptRow(id)).toMatchObject({
        state: "revoked",
        revoked_by_membership_id: fx.memberA,
      });
      expect(
        (
          await fx.refused(
            rep().revoke(A(), id, { revokedOn: daysAgo(0), note: "again" }, await ver(id)),
          )
        )?.code,
      ).toBe("APPOINTMENT_NOT_REVOCABLE");
      const frozen = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(`UPDATE representative_appointment SET revocation_note='x' WHERE id='${id}'`),
          ),
        ),
      );
      expect(frozen).toMatch(/M25_REP_FROZEN/);
      // a draft can be discarded by revoking it
      const draft = await readyDraft();
      await rep().revoke(
        A(),
        draft,
        { revokedOn: daysAgo(0), note: "entered in error" },
        await ver(draft),
      );
      expect((await apptRow(draft)).state).toBe("revoked");
    });

    it("derives a passed typed validity end as a flag and never changes the stored state; an absent end stays absent", async () => {
      const id = await readyDraft(A(), {
        validThroughOn: daysAgo(10),
        validitySourceNote: "signed form, section 3",
      });
      const activated = await rep().activate(R(), id, await ver(id));
      expect(activated.validityEndPassed).toBe(true); // a warning, not a block
      const view = await rep().getAppointment(A(), id);
      expect(view).toMatchObject({
        state: "active",
        status: "validity_end_passed_as_recorded",
        validThroughOn: daysAgo(10),
      });
      expect((await apptRow(id)).state).toBe("active");
      const none = await readyDraft();
      await rep().activate(R(), none, await ver(none));
      expect(await rep().getAppointment(A(), none)).toMatchObject({
        status: "active",
        validThroughOn: null,
      });
    });

    // ── the routes: permission, idempotency, If-Match, step-up, read audit ──────────────────────────────
    it("gates the routes on their keys; activation needs the verify key AND a step-up, and the recorder is refused with a typed 409", async () => {
      const id = await readyDraft(R());
      const v = await ver(id);
      // the verify key alone, no step-up
      const noStepUp = makeApp(["representative.read", "representative.verify"]);
      const a = await noStepUp.inject({
        method: "POST",
        url: `/api/v1/representative-appointments/${id}/activate`,
        headers: WRITE(v),
      });
      expect(a.statusCode).toBe(403);
      expect((a.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
      await noStepUp.close();
      // manage without verify
      const manageOnly = makeApp(["representative.manage"], { stepUp: true });
      expect(
        (
          await manageOnly.inject({
            method: "POST",
            url: `/api/v1/representative-appointments/${id}/activate`,
            headers: WRITE(v),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await manageOnly.inject({
            method: "POST",
            url: `/api/v1/representative-appointments/${id}/revoke`,
            headers: WRITE(v),
            payload: { revokedOn: daysAgo(0), note: "n" },
          })
        ).statusCode,
      ).toBe(403);
      await manageOnly.close();
      // verify + step-up, as a second person
      const verify = makeApp(["representative.verify"], { stepUp: true });
      const noKey = await verify.inject({
        method: "POST",
        url: `/api/v1/representative-appointments/${id}/activate`,
        headers: { "if-match": String(v) },
      });
      expect(noKey.statusCode).toBe(400);
      const stale = await verify.inject({
        method: "POST",
        url: `/api/v1/representative-appointments/${id}/activate`,
        headers: WRITE(v + 5),
      });
      expect(stale.statusCode).toBe(409);
      expect((stale.json() as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
      const ok = await verify.inject({
        method: "POST",
        url: `/api/v1/representative-appointments/${id}/activate`,
        headers: WRITE(v),
      });
      expect(ok.statusCode).toBe(200);
      await verify.close();
      // the recorder through the route
      const mine = await readyDraft(A());
      const self = makeApp(["representative.verify"], { stepUp: true });
      const refused = await self.inject({
        method: "POST",
        url: `/api/v1/representative-appointments/${mine}/activate`,
        headers: WRITE(await ver(mine)),
      });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { error: { code: string } }).error.code).toBe(
        "APPOINTMENT_ACTIVATOR_IS_RECORDER",
      );
      await self.close();
    });

    it("emits a read-audit event with a resource id on every PHI read and writes none for the config list", async () => {
      const fv = await formVersion();
      const created = await rep().createDraft(A(), fx.claim1, draftBody(fv) as never);
      const appeal = await ben().create(A(), fx.claim1, intake() as never);
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type IN ('claim_representative_appointments.viewed','representative_appointment.viewed','claim_beneficiary_appeals.viewed','beneficiary_appeal.viewed','claim_case_view.viewed')",
        [ORG],
      );
      const app = makeApp(ALL_KEYS);
      const get = async (url: string) => (await app.inject({ method: "GET", url })).statusCode;
      expect(await get(`/api/v1/claims/${fx.claim1}/representative-appointments`)).toBe(200);
      expect(await get(`/api/v1/representative-appointments/${created.id}`)).toBe(200);
      expect(await get(`/api/v1/claims/${fx.claim1}/beneficiary-appeals`)).toBe(200);
      expect(await get(`/api/v1/beneficiary-appeals/${appeal.id}`)).toBe(200);
      expect(await get(`/api/v1/claims/${fx.claim1}/case-view`)).toBe(200);
      expect(await get("/api/v1/representative-form-versions")).toBe(200);
      expect(await get(`/api/v1/representative-appointments/${randomUUID()}`)).toBe(404);
      expect(await get("/api/v1/beneficiary-appeals/not-a-uuid")).toBe(404);
      await app.close();
      const audited = (
        await fx.admin.query(
          "SELECT event_type, resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type LIKE '%.viewed'",
          [ORG],
        )
      ).rows as { event_type: string; rid: string | null }[];
      const ridOf = (type: string) =>
        audited.filter((r) => r.event_type === type).map((r) => r.rid);
      expect(ridOf("claim_representative_appointments.viewed")).toContain(fx.claim1);
      expect(ridOf("representative_appointment.viewed")).toContain(created.id);
      expect(ridOf("claim_beneficiary_appeals.viewed")).toContain(fx.claim1);
      expect(ridOf("beneficiary_appeal.viewed")).toContain(appeal.id);
      expect(ridOf("claim_case_view.viewed")).toContain(fx.claim1);
      expect(audited.every((r) => r.rid !== null && r.rid !== "")).toBe(true);
      // the stored audit rows never carry the representative's name, label or notes
      const written = await fx.admin.query(
        "SELECT after::text AS a FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND event_type='representative_appointment.insert'",
        [ORG, created.id],
      );
      expect(written.rows[0].a).not.toContain(PRIVATE_NAME);
      expect(written.rows[0].a).not.toContain("daughter");
    });

    it("an auditor-style read-only principal (none of the new keys) cannot read any of it", async () => {
      const app = makeApp(["audit.read", "appeal.read"]);
      const id = (await rep().createDraft(A(), fx.claim1, draftBody(await formVersion()) as never))
        .id;
      for (const url of [
        `/api/v1/claims/${fx.claim1}/representative-appointments`,
        `/api/v1/representative-appointments/${id}`,
        `/api/v1/claims/${fx.claim1}/beneficiary-appeals`,
        "/api/v1/representative-form-versions",
      ]) {
        expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(403);
      }
      // the case view stays allowed but leaves the beneficiary appeals out, never widened
      const view = await app.inject({
        method: "GET",
        url: `/api/v1/claims/${fx.claim1}/case-view`,
      });
      expect(
        (view.json() as { items: { kind: string }[] }).items.some(
          (i) => i.kind === "beneficiary_appeal",
        ),
      ).toBe(false);
      await app.close();
    });

    // ── no identity side effects ─────────────────────────────────────────────────────────────────────────
    it("an appointment creates no portal, consent or caregiver row and changes no hospice appeal or denial", async () => {
      const hospiceAppeal = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "redetermination",
      });
      const watched = [
        "portal_account",
        "portal_access_grant",
        "consent_record",
        "delegated_access",
        "patient_caregiver",
        "appeal_case",
        "denial_case",
        "outbox_event",
      ];
      const snapshot = async () =>
        Object.fromEntries(await Promise.all(watched.map(async (t) => [t, await count(t)])));
      const before = await snapshot();
      const appealBefore = (
        await fx.admin.query(
          "SELECT state, version, tier_deadline_at FROM appeal_case WHERE id=$1",
          [hospiceAppeal],
        )
      ).rows[0];
      const id = await readyDraft();
      await rep().activate(R(), id, await ver(id));
      const ba = await ben().create(
        A(),
        fx.claim1,
        intake({ filerKind: "representative", representativeAppointmentId: id }) as never,
      );
      await ben().move(A(), ba.id, "support", {}, ba.version);
      await tier().createDeadline(
        A(),
        { kind: "beneficiary_appeal", id: ba.id },
        { label: "Reply", dueOn: daysAhead(20), sourceNote: "notice p.1" },
      );
      await rep().revoke(A(), id, { revokedOn: daysAgo(0), note: "withdrawn" }, await ver(id));
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await fx.admin.query(
            "SELECT state, version, tier_deadline_at FROM appeal_case WHERE id=$1",
            [hospiceAppeal],
          )
        ).rows[0],
      ).toEqual(appealBefore);
    });

    // ── beneficiary appeals ─────────────────────────────────────────────────────────────────────────────
    it("records a beneficiary appeal from a claim: the patient comes from the claim, nothing is computed, the tier is a label, and it coexists with a hospice appeal of the same tier", async () => {
      const hospice = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "redetermination",
      });
      const created = await ben().create(A(), fx.claim1, intake() as never);
      expect(
        await fx.admin.query("SELECT * FROM beneficiary_appeal WHERE id=$1", [created.id]),
      ).toMatchObject({
        rows: [
          {
            patient_id: patient1,
            provider_entity_id: fx.pe1,
            state: "recorded",
            tier_label: "redetermination",
          },
        ],
      });
      // a second hospice appeal of the same tier on the same claim is unaffected: separate aggregates
      expect(
        (
          await fx.admin.query(
            "SELECT count(*)::int AS n FROM appeal_case WHERE claim_id=$1 AND tier='redetermination'",
            [fx.claim1],
          )
        ).rows[0].n,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (await fx.admin.query("SELECT state FROM appeal_case WHERE id=$1", [hospice])).rows[0]
          .state,
      ).toBe("draft");
      // the record has no deadline column of its own and shows the prompt
      const view = await ben().get(A(), created.id);
      expect(view?.deadlines).toEqual([]);
      // validation
      expect(
        (
          await fx.refused(
            ben().create(A(), fx.claim1, intake({ sourceNote: `heard ${MBI}` }) as never),
          )
        )?.code,
      ).toBe("BENEFICIARY_MBI_IN_FREE_TEXT");
      expect(
        (
          await fx.refused(
            ben().create(A(), fx.claim1, intake({ tierLabel: "first_level" }) as never),
          )
        )?.code,
      ).toBe("BENEFICIARY_TIER_INVALID");
      expect(
        (await fx.refused(ben().create(A(), fx.claim1, intake({ filedOn: daysAhead(3) }) as never)))
          ?.code,
      ).toBe("BENEFICIARY_DATE_IN_FUTURE");
      expect(
        (
          await fx.refused(
            ben().create(
              A(),
              fx.claim1,
              intake({ representativeAppointmentId: randomUUID() }) as never,
            ),
          )
        )?.code,
      ).toBe("BENEFICIARY_APPOINTMENT_NEEDS_REPRESENTATIVE_FILER");
      // cross-tenant: org B cannot see or edit it
      expect(await ben().get(B(), created.id)).toBeNull();
      expect(
        (await fx.refused(ben().update(B(), created.id, { tierLabel: "alj" }, created.version)))
          ?.statusCode,
      ).toBe(404);
    });

    it("links a denial only on the same claim and an appointment only of the same patient", async () => {
      const denialSame = await fx.mkDenial(fx.claim1, fx.pe1);
      const denialOther = await fx.mkDenial(fx.claim1b, fx.pe1);
      const apptOtherPatient = await (async () => {
        const created = await rep().createDraft(
          A(),
          fx.claim1b,
          draftBody(await formVersion()) as never,
        );
        return created.id;
      })();
      const apptSame = await readyDraft();
      // a draft appointment cannot be linked (service and database); a second person activates it first
      expect(
        (
          await fx.refused(
            ben().create(
              A(),
              fx.claim1,
              intake({
                filerKind: "representative",
                representativeAppointmentId: apptSame,
              }) as never,
            ),
          )
        )?.code,
      ).toBe("APPOINTMENT_NOT_ACTIVE");
      await rep().activate(R(), apptSame, await ver(apptSame));
      expect(
        (
          await fx.refused(
            ben().create(A(), fx.claim1, intake({ denialCaseId: denialOther }) as never),
          )
        )?.statusCode,
      ).toBe(404);
      expect(
        (
          await fx.refused(
            ben().create(
              A(),
              fx.claim1,
              intake({
                filerKind: "representative",
                representativeAppointmentId: apptOtherPatient,
              }) as never,
            ),
          )
        )?.code,
      ).toBe("APPOINTMENT_PATIENT_MISMATCH");
      const ok = await ben().create(
        A(),
        fx.claim1,
        intake({
          filerKind: "representative",
          denialCaseId: denialSame,
          representativeAppointmentId: apptSame,
        }) as never,
      );
      expect(await ben().get(A(), ok.id)).toMatchObject({
        denialCaseId: denialSame,
        representativeAppointmentId: apptSame,
      });
      // the database refuses the same links written straight (the service is not the only writer)
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE beneficiary_appeal SET denial_case_id='${denialOther}' WHERE id='${ok.id}'`,
            ),
          ),
        ),
      );
      expect(msg).toMatch(/M25_BENEFICIARY_APPEAL_DENIAL/);
      const draftAppt = (
        await rep().createDraft(A(), fx.claim1, draftBody(await formVersion()) as never)
      ).id;
      const stateMsg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE beneficiary_appeal SET representative_appointment_id='${draftAppt}' WHERE id='${ok.id}'`,
            ),
          ),
        ),
      );
      expect(stateMsg).toMatch(/M25_BENEFICIARY_APPEAL_APPOINTMENT_STATE/);
      // the denial itself is untouched
      expect(
        (await fx.admin.query("SELECT state FROM denial_case WHERE id=$1", [denialSame])).rows[0]
          .state,
      ).toBe("appealed");
    });

    it("walks the states, freezes a closed record, and a decided record needs an outcome label", async () => {
      const created = await ben().create(A(), fx.claim1, intake() as never);
      let v = created.version;
      expect((await fx.refused(ben().move(A(), created.id, "decide", {}, v)))?.code).toBe(
        "BENEFICIARY_OUTCOME_REQUIRED",
      );
      expect(
        (await fx.refused(ben().move(A(), created.id, "decide", { outcomeLabel: "other" }, v)))
          ?.code,
      ).toBe("BENEFICIARY_OUTCOME_NOTE_REQUIRED");
      v = (await ben().move(A(), created.id, "support", {}, v)).version;
      v = (await ben().move(A(), created.id, "decide", { outcomeLabel: "unfavorable" }, v)).version;
      // an unfavorable label spawns nothing
      expect(
        (
          await fx.admin.query(
            "SELECT count(*)::int AS n FROM appeal_case WHERE claim_id=$1 AND state='draft' AND filed_by_escalation",
            [fx.claim1],
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await fx.refused(ben().move(A(), created.id, "support", {}, v)))?.code).toBe(
        "INVALID_STATE",
      );
      v = (await ben().move(A(), created.id, "close", {}, v)).version;
      expect((await fx.refused(ben().update(A(), created.id, { tierLabel: "alj" }, v)))?.code).toBe(
        "BENEFICIARY_APPEAL_TERMINAL",
      );
      const frozen = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(`UPDATE beneficiary_appeal SET tier_label='alj' WHERE id='${created.id}'`),
          ),
        ),
      );
      expect(frozen).toMatch(/M25_BENEFICIARY_APPEAL_TERMINAL_IMMUTABLE/);
      expect(
        (
          await fx.refused(
            tier().createDeadline(
              A(),
              { kind: "beneficiary_appeal", id: created.id },
              { label: "x", dueOn: daysAhead(5), sourceNote: "n" },
            ),
          )
        )?.code,
      ).toBe("DEADLINE_SUBJECT_FINISHED");
    });

    it("validates beneficiary-appeal documents against the claim's patient and admission, persists the version id, and detaches", async () => {
      const created = await ben().create(A(), fx.claim1, intake() as never);
      let v = created.version;
      const attach = (d: { documentId: string; versionId: string }) =>
        ben().attachDocument(
          A(),
          created.id,
          { documentId: d.documentId, documentVersionId: d.versionId },
          v,
        );
      const other = await seedDoc(patient1b);
      const part2 = await seedDoc(patient1, { retention: "compliance_42cfr_part2" });
      const wrongAdmission = await seedDoc(patient1, { admissionId: randomUUID() });
      expect((await fx.refused(attach(other)))?.message).toContain("other_patient");
      expect((await fx.refused(attach(part2)))?.message).toContain("part2_restricted");
      expect((await fx.refused(attach(wrongAdmission)))?.code).toBe("DOCUMENT_ADMISSION_MISMATCH");
      const sameAdmission = await seedDoc(patient1, { admissionId: admission1 });
      const noAdmission = await seedDoc(patient1);
      v = (await attach(sameAdmission)).version;
      v = (await attach(noAdmission)).version;
      expect((await fx.refused(attach(noAdmission)))?.code).toBe("BENEFICIARY_DUPLICATE_DOCUMENT");
      const rows = (
        await fx.admin.query(
          "SELECT document_id, document_version_id FROM beneficiary_appeal_document WHERE beneficiary_appeal_id=$1 AND removed_at IS NULL ORDER BY attached_at",
          [created.id],
        )
      ).rows;
      expect(rows).toEqual([
        { document_id: sameAdmission.documentId, document_version_id: sameAdmission.versionId },
        { document_id: noAdmission.documentId, document_version_id: noAdmission.versionId },
      ]);
      await ben().detachDocument(A(), created.id, noAdmission.documentId, v);
      expect((await ben().get(A(), created.id))?.documents).toHaveLength(1);
    });

    // ── recorded deadlines ──────────────────────────────────────────────────────────────────────────────
    it("a recorded deadline on a beneficiary appeal alerts once per boundary with an ids-only payload and never for a past date; the one-subject check holds", async () => {
      const created = await ben().create(
        A(),
        fx.claim1,
        intake({ sourceNote: "private family detail" }) as never,
      );
      const subject = { kind: "beneficiary_appeal" as const, id: created.id };
      const soon = await tier().createDeadline(A(), subject, {
        label: "Private label",
        dueOn: daysAhead(6),
        sourceNote: "notice p.2",
      });
      const past = await tier().createDeadline(A(), subject, {
        label: "Past",
        dueOn: daysAgo(0),
        sourceNote: "notice",
      });
      await fx.admin.query("UPDATE recorded_deadline SET due_on = CURRENT_DATE - 3 WHERE id=$1", [
        past.id,
      ]);
      const first = await cron();
      expect(recordedAlerts(first, soon.id)).toHaveLength(1);
      expect(recordedAlerts(first, soon.id)[0]?.payload).toEqual({
        deadlineId: soon.id,
        subjectKind: "beneficiary_appeal",
        subjectId: created.id,
        daysRemaining: 7,
      });
      expect(JSON.stringify(first)).not.toContain("Private label");
      expect(JSON.stringify(first)).not.toContain("private family detail");
      expect(recordedAlerts(first, past.id)).toEqual([]);
      expect(recordedAlerts(await cron(), soon.id)).toEqual([]);
      // the deadline shows on the appeal view as recorded, typed, with its source
      const view = await ben().get(A(), created.id);
      expect(view?.deadlines.map((d) => d.id)).toContain(soon.id);
      // a closed appeal's deadlines are not watched
      let v = created.version;
      v = (await ben().move(A(), created.id, "close", {}, v)).version;
      const later = () => new Date(Date.now() + 6 * 864e5);
      expect(recordedAlerts(await cron(later), soon.id)).toEqual([]);
      // exactly one subject: none, two, or four are refused by the database
      const base = `INSERT INTO recorded_deadline (organization_id, provider_entity_id, label, due_on, zone, source_note`;
      const onlyBeneficiary = await fx.admin.query(
        `${base}, beneficiary_appeal_id) VALUES ($1,$2,'l','2099-01-01','UTC','n',$3) RETURNING id`,
        [ORG, fx.pe1, created.id],
      );
      expect(onlyBeneficiary.rowCount).toBe(1);
      await expect(
        fx.admin.query(`${base}) VALUES ($1,$2,'l','2099-01-01','UTC','n')`, [ORG, fx.pe1]),
      ).rejects.toThrow(/recorded_deadline_one_subject|M25_RECORDED_DEADLINE_PARENT/);
      const hospice = await fx.mkAppeal({
        claimId: fx.claim1b,
        pe: fx.pe1,
        tier: "redetermination",
      });
      await expect(
        fx.admin.query(
          `${base}, beneficiary_appeal_id, appeal_case_id) VALUES ($1,$2,'l','2099-01-01','UTC','n',$3,$4)`,
          [ORG, fx.pe1, created.id, hospice],
        ),
      ).rejects.toThrow(/recorded_deadline_one_subject/);
      // the earlier subjects still satisfy the amended constraint
      await expect(
        fx.admin.query(`${base}, appeal_case_id) VALUES ($1,$2,'l','2099-01-01','UTC','n',$3)`, [
          ORG,
          fx.pe1,
          hospice,
        ]),
      ).resolves.toBeTruthy();
      // another tenant cannot hang a deadline on it
      expect(
        (
          await fx.refused(
            tier().createDeadline(B(), subject, {
              label: "x",
              dueOn: daysAhead(5),
              sourceNote: "n",
            }),
          )
        )?.statusCode,
      ).toBe(404);
    });

    it("the recorded_deadline guard refuses another tenant's subject on every branch (appeal, payer appeal, audit request, beneficiary appeal)", async () => {
      const appeal = await fx.mkAppeal({
        claimId: fx.claim1b,
        pe: fx.pe1,
        tier: "redetermination",
      });
      const denial = await fx.mkDenial(fx.claim1, fx.pe1);
      const payer = (
        await fx.admin.query(
          `INSERT INTO payer_appeal_case (organization_id, provider_entity_id, denial_case_id, payer_id, program, level_kind, level_label)
           VALUES ($1,$2,$3,$4,'commercial','internal','L1') RETURNING id`,
          [ORG, fx.pe1, denial, randomUUID()],
        )
      ).rows[0].id as string;
      const audit = (
        await buildDrizzleAuditRequestService(fx.handle.db, {
          sources: buildSeamAppealSourcePorts(),
        }).createAuditRequest(A(), {
          authorityKind: "upic",
          receivedOn: daysAgo(1),
          claimIds: [fx.claim1],
        } as never)
      ).id;
      const beneficiary = (await ben().create(A(), fx.claim1, intake() as never)).id;
      for (const [column, id] of [
        ["appeal_case_id", appeal],
        ["payer_appeal_case_id", payer],
        ["audit_request_id", audit],
        ["beneficiary_appeal_id", beneficiary],
      ] as const) {
        const msg = await fx.dbMessage(
          fx.asApp(
            (tx) =>
              tx.execute(
                sql.raw(
                  `INSERT INTO recorded_deadline (organization_id, provider_entity_id, ${column}, label, due_on, zone, source_note) VALUES ('${ORG_B}','${fx.peB}','${id}','l','2099-01-01','UTC','n')`,
                ),
              ),
            ORG_B,
          ),
        );
        expect(msg, column).toMatch(/M25_RECORDED_DEADLINE_PARENT/);
      }
    });

    // ── the one case view ───────────────────────────────────────────────────────────────────────────────
    it("shows beneficiary appeals on the one case view next to the hospice chain, with the representative-status badge derived from typed dates", async () => {
      const claim = fx.claim1b;
      const hospice = await fx.mkAppeal({ claimId: claim, pe: fx.pe1, tier: "redetermination" });
      const viewOf = async () =>
        buildDrizzleCaseViewService(fx.handle.db).getCaseView(A(), claim, {
          includeAdr: false,
          includeReopening: false,
          includeAudits: false,
          includeBeneficiaryAppeals: true,
        });
      const flagOf = async (id: string) =>
        (await viewOf()).items.find((i) => i.id === id)?.flags?.representativeStatus;
      const none = await ben().create(A(), claim, intake({ filerKind: "representative" }) as never);
      const family = await ben().create(A(), claim, intake() as never);
      const fv = await formVersion();
      const appt = await rep().createDraft(
        A(),
        claim,
        draftBody(fv, { validThroughOn: daysAgo(2), validitySourceNote: "signed form" }) as never,
      );
      // a draft cannot be linked; once a second person activates it the appeal can carry it
      expect(
        (
          await fx.refused(
            ben().create(
              A(),
              claim,
              intake({
                filerKind: "representative",
                representativeAppointmentId: appt.id,
              }) as never,
            ),
          )
        )?.code,
      ).toBe("APPOINTMENT_NOT_ACTIVE");
      const doc = await seedDoc(patient1b);
      let v = (
        await rep().attachDocument(
          A(),
          appt.id,
          { documentId: doc.documentId, documentVersionId: doc.versionId },
          appt.version,
        )
      ).version;
      v = (
        await rep().confirmElements(A(), appt.id, ["Fixture element one", "Fixture element two"], v)
      ).version;
      await rep().activate(R(), appt.id, v);
      const linked = await ben().create(
        A(),
        claim,
        intake({ filerKind: "representative", representativeAppointmentId: appt.id }) as never,
      );
      const view = await viewOf();
      expect(view.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([hospice, none.id, family.id, linked.id]),
      );
      expect(view.items.find((i) => i.id === none.id)).toMatchObject({
        kind: "beneficiary_appeal",
        deadlineAt: null,
        flags: { representativeStatus: "none_on_file" },
      });
      expect(await flagOf(family.id)).toBeNull();
      // items carry the tier label only: never the representative's name or any note
      expect(JSON.stringify(view)).not.toContain(PRIVATE_NAME);
      expect(JSON.stringify(view)).not.toContain("family telephoned the office");
      // the typed end has passed, so the badge says so and the stored state stays active
      expect(await flagOf(linked.id)).toBe("validity_end_passed_as_recorded");
      expect((await apptRow(appt.id)).state).toBe("active");
      await rep().revoke(
        A(),
        appt.id,
        { revokedOn: daysAgo(0), note: "revocation received" },
        await ver(appt.id),
      );
      expect(await flagOf(linked.id)).toBe("revoked");
      // a deadline typed from a notice shows as the next recorded deadline
      const d = await tier().createDeadline(
        A(),
        { kind: "beneficiary_appeal", id: none.id },
        { label: "Reply due", dueOn: daysAhead(15), sourceNote: "notice" },
      );
      const withDeadline = await viewOf();
      expect(withDeadline.nextDeadline).toMatchObject({
        id: d.id,
        kind: "recorded_deadline",
        deadlineSource: "recorded",
      });
      // without the read key the beneficiary appeals are left out, never widened
      const narrow = await buildDrizzleCaseViewService(fx.handle.db).getCaseView(A(), claim, {
        includeAdr: false,
        includeReopening: false,
        includeAudits: false,
      });
      expect(narrow.items.some((i) => i.kind === "beneficiary_appeal")).toBe(false);
    });

    it("rolls a failed document attach back and keeps typed values editable on a 409 stale version", async () => {
      const created = await ben().create(A(), fx.claim1, intake() as never);
      const app = makeApp(ALL_KEYS);
      const stale = await app.inject({
        method: "PATCH",
        url: `/api/v1/beneficiary-appeals/${created.id}`,
        headers: WRITE(created.version + 3),
        payload: { sourceNote: "typed value" },
      });
      expect(stale.statusCode).toBe(409);
      const fresh = await app.inject({
        method: "PATCH",
        url: `/api/v1/beneficiary-appeals/${created.id}`,
        headers: WRITE(await bver(created.id)),
        payload: { sourceNote: "typed value", externalReference: null },
      });
      expect(fresh.statusCode).toBe(200);
      expect(await ben().get(A(), created.id)).toMatchObject({
        sourceNote: "typed value",
        externalReference: null,
      });
      const badDoc = await app.inject({
        method: "POST",
        url: `/api/v1/beneficiary-appeals/${created.id}/documents`,
        headers: WRITE(await bver(created.id)),
        payload: { documentId: randomUUID(), documentVersionId: randomUUID() },
      });
      expect(badDoc.statusCode).toBe(422);
      expect((await ben().get(A(), created.id))?.documents).toEqual([]);
      await app.close();
    });
  },
);
