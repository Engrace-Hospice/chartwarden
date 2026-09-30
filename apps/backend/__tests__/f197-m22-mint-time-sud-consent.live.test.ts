/**
 * F-197 (#248) — the §7.16 SUD-consent MINT-TIME gate, proven against real Postgres and the real M39
 * `ConsentEvaluator` (in-memory-backed, `@wardenx/consent`'s own real evaluation logic — not a stand-in).
 *
 * `consent-gate.ts`'s `resolveSudConsentPresent` was already called once, at RENDER time — but nothing
 * re-checked consent at any LATER signed-URL mint, so a document rendered while a 42 CFR Part 2 consent was
 * active stayed freely downloadable via fresh signed URLs forever after that consent was later revoked.
 * This suite drives BOTH mint paths — the staff `signed-url-service.ts` `mint()` and the portal
 * `readers.ts` `mintPortalDownloadUrl` — against a SUD-flagged document, proving: no consent on file
 * refuses; an ACTIVE consent allows; a REVOKED consent (simulating a document rendered before, then
 * revoked after) refuses again; a non-SUD document is never gated at all; and RLS still isolates a
 * cross-tenant mint attempt to a non-leaking 404.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test …
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ConsentStore,
  type InMemoryConsentDataset,
  type StoredConsent,
  createInMemoryConsentStore,
} from "@wardenx/consent";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { ForbiddenError, NotFoundError } from "@wardenx/types";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerConsentSeams } from "../src/modules/39-consent/index";
import { createDbSignedUrlObjectResolver } from "../src/modules/22-documents/documents-route-service-db";
import {
  createInMemoryObjectStore,
  createPortalDocumentReader,
  createSudConsentEvaluatorPortalConsentPort,
} from "../src/modules/22-documents/seams/index";
import { createDrizzleDocumentReaderStore } from "../src/modules/22-documents/seams/drizzle-readers-store";
import { createSignedUrlService } from "../src/modules/22-documents/routes/signed-url-service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";
const PATIENT_A = "55555555-5555-5555-5555-555555555555";
const RECIPIENT = "66666666-6666-6666-6666-666666666666";
const NOW_MS = Date.parse("2026-09-29T00:00:00.000Z");

describe.skipIf(!DB_URL)("F-197 (#248) — mint-time SUD-consent re-check — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consentDataset: InMemoryConsentDataset;

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

  /** Insert one document + its v1 version for `org`, optionally flagged SUD-class (F-197's real signal,
   *  `document.metadata.sudRedacted`) and/or with `patient_id` null (the "no resolvable patient" edge). */
  async function seedDocument(args: {
    org: string;
    n: number;
    sud: boolean;
    patientId?: string | null;
  }) {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [args.org, `CCN-F194-${args.n}`, `F194 ${args.n}`, `NPI-F194-${args.n}`],
      )
    ).rows[0].id;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe, `Loc-F194-${args.n}`],
      )
    ).rows[0].id;
    const metadata = args.sud ? JSON.stringify({ sudRedacted: true }) : null;
    const patientId = args.patientId === undefined ? PATIENT_A : args.patientId;
    const document = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, provider_entity_id, location_id, retention_class,
           source_kind, aggregate_type, title, patient_facing, created_by_membership_id, metadata)
         VALUES ($1,$2,$3,$4,'compliance_42cfr_part2','user_upload','other','SUD chart doc',true,$5,$6) RETURNING id`,
        [args.org, patientId, pe, loc, MEMBERSHIP, metadata],
      )
    ).rows[0].id;
    const documentVersion = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
           mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1','minio/key-f194-${args.n}','application/pdf','1024','abc123','system') RETURNING id`,
        [args.org, document],
      )
    ).rows[0].id;
    await admin.query(`UPDATE document SET active_version_id = $1 WHERE id = $2`, [
      documentVersion,
      document,
    ]);
    return { documentId: document as string, versionId: documentVersion as string };
  }

  function setConsent(status: StoredConsent["status"] | "none") {
    consentDataset.consents.length = 0;
    if (status === "none") return;
    consentDataset.consents.push({
      id: "consent-1",
      organizationId: ORG_A,
      patientId: PATIENT_A,
      typeKey: "42_cfr_part_2_release",
      status,
      version: 1,
      effectiveAtMs: NOW_MS - 86_400_000,
      expiresAtMs: null,
      survivesDeath: false,
      scopeDescriptor: null,
      recipients: [
        {
          recipientResolvedKind: "workforce_member",
          recipientResolvedId: RECIPIENT,
          recipientClientId: undefined,
          removedAtMs: null,
          expiresAtMs: null,
        },
      ],
    });
  }

  const noopStorage = {
    async presignDownload() {
      return { url: "https://example.test/signed", expiresAt: "2026-09-29T00:05:00.000Z" };
    },
  };
  const noopObjects = createInMemoryObjectStore().store;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(() => {
    const { store, dataset } = createInMemoryConsentStore({
      consents: [],
      deceasedPatientIds: new Set(),
    });
    consentDataset = dataset;
    // The REAL M39 ConsentEvaluator seam — the SAME registry singleton `resolveSudConsentPresent` resolves
    // via `getSeam("ConsentEvaluator")`, not a test stand-in.
    registerConsentSeams({ store: store as ConsentStore });
  });

  describe("staff mint path (signed-url-service.ts mint())", () => {
    function service() {
      return createSignedUrlService({
        storage: noopStorage,
        resolver: createDbSignedUrlObjectResolver(handle.db),
      });
    }

    it("refuses a SUD document when no consent is on file", async () => {
      const { documentId, versionId } = await seedDocument({ org: ORG_A, n: 1, sud: true });
      setConsent("none");
      await expect(
        service().mint({
          organizationId: ORG_A,
          documentId,
          versionId,
          purpose: "treatment",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("allows a SUD document when consent is ACTIVE", async () => {
      const { documentId, versionId } = await seedDocument({ org: ORG_A, n: 2, sud: true });
      setConsent("active");
      const minted = await service().mint({
        organizationId: ORG_A,
        documentId,
        versionId,
        purpose: "treatment",
      });
      expect(minted.url).toBe("https://example.test/signed");
    });

    it("refuses again once that same consent is REVOKED — the exact vulnerability this round fixes: a document rendered while consent was active must not stay downloadable after revocation", async () => {
      const { documentId, versionId } = await seedDocument({ org: ORG_A, n: 3, sud: true });
      setConsent("active");
      await expect(
        service().mint({ organizationId: ORG_A, documentId, versionId, purpose: "treatment" }),
      ).resolves.toBeTruthy();
      setConsent("revoked");
      await expect(
        service().mint({ organizationId: ORG_A, documentId, versionId, purpose: "treatment" }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("never gates a non-SUD document, consent present or not", async () => {
      const { documentId, versionId } = await seedDocument({ org: ORG_A, n: 4, sud: false });
      setConsent("none");
      const minted = await service().mint({
        organizationId: ORG_A,
        documentId,
        versionId,
        purpose: "treatment",
      });
      expect(minted.url).toBe("https://example.test/signed");
    });

    it("stays a non-leaking 404 for a cross-tenant mint attempt (RLS), independent of the SUD gate", async () => {
      const { documentId, versionId } = await seedDocument({ org: ORG_B, n: 5, sud: true });
      setConsent("none");
      await expect(
        service().mint({ organizationId: ORG_A, documentId, versionId, purpose: "treatment" }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("portal mint path (readers.ts mintPortalDownloadUrl)", () => {
    function portal() {
      const store = createDrizzleDocumentReaderStore(handle.db);
      return createPortalDocumentReader({
        store,
        objects: noopObjects,
        consent: createSudConsentEvaluatorPortalConsentPort(),
      });
    }

    it("refuses a SUD document when no consent is on file", async () => {
      const { versionId } = await seedDocument({ org: ORG_A, n: 6, sud: true });
      setConsent("none");
      const res = await runWithRequestContext(
        { organizationId: ORG_A, userId: MEMBERSHIP } as never,
        () =>
          portal().mintPortalDownloadUrl({
            documentVersionId: versionId,
            portalSessionId: "s",
            patientId: PATIENT_A,
            organizationId: ORG_A,
          }),
      );
      expect(res).toEqual({ denied: true, reason: "sud_consent_absent" });
    });

    it("allows a SUD document when consent is ACTIVE, then refuses again once REVOKED", async () => {
      const { versionId } = await seedDocument({ org: ORG_A, n: 7, sud: true });
      setConsent("active");
      const allowed = await runWithRequestContext(
        { organizationId: ORG_A, userId: MEMBERSHIP } as never,
        () =>
          portal().mintPortalDownloadUrl({
            documentVersionId: versionId,
            portalSessionId: "s",
            patientId: PATIENT_A,
            organizationId: ORG_A,
          }),
      );
      expect("url" in allowed).toBe(true);
      setConsent("revoked");
      const denied = await runWithRequestContext(
        { organizationId: ORG_A, userId: MEMBERSHIP } as never,
        () =>
          portal().mintPortalDownloadUrl({
            documentVersionId: versionId,
            portalSessionId: "s",
            patientId: PATIENT_A,
            organizationId: ORG_A,
          }),
      );
      expect(denied).toEqual({ denied: true, reason: "sud_consent_absent" });
    });
  });
});
