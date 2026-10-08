/**
 * GAP-036 - the appeal packet render request carries the TYPED AppealPacketRenderPayload, LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role through the real catalog-validating outbox publisher.
 *
 * Before: submitAppeal published `m25.appeal_packet.render_requested` with `payload: {}` (the late good-cause path
 * with `{ lateGoodCauseFiling: true }` only), so M22 rendered a letter with no narrative, no document index and no
 * claim / remittance references - and the stored narrative never reached it. Now the payload is built server-side
 * from the appeal + denial rows, validates against AppealPacketRenderPayload, and renders as a real PDF.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m25:appeal-packet:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { appealPacketViolations } from "@wardenx/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
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
  const claimId = randomUUID();
  const remittanceLineId = randomUUID();
  const docA = randomUUID();
  const docB = randomUUID();

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };

  async function seedAppeal(
    tier: string,
    deadline: string,
  ): Promise<{ id: string; denialId: string }> {
    const denialId = (
      await admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, remittance_line_id,
           source_evv_aggregator_submission_id, carc_code, rarc_code, category, source, state, dollar_value,
           taxonomy_status)
         VALUES ($1,$2,$3,$4,$5,'50','N115','denial','evv_aggregator_rejection','in_progress',1234.50,'mapped')
         RETURNING id`,
        [ORG, providerEntityId, claimId, remittanceLineId, randomUUID()],
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m25-pkt','A','A')",
      [ORG],
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
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("submitAppeal publishes a valid typed packet built from the appeal + denial rows", async () => {
    const { id, denialId } = await seedAppeal("redetermination", "2027-03-01T00:00:00Z");
    const write = buildDrizzleM25WriteService(handle.db, m25Outbox);
    await write.submitAppeal(
      actor,
      id,
      { appealNarrative: NARRATIVE, attachedDocumentIds: [docA, docB] },
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
        { ordinal: 1, documentId: docA },
        { ordinal: 2, documentId: docB },
      ],
      signedClaimCopyRef: { claimId },
      remitCopyRef: { remittanceLineId },
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

  it("the published payload renders as a real PDF carrying the narrative and the document index", async () => {
    const [{ id }] = (await admin.query("SELECT id FROM appeal_case")).rows;
    const [{ payload }] = await renderRequested(id);
    const bytes = renderPdfForTemplate(
      "appeal_packet",
      { ...payload.payload, aggregateId: id, patientId: null },
      "Appeal Packet",
    );
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).toContain("Request for Redetermination");
    expect(raw).toContain("face-to-face");
    expect(raw).not.toContain("wardenx-render");
  });

  it("a late good-cause filing carries the justification and the flag in the typed packet", async () => {
    const { id } = await seedAppeal("reconsideration", "2025-01-01T00:00:00Z");
    const write = buildDrizzleM25WriteService(handle.db, m25Outbox);
    await write.submitAppealLateGoodCause(
      actor,
      id,
      {
        appealNarrative: NARRATIVE,
        attachedDocumentIds: [],
        goodCauseJustification:
          "The MAC notice was misdelivered to a prior address on file with CMS.",
      },
      1,
    );
    const [{ payload }] = await renderRequested(id);
    expect(appealPacketViolations(payload.payload)).toEqual([]);
    expect(payload.payload).toMatchObject({
      lateGoodCauseFiling: true,
      tier: "reconsideration",
      supportingDocuments: [],
    });
    expect(payload.payload.goodCauseJustification).toContain("misdelivered");
  });
});
