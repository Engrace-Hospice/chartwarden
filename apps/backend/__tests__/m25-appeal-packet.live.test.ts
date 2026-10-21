/**
 * GAP-036 - the appeal packet render request carries the TYPED AppealPacketRenderPayload, LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role through the real catalog-validating outbox publisher AND the real cross-module
 * seams (M23 `ClaimSubmissionReader`, M22 `DocumentReader`).
 *
 * Before: submitAppeal published `m25.appeal_packet.render_requested` with `payload: {}` (later: ids only), so M22
 * rendered a letter that cited `Claim ab12cd34` and listed raw uuids, and nothing checked that an attached document
 * id existed, belonged to the org, or belonged to the claim's patient. Now the payload is built server-side from the
 * appeal, denial, claim, remittance and document records, every enclosure is validated BEFORE anything reaches the
 * outbox, and the letter prints the claim lines, the 835 adjustments and the named enclosures.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m25:appeal-packet:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { appealPacketViolations } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createDocumentReader,
  createDrizzleDocumentReaderStore,
} from "../src/modules/22-documents/index";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const NARRATIVE =
  "Hospice eligibility was certified timely; the face-to-face encounter is enclosed.";

describe.skipIf(!DB_URL)("GAP-036 - appeal packet render payload - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let actor: {
    organizationId: string;
    userId: string;
    membershipId: string;
    roles: string[];
    stepUpRecent: boolean;
  };
  let providerEntityId = "";
  const patient = randomUUID();
  const otherPatient = randomUUID();
  let claimId = "";
  let remittanceLineId = "";
  let docF2f = "";
  let docCti = "";
  let docBundle = "";
  let docOtherPatient = "";
  let docPart2 = "";
  let docSuperseded = "";
  let docOtherTenant = "";
  let docLegalHold = "";

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };
  /** The production adapter: M22 / M23 seams resolved through the M1 registry. */
  const write = () =>
    buildDrizzleM25WriteService(handle.db, m25Outbox, {
      appealSources: buildSeamAppealSourcePorts(),
      providerZones: (tx, providerEntityId) =>
        buildFoundationSiteReader().providerEntityTimezones(tx, providerEntityId),
    });

  async function seedDocument(
    org: string,
    patientId: string | null,
    title: string,
    over: { retentionClass?: string; status?: string; aggregateType?: string } = {},
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
           status, created_by_membership_id)
         VALUES ($1,$2,$3,'user_upload',$4,$5,$6,$7) RETURNING id`,
        [
          org,
          patientId,
          over.retentionClass ?? "clinical_record",
          over.aggregateType ?? "f2f",
          title,
          over.status ?? "active",
          actor.membershipId,
        ],
      )
    ).rows[0].id as string;
  }

  async function seedAppeal(
    tier: string,
    deadline: string,
    opts: { withRemit?: boolean } = {},
  ): Promise<{ id: string; denialId: string }> {
    const withRemit = opts.withRemit ?? true;
    const denialId = (
      await admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, remittance_line_id,
           source_evv_aggregator_submission_id, carc_code, rarc_code, category, source, state, dollar_value,
           taxonomy_status)
         VALUES ($1,$2,$3,$4,$5,'50','N115','denial','evv_aggregator_rejection','in_progress',1234.50,'mapped')
         RETURNING id`,
        [ORG, providerEntityId, claimId, withRemit ? remittanceLineId : null, randomUUID()],
      )
    ).rows[0].id as string;
    const id = (
      await admin.query(
        `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
           tier_deadline_at) VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING id`,
        [ORG, providerEntityId, denialId, claimId, tier, deadline],
      )
    ).rows[0].id as string;
    return { id, denialId };
  }
  const renderRequested = async (appealId: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m25.appeal_packet.render_requested' AND aggregate_id=$1",
        [appealId],
      )
    ).rows;
  const appealState = async (appealId: string) =>
    (await admin.query("SELECT state FROM appeal_case WHERE id=$1", [appealId])).rows[0].state;
  const outboxCount = async () =>
    Number((await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [org, slug] of [
      [ORG, "m25-pkt"],
      [ORG_B, "m25-pkt-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('m25pkt@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-PKT','PKT','NPI-PKT','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    actor = {
      organizationId: ORG,
      userId,
      membershipId,
      roles: ["billing_manager"],
      stepUpRecent: true,
    };
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    // The claim M23 holds: header + two lines (one with an HCPCS, one without).
    const claim = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      new repositories.ClaimRepository(tx).create({
        organizationId: ORG,
        providerEntityId,
        patientId: patient,
        admissionId: randomUUID(),
        electionPeriodIdFrom: randomUUID(),
        electionPeriodIdTo: randomUUID(),
        patientPayerId: randomUUID(),
        tob: "811",
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-31",
        claimControlNumber: "CCN-GAP036-0042",
        payerClaimControlNumber: null,
        macJurisdiction: "ngs_j6",
        sequestrationAppliedPct: "2.00",
        sequestrationPolicyId: randomUUID(),
        createdByMembershipId: randomUUID(),
        totalChargeCents: 1_234_500,
      }),
    );
    claimId = claim.id;
    await admin.query("UPDATE claim SET state = 'DENIED' WHERE id = $1", [claimId]);
    await admin.query(
      `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
         service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
       VALUES ($1,$2,1,'0651','Q5001','RHC','2026-03-01','2026-03-31',30,41150,1234500,$1)`,
      [ORG, claimId],
    );

    // The 835 line the denial came from: payment detail, one CO-50 adjustment, one remark, one service line.
    const advice = (
      await admin.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, check_or_eft_trace_number, payment_method,
           total_payment_amount, production_date, minio_object_key, file_sha256, parse_status)
         VALUES ($1,$2,$3,'medicare','900000036','100036','TRC036036','eft',0, now(),'k',$4,'partial_posted')
         RETURNING id, received_at`,
        [ORG, providerEntityId, randomUUID(), "0".repeat(64)],
      )
    ).rows[0];
    remittanceLineId = (
      await admin.query(
        `INSERT INTO remittance_line (organization_id, remittance_advice_id, claim_id, clp07_payer_icn,
           clp02_status_code, clp03_total_charge_amount, clp04_total_payment_amount,
           clp05_patient_responsibility_amount, match_state, received_at)
         VALUES ($1,$2,$3,'ICN-036',4,1234.50,0,0,'auto_matched',$4) RETURNING id`,
        [ORG, advice.id, claimId, advice.received_at],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO remittance_adjustment (organization_id, remittance_line_id, cas_group_code, cas_reason_code,
         adjustment_amount, post_action, taxonomy_status, received_at)
       VALUES ($1,$2,'CO','50',1234.50,'denial_seeded','mapped',$3)`,
      [ORG, remittanceLineId, advice.received_at],
    );
    await admin.query(
      `INSERT INTO remittance_remark (organization_id, remittance_line_id, remark_kind, remark_code, received_at)
       VALUES ($1,$2,'LQ','N115',$3)`,
      [ORG, remittanceLineId, advice.received_at],
    );
    await admin.query(
      `INSERT INTO remittance_service_line (organization_id, remittance_line_id, svc01_procedure_code,
         svc01_revenue_code, svc02_charge_amount, svc03_paid_amount, received_at)
       VALUES ($1,$2,'Q5001','0651',1234.50,0,$3)`,
      [ORG, remittanceLineId, advice.received_at],
    );

    // M22 documents: two enclosable ones for the claim's patient, a bundle, and the ones that must be refused.
    docF2f = await seedDocument(ORG, patient, "Face-to-face encounter 2026-02-20");
    docCti = await seedDocument(ORG, patient, "Certification of terminal illness", {
      aggregateType: "cti",
    });
    docBundle = await seedDocument(ORG, patient, "Medical records March 2026", {
      aggregateType: "encounter",
    });
    docLegalHold = await seedDocument(ORG, patient, "Election statement (legal hold)", {
      status: "legal_hold",
      aggregateType: "election_statement",
    });
    docOtherPatient = await seedDocument(ORG, otherPatient, "SECRET other patient's note");
    docPart2 = await seedDocument(ORG, patient, "SECRET SUD treatment note", {
      retentionClass: "compliance_42cfr_part2",
    });
    docSuperseded = await seedDocument(ORG, patient, "Old version", { status: "superseded" });
    docOtherTenant = await seedDocument(ORG_B, null, "SECRET other tenant's document");

    // The REAL cross-module seams, registered the way the composition root does.
    registerM23PublishedSeams(handle.db);
    registerSeam(
      "DocumentReader",
      createDocumentReader(createDrizzleDocumentReaderStore(handle.db)),
    );
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("submitAppeal publishes a valid typed packet built from the appeal, denial, claim, remittance and documents", async () => {
    const { id, denialId } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
    await write().submitAppeal(
      actor,
      id,
      {
        appealNarrative: NARRATIVE,
        attachedDocumentIds: [docF2f, docCti, docLegalHold],
        medicalRecordsBundleDocumentId: docBundle,
      },
      1,
    );

    const rows = await renderRequested(id);
    expect(rows).toHaveLength(1);
    const packet = rows[0].payload.payload;
    expect(appealPacketViolations(packet)).toEqual([]);
    expect(packet).toMatchObject({
      appealCaseId: id,
      denialCaseId: denialId,
      claimId,
      tier: "redetermination",
      appealNarrative: NARRATIVE,
      denial: { carcCode: "50", rarcCode: "N115", dollarValue: "1234.50" },
      supportingDocuments: [
        {
          ordinal: 1,
          documentId: docF2f,
          title: "Face-to-face encounter 2026-02-20",
          documentKind: "f2f",
        },
        {
          ordinal: 2,
          documentId: docCti,
          title: "Certification of terminal illness",
          documentKind: "cti",
        },
        { ordinal: 3, documentId: docLegalHold, documentKind: "election_statement" },
      ],
      medicalRecordsBundleRef: { documentId: docBundle, title: "Medical records March 2026" },
      signedClaimCopyRef: { claimId },
      claimCopy: {
        controlNumber: "CCN-GAP036-0042",
        tob: "811",
        totalChargeCents: 1_234_500,
        lines: [
          {
            lineNumber: 1,
            revenueCode: "0651",
            hcpcsCode: "Q5001",
            units: 30,
            chargeCents: 1_234_500,
          },
        ],
      },
      remitCopyRef: { remittanceLineId },
      remitCopy: {
        checkOrEftTrace: "TRC036036",
        payerIcn: "ICN-036",
        claimStatusCode: 4,
        chargeCents: 123_450,
        paidCents: 0,
        adjustments: [{ group: "CO", carc: "50", amountCents: 123_450 }],
        remarks: [{ kind: "LQ", rarc: "N115" }],
        serviceLines: [
          { revenueCode: "0651", hcpcsCode: "Q5001", chargeCents: 123_450, paidCents: 0 },
        ],
      },
    });
    // and the submitted-at on the sibling event is the real instant, not the epoch
    const submitted = (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m25.appeal.submitted' AND aggregate_id=$1",
        [id],
      )
    ).rows[0].payload;
    expect(Date.parse(submitted.submittedAt)).toBeGreaterThan(Date.parse("2026-01-01"));
  });

  it("the published payload renders as a real PDF carrying the claim lines, the 835 adjustments and the named enclosures", async () => {
    const [{ id }] = (
      await admin.query("SELECT id FROM appeal_case WHERE state = 'submitted' LIMIT 1")
    ).rows;
    const [{ payload }] = await renderRequested(id);
    const bytes = renderPdfForTemplate(
      "appeal_packet",
      { ...payload.payload, aggregateId: id, patientId: null },
      "Appeal Packet",
    );
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).not.toContain("wardenx-render");
    const text = [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]).join("\n");
    expect(text).toContain("Request for Redetermination");
    expect(text).toContain("face-to-face");
    // the as-submitted claim and the 835, in words
    expect(text).toContain("CCN-GAP036-0042");
    expect(text).toContain("0651");
    expect(text).toContain("Q5001");
    expect(text).toContain("TRC036036");
    expect(text).toContain("ICN-036");
    expect(text).toContain("N115");
    // enclosures named, not cited by uuid prefix
    expect(text).toContain("Face-to-face encounter 2026-02-20");
    expect(text).toContain("Medical records March 2026");
    expect(text).not.toContain("SECRET");
  });

  describe("an enclosure that cannot be named is refused BEFORE anything reaches the outbox", () => {
    const attemptWith = async (attached: string[], bundle?: string) => {
      const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
      const before = await outboxCount();
      const err = await write()
        .submitAppeal(
          actor,
          id,
          {
            appealNarrative: NARRATIVE,
            attachedDocumentIds: attached,
            ...(bundle ? { medicalRecordsBundleDocumentId: bundle } : {}),
          },
          1,
        )
        .then(
          () => null,
          (e: unknown) => e as { code?: string; statusCode?: number; message: string },
        );
      // nothing published, the appeal is still a draft (the submit rolled back as one unit)
      expect(await outboxCount()).toBe(before);
      expect(await renderRequested(id)).toHaveLength(0);
      expect(await appealState(id)).toBe("draft");
      return err;
    };

    it.each([
      ["another patient's document", () => [docOtherPatient], "other_patient"],
      ["another tenant's document id", () => [docOtherTenant], "not_found"],
      ["a nonexistent id", () => [randomUUID()], "not_found"],
      ["a 42 CFR Part 2 record", () => [docF2f, docPart2], "part2_restricted"],
      ["a superseded document", () => [docSuperseded], "not_active"],
    ])("%s -> 422 APPEAL_DOCUMENT_NOT_ATTACHABLE", async (_label, ids, reason) => {
      const err = await attemptWith(ids());
      expect(err).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE", statusCode: 422 });
      expect(err?.message).toContain(reason);
      // the refusal carries ids and a reason code only - never a document title
      expect(err?.message).not.toContain("SECRET");
    });

    it("a bad medical-records bundle id fails the whole filing", async () => {
      const err = await attemptWith([docF2f], docPart2);
      expect(err).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE", statusCode: 422 });
    });

    it("a duplicated enclosure is refused", async () => {
      const err = await attemptWith([docF2f, docF2f]);
      expect(err).toMatchObject({ code: "APPEAL_DUPLICATE_ENCLOSURE", statusCode: 422 });
    });
  });

  it("with no document / claim source bound the submit is refused (503), never filed half-empty", async () => {
    const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
    const before = await outboxCount();
    const err = await buildDrizzleM25WriteService(handle.db, m25Outbox)
      .submitAppeal(actor, id, { appealNarrative: NARRATIVE, attachedDocumentIds: [docF2f] }, 1)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; statusCode?: number },
      );
    expect(err).toMatchObject({ code: "SEAM_UNBOUND", statusCode: 503 });
    expect(await outboxCount()).toBe(before);
    expect(await appealState(id)).toBe("draft");
  });

  it("a pre-835 denial (no remittance line) is a valid packet with no remit copy", async () => {
    const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z", {
      withRemit: false,
    });
    await write().submitAppeal(
      actor,
      id,
      { appealNarrative: NARRATIVE, attachedDocumentIds: [docF2f] },
      1,
    );
    const [{ payload }] = await renderRequested(id);
    expect(appealPacketViolations(payload.payload)).toEqual([]);
    expect(payload.payload.remitCopyRef).toEqual({ remittanceLineId: null });
    expect(payload.payload.remitCopy).toBeUndefined();
  });

  it("a late good-cause filing carries the justification and the flag in the typed packet", async () => {
    const { id } = await seedAppeal("reconsideration", "2025-01-01T00:00:00Z");
    // Milestone 4: a reconsideration also carries the QIC request elements (the notice named no missing documentation).
    await admin.query(
      "UPDATE appeal_case SET notice_dated_on = '2024-06-01', cited_evidence_none = true WHERE id = $1",
      [id],
    );
    await write().submitAppealLateGoodCause(
      actor,
      id,
      {
        appealNarrative: NARRATIVE,
        attachedDocumentIds: [docF2f],
        goodCauseJustification:
          "The MAC notice was misdelivered to a prior address on file with CMS.",
        reconsideration: {
          redeterminationMacName: "Example MAC",
          redeterminationNoticeDocumentId: docF2f,
        },
      },
      1,
    );
    const [{ payload }] = await renderRequested(id);
    expect(appealPacketViolations(payload.payload)).toEqual([]);
    expect(payload.payload).toMatchObject({
      lateGoodCauseFiling: true,
      tier: "reconsideration",
      supportingDocuments: [{ ordinal: 1, documentId: docF2f }],
    });
    expect(payload.payload.goodCauseJustification).toContain("misdelivered");
  });

  it("a claim the packet cannot read is refused (422), not filed with a bare reference", async () => {
    const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
    await admin.query("UPDATE appeal_case SET claim_id = $1 WHERE id = $2", [randomUUID(), id]);
    const before = await outboxCount();
    const err = await write()
      .submitAppeal(actor, id, { appealNarrative: NARRATIVE, attachedDocumentIds: [docF2f] }, 1)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; statusCode?: number },
      );
    expect(err).toMatchObject({ code: "APPEAL_CLAIM_UNAVAILABLE", statusCode: 422 });
    expect(await outboxCount()).toBe(before);
  });

  // ---- CMS-correct appeal deadlines (hospice ADR/TPE/QIC PRD, milestone 1) ----
  // The window runs from presumed receipt (notice date + 5 days) and the last filing day is usable to its end
  // (America/New_York by default). Proven through the real service on the NOBYPASSRLS role.
  describe("appeal deadlines run from the notice date", () => {
    const seedDenial = async (withRemit: boolean): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, remittance_line_id,
             source_evv_aggregator_submission_id, carc_code, rarc_code, category, source, state, dollar_value,
             taxonomy_status)
           VALUES ($1,$2,$3,$4,$5,'50','N115','denial','evv_aggregator_rejection','in_progress',10,'mapped')
           RETURNING id`,
          [ORG, providerEntityId, claimId, withRemit ? remittanceLineId : null, randomUUID()],
        )
      ).rows[0].id as string;
    const appealRow = async (id: string) =>
      (
        await admin.query(
          `SELECT tier, to_char(notice_dated_on,'YYYY-MM-DD') AS notice, tier_deadline_at, version
             FROM appeal_case WHERE id=$1`,
          [id],
        )
      ).rows[0];

    beforeEach(async () => {
      await admin.query(
        `UPDATE remittance_advice SET production_date = '2026-01-01T00:00:00Z'
           WHERE id = (SELECT remittance_advice_id FROM remittance_line WHERE id = $1)`,
        [remittanceLineId],
      );
    });

    it("a redetermination anchors on the remittance advice date, not the day the file was ingested", async () => {
      const denialId = await seedDenial(true);
      const { id } = await write().createAppeal(actor, denialId, {});
      const row = await appealRow(id);
      expect(row.notice).toBe("2026-01-01");
      // 2026-01-01 + 5 days receipt + 120 days = 2026-05-06, usable to 23:59:59.999 EDT.
      expect(new Date(row.tier_deadline_at).toISOString()).toBe("2026-05-07T03:59:59.999Z");
    });

    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as { code?: string; statusCode?: number },
      );

    it("an earlier explicit notice date is accepted (it only shortens the window)", async () => {
      const { id } = await write().createAppeal(actor, await seedDenial(true), {
        noticeDate: "2025-12-20",
      });
      expect((await appealRow(id)).notice).toBe("2025-12-20");
    });

    it("a notice date later than the remittance advice is refused: it cannot lengthen the window", async () => {
      const err = await refused(
        write().createAppeal(actor, await seedDenial(true), { noticeDate: "2026-03-10" }),
      );
      expect(err).toMatchObject({ code: "NOTICE_DATE_AFTER_REMITTANCE", statusCode: 422 });
    });

    it("a malformed or future notice date is refused (422)", async () => {
      const bad = await refused(
        write().createAppeal(actor, await seedDenial(true), { noticeDate: "2026-02-30" }),
      );
      expect(bad).toMatchObject({ code: "INVALID_NOTICE_DATE", statusCode: 422 });
      const future = await refused(
        write().createAppeal(actor, await seedDenial(false), { noticeDate: "2999-01-01" }),
      );
      expect(future).toMatchObject({ code: "NOTICE_DATE_IN_FUTURE", statusCode: 422 });
    });

    it("a redetermination with no remittance advice needs the printed notice date, not the denial open date", async () => {
      const denialId = await seedDenial(false);
      expect(await refused(write().createAppeal(actor, denialId, {}))).toMatchObject({
        code: "NOTICE_DATE_REQUIRED",
        statusCode: 422,
      });
      const { id } = await write().createAppeal(actor, denialId, { noticeDate: "2026-02-02" });
      expect((await appealRow(id)).notice).toBe("2026-02-02");
    });

    it("a manual later tier needs the notice date (422), not a guess", async () => {
      const err = await refused(
        write().createAppeal(actor, await seedDenial(false), { tier: "reconsideration" }),
      );
      expect(err).toMatchObject({ code: "NOTICE_DATE_REQUIRED", statusCode: 422 });
    });

    it("the printed decision-letter date beats a UTC-shifted timestamp", async () => {
      const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
      await admin.query("UPDATE appeal_case SET state = 'under_review' WHERE id = $1", [id]);
      // 8pm Eastern on 2026-03-01 is already 2026-03-02 in UTC; the letter says 2026-03-01.
      await write().decideAppeal(
        actor,
        id,
        {
          outcome: "unfavorable",
          decidedAt: "2026-03-02T01:00:00Z",
          decisionNoticeDate: "2026-03-01",
          reason: "The MAC upheld the denial; the medical record was found not to support prognosis.",
        },
        1,
      );
      const next = (
        await admin.query(
          `SELECT id FROM appeal_case WHERE prior_tier_appeal_case_id = $1 AND tier = 'reconsideration'`,
          [id],
        )
      ).rows[0];
      expect((await appealRow(next.id)).notice).toBe("2026-03-01");
    });

    it("a manual later tier needs a recorded unfavorable or partial decision of the prior tier", async () => {
      const err = await refused(
        write().createAppeal(actor, await seedDenial(true), {
          tier: "reconsideration",
          noticeDate: "2026-03-01",
        }),
      );
      expect(err).toMatchObject({ code: "PRIOR_TIER_REQUIRED", statusCode: 422 });
    });

    it("a manual later tier cannot restart a window: a live same-tier appeal blocks it, and so does a later date", async () => {
      const denialId = await seedDenial(true);
      const first = await write().createAppeal(actor, denialId, {});
      await admin.query("UPDATE appeal_case SET state = 'under_review' WHERE id = $1", [first.id]);
      await write().decideAppeal(
        actor,
        first.id,
        {
          outcome: "unfavorable",
          decidedAt: "2026-03-01T00:00:00Z",
          decisionNoticeDate: "2026-03-01",
          reason: "The MAC upheld the denial; the medical record was found not to support prognosis.",
        },
        1,
      );
      // The decision already spawned the reconsideration draft; a manual duplicate is refused.
      expect(
        await refused(write().createAppeal(actor, denialId, { tier: "reconsideration", noticeDate: "2026-03-01" })),
      ).toMatchObject({ code: "APPEAL_TIER_EXISTS", statusCode: 409 });
      // With the draft withdrawn, a date after the decision letter still cannot restart the clock.
      await admin.query(
        "UPDATE appeal_case SET state = 'withdrawn' WHERE denial_case_id = $1 AND tier = 'reconsideration'",
        [denialId],
      );
      expect(
        await refused(write().createAppeal(actor, denialId, { tier: "reconsideration", noticeDate: "2026-06-01" })),
      ).toMatchObject({ code: "NOTICE_DATE_AFTER_DECISION", statusCode: 422 });
    });

    it("an unappealable denial (no claim) is a 409 before any date is judged", async () => {
      const denialId = await seedDenial(false);
      await admin.query("UPDATE denial_case SET claim_id = NULL WHERE id = $1", [denialId]);
      expect(await refused(write().createAppeal(actor, denialId, { noticeDate: "2026-02-30" }))).toMatchObject({
        code: "INVALID_STATE",
        statusCode: 409,
      });
    });

    it("the last filing day ends in the provider's own zone when its locations agree", async () => {
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'West','1 Main','Reno','NV','89501','America/Los_Angeles')`,
        [providerEntityId],
      );
      try {
        const { id } = await write().createAppeal(actor, await seedDenial(true), {});
        // Same last filing day as the Eastern case (2026-05-06), ending 3 hours later on the Pacific clock.
        expect(new Date((await appealRow(id)).tier_deadline_at).toISOString()).toBe(
          "2026-05-07T06:59:59.999Z",
        );
      } finally {
        await admin.query("DELETE FROM location WHERE provider_entity_id = $1", [providerEntityId]);
      }
    });

    it("a decision notice date later than the decided-at date is refused", async () => {
      const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
      await admin.query("UPDATE appeal_case SET state = 'under_review' WHERE id = $1", [id]);
      const err = await refused(
        write().decideAppeal(
          actor,
          id,
          {
            outcome: "favorable",
            decidedAt: "2026-01-01T00:00:00Z",
            decisionNoticeDate: "2026-02-01",
            reason: "The MAC reversed the denial after reviewing the submitted certification.",
          },
          1,
        ),
      );
      expect(err).toMatchObject({ code: "NOTICE_DATE_AFTER_DECISION", statusCode: 422 });
    });

    it("an unfavorable decision opens the QIC tier on the decision-letter date", async () => {
      const { id } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
      await admin.query("UPDATE appeal_case SET state = 'under_review' WHERE id = $1", [id]);
      await write().decideAppeal(
        actor,
        id,
        {
          outcome: "unfavorable",
          decidedAt: "2026-01-01T00:00:00Z",
          reason: "The MAC upheld the denial; the medical record was found not to support prognosis.",
        },
        1,
      );
      const next = (
        await admin.query(
          `SELECT id FROM appeal_case WHERE prior_tier_appeal_case_id = $1 AND tier = 'reconsideration'`,
          [id],
        )
      ).rows[0];
      const row = await appealRow(next.id);
      expect(row.notice).toBe("2026-01-01");
      // 2026-01-01 + 5 + 180 = Sunday 2026-07-05; 4 July is a Saturday holiday observed Friday 3 July, so the
      // last filing day rolls back to Thursday 2026-07-02, usable to 23:59:59.999 EDT.
      expect(new Date(row.tier_deadline_at).toISOString()).toBe("2026-07-03T03:59:59.999Z");
    });
  });
});
