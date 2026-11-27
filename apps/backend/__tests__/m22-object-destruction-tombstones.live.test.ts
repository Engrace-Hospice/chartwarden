/**
 * M22 CW-DS-01 — object destruction tombstones, LIVE Postgres. Every tenant read runs as the NOBYPASSRLS `chartwarden_app` role and the
 * document eraser runs as a real `chartwarden_destruction` login; the superuser only seeds and inspects.
 *
 *   1. ROLES      the application role reads its own tenant's tombstones and nothing else, and cannot write, change or delete one;
 *                 the destruction role inserts for ITS organization only (RLS WITH CHECK, and a CHECK pinning the bucket to the
 *                 tenant), cannot change or delete one; a superuser's UPDATE and DELETE are refused too (append-only trigger).
 *   2. ERASER     a certificate erase tombstones every object it destroys, BEFORE destroying it: the objects of a held document and
 *                 of a 42 CFR Part 2 document are neither destroyed nor tombstoned, another patient's and another tenant's objects
 *                 are untouched, and a second run changes nothing.
 *   3. HOLD       releasing the hold lets the next erase destroy and tombstone the document that was kept.
 *   4. DURABLE    a store that fails mid-erase leaves every planned tombstone committed and every row in place, and a retry finishes.
 *   5. AUDIT      each tombstone writes an `object_destruction_tombstone.insert` audit event whose snapshot carries no object key (it
 *                 holds the patient's id), and the row deletes of the destroyed document are audited too.
 *   6. EXPORT     `exportTombstones` returns exactly the tombstoned objects, in the form the copy tool's `--tombstones` reads.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m22:object-destruction:live
 * Use a PRIVATE pgvector/pgvector:pg18 (chartwarden-postgres:dev) container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeOrgTombstones } from "../../../scripts/db/lib/purge-org-tombstones";
import { isObjectKeyShape, parseTombstones } from "../../../scripts/lib/object-tombstones";
import { exportTombstones } from "../../../scripts/storage/object-tombstones";
import {
  createDrizzleDocumentEraseStore,
  eraseDocumentRecord,
} from "../src/modules/22-documents/erasers/document-eraser";
import { deriveObjectKey, deriveTenantBucket } from "../src/modules/22-documents/lifecycle/storage";
import { createInMemoryObjectStore } from "../src/modules/22-documents/seams/store";
import type { ObjectStorePort } from "../src/modules/22-documents/seams/store";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-1111000d5101";
const ORG_B = "22222222-2222-4222-8222-2222000d5102";
const MEMBER = "33333333-3333-4333-8333-3333000d5103";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a1";
const PATIENT_OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a2";
const PATIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-0000000d51b1";
const PATIENT_HELD = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a3";
const PATIENT_ROLES = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a4"; // the roles tests seed their own patient, so the eraser tests below never destroy their documents
const PATIENT_KEPT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a5"; // held and Part 2 documents the database must refuse to tombstone
const PATIENT_BIG = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a6"; // one document with more versions than one INSERT can bind
const PATIENT_ODD = "aaaaaaaa-aaaa-4aaa-8aaa-0000000d51a7"; // a document whose key the store would not write today
const ORG_C = "44444444-4444-4444-8444-4444000d5104"; // the seed-teardown test's organization
const DESTROYER_LOGIN = "ds01_destroyer";
const DESTROYER_PASSWORD = "ds01_destroyer_pw";
const BUCKET_A = deriveTenantBucket(ORG_A as never);
const BUCKET_B = deriveTenantBucket(ORG_B as never);

describe.skipIf(!DB_URL)("M22 object destruction tombstones (CW-DS-01) - LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;
  let destroyer: ReturnType<typeof createDbClient>;
  let adminHandle: ReturnType<typeof createDbClient>;
  const memory = createInMemoryObjectStore();
  /** Keys whose destruction the store should refuse (a store outage in the middle of an erase). */
  const failing = new Set<string>();
  const flakyStore: ObjectStorePort = {
    ...memory.store,
    async destroyAllVersions(args) {
      if (failing.has(args.objectKey)) throw new Error("store unavailable");
      return memory.store.destroyAllVersions(args);
    },
  };
  const eraser = () => createDrizzleDocumentEraseStore(destroyer.db, { objects: flakyStore });
  const erase = (org: string, patient: string) => eraseDocumentRecord(org, patient, eraser());

  const objectPath = (bucket: string, key: string): string => `${bucket}/${key}`;
  const keyOf = (patient: string, name: string): string =>
    `documents/${patient}/other/${randomUUID()}/${name}.pdf`;

  async function seedDocument(
    org: string,
    patient: string,
    keys: readonly string[],
    opts: { retentionClass?: string; hold?: boolean } = {},
  ): Promise<string> {
    const documentId = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1,$2,$3,'user_upload','other','Synthetic doc',$4) RETURNING id`,
        [org, patient, opts.retentionClass ?? "clinical_record", MEMBER],
      )
    ).rows[0].id as string;
    let n = 0;
    for (const key of keys) {
      n += 1;
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,$3,$4,'application/pdf','10',$5,'system_render')`,
        [org, documentId, String(n), key, "a".repeat(64)],
      );
      memory.objects.set(
        objectPath(deriveTenantBucket(org as never), key),
        new TextEncoder().encode(`synthetic ${key}`),
      );
    }
    if (opts.hold)
      await admin.query(
        "INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id) VALUES ($1,$2,gen_random_uuid())",
        [org, documentId],
      );
    return documentId;
  }

  const tombstoneKeys = async (org: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT object_key FROM object_destruction_tombstone WHERE organization_id = $1 ORDER BY object_key",
        [org],
      )
    ).rows.map((r) => r.object_key as string);
  const docExists = async (id: string): Promise<boolean> =>
    (await admin.query("SELECT 1 FROM document WHERE id = $1", [id])).rowCount === 1;
  const present = (bucket: string, key: string): boolean =>
    memory.objects.has(objectPath(bucket, key));

  /** The SQLSTATE of the error a statement raises (undefined when it succeeds). */
  async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      return e.code ?? e.cause?.code;
    }
  }
  const rowsOf = (result: unknown): Record<string, unknown>[] =>
    ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Record<string, unknown>[];

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        text = text.replace(/\bvector\(\d+\)/g, "text");
        text = text.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(text);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'ds01-a','A','A'),($2,'ds01-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ds01@x.test')`, [MEMBER]);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    appHandle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${DESTROYER_LOGIN}') THEN
       CREATE ROLE ${DESTROYER_LOGIN} LOGIN PASSWORD '${DESTROYER_PASSWORD}'; END IF; END $$;`,
    );
    // Re-granted every run: the roles are dropped and recreated, which silently ends an earlier membership.
    await admin.query(`GRANT chartwarden_destruction TO ${DESTROYER_LOGIN}`);
    const url = new URL(DB_URL as string);
    url.username = DESTROYER_LOGIN;
    url.password = DESTROYER_PASSWORD;
    destroyer = createDbClient({ connectionString: url.toString() });
    adminHandle = createDbClient({ connectionString: DB_URL as string });
  }, 300_000);

  afterAll(async () => {
    await appHandle?.close();
    await destroyer?.close();
    await adminHandle?.close();
    await admin?.end();
  });

  describe("roles", () => {
    const tombstone = (org: string, bucket: string, key: string) =>
      sql`INSERT INTO object_destruction_tombstone (organization_id, bucket, object_key) VALUES (${org}::uuid, ${bucket}, ${key})`;
    const asDestroyer = <T>(org: string, fn: (tx: DbClient) => Promise<T>) =>
      withOrgContext(destroyer.db, { organizationId: org, userId: "" }, (tx) => fn(tx as DbClient));
    const asApp = <T>(org: string, fn: (tx: DbClient) => Promise<T>) =>
      withOrgContext(appHandle.db, { organizationId: org, userId: MEMBER }, (tx) =>
        fn(tx as DbClient),
      );

    it("the destruction role inserts a tombstone for an object its organization's document versions record", async () => {
      const key = keyOf(PATIENT_ROLES, "roles-a");
      await seedDocument(ORG_A, PATIENT_ROLES, [key]);
      await asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_A, BUCKET_A, key)));
      expect(await tombstoneKeys(ORG_A)).toContain(key);
    });

    it("a tombstone cannot be planted: one for a key no document version of the organization records is refused", async () => {
      const unrecorded = keyOf(PATIENT_ROLES, "planted");
      const refused = await sqlstateOf(() =>
        asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_A, BUCKET_A, unrecorded))),
      );
      expect(refused).toBe("23514");
      // another tenant's recorded key does not count for this organization either
      const otherTenantKey = keyOf(PATIENT_B, "recorded-by-b");
      await seedDocument(ORG_B, PATIENT_B, [otherTenantKey]);
      expect(
        await sqlstateOf(() =>
          asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_A, BUCKET_A, otherTenantKey))),
        ),
      ).toBe("23514");
      expect(await tombstoneKeys(ORG_A)).not.toContain(unrecorded);
      expect(await tombstoneKeys(ORG_A)).not.toContain(otherTenantKey);
    });

    it("the destruction role cannot write a tombstone for another organization, or aim one at another tenant's bucket", async () => {
      // scoped to A, inserting a row that says B (B does record the key): refused. Two layers say no: the version check runs as the
      // destruction role scoped to A, whose row security hides B's versions (23514, which fires first), and the policy's WITH CHECK (42501).
      const keyB = keyOf(PATIENT_B, "x");
      await seedDocument(ORG_B, PATIENT_B, [keyB]);
      const crossTenant = await sqlstateOf(() =>
        asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_B, BUCKET_B, keyB))),
      );
      expect(["23514", "42501"]).toContain(crossTenant);
      expect(await tombstoneKeys(ORG_B)).not.toContain(keyB);
      // scoped to A, A's row (A records the key) but B's bucket: refused by the CHECK that pins the bucket to the tenant
      const keyY = keyOf(PATIENT_ROLES, "y");
      await seedDocument(ORG_A, PATIENT_ROLES, [keyY]);
      const wrongBucket = await sqlstateOf(() =>
        asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_A, BUCKET_B, keyY))),
      );
      expect(wrongBucket).toBe("23514");
      expect(await tombstoneKeys(ORG_B)).toEqual([]);
    });

    it("the destruction role cannot change or delete a tombstone (no grant), and a duplicate object is one row", async () => {
      const key = (await tombstoneKeys(ORG_A))[0] as string;
      for (const statement of [
        sql`UPDATE object_destruction_tombstone SET basis = 'patient_erasure'`,
        sql`DELETE FROM object_destruction_tombstone`,
      ]) {
        expect(await sqlstateOf(() => asDestroyer(ORG_A, (tx) => tx.execute(statement)))).toBe(
          "42501",
        );
      }
      expect(
        await sqlstateOf(() =>
          asDestroyer(ORG_A, (tx) => tx.execute(tombstone(ORG_A, BUCKET_A, key))),
        ),
      ).toBe("23505");
    });

    it("the application role reads its own tenant's tombstones and nothing else, and cannot write, change or delete one", async () => {
      const keyB = keyOf(PATIENT_B, "roles-b");
      await seedDocument(ORG_B, PATIENT_B, [keyB]);
      await asDestroyer(ORG_B, (tx) => tx.execute(tombstone(ORG_B, BUCKET_B, keyB)));
      const asA = rowsOf(
        await asApp(ORG_A, (tx) =>
          tx.execute(sql`SELECT organization_id FROM object_destruction_tombstone`),
        ),
      );
      expect(asA.length).toBeGreaterThan(0);
      expect(asA.every((r) => r.organization_id === ORG_A)).toBe(true);
      // no organization context: no row at all
      const bare = rowsOf(
        await appHandle.db.execute(sql`SELECT 1 FROM object_destruction_tombstone`),
      );
      expect(bare).toHaveLength(0);
      for (const statement of [
        tombstone(ORG_A, BUCKET_A, keyOf(PATIENT, "app-insert")),
        sql`UPDATE object_destruction_tombstone SET basis = 'patient_erasure'`,
        sql`DELETE FROM object_destruction_tombstone`,
      ]) {
        expect(await sqlstateOf(() => asApp(ORG_A, (tx) => tx.execute(statement)))).toBe("42501");
      }
    });

    it("no application or destruction role can TRUNCATE it (no grant)", async () => {
      const truncate = sql`TRUNCATE object_destruction_tombstone`;
      expect(await sqlstateOf(() => asApp(ORG_A, (tx) => tx.execute(truncate)))).toBe("42501");
      expect(await sqlstateOf(() => asDestroyer(ORG_A, (tx) => tx.execute(truncate)))).toBe(
        "42501",
      );
    });

    it("is append-only even for a superuser: UPDATE and DELETE are refused by the trigger, also under session_replication_role = replica", async () => {
      const statements = [
        "UPDATE object_destruction_tombstone SET basis = 'patient_erasure'",
        "DELETE FROM object_destruction_tombstone",
      ];
      for (const text of statements)
        await expect(admin.query(text), text).rejects.toMatchObject({ code: "23514" });
      // ENABLE ALWAYS: the replica role, which skips ordinary triggers, does not skip these
      await admin.query("SET session_replication_role = replica");
      try {
        for (const text of statements)
          await expect(admin.query(text), `replica: ${text}`).rejects.toMatchObject({
            code: "23514",
          });
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      expect((await tombstoneKeys(ORG_A)).length).toBeGreaterThan(0);
    });
  });

  describe("the document eraser", () => {
    it("tombstones every object it destroys, and spares a held document, a Part 2 document, another patient and another tenant", async () => {
      const normal = [keyOf(PATIENT, "n1"), keyOf(PATIENT, "n2")];
      const heldKey = keyOf(PATIENT, "held");
      const part2Key = keyOf(PATIENT, "part2");
      const otherPatientKey = keyOf(PATIENT_OTHER, "other");
      const tenantBKey = keyOf(PATIENT_B, "b");
      const normalDoc = await seedDocument(ORG_A, PATIENT, normal);
      const heldDoc = await seedDocument(ORG_A, PATIENT, [heldKey], { hold: true });
      const part2Doc = await seedDocument(ORG_A, PATIENT, [part2Key], {
        retentionClass: "compliance_42cfr_part2",
      });
      const otherDoc = await seedDocument(ORG_A, PATIENT_OTHER, [otherPatientKey]);
      const bDoc = await seedDocument(ORG_B, PATIENT_B, [tenantBKey]);
      const before = await tombstoneKeys(ORG_A);
      const tombstonesBeforeB = await tombstoneKeys(ORG_B);

      const result = await erase(ORG_A, PATIENT);

      expect(result.skips.legalHoldDocumentIds).toEqual([heldDoc]);
      expect(result.skips.part2DocumentIds).toEqual([part2Doc]);
      // the objects: only the normal document's are gone
      for (const key of normal) expect(present(BUCKET_A, key), key).toBe(false);
      for (const [bucket, key] of [
        [BUCKET_A, heldKey],
        [BUCKET_A, part2Key],
        [BUCKET_A, otherPatientKey],
        [BUCKET_B, tenantBKey],
      ] as const)
        expect(present(bucket, key), key).toBe(true);
      // the rows
      expect(await docExists(normalDoc)).toBe(false);
      for (const id of [heldDoc, part2Doc, otherDoc, bDoc]) expect(await docExists(id)).toBe(true);
      // the tombstones: exactly the destroyed objects
      const added = (await tombstoneKeys(ORG_A)).filter((k) => !before.includes(k));
      expect(added.sort()).toEqual([...normal].sort());
      expect(await tombstoneKeys(ORG_B)).toEqual(tombstonesBeforeB);
      // a second run changes nothing
      await erase(ORG_A, PATIENT);
      expect((await tombstoneKeys(ORG_A)).filter((k) => !before.includes(k)).sort()).toEqual(
        [...normal].sort(),
      );
    });

    it("once the hold is released, the next erase destroys and tombstones the document that was kept", async () => {
      const key = keyOf(PATIENT, "held-then-released");
      const doc = await seedDocument(ORG_A, PATIENT, [key], { hold: true });
      await erase(ORG_A, PATIENT);
      expect(present(BUCKET_A, key)).toBe(true);
      expect(await tombstoneKeys(ORG_A)).not.toContain(key);

      await admin.query(
        "UPDATE document_legal_hold SET released_at = now() WHERE document_id = $1",
        [doc],
      );
      await erase(ORG_A, PATIENT);

      expect(present(BUCKET_A, key)).toBe(false);
      expect(await docExists(doc)).toBe(false);
      expect(await tombstoneKeys(ORG_A)).toContain(key);
    });

    it("a store that fails mid-erase leaves every planned tombstone committed and every row in place; a retry finishes", async () => {
      const keys = [
        keyOf(PATIENT_OTHER, "d1"),
        keyOf(PATIENT_OTHER, "d2"),
        keyOf(PATIENT_OTHER, "d3"),
      ];
      const doc = await seedDocument(ORG_A, PATIENT_OTHER, keys);
      failing.add(keys[1] as string);
      await expect(erase(ORG_A, PATIENT_OTHER)).rejects.toThrow(/store unavailable/);
      // the record is there for ALL of them (committed before the first was destroyed), and nothing was row-deleted
      for (const key of keys) expect(await tombstoneKeys(ORG_A), key).toContain(key);
      expect(await docExists(doc)).toBe(true);
      expect(present(BUCKET_A, keys[1] as string)).toBe(true);

      failing.clear();
      await erase(ORG_A, PATIENT_OTHER);

      for (const key of keys) expect(present(BUCKET_A, key), key).toBe(false);
      expect(await docExists(doc)).toBe(false);
      // no duplicate rows from the retry
      expect((await tombstoneKeys(ORG_A)).filter((k) => keys.includes(k))).toHaveLength(3);
    });

    const placeHold = (org: string, documentId: string) =>
      admin.query(
        "INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id) VALUES ($1,$2,gen_random_uuid())",
        [org, documentId],
      );

    it("a hold placed while the erase is running stops it before anything is recorded or destroyed", async () => {
      const key = keyOf(PATIENT_HELD, "hold-during");
      const doc = await seedDocument(ORG_A, PATIENT_HELD, [key]);
      const store = eraser();
      await store.cryptoEraseDocumentPayloads(ORG_A, PATIENT_HELD);
      const skips = await store.resolveSkips(ORG_A, PATIENT_HELD); // read before the hold exists
      expect(skips.legalHoldDocumentIds).toEqual([]);
      await placeHold(ORG_A, doc);

      await expect(store.eraseDocumentSubtree(ORG_A, PATIENT_HELD, skips)).rejects.toThrow(
        /legal hold was placed/,
      );

      expect(await tombstoneKeys(ORG_A)).not.toContain(key); // a tombstone is permanent: none was written
      expect(present(BUCKET_A, key)).toBe(true);
      expect(await docExists(doc)).toBe(true);
    });

    it("a hold placed after a failed run keeps the document, and the tombstones of that unfinished erase are not exported", async () => {
      const keys = [keyOf(PATIENT_HELD, "e1"), keyOf(PATIENT_HELD, "e2")];
      const doc = await seedDocument(ORG_A, PATIENT_HELD, keys);
      failing.add(keys[1] as string);
      await expect(erase(ORG_A, PATIENT_HELD)).rejects.toThrow(/store unavailable/);
      for (const key of keys) expect(await tombstoneKeys(ORG_A)).toContain(key); // recorded before anything was destroyed
      failing.clear();
      await placeHold(ORG_A, doc); // the document is now held

      const rerun = await erase(ORG_A, PATIENT_HELD);

      expect(rerun.skips.legalHoldDocumentIds).toContain(doc);
      expect(await docExists(doc)).toBe(true);
      // the export leaves them out (a document version still records those keys), and counts them as pending
      const exported = await exportTombstones(adminHandle.db as DbClient);
      const index = parseTombstones(exported.text);
      for (const key of keys) expect(index.get(BUCKET_A)?.has(key), key).not.toBe(true);
      expect(exported.pending).toBeGreaterThanOrEqual(2);

      // released, the next erase finishes it and the export now carries them
      await admin.query(
        "UPDATE document_legal_hold SET released_at = now() WHERE document_id = $1",
        [doc],
      );
      await erase(ORG_A, PATIENT_HELD);
      expect(await docExists(doc)).toBe(false);
      const after = parseTombstones((await exportTombstones(adminHandle.db as DbClient)).text);
      for (const key of keys) expect(after.get(BUCKET_A)?.has(key), key).toBe(true);
    });
  });

  describe("the audit trail", () => {
    it("every tombstone is audited without its object key, and the destroyed document's row deletes are audited too", async () => {
      const key = keyOf(PATIENT, "audited");
      const doc = await seedDocument(ORG_A, PATIENT, [key]);
      await erase(ORG_A, PATIENT);

      const events = (
        await admin.query(
          `SELECT resource_id, after FROM audit_event
            WHERE organization_id = $1 AND event_type = 'object_destruction_tombstone.insert'`,
          [ORG_A],
        )
      ).rows as { resource_id: string; after: Record<string, unknown> }[];
      const mine = (
        await admin.query("SELECT id FROM object_destruction_tombstone WHERE object_key = $1", [
          key,
        ])
      ).rows[0].id as string;
      const event = events.find((e) => e.resource_id === mine);
      expect(event, "the tombstone insert left no audit event").toBeDefined();
      expect(event?.after.bucket).toBe(BUCKET_A);
      expect(event?.after.organization_id).toBe(ORG_A);
      expect(JSON.stringify(event?.after)).not.toContain(PATIENT);
      // audit_scrub keeps the column's name and replaces its value: the key (which holds the patient's id) is not in the snapshot
      expect(event?.after.object_key).toBe("<changed>");
      expect(JSON.stringify(event?.after)).not.toContain("documents/");
      const deletes = (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND event_type = 'document.delete' AND resource_id = $2",
          [ORG_A, doc],
        )
      ).rows[0].n as number;
      expect(deletes).toBe(1);
    });
  });

  describe("the export", () => {
    it("lists exactly the tombstones of FINISHED erases, in the form the copy tool reads (with its trailer)", async () => {
      const exported = await exportTombstones(adminHandle.db as DbClient);
      const index = parseTombstones(exported.text); // strict: the trailer is present and its count matches
      const finished = (
        await admin.query(
          `SELECT t.bucket, t.object_key FROM object_destruction_tombstone t
            WHERE NOT EXISTS (SELECT 1 FROM document_version v
                               WHERE v.organization_id = t.organization_id AND v.object_key = t.object_key)`,
        )
      ).rows as { bucket: string; object_key: string }[];
      expect(finished.length).toBeGreaterThan(0);
      for (const row of finished)
        expect(index.get(row.bucket)?.has(row.object_key), row.object_key).toBe(true);
      expect([...index.values()].reduce((n, keys) => n + keys.size, 0)).toBe(finished.length);
      expect(exported.exported).toBe(finished.length);
    });

    it("refuses a connection that is subject to row security: the application role would read nothing, and an empty export is not 'nothing destroyed'", async () => {
      await expect(exportTombstones(appHandle.db as DbClient)).rejects.toThrow(
        /subject to row security/,
      );
    });
  });

  describe("what the database itself refuses (CW-DS-01 hardening)", () => {
    const insertTombstone = (key: string, conflict = ""): string =>
      `INSERT INTO object_destruction_tombstone (organization_id, bucket, object_key) VALUES ('${ORG_A}', '${BUCKET_A}', '${key}') ${conflict}`;
    const asDestroyer = <T>(org: string, fn: (tx: DbClient) => Promise<T>) =>
      withOrgContext(destroyer.db, { organizationId: org, userId: "" }, (tx) => fn(tx as DbClient));

    it("refuses a tombstone for a document under an active hold, one with status legal_hold, and a 42 CFR Part 2 document: any role, also under the replica role", async () => {
      const heldKey = keyOf(PATIENT_KEPT, "kept-hold");
      const statusKey = keyOf(PATIENT_KEPT, "kept-status");
      const part2Key = keyOf(PATIENT_KEPT, "kept-part2");
      await seedDocument(ORG_A, PATIENT_KEPT, [heldKey], { hold: true });
      const statusDoc = await seedDocument(ORG_A, PATIENT_KEPT, [statusKey]);
      await admin.query("UPDATE document SET status = 'legal_hold' WHERE id = $1", [statusDoc]);
      await seedDocument(ORG_A, PATIENT_KEPT, [part2Key], {
        retentionClass: "compliance_42cfr_part2",
      });
      const kept = [heldKey, statusKey, part2Key];

      for (const key of kept) {
        await expect(admin.query(insertTombstone(key)), key).rejects.toMatchObject({
          code: "23514",
        });
        // the eraser's own insert is ON CONFLICT DO NOTHING: a BEFORE trigger still sees the row
        await expect(
          admin.query(insertTombstone(key, "ON CONFLICT DO NOTHING")),
          `${key} (ON CONFLICT)`,
        ).rejects.toMatchObject({ code: "23514" });
        expect(
          await sqlstateOf(() =>
            asDestroyer(ORG_A, (tx) => tx.execute(sql.raw(insertTombstone(key)))),
          ),
          `${key} (destruction role)`,
        ).toBe("23514");
      }
      await admin.query("SET session_replication_role = replica");
      try {
        for (const key of kept)
          await expect(admin.query(insertTombstone(key)), `replica: ${key}`).rejects.toMatchObject({
            code: "23514",
          });
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      const recorded = await tombstoneKeys(ORG_A);
      for (const key of kept) expect(recorded).not.toContain(key);
    });

    it("also refuses a tombstone planted under the replica role for a key no version records (the version check is ENABLE ALWAYS too)", async () => {
      await admin.query("SET session_replication_role = replica");
      try {
        await expect(
          admin.query(insertTombstone(keyOf(PATIENT_KEPT, "no-such-version"))),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
    });

    it("refuses TRUNCATE for the table owner and a superuser, also under the replica role, and leaves the rows", async () => {
      const before = (await tombstoneKeys(ORG_A)).length;
      expect(before).toBeGreaterThan(0);
      await expect(admin.query("TRUNCATE object_destruction_tombstone")).rejects.toMatchObject({
        code: "23514",
      });
      await admin.query("SET session_replication_role = replica");
      try {
        await expect(admin.query("TRUNCATE object_destruction_tombstone")).rejects.toMatchObject({
          code: "23514",
        });
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      expect((await tombstoneKeys(ORG_A)).length).toBe(before);
    });

    it("refuses TRUNCATE of a table that reaches it by CASCADE (the foreign key to organization), and rolls back", async () => {
      // a transaction that is always rolled back: were the guard to miss, nothing may be left truncated
      await admin.query("BEGIN");
      try {
        await expect(admin.query("TRUNCATE organization CASCADE")).rejects.toMatchObject({
          code: "23514",
        });
      } finally {
        await admin.query("ROLLBACK");
      }
      expect((await tombstoneKeys(ORG_A)).length).toBeGreaterThan(0);
    });

    it("refuses a tombstone whose key is not a form the document store writes, and agrees with isObjectKeyShape on every sample", async () => {
      // what the store's own key builders produce (lifecycle/storage.ts; the upload routes build `uploads/<id>/<aggregate>-<12 chars>`)
      const produced = [
        deriveObjectKey({
          kind: "rendered",
          aggregateType: "other",
          documentId: randomUUID(),
          patientId: PATIENT_KEPT,
          batchId: null,
          shortVersionId: "a1b2c3d4e5f6",
        }),
        deriveObjectKey({
          kind: "rendered",
          aggregateType: "other",
          documentId: randomUUID(),
          patientId: null,
          batchId: null,
          shortVersionId: "a1b2c3d4e5f6",
        }),
        deriveObjectKey({
          kind: "intake",
          aggregateType: "other",
          documentId: randomUUID(),
          patientId: null,
          batchId: randomUUID(),
          shortVersionId: "a1b2c3d4e5f6",
        }),
        `uploads/${randomUUID()}/other-${randomUUID().slice(0, 12)}`,
      ];
      for (const key of produced) {
        expect(isObjectKeyShape(key), key).toBe(true);
        expect(
          (
            await admin.query(
              "SELECT (length($1) <= 512 AND $1 ~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$') AS ok",
              [key],
            )
          ).rows[0].ok,
          key,
        ).toBe(true);
      }
      const samples = [
        `documents/${PATIENT_KEPT}/other/${randomUUID()}/other-a1b2c3d4e5f6.pdf`,
        `intake/${randomUUID()}/intake-a1b2c3d4e5f6.pdf`,
        `uploads/${randomUUID()}/other-a1b2c3d4e5f6`,
        "documents/unbound/other/x1/y.pdf",
        "documents/p1/a.pdf",
        "",
        "a",
        "documents",
        "documents/p1",
        "/documents/p1/a.pdf",
        "documents//a.pdf",
        "documents/../x/y.pdf",
        "documents/./p1/a.pdf",
        "documents/p1/a%2Fb.pdf",
        "documents/p1/a b.pdf",
        "documents/p1/é.pdf",
        "backups/p1/a.pdf",
        "Documents/p1/a.pdf",
        "documents/-p1/a.pdf",
        "documents/a/b/c/d/e/f/g/h.pdf",
        `documents/${"a".repeat(600)}/b.pdf`,
      ];
      for (const key of samples) {
        const accepted = (
          await admin.query(
            "SELECT (length($1) <= 512 AND $1 ~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$') AS ok",
            [key],
          )
        ).rows[0].ok as boolean;
        expect(accepted, `SQL form vs isObjectKeyShape for ${JSON.stringify(key)}`).toBe(
          isObjectKeyShape(key),
        );
      }
      // a trailing newline: `$` must not accept it in either language
      expect(isObjectKeyShape("documents/p1/a.pdf\n")).toBe(false);
      expect(
        (
          await admin.query(
            "SELECT ('documents/p1/a.pdf' || chr(10)) ~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$' AS ok",
          )
        ).rows[0].ok,
      ).toBe(false);
      // and the trigger refuses an insert the document-version check alone would allow (the version exists, the form is odd)
      const odd = "legacy-upload/odd-name.bin";
      await seedDocument(ORG_A, PATIENT_KEPT, [odd]);
      await expect(admin.query(insertTombstone(odd)), odd).rejects.toMatchObject({ code: "23514" });
      expect(await tombstoneKeys(ORG_A)).not.toContain(odd);
    });

    it("the migration's pre-check refuses to apply over an existing tombstone with such a key, naming a count and no key", async () => {
      const migration = readFileSync(
        join(MIGRATIONS_DIR, "1583_m22_object_destruction_tombstone_guards.sql"),
        "utf8",
      );
      const precheck = /DO \$\$[\s\S]*?END \$\$;/.exec(migration)?.[0];
      expect(precheck, "the pre-check block").toBeTruthy();
      const odd = "legacy-upload/odd-name.bin"; // seeded by the previous test; its version still exists, so a tombstone can name it
      await admin.query("BEGIN"); // always rolled back: the bad row must not outlive this test
      try {
        // a row written before the guards existed: the key-form trigger is switched off for this transaction only
        await admin.query(
          "ALTER TABLE object_destruction_tombstone DISABLE TRIGGER trg_object_destruction_tombstone_key_form",
        );
        await admin.query(insertTombstone(odd));
        const failure = await admin.query(precheck as string).then(
          () => null,
          (error: unknown) => error as Error & { code?: string },
        );
        expect(failure?.code).toBe("23514");
        expect(failure?.message).toMatch(/1 existing tombstone\(s\) have an object key/);
        expect(failure?.message).not.toContain(odd);
      } finally {
        await admin.query("ROLLBACK");
      }
      // with no such row the same block passes (notices only)
      await expect(admin.query(precheck as string)).resolves.toBeTruthy();
    });

    it("has exactly its six triggers (five guards and the audit trigger), all ENABLE ALWAYS, and no role holds TRUNCATE", async () => {
      const triggers = (
        await admin.query(
          `SELECT tgname, tgenabled FROM pg_trigger
            WHERE tgrelid = 'object_destruction_tombstone'::regclass AND NOT tgisinternal`,
        )
      ).rows as { tgname: string; tgenabled: string }[];
      expect(triggers.map((t) => t.tgname).sort()).toEqual([
        "trg_audit_object_destruction_tombstone",
        "trg_object_destruction_tombstone_append_only",
        "trg_object_destruction_tombstone_key_form",
        "trg_object_destruction_tombstone_names_a_version",
        "trg_object_destruction_tombstone_no_truncate",
        "trg_object_destruction_tombstone_not_preserved",
      ]);
      for (const t of triggers) expect(t.tgenabled, t.tgname).toBe("A");
      const truncateHolders = (
        await admin.query(
          `SELECT grantee FROM information_schema.role_table_grants
            WHERE table_name = 'object_destruction_tombstone' AND privilege_type = 'TRUNCATE'
              AND grantee IN ('PUBLIC', 'chartwarden_app', 'chartwarden_destruction')`,
        )
      ).rows;
      expect(truncateHolders).toEqual([]);
    });
  });

  describe("an erase past the single-statement bind limit", () => {
    it("records a tombstone for every one of more than 13,107 versions of one patient, destroys the objects, and a retry changes nothing", async () => {
      const versions = 13_200; // 5 bound values each: 66,000 > 65,535, so one INSERT could not carry it
      const documentId = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title, created_by_membership_id)
           VALUES ($1,$2,'clinical_record','user_upload','other','Synthetic big doc',$3) RETURNING id`,
          [ORG_A, PATIENT_BIG, MEMBER],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
         SELECT $1::uuid, $2::uuid, g, 'documents/' || $3::text || '/other/' || $2::text || '/v' || g || '.pdf',
                'application/pdf', 10, $4::text, 'system_render'
           FROM generate_series(1, $5::int) AS g`,
        [ORG_A, documentId, PATIENT_BIG, "a".repeat(64), versions],
      );
      const keys = (
        await admin.query("SELECT object_key FROM document_version WHERE document_id = $1", [
          documentId,
        ])
      ).rows.map((r) => r.object_key as string);
      expect(keys.length).toBe(versions);
      const bytes = new TextEncoder().encode("synthetic");
      for (const key of keys) memory.objects.set(objectPath(BUCKET_A, key), bytes);
      const tombstonesOf = async (): Promise<number> =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM object_destruction_tombstone WHERE document_id = $1",
            [documentId],
          )
        ).rows[0].n as number;

      await erase(ORG_A, PATIENT_BIG);

      expect(await tombstonesOf()).toBe(versions);
      expect(keys.filter((key) => present(BUCKET_A, key))).toEqual([]);
      expect(await docExists(documentId)).toBe(false);
      await erase(ORG_A, PATIENT_BIG); // a second run
      expect(await tombstonesOf()).toBe(versions);
    }, 300_000);
  });

  describe("the dev seed's teardown of an organization that has tombstones", () => {
    it("removes that organization's tombstones only, leaves the append-only trigger ENABLE ALWAYS, and lets the organization be deleted", async () => {
      const bucketC = deriveTenantBucket(ORG_C as never);
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'ds01-c','C','C')",
        [ORG_C],
      );
      const key = keyOf(PATIENT_B, "seed-teardown");
      await seedDocument(ORG_C, PATIENT_B, [key]);
      await admin.query(
        "INSERT INTO object_destruction_tombstone (organization_id, bucket, object_key) VALUES ($1,$2,$3)",
        [ORG_C, bucketC, key],
      );
      const otherOrgBefore = (await tombstoneKeys(ORG_A)).length;
      expect(otherOrgBefore).toBeGreaterThan(0);
      // append-only: it cannot be deleted by hand, even by the superuser the seed runs as
      await expect(
        admin.query("DELETE FROM object_destruction_tombstone WHERE organization_id = $1", [ORG_C]),
      ).rejects.toMatchObject({ code: "23514" });

      // outside a transaction the helper refuses (the DISABLE would be visible to every other session) and touches nothing
      await expect(purgeOrgTombstones(admin, ORG_C)).rejects.toMatchObject({ code: "25P01" });
      expect(await tombstoneKeys(ORG_C)).toEqual([key]);
      await admin.query("BEGIN");
      try {
        expect(await purgeOrgTombstones(admin, ORG_C)).toBe(1);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      expect(await tombstoneKeys(ORG_C)).toEqual([]);
      expect((await tombstoneKeys(ORG_A)).length).toBe(otherOrgBefore);
      const trigger = (
        await admin.query(
          "SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_object_destruction_tombstone_append_only'",
        )
      ).rows[0];
      expect(trigger?.tgenabled).toBe("A");
      await expect(
        admin.query("DELETE FROM object_destruction_tombstone WHERE organization_id = $1", [ORG_A]),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await purgeOrgTombstones(admin, ORG_C)).toBe(0); // nothing left: no savepoint, no ALTER, so also fine outside a transaction

      // the seed's own order from here: the org-owned rows (under the replica role, as the seed runs), then the organization
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("DELETE FROM document_version WHERE organization_id = $1", [ORG_C]);
        await admin.query("DELETE FROM document WHERE organization_id = $1", [ORG_C]);
        await admin
          .query("DELETE FROM audit_event WHERE organization_id = $1", [ORG_C])
          .catch(() => {});
        await admin.query("DELETE FROM organization WHERE id = $1", [ORG_C]);
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      expect(
        (await admin.query("SELECT 1 FROM organization WHERE id = $1", [ORG_C])).rowCount,
      ).toBe(0);
    });
  });

  describe("an erase of a document whose key is not a form the store writes", () => {
    it("fails before anything is recorded or destroyed, so no tombstone is ever unexportable", async () => {
      const odd = "legacy-upload/erased-odd-name.bin";
      const documentId = await seedDocument(ORG_A, PATIENT_ODD, [odd]);
      const failure = await erase(ORG_A, PATIENT_ODD).then(
        () => null,
        (error: unknown) => error as Error & { code?: string },
      );
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe("DOCUMENT_TOMBSTONE_REFUSED");
      // the driver's own error text would carry every bound value; the refusal that replaces it carries none (a key holds a patient id)
      expect(failure?.message).not.toContain(odd);
      expect(failure?.message).not.toContain(PATIENT_ODD);
      expect(present(BUCKET_A, odd)).toBe(true); // the object is still there
      expect(await docExists(documentId)).toBe(true); // and so are the rows
      expect(await tombstoneKeys(ORG_A)).not.toContain(odd);
    });
  });
});
