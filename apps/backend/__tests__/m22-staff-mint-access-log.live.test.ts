/**
 * M22 §4.12 / §164.528 — a STAFF signed-URL mint is accounted, proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role through the real signed-URL service and the real Drizzle ledger writer.
 *
 * What this pins:
 *   • a disclosure mint appends exactly one `document_access_log` row: the staff membership (no portal
 *     account), the patient, access_kind 'disclosure_export', purpose, and `recipient_class` = '<kind>:<id>';
 *   • an internal-purpose mint is logged too, with a null recipient (a mislabelled hand-off stays visible);
 *   • a ledger write that RLS refuses (asserted org != ambient org) throws, so no URL is released;
 *   • the ledger is org-isolated and append-only for the app role (no UPDATE / DELETE).
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run \
 *     apps/backend/__tests__/m22-staff-mint-access-log.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createSignedUrlService } from "../src/modules/22-documents/routes/signed-url-service";
import { createDrizzleStaffMintAccessLog } from "../src/modules/22-documents/seams/drizzle-readers-store";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-1111111a0001";
const ORG_B = "22222222-2222-4222-8222-2222222a0001";
const USER_A = "33333333-3333-4333-8333-3333333a0001";
const MEMBERSHIP = "44444444-4444-4444-8444-4444444a0001";
const PATIENT = "55555555-5555-4555-8555-5555555a0001";
const DOC = "66666666-6666-4666-8666-6666666a0001";
const VERSION = "77777777-7777-4777-8777-7777777a0001";
const FACILITY = "88888888-8888-4888-8888-8888888a0001";

/** drizzle wraps the driver error; the SQLSTATE text lives on `cause`. */
async function expectDenied(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(`${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ""}`).toMatch(
      pattern,
    );
    return;
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

describe.skipIf(!DB_URL)("M22 staff signed-URL mint accounting — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  const service = (rowOrganizationId: string = ORG_A) =>
    createSignedUrlService({
      storage: {
        async presignDownload() {
          return { url: "https://minio.example/x", expiresAt: "2099-01-01T00:00:00.000Z" };
        },
      },
      resolver: {
        async loadObject() {
          return { objectKey: "k", externalRecipient: null, patientId: PATIENT, isSudClass: false };
        },
      },
      accessLog: {
        // The real writer; `rowOrganizationId` lets a test assert an org that is not the ambient one.
        append: (entry) =>
          createDrizzleStaffMintAccessLog(handle.db).append({
            ...entry,
            organizationId: rowOrganizationId as typeof entry.organizationId,
          }),
      },
    });
  const mint = (svc: ReturnType<typeof service>, purpose: "disclosure" | "treatment") =>
    runWithRequestContext(
      { organizationId: ORG_A, userId: USER_A, correlationId: "corr-m22-staff" } as never,
      () =>
        svc.mint({
          organizationId: ORG_A as never,
          documentId: DOC,
          versionId: VERSION,
          purpose,
          actorMembershipId: MEMBERSHIP,
          ...(purpose === "disclosure"
            ? { recipient: { kind: "facility" as const, entityId: FACILITY } }
            : {}),
        }),
    );
  const rows = async (org = ORG_A) =>
    (
      await admin.query(
        `SELECT organization_id, document_id, document_version_id, accessor_membership_id,
                accessor_portal_account_id, patient_id, access_kind, purpose, recipient_class, correlation_id
           FROM document_access_log WHERE organization_id = $1 ORDER BY accessed_at, id`,
        [org],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'staff-mint@x.test')`, [USER_A]);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // Disclosure needs the entity + an executed BAA; both seams are stubbed (this suite is about the ledger).
    __resetSeamsForTest();
    registerSeam("MdmEntityProvider", {
      resolveFacility: async (_org: string, id: string) => ({ id, status: "active" }),
      resolvePayer: async (_org: string, id: string) => ({ id, status: "active" }),
    } as never);
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed" }),
    } as never);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM document_access_log");
  });

  it("a disclosure mint appends exactly one row: staff membership, patient, kind, purpose and recipient", async () => {
    const out = await mint(service(), "disclosure");
    expect(out.accessKind).toBe("disclosure_export");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      organization_id: ORG_A,
      document_id: DOC,
      document_version_id: VERSION,
      accessor_membership_id: MEMBERSHIP,
      accessor_portal_account_id: null,
      patient_id: PATIENT,
      access_kind: "disclosure_export",
      purpose: "disclosure",
      recipient_class: `facility:${FACILITY}`,
      correlation_id: "corr-m22-staff",
    });
  });

  it("the row also lands in the M4 audit trail, attributed to the minting user", async () => {
    await mint(service(), "disclosure");
    const logId = (
      await admin.query("SELECT id::text FROM document_access_log WHERE organization_id = $1", [
        ORG_A,
      ])
    ).rows[0].id as string;
    const audit = (
      await admin.query(
        `SELECT actor_user_id::text, event_type FROM audit_event
          WHERE organization_id = $1 AND resource_kind = 'document_access_log' AND resource_id = $2`,
        [ORG_A, logId],
      )
    ).rows;
    expect(audit).toEqual([{ actor_user_id: USER_A, event_type: "document_access_log.insert" }]);
  });

  it("an internal-purpose mint is logged too, with no recipient", async () => {
    await mint(service(), "treatment");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      access_kind: "signed_url_issued",
      purpose: "treatment",
      recipient_class: null,
    });
  });

  it("a ledger write RLS refuses (row org != ambient org) throws and releases no URL", async () => {
    await expectDenied(mint(service(ORG_B), "treatment"), /row-level security|violates/i);
    expect(await rows(ORG_A)).toHaveLength(0);
    expect(await rows(ORG_B)).toHaveLength(0);
  });

  it("is org-isolated and append-only for the app role", async () => {
    await mint(service(), "treatment");
    const seenByB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: USER_A },
      (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM document_access_log`),
    );
    const first =
      (seenByB as unknown as { rows?: Array<{ n: number }> }).rows?.[0] ??
      (seenByB as unknown as Array<{ n: number }>)[0];
    expect(first?.n).toBe(0);
    await expectDenied(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: USER_A }, (tx) =>
        tx.execute(sql`UPDATE document_access_log SET purpose = 'x'`),
      ),
      /permission denied/i,
    );
    await expectDenied(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: USER_A }, (tx) =>
        tx.execute(sql`DELETE FROM document_access_log`),
      ),
      /permission denied/i,
    );
  });
});
