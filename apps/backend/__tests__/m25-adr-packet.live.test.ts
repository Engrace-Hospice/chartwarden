/**
 * M25 ADR response packet (hospice ADR/TPE/QIC PRD, milestone 2b) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`
 * role, through the real catalog-validating outbox publisher AND the real cross-module seams (M23
 * `ClaimSubmissionReader`, M22 `DocumentReader`).
 *
 * Proves what the pure suites cannot: attachments obey the appeal enclosure rules (another patient, another
 * tenant, 42 CFR Part 2, superseded - refused with a reason code and never a title), a reviewer must differ from
 * whoever sent the packet to review, a sign-off is on the version the reviewer saw, nothing reaches `submitted`
 * without sign-off and proof, a late filing needs an acknowledgement, the render request is a valid typed packet
 * that reaches the outbox in the same transaction, a document reclassified to Part 2 after attachment stops the
 * filing, and the database freezes the manifest, the filing facts and the enclosure list once filed.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:adr-packet:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { adrPacketViolations } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createDocumentReader,
  createDrizzleDocumentReaderStore,
} from "../src/modules/22-documents/index";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { ADR_CHECKLIST_KEYS } from "../src/modules/25-remittance/domain";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { buildDrizzleAdrService } from "../src/modules/25-remittance/routes/adr-service";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("M25 ADR response packet - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId = "";
  let claimId = "";
  const patient = randomUUID();
  const otherPatient = randomUUID();
  let userA = "";
  let memberA = "";
  let memberB = "";
  let docF2f = "";
  let docCti = "";
  let docOtherPatient = "";
  let docPart2 = "";
  let docSuperseded = "";
  let docOtherTenant = "";

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };
  const svc = (withOutbox = true) =>
    buildDrizzleAdrService(handle.db, {
      ...(withOutbox ? { outbox: m25Outbox } : {}),
      sources: buildSeamAppealSourcePorts(),
    });
  const actorOf = (membershipId: string, organizationId = ORG) => ({
    organizationId,
    userId: userA,
    membershipId,
    roles: ["billing_manager"],
    stepUpRecent: true,
  });
  const A = () => actorOf(memberA);
  const B = () => actorOf(memberB);
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string; statusCode?: number }) => e,
    );
  const row = async (id: string) =>
    (await admin.query("SELECT * FROM adr_case WHERE id=$1", [id])).rows[0];
  const ver = async (id: string) => Number((await row(id)).version);
  const outboxFor = async (id: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m25.adr_packet.render_requested' AND aggregate_id=$1",
        [id],
      )
    ).rows;

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
          memberA,
        ],
      )
    ).rows[0].id as string;
  }

  /** A new ADR for the claim, moved into assembly by A. */
  async function inAssembly(requestedDaysAgo = 5): Promise<string> {
    const { id } = await svc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(requestedDaysAgo),
      adrReference: "ADR-REF-1",
    });
    await svc().transitionAdr(A(), id, "in_assembly", await ver(id));
    return id;
  }
  async function tickAll(id: string): Promise<void> {
    for (const key of ADR_CHECKLIST_KEYS) {
      await svc().setAdrChecklistItem(
        A(),
        id,
        key,
        key === "visit_notes" ? "not_applicable" : "ready",
        await ver(id),
      );
    }
  }
  async function attach(id: string, documentId: string, checklistKey?: string): Promise<void> {
    await svc().attachAdrDocument(
      A(),
      id,
      { documentId, ...(checklistKey ? { checklistKey } : {}) },
      await ver(id),
    );
  }
  /** Assembled by A: two documents, checklist complete, sent to review. */
  async function inReview(requestedDaysAgo = 5): Promise<string> {
    const id = await inAssembly(requestedDaysAgo);
    await attach(id, docF2f, "plan_of_care");
    await attach(id, docCti, "certification_of_terminal_illness");
    await tickAll(id);
    await svc().transitionAdr(A(), id, "in_review", await ver(id));
    return id;
  }
  const filing = (over: Record<string, unknown> = {}) => ({
    channel: "mac_portal",
    confirmationRef: "CONF-90210",
    filedAt: new Date().toISOString(),
    ...over,
  });

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
      [ORG, "m25-adrp"],
      [ORG_B, "m25-adrp-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userA = (await admin.query(`INSERT INTO "user" (email) VALUES ('adrp-a@x.test') RETURNING id`))
      .rows[0].id as string;
    const userB = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('adrp-b@x.test') RETURNING id`)
    ).rows[0].id as string;
    const member = async (user: string) =>
      (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, ORG],
        )
      ).rows[0].id as string;
    memberA = await member(userA);
    memberB = await member(userB);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-ADRP','ADRP','NPI-ADRP','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    claimId = (
      await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
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
          claimControlNumber: "CCN-ADRP-0001",
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 100_000,
        }),
      )
    ).id;
    docF2f = await seedDocument(ORG, patient, "Face-to-face encounter 2026-02-20");
    docCti = await seedDocument(ORG, patient, "Certification of terminal illness", {
      aggregateType: "cti",
    });
    docOtherPatient = await seedDocument(ORG, otherPatient, "SECRET other patient's note");
    docPart2 = await seedDocument(ORG, patient, "SECRET SUD treatment note", {
      retentionClass: "compliance_42cfr_part2",
    });
    docSuperseded = await seedDocument(ORG, patient, "Old version", { status: "superseded" });
    docOtherTenant = await seedDocument(ORG_B, null, "SECRET other tenant's document");
    registerM23PublishedSeams(handle.db);
    registerSeam(
      "DocumentReader",
      createDocumentReader(createDrizzleDocumentReaderStore(handle.db)),
    );
  }, 240_000);

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  it("assembles, reviews by a second person, and files: manifest frozen, proof stored, valid render request", async () => {
    const id = await inReview();
    // The assembler cannot sign off their own packet.
    expect(await refused(svc().signOffAdr(A(), id, await ver(id)))).toMatchObject({
      code: "REVIEWER_IS_ASSEMBLER",
      statusCode: 409,
    });
    await svc().signOffAdr(B(), id, await ver(id));
    const before = await row(id);
    expect(before.reviewed_by_membership_id).toBe(memberB);

    await svc().submitAdr(B(), id, filing(), await ver(id));
    const after = await row(id);
    expect(after.state).toBe("submitted");
    expect(after.filing_channel).toBe("mac_portal");
    expect(after.filing_confirmation_ref).toBe("CONF-90210");
    expect(after.filed_late).toBe(false);
    expect(
      after.packet_manifest.documents.map((d: { documentId: string }) => d.documentId),
    ).toEqual([docF2f, docCti]);

    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    const packet = rows[0].payload.payload;
    expect(adrPacketViolations(packet)).toEqual([]);
    expect(packet).toMatchObject({
      adrCaseId: id,
      macName: "CGS",
      filingChannel: "mac_portal",
      filingConfirmationRef: "CONF-90210",
      filedLate: false,
      enclosures: [
        { ordinal: 1, documentId: docF2f, title: "Face-to-face encounter 2026-02-20" },
        { ordinal: 2, documentId: docCti, title: "Certification of terminal illness" },
      ],
    });

    const detail = await svc().getAdr(B(), id);
    expect(detail?.packet.filing?.confirmationRef).toBe("CONF-90210");
    expect(detail?.events.map((e) => e.eventKind)).toEqual(
      expect.arrayContaining(["document_attached", "checklist_updated", "signed_off", "submitted"]),
    );
  });

  it("the database freezes the manifest, the filing facts and the enclosure list once filed", async () => {
    const id = await inReview();
    await svc().signOffAdr(B(), id, await ver(id));
    await svc().submitAdr(B(), id, filing(), await ver(id));
    await expect(
      admin.query("UPDATE adr_case SET packet_manifest = '{}'::jsonb WHERE id=$1", [id]),
    ).rejects.toThrow(/M25_ADR_FILING_IMMUTABLE/);
    await expect(
      admin.query("UPDATE adr_case SET filing_confirmation_ref = 'x' WHERE id=$1", [id]),
    ).rejects.toThrow(/M25_ADR_FILING_IMMUTABLE/);
    await expect(
      admin.query(
        `INSERT INTO adr_case_document (organization_id, adr_case_id, document_id) VALUES ($1,$2,$3)`,
        [ORG, id, randomUUID()],
      ),
    ).rejects.toThrow(/M25_ADR_PACKET_FROZEN/);
    await expect(
      admin.query("UPDATE adr_case_document SET removed_at = now() WHERE adr_case_id=$1", [id]),
    ).rejects.toThrow(/M25_ADR_PACKET_FROZEN/);
  });

  it("the database refuses a submitted case without its manifest", async () => {
    const id = await inReview();
    await expect(
      admin.query("UPDATE adr_case SET state='submitted' WHERE id=$1", [id]),
    ).rejects.toThrow(/adr_case_submitted_has_filing/);
  });

  it("refuses attachments by the appeal enclosure rules, naming the reason and never the title", async () => {
    const id = await inAssembly();
    for (const [documentId, reason] of [
      [docOtherPatient, "other_patient"],
      [docPart2, "part2_restricted"],
      [docSuperseded, "not_active"],
      [docOtherTenant, "not_found"],
      [randomUUID(), "not_found"],
    ] as const) {
      const e = await refused(svc().attachAdrDocument(A(), id, { documentId }, await ver(id)));
      expect(e).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE", statusCode: 422 });
      expect(e?.message).toContain(reason);
      expect(e?.message).toContain("ADR response");
      expect(e?.message).not.toContain("SECRET");
    }
    await attach(id, docF2f);
    expect(
      await refused(svc().attachAdrDocument(A(), id, { documentId: docF2f }, await ver(id))),
    ).toMatchObject({ code: "ADR_DUPLICATE_DOCUMENT", statusCode: 409 });
    expect(
      await refused(
        svc().attachAdrDocument(
          A(),
          id,
          { documentId: docCti, checklistKey: "bogus" },
          await ver(id),
        ),
      ),
    ).toMatchObject({ code: "INVALID_CHECKLIST_KEY" });
  });

  it("changes the packet only while the case is in assembly, and removing a document keeps the history", async () => {
    const { id } = await svc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(5),
    });
    expect(
      await refused(svc().attachAdrDocument(A(), id, { documentId: docF2f }, await ver(id))),
    ).toMatchObject({ code: "ADR_WRONG_STATE", statusCode: 409 });
    await svc().transitionAdr(A(), id, "in_assembly", await ver(id));
    await attach(id, docF2f);
    await svc().detachAdrDocument(A(), id, docF2f, await ver(id));
    const rows = (
      await admin.query("SELECT removed_at FROM adr_case_document WHERE adr_case_id=$1", [id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).not.toBeNull();
    // The same document can be attached again after a removal.
    await attach(id, docF2f);
    expect((await svc().getAdr(A(), id))?.packet.documents).toHaveLength(1);
  });

  it("refuses sign-off of an empty packet or an unticked checklist, and a stale version is a 409", async () => {
    const empty = await inAssembly();
    await tickAll(empty);
    await svc().transitionAdr(A(), empty, "in_review", await ver(empty));
    expect(await refused(svc().signOffAdr(B(), empty, await ver(empty)))).toMatchObject({
      code: "PACKET_EMPTY",
    });

    const unticked = await inAssembly();
    await attach(unticked, docF2f);
    await svc().transitionAdr(A(), unticked, "in_review", await ver(unticked));
    expect(await refused(svc().signOffAdr(B(), unticked, await ver(unticked)))).toMatchObject({
      code: "CHECKLIST_INCOMPLETE",
    });

    const id = await inReview();
    const stale = await ver(id);
    await svc().transitionAdr(A(), id, "in_assembly", stale); // returned: the version moves
    await svc().transitionAdr(A(), id, "in_review", await ver(id));
    expect(await refused(svc().signOffAdr(B(), id, stale))).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
    });
  });

  it("returning a signed-off packet to assembly voids the sign-off", async () => {
    const id = await inReview();
    await svc().signOffAdr(B(), id, await ver(id));
    await svc().transitionAdr(A(), id, "in_assembly", await ver(id));
    const r = await row(id);
    expect(r.reviewed_by_membership_id).toBeNull();
    expect(r.reviewed_at).toBeNull();
    await svc().transitionAdr(A(), id, "in_review", await ver(id));
    expect(await refused(svc().submitAdr(B(), id, filing(), await ver(id)))).toMatchObject({
      code: "NOT_SIGNED_OFF",
      statusCode: 409,
    });
  });

  it("refuses a filing without proof, with a bad channel, or dated in the future", async () => {
    const id = await inReview();
    await svc().signOffAdr(B(), id, await ver(id));
    const tryFile = async (over: Record<string, unknown>) =>
      refused(svc().submitAdr(B(), id, filing(over), await ver(id)));
    expect(await tryFile({ confirmationRef: "  " })).toMatchObject({ code: "PROOF_REQUIRED" });
    expect(await tryFile({ channel: "carrier_pigeon" })).toMatchObject({ code: "CHANNEL_INVALID" });
    expect(await tryFile({ filedAt: new Date(Date.now() + 864e5).toISOString() })).toMatchObject({
      code: "FILED_IN_FUTURE",
    });
    expect(await tryFile({ filedAt: "not a date" })).toMatchObject({ code: "INVALID_FILING_TIME" });
    expect((await row(id)).state).toBe("in_review");
    expect(await outboxFor(id)).toHaveLength(0);
  });

  it("a late filing needs an acknowledgement and is then recorded as late", async () => {
    const id = await inReview(100); // 45 days from 100 days ago is long past
    await svc().signOffAdr(B(), id, await ver(id));
    expect(await refused(svc().submitAdr(B(), id, filing(), await ver(id)))).toMatchObject({
      code: "LATE_ACKNOWLEDGEMENT_REQUIRED",
    });
    await svc().submitAdr(B(), id, filing({ lateAcknowledged: true }), await ver(id));
    const r = await row(id);
    expect(r.state).toBe("submitted");
    expect(r.filed_late).toBe(true);
    expect((await outboxFor(id))[0].payload.payload.filedLate).toBe(true);
  });

  it("a document reclassified to 42 CFR Part 2 after attachment stops the filing, atomically", async () => {
    const id = await inReview();
    await svc().signOffAdr(B(), id, await ver(id));
    await admin.query("UPDATE document SET retention_class='compliance_42cfr_part2' WHERE id=$1", [
      docCti,
    ]);
    try {
      const e = await refused(svc().submitAdr(B(), id, filing(), await ver(id)));
      expect(e).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE" });
      expect(e?.message).toContain("part2_restricted");
      expect((await row(id)).state).toBe("in_review");
      expect(await outboxFor(id)).toHaveLength(0);
    } finally {
      await admin.query("UPDATE document SET retention_class='clinical_record' WHERE id=$1", [
        docCti,
      ]);
    }
  });

  it("refuses to record a filing when no outbox is bound, leaving the case untouched", async () => {
    const id = await inReview();
    await svc().signOffAdr(B(), id, await ver(id));
    expect(await refused(svc(false).submitAdr(B(), id, filing(), await ver(id)))).toMatchObject({
      code: "SEAM_UNBOUND",
      statusCode: 503,
    });
    expect((await row(id)).state).toBe("in_review");
  });

  it("caps a packet at the shared enclosure limit at attach, so filing cannot fail on size later", async () => {
    const id = await inAssembly();
    for (let i = 0; i < 50; i += 1) await attach(id, await seedDocument(ORG, patient, `Bulk ${i}`));
    const e = await refused(
      svc().attachAdrDocument(A(), id, { documentId: docF2f }, await ver(id)),
    );
    expect(e).toMatchObject({ code: "ADR_TOO_MANY_ENCLOSURES", statusCode: 422 });
  });

  it("another tenant cannot see or change an ADR's packet", async () => {
    const id = await inAssembly();
    const intruder = actorOf(randomUUID(), ORG_B);
    expect(await svc().getAdr(intruder, id)).toBeNull();
    expect(
      await refused(svc().attachAdrDocument(intruder, id, { documentId: docF2f }, await ver(id))),
    ).toMatchObject({ statusCode: 404 });
    expect(await refused(svc().signOffAdr(intruder, id, await ver(id)))).toMatchObject({
      statusCode: 404,
    });
  });

  it("the app role cannot rewrite the case's anchor or delete packet rows", async () => {
    const id = await inAssembly();
    await attach(id, docF2f);
    const app = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.org_id', $1, false)`, [ORG]);
      await expect(
        app.query("UPDATE adr_case SET response_due_at = now() WHERE id=$1", [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query("DELETE FROM adr_case_document WHERE adr_case_id=$1", [id]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
