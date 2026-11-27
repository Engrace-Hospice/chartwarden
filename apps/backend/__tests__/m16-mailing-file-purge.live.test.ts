/**
 * CW-BR-10 — the retention PURGE of the rendered bereavement mailing batch files (a name-and-address list each), against REAL Postgres, as the NOBYPASSRLS
 * `chartwarden_app` role. The files are made by the REAL M22 `DocumentRenderer` over the real document tables and filed in an object-store test double; the
 * purge runs through the REAL M22 `OrgDocumentAccessProvider` over the real Drizzle port and M4's REAL `activeLegalHoldScopeForOrg`. (The purge publishes no
 * outbox event, so there is no publisher to bind.) What is proven:
 *
 *   rule        an old mailed file, an old cancelled one, an old unreferenced one and an abandoned `ready` one are destroyed (its run is cancelled first); a young
 *               mailed file, a young cancelled one and a fresh unreferenced one stay;
 *   holds       an M22 hold row and a `legal_hold` status stay; an active M4 patient-scoped hold keeps the runs that hold that patient's family AND every file no run
 *               names, while another family's file goes; an org-wide M4 hold keeps everything; releasing the hold lets the same files go on the next run;
 *   tenancy     a pass for org A touches nothing of org B, and the reverse; the seam answers not_found for another tenant's document whichever way the context
 *               and the argument disagree, and lists nothing across tenants;
 *   record      a destroyed file's object is gone from the bucket, its document is `destroyed_tombstone` with no active version and no cipher, its version row stays,
 *               the audit trail has the change, and neither the audit rows nor any log line carries a name, an address or an object key;
 *   bounds      the default is a DRY RUN that touches nothing; a plan bigger than the cap is refused whole (nothing deleted, the tick throws so the DLQ alert fires)
 *               while another org's pass still runs; the cap raised, the same plan goes;
 *   resumable   a store failure leaves that file's row and object, the rest go, and the next run finishes it; a crash after the object delete is finished by the
 *               next run; a re-run over a finished org is a no-op.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:mailing-file-purge:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import {
  BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY,
  type BereavementMailingBatchRenderPayload,
  type DocumentId,
  type OrgDocumentAccessProvider,
  type OrgId,
  messagingHoldLockName,
} from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activeLegalHoldScopeForOrg } from "../src/modules/04-audit/legal-hold-scope";
import {
  type MailingFilePurgeDeps,
  MailingFilePurgeRefusedError,
  purgeMailingFilesForOrg,
  runMailingFilePurgeCron,
} from "../src/modules/16-bereavement/jobs/mailing-file-purge";
import {
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createDrizzleOrgDocumentAccessPort,
  createDrizzleStaffMintAccessLog,
  createInMemoryObjectStore,
  createOrgDocumentAccessProvider,
} from "../src/modules/22-documents/seams/index";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "a1630000-0000-4000-8000-0000000000a1";
const ORG_B = "b1630000-0000-4000-8000-0000000000b1";
const DAY_MS = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

// Synthetic people and addresses (invented). They are printed INTO the batch PDF, so they must never appear anywhere the purge writes.
const FAMILIES = [
  { name: "Wren Fixture", address: ["10 Sample Street", "Testville, ZZ 00000"] },
  { name: "Odell Placeholder", address: ["22 Mockingbird Lane", "Mockton, ZZ 00001"] },
];
const SECRETS = FAMILIES.flatMap((f) => [f.name, ...f.address]);

describe.skipIf(!DB_URL)("CW-BR-10 — mailing batch file purge, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let provider: OrgDocumentAccessProvider;
  let renderer: ReturnType<typeof createDocumentRenderer>;
  let clock = NOW;
  const pe: Record<string, string> = {};
  /** Object keys whose delete fails BEFORE the object goes / AFTER it went (fault injection on the object store). */
  const failBefore = new Set<string>();
  const failAfter = new Set<string>();
  const logged: string[] = [];

  // ── seeds ─────────────────────────────────────────────────────────────────────────────────────
  /** A real batch file: the REAL renderer files the document, its version and its object, dated `ageDays` ago. */
  async function seedFile(org: string, ageDays: number): Promise<string> {
    clock = daysAgo(ageDays);
    const payload: BereavementMailingBatchRenderPayload = {
      aggregateId: randomUUID(),
      heading: "A note from the program",
      paragraphs: ["We are thinking of you this season."],
      letters: FAMILIES.map((f, i) => ({
        recipientName: f.name,
        addressLines: f.address,
        greeting: `Dear ${f.name},`,
        ref: i + 1,
      })),
    };
    const out = await renderer.render(
      { orgId: org as never },
      BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY,
      payload,
    );
    return out.documentId as string;
  }

  async function seedRun(
    org: string,
    documentId: string,
    o: {
      status: "mailed" | "ready" | "cancelled";
      mailedDaysAgo?: number;
      generatedDaysAgo?: number;
      updatedDaysAgo?: number;
    },
  ): Promise<string> {
    const mailed = o.status === "mailed";
    return (
      await admin.query(
        `INSERT INTO bereavement_mailing_run
           (organization_id, run_kind, mailing_key, occurrence_key, scheduled_for, status, content_jsonb, rendered_document_id,
            recipient_count, generated_at, mailed_at, mailed_by_membership_id, updated_at)
         VALUES ($1,'newsletter','newsletter_quarterly',$2, CURRENT_DATE, $3, '{}'::jsonb, $4, 2,
                 $5, $6, $7, $8)
         RETURNING id`,
        [
          org,
          `newsletter_quarterly:${randomUUID().slice(0, 8)}`,
          o.status,
          documentId,
          daysAgo(o.generatedDaysAgo ?? o.mailedDaysAgo ?? 1),
          mailed ? daysAgo(o.mailedDaysAgo ?? 1) : null,
          mailed ? randomUUID() : null,
          daysAgo(o.updatedDaysAgo ?? 1),
        ],
      )
    ).rows[0].id as string;
  }

  /** A plan for `patientId` with one family in `runId` (the patient-scoped hold reaches a run through this chain). */
  async function seedFamilyInRun(org: string, runId: string, patientId: string): Promise<void> {
    const plan = (
      await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date, assigned_counselor_user_id, opened_at)
         VALUES ($1,$2,$3,$4,'active', CURRENT_DATE - 30, $5, now()) RETURNING id`,
        [org, patientId, randomUUID(), pe[org], randomUUID()],
      )
    ).rows[0].id as string;
    const contact = (
      await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status, outreach_preferences_jsonb)
         VALUES ($1,$2,$3,'Synthetic Contact','spouse','active','{"allowed_kinds":["phone_call"]}'::jsonb) RETURNING id`,
        [org, pe[org], plan],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO bereavement_mailing_item
         (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status)
       VALUES ($1,$2,$3,$4,$5,'postal','logged')`,
      [org, pe[org], runId, plan, contact],
    );
  }

  async function hold(org: string, criteria: object): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, status, reason)
         VALUES ($1,'synthetic hold',$2::jsonb,'active','synthetic live-suite hold') RETURNING id`,
        [org, JSON.stringify(criteria)],
      )
    ).rows[0].id as string;
  }
  const release = (id: string) =>
    admin.query("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [id]);

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────
  const docRow = async (id: string) =>
    (await admin.query("SELECT status, active_version_id FROM document WHERE id=$1", [id]))
      .rows[0] as { status: string; active_version_id: string | null };
  const keyOf = async (id: string): Promise<string> =>
    (await admin.query("SELECT object_key FROM document_version WHERE document_id=$1", [id]))
      .rows[0].object_key as string;
  const objectThere = async (org: string, id: string): Promise<boolean> =>
    objects.objects.has(`tenant-${org}/${await keyOf(id)}`);
  const gone = async (org: string, id: string): Promise<boolean> =>
    (await docRow(id)).status === "destroyed_tombstone" && !(await objectThere(org, id));
  const intact = async (org: string, id: string): Promise<boolean> =>
    (await docRow(id)).status !== "destroyed_tombstone" && (await objectThere(org, id));
  const runRow = async (id: string) =>
    (
      await admin.query(
        "SELECT status, version, rendered_document_id FROM bereavement_mailing_run WHERE id=$1",
        [id],
      )
    ).rows[0] as { status: string; version: number; rendered_document_id: string | null };

  const deps = (over: Partial<MailingFilePurgeDeps> = {}): MailingFilePurgeDeps => ({
    db: handle.db,
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    },
    legalHolds: { activeScopeForOrg: (org) => activeLegalHoldScopeForOrg(handle.db, org) },
    orgDocuments: () => provider,
    mailingFilePurge: { execute: true, executionSupported: true, maxFilesPerOrgRun: 100 },
    now: () => NOW,
    ...over,
  });
  /** The default configuration: no `execute`, so a DRY RUN. */
  const dryRunDeps = () => deps({ mailingFilePurge: { maxFilesPerOrgRun: 100 } });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m16-purge-a"],
      [ORG_B, "m16-purge-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
      pe[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
    }

    // The REAL app role: every statement below the seeds runs as NOBYPASSRLS `chartwarden_app` (the helper asserts it).
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    objects = createInMemoryObjectStore();
    // The object store with fault injection in front of the in-memory double.
    const store = {
      ...objects.store,
      async destroyAllVersions(args: { bucket: string; objectKey: string; organizationId: OrgId }) {
        if (failBefore.has(args.objectKey)) throw new Error(`store down for ${args.objectKey}`);
        await objects.store.destroyAllVersions(args);
        if (failAfter.has(args.objectKey)) throw new Error(`store crashed after ${args.objectKey}`);
      },
    };
    renderer = createDocumentRenderer({
      store: createDrizzleDocumentSeamStore(handle.db),
      objects: objects.store,
      now: () => clock.toISOString() as never,
    });
    provider = createOrgDocumentAccessProvider({
      port: createDrizzleOrgDocumentAccessPort(handle.db),
      objects: store,
      accessLog: createDrizzleStaffMintAccessLog(handle.db),
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await handle?.close();
    if (admin) await admin.end();
  });

  // The set seeded in the first describe is what the next describes act on.
  const a: Record<string, string> = {};
  const b: Record<string, string> = {};
  const runs: Record<string, string> = {};

  // ══ the default is a dry run ══════════════════════════════════════════════════════════════════
  describe("the rule, a dry run first", () => {
    beforeAll(async () => {
      for (const [org, set] of [
        [ORG_A, a],
        [ORG_B, b],
      ] as const) {
        set.mailedOld = await seedFile(org, 405);
        runs[`${org}:mailedOld`] = await seedRun(org, set.mailedOld, {
          status: "mailed",
          mailedDaysAgo: 400,
        });
        set.mailedYoung = await seedFile(org, 120);
        await seedRun(org, set.mailedYoung, { status: "mailed", mailedDaysAgo: 100 });
        set.cancelledOld = await seedFile(org, 90);
        await seedRun(org, set.cancelledOld, { status: "cancelled", updatedDaysAgo: 40 });
        set.cancelledYoung = await seedFile(org, 90);
        await seedRun(org, set.cancelledYoung, { status: "cancelled", updatedDaysAgo: 5 });
        set.orphanOld = await seedFile(org, 20);
        set.orphanFresh = await seedFile(org, 2);
        set.readyAbandoned = await seedFile(org, 420);
        runs[`${org}:readyAbandoned`] = await seedRun(org, set.readyAbandoned, {
          status: "ready",
          generatedDaysAgo: 420,
        });
        set.m22HoldRow = await seedFile(org, 500);
        await seedRun(org, set.m22HoldRow, { status: "mailed", mailedDaysAgo: 450 });
        await admin.query(
          "INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id) VALUES ($1,$2,$3)",
          [org, set.m22HoldRow, randomUUID()],
        );
        set.m22HoldStatus = await seedFile(org, 500);
        await seedRun(org, set.m22HoldStatus, { status: "mailed", mailedDaysAgo: 450 });
        await admin.query("UPDATE document SET status='legal_hold' WHERE id=$1", [
          set.m22HoldStatus,
        ]);
      }
    }, 180_000);

    it("the REAL renderer filed real files: every document has its object in its own tenant's bucket", async () => {
      for (const [org, set] of [
        [ORG_A, a],
        [ORG_B, b],
      ] as const) {
        for (const id of Object.values(set)) expect(await objectThere(org, id)).toBe(true);
      }
    });

    it("a dry run (the default) reports the plan and touches nothing: no object, no row, no run", async () => {
      logged.length = 0;
      const out = await purgeMailingFilesForOrg(dryRunDeps(), ORG_A);
      expect(out).toMatchObject({
        mode: "dry_run",
        due: 4, // mailedOld, cancelledOld, orphanOld, readyAbandoned
        held: 2, // the two M22 holds
        retained: 2, // mailedYoung, cancelledYoung (orphanFresh is younger than 7 days and is not even listed)
        destroyed: 0,
      });
      for (const id of Object.values(a)) expect(await intact(ORG_A, id)).toBe(true);
      expect((await runRow(runs[`${ORG_A}:readyAbandoned`] as string)).status).toBe("ready");
      // the report names ids by rule, never a name, an address or a key
      const report = logged.find((l) => l.includes("DRY RUN"));
      expect(report).toContain(a.mailedOld);
      expect(report).toContain("abandoned_ready");
    });

    it("with the env switch ON but execution disabled in code (the shipped default), the pass is STILL a dry run: nothing destroyed, one line says so", async () => {
      logged.length = 0;
      // exactly what production runs: `execute: true` from the env, no `executionSupported` (the composition root never sets it)
      const asShipped = deps({ mailingFilePurge: { execute: true, maxFilesPerOrgRun: 100 } });
      const out = await purgeMailingFilesForOrg(asShipped, ORG_A);
      expect(out).toMatchObject({ mode: "dry_run", due: 4, destroyed: 0, refused: 0, failed: 0 });
      for (const id of Object.values(a)) expect(await intact(ORG_A, id)).toBe(true);
      expect((await runRow(runs[`${ORG_A}:readyAbandoned`] as string)).status).toBe("ready");
      expect(logged.filter((l) => l.includes("DISABLED IN CODE"))).toHaveLength(1);
    });
  });

  // ══ the real pass over org A ═════════════════════════════════════════════════════════════════
  describe("org A's pass: expired files go, unexpired and held files stay, and org B is untouched", () => {
    it("destroys the four due files and leaves every other file of org A and all of org B alone", async () => {
      logged.length = 0;
      const out = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(out).toMatchObject({ mode: "execute", due: 4, destroyed: 4, failed: 0, refused: 0 });

      for (const key of ["mailedOld", "cancelledOld", "orphanOld", "readyAbandoned"]) {
        expect(await gone(ORG_A, a[key] as string)).toBe(true);
      }
      for (const key of [
        "mailedYoung",
        "cancelledYoung",
        "orphanFresh",
        "m22HoldRow",
        "m22HoldStatus",
      ]) {
        expect(await intact(ORG_A, a[key] as string)).toBe(true);
      }
      // one direction of the tenant wall: nothing of org B moved
      for (const id of Object.values(b)) expect(await intact(ORG_B, id)).toBe(true);
    });

    it("an abandoned `ready` run is cancelled (version bumped, document pointer kept) before its file goes", async () => {
      const run = await runRow(runs[`${ORG_A}:readyAbandoned`] as string);
      expect(run).toMatchObject({ status: "cancelled", version: 1 });
      expect(run.rendered_document_id).toBe(a.readyAbandoned);
      // a mailed run's status is its own and is not touched by the purge of its file
      expect((await runRow(runs[`${ORG_A}:mailedOld`] as string)).status).toBe("mailed");
    });

    it("the record: the document is a tombstone with no active version and no cipher, its version row stays, and the audit trail has the change", async () => {
      const id = a.mailedOld as string;
      expect((await docRow(id)).active_version_id).toBeNull();
      const versions = (
        await admin.query(
          "SELECT id, byte_payload_cipher, object_key FROM document_version WHERE document_id=$1",
          [id],
        )
      ).rows as { id: string; byte_payload_cipher: string | null; object_key: string }[];
      expect(versions).toHaveLength(1);
      expect(versions[0]?.byte_payload_cipher).toBeNull();

      const ids = [id, ...versions.map((v) => v.id)];
      const audit = (
        await admin.query(
          `SELECT event_type, resource_kind, resource_id, before, after, context
             FROM audit_event WHERE organization_id=$1 AND resource_id = ANY($2::uuid[])`,
          [ORG_A, ids],
        )
      ).rows;
      expect(audit.some((r) => r.resource_id === id && /update/.test(String(r.event_type)))).toBe(
        true,
      );
      // the version row's own audit trigger fired too
      expect(audit.some((r) => versions.some((v) => v.id === r.resource_id))).toBe(true);
      // ids only: no family name, no address line and no object key in any audit row
      const auditText = JSON.stringify(audit);
      for (const secret of [...SECRETS, versions[0]?.object_key as string]) {
        expect(auditText).not.toContain(secret);
      }
    });

    it("no log line the pass wrote carries a name, an address or an object key", async () => {
      expect(logged.length).toBeGreaterThan(0);
      const text = logged.join("\n");
      const keys = await Promise.all(Object.values(a).map(keyOf));
      for (const secret of [...SECRETS, ...keys]) expect(text).not.toContain(secret);
      expect(text).toContain("file destroyed");
    });

    it("a re-run over the finished org is a no-op: nothing due, nothing destroyed, no new audit rows", async () => {
      const before = (await admin.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n;
      const out = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(out).toMatchObject({ due: 0, destroyed: 0, failed: 0, refused: 0 });
      expect((await admin.query("SELECT count(*)::int AS n FROM audit_event")).rows[0].n).toBe(
        before,
      );
    });
  });

  // ══ tenancy at the seam ═════════════════════════════════════════════════════════════════════
  describe("the seam never crosses tenants, whichever way the context and the argument disagree", () => {
    const destroyAs = (ctxOrg: string, argOrg: string, documentId: string) =>
      runWithRequestContext({ organizationId: ctxOrg, userId: "" }, () =>
        provider.destroyOrgDocument({
          organizationId: argOrg as OrgId,
          documentId: documentId as DocumentId,
          allowedAggregateTypes: ["bereavement_mailing_batch"],
        }),
      );

    it("org B's context cannot destroy org A's file, and org A's cannot destroy org B's", async () => {
      expect(await destroyAs(ORG_B, ORG_B, a.mailedYoung as string)).toEqual({
        refused: true,
        reason: "not_found",
      });
      expect(await destroyAs(ORG_A, ORG_A, b.mailedYoung as string)).toEqual({
        refused: true,
        reason: "not_found",
      });
    });

    it("a mismatched context and argument finds nothing (the context's RLS and the explicit predicate are two walls)", async () => {
      expect(await destroyAs(ORG_A, ORG_B, b.mailedYoung as string)).toEqual({
        refused: true,
        reason: "not_found",
      });
      expect(await destroyAs(ORG_A, ORG_B, a.mailedYoung as string)).toEqual({
        refused: true,
        reason: "not_found",
      });
      expect(await intact(ORG_A, a.mailedYoung as string)).toBe(true);
      expect(await intact(ORG_B, b.mailedYoung as string)).toBe(true);
    });

    it("a list under one org's context never returns the other org's files", async () => {
      const listed = await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
        provider.listOrgDocumentsForPurge({
          organizationId: ORG_B as OrgId,
          aggregateType: "bereavement_mailing_batch",
          createdBefore: new Date().toISOString() as never,
          limit: 100,
        }),
      );
      expect(listed).toMatchObject({ documents: [], truncated: false });
    });

    it("the seam refuses to destroy a type it does not own (a patient-less document of another type stays)", async () => {
      const other = (
        await admin.query(
          `INSERT INTO document
             (organization_id, retention_class, source_kind, aggregate_type, aggregate_id, title, created_by_membership_id)
           VALUES ($1,'bereavement','form_render','bereavement_library_item',$2,'Synthetic library item',$3) RETURNING id`,
          [ORG_A, randomUUID(), randomUUID()],
        )
      ).rows[0].id as string;
      expect(await destroyAs(ORG_A, ORG_A, other)).toEqual({ refused: true, reason: "wrong_type" });
      expect((await docRow(other)).status).toBe("active");
    });
  });

  // ══ M4 legal holds ══════════════════════════════════════════════════════════════════════════
  describe("legal holds beat the clock", () => {
    const held: Record<string, string> = {};
    const patientX = randomUUID();
    const patientY = randomUUID();

    beforeAll(async () => {
      held.familyX = await seedFile(ORG_A, 450);
      const runX = await seedRun(ORG_A, held.familyX, { status: "mailed", mailedDaysAgo: 420 });
      await seedFamilyInRun(ORG_A, runX, patientX);
      held.familyY = await seedFile(ORG_A, 450);
      const runY = await seedRun(ORG_A, held.familyY, { status: "mailed", mailedDaysAgo: 420 });
      await seedFamilyInRun(ORG_A, runY, patientY);
      held.orphan = await seedFile(ORG_A, 30);
    }, 120_000);

    it("a patient-scoped M4 hold keeps the run that holds that patient's family and every file no run names; another family's file goes", async () => {
      const holdId = await hold(ORG_A, { patientIds: [patientX] });
      const out = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(out).toMatchObject({ destroyed: 1, failed: 0 });
      expect(await gone(ORG_A, held.familyY as string)).toBe(true);
      expect(await intact(ORG_A, held.familyX as string)).toBe(true);
      expect(await intact(ORG_A, held.orphan as string)).toBe(true);

      // released, the same files go on the next run: it was the hold that kept them
      await release(holdId);
      const next = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(next).toMatchObject({ destroyed: 2, failed: 0 });
      expect(await gone(ORG_A, held.familyX as string)).toBe(true);
      expect(await gone(ORG_A, held.orphan as string)).toBe(true);
    });

    it("an org-wide M4 hold (one that names no patient) keeps everything in the org, and org B's pass is unaffected by org A's hold", async () => {
      const file = await seedFile(ORG_A, 450);
      await seedRun(ORG_A, file, { status: "mailed", mailedDaysAgo: 420 });
      const fileB = await seedFile(ORG_B, 450);
      await seedRun(ORG_B, fileB, { status: "mailed", mailedDaysAgo: 420 });
      const holdId = await hold(ORG_A, { resourceKinds: ["document"] });

      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 0 });
      expect(await intact(ORG_A, file)).toBe(true);
      // the pass over org B (which has its own due files and no hold) still destroys
      const outB = await purgeMailingFilesForOrg(deps(), ORG_B);
      expect(outB.destroyed).toBeGreaterThanOrEqual(1);
      expect(await gone(ORG_B, fileB)).toBe(true);
      // the other direction of the tenant wall: org B's pass left org A's file alone
      expect(await intact(ORG_A, file)).toBe(true);

      await release(holdId);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
      expect(await gone(ORG_A, file)).toBe(true);
    });

    it("the M4 scope is read again right before each destroy: a hold that appears after the plan stops it (an unreferenced file too)", async () => {
      const file = await seedFile(ORG_A, 450);
      await seedRun(ORG_A, file, { status: "mailed", mailedDaysAgo: 420 });
      const none = { orgWide: false, patientIds: new Set<string>() };
      let calls = 0;
      // call 0 is the plan's read (no hold); every later call is the per-file re-read (an org-wide hold has appeared)
      const orgWideLater = deps({
        legalHolds: {
          activeScopeForOrg: async () => (calls++ === 0 ? none : { ...none, orgWide: true }),
        },
      });
      expect(await purgeMailingFilesForOrg(orgWideLater, ORG_A)).toMatchObject({
        due: 1,
        destroyed: 0,
        refused: 1,
      });
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(await intact(ORG_A, file)).toBe(true);

      // a patient-scoped hold at that moment protects the file no run names, while a run that holds no held patient's family still goes
      const orphan = await seedFile(ORG_A, 30);
      calls = 0;
      const patientLater = deps({
        legalHolds: {
          activeScopeForOrg: async () =>
            calls++ === 0 ? none : { orgWide: false, patientIds: new Set([randomUUID()]) },
        },
      });
      expect(await purgeMailingFilesForOrg(patientLater, ORG_A)).toMatchObject({
        due: 2,
        destroyed: 1,
        refused: 1,
      });
      expect(await gone(ORG_A, file)).toBe(true);
      expect(await intact(ORG_A, orphan)).toBe(true);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
    });

    it("a hold applied in the instant between the plan and the destroy is seen: M4's per-org hold lock makes the purge wait, then the re-read refuses", async () => {
      const file = await seedFile(ORG_A, 450);
      await seedRun(ORG_A, file, { status: "mailed", mailedDaysAgo: 420 });
      // A second connection plays POST /legal-holds in flight: it takes M4's per-org advisory lock EXCLUSIVE and inserts an org-wide hold it has not committed.
      const applier = new Client({ connectionString: DB_URL });
      await applier.connect();
      try {
        await applier.query("BEGIN");
        await applier.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          messagingHoldLockName(ORG_A),
        ]);
        await applier.query(
          `INSERT INTO legal_hold (organization_id, name, criteria, status, reason)
           VALUES ($1,'in flight','{"resourceKinds":["document"]}'::jsonb,'active','synthetic live-suite hold')`,
          [ORG_A],
        );
        // the plan reads no committed hold, so the file is due; the per-file step then blocks on the lock
        const pass = purgeMailingFilesForOrg(deps(), ORG_A);
        let waiting = 0;
        for (let i = 0; i < 200 && waiting === 0; i += 1) {
          waiting = (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
            )
          ).rows[0].n as number;
          if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBeGreaterThan(0); // the purge really is waiting for the applier
        expect(await intact(ORG_A, file)).toBe(true);
        await applier.query("COMMIT");
        expect(await pass).toMatchObject({ due: 1, destroyed: 0, refused: 1, failed: 0 });
        expect(await intact(ORG_A, file)).toBe(true);
      } finally {
        await applier.end();
      }
      await admin.query(
        "UPDATE legal_hold SET status='released', released_at=now() WHERE organization_id=$1 AND status='active'",
        [ORG_A],
      );
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
      expect(await gone(ORG_A, file)).toBe(true);
    });

    it("a held patient id that is not a uuid fails CLOSED: it holds every run instead of being dropped", async () => {
      const file = await seedFile(ORG_A, 450);
      const runId = await seedRun(ORG_A, file, { status: "mailed", mailedDaysAgo: 420 });
      await seedFamilyInRun(ORG_A, runId, randomUUID());
      const holdId = await hold(ORG_A, { patientIds: ["not-a-uuid"] });
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 0 });
      expect(await intact(ORG_A, file)).toBe(true);
      await release(holdId);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
      expect(await gone(ORG_A, file)).toBe(true);
    });

    it("an abandoned `ready` run that moved on between the plan and the cancel is left alone (compare-and-set), its file intact", async () => {
      const file = await seedFile(ORG_A, 420);
      const runId = await seedRun(ORG_A, file, { status: "ready", generatedDaysAgo: 420 });
      let calls = 0;
      const none = { orgWide: false, patientIds: new Set<string>() };
      // call 0 is the plan's read; call 1 is the per-file re-read, where another writer bumps the run's version before our compare-and-set
      const interfering = deps({
        legalHolds: {
          activeScopeForOrg: async () => {
            if (calls++ === 1) {
              await admin.query(
                "UPDATE bereavement_mailing_run SET version = version + 1 WHERE id = $1",
                [runId],
              );
            }
            return none;
          },
        },
      });
      expect(await purgeMailingFilesForOrg(interfering, ORG_A)).toMatchObject({
        due: 1,
        destroyed: 0,
        refused: 1,
        runsCancelled: 0,
      });
      expect(await runRow(runId)).toMatchObject({ status: "ready", version: 1 });
      expect(await intact(ORG_A, file)).toBe(true);
      // undisturbed, the next pass cancels the run and destroys the file
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({
        destroyed: 1,
        runsCancelled: 1,
      });
      expect(await gone(ORG_A, file)).toBe(true);
    });
  });

  // ══ the cap ═════════════════════════════════════════════════════════════════════════════════
  describe("a plan bigger than the cap is refused whole and alarms; the cap raised, it goes", () => {
    const big: string[] = [];
    beforeAll(async () => {
      for (let i = 0; i < 3; i += 1) {
        const file = await seedFile(ORG_B, 450);
        await seedRun(ORG_B, file, { status: "mailed", mailedDaysAgo: 420 });
        big.push(file);
      }
    }, 120_000);

    it("deletes nothing when the plan exceeds the cap", async () => {
      const capped = deps({
        mailingFilePurge: { execute: true, executionSupported: true, maxFilesPerOrgRun: 2 },
      });
      await expect(purgeMailingFilesForOrg(capped, ORG_B)).rejects.toMatchObject({
        name: "MailingFilePurgeRefusedError",
        code: "PLAN_TOO_LARGE",
      });
      for (const id of big) expect(await intact(ORG_B, id)).toBe(true);
    });

    it("the daily tick throws (so the queue retries and the DLQ alert fires) yet org A's pass still ran", async () => {
      const capped = deps({
        mailingFilePurge: { execute: true, executionSupported: true, maxFilesPerOrgRun: 2 },
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_B }, { organizationId: ORG_A }],
        },
      });
      logged.length = 0;
      await expect(runMailingFilePurgeCron(capped)).rejects.toThrow(
        /1 org\(s\) refused or failed, 0 file\(s\) failed/,
      );
      expect(logged.join("\n")).toContain("tick done");
      for (const id of big) expect(await intact(ORG_B, id)).toBe(true);
    });

    it("the refusal message carries counts and the org id only", async () => {
      const err = await purgeMailingFilesForOrg(
        deps({
          mailingFilePurge: { execute: true, executionSupported: true, maxFilesPerOrgRun: 2 },
        }),
        ORG_B,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailingFilePurgeRefusedError);
      const message = (err as Error).message;
      expect(message).toBe(
        `m16-mailing-file-purge: PLAN_TOO_LARGE org=${ORG_B} due=3 cap=2; nothing was deleted`,
      );
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    });

    it("with the cap raised the same plan goes", async () => {
      expect(await purgeMailingFilesForOrg(deps(), ORG_B)).toMatchObject({ due: 3, destroyed: 3 });
      for (const id of big) expect(await gone(ORG_B, id)).toBe(true);
    });

    it("a pass for org B never touches org A's due file (the reverse direction of the tenant wall)", async () => {
      const file = await seedFile(ORG_A, 450);
      await seedRun(ORG_A, file, { status: "mailed", mailedDaysAgo: 420 });
      expect(await purgeMailingFilesForOrg(deps(), ORG_B)).toMatchObject({ due: 0, destroyed: 0 });
      expect(await intact(ORG_A, file)).toBe(true);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
      expect(await gone(ORG_A, file)).toBe(true);
    });
  });

  // ══ interruption ════════════════════════════════════════════════════════════════════════════
  describe("an interrupted run resumes", () => {
    it("a store failure leaves that file's row and object; the rest go; the next run finishes it", async () => {
      const files = [
        await seedFile(ORG_A, 30),
        await seedFile(ORG_A, 30),
        await seedFile(ORG_A, 30),
      ];
      const stuckKey = await keyOf(files[1] as string);
      failBefore.add(stuckKey);
      logged.length = 0;
      const first = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(first).toMatchObject({ due: 3, destroyed: 2, failed: 1 });
      expect(await intact(ORG_A, files[1] as string)).toBe(true);
      // the log names the document id and the error class, never the message (it carried the object key)
      expect(logged.join("\n")).not.toContain(stuckKey);

      failBefore.delete(stuckKey);
      const resumed = await purgeMailingFilesForOrg(deps(), ORG_A);
      expect(resumed).toMatchObject({ due: 1, destroyed: 1, failed: 0 });
      expect(await gone(ORG_A, files[1] as string)).toBe(true);
    });

    it("a crash after the object delete (row still `active`) is finished by the next run", async () => {
      const file = await seedFile(ORG_A, 30);
      const key = await keyOf(file);
      failAfter.add(key);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({
        destroyed: 0,
        failed: 1,
      });
      expect(await objectThere(ORG_A, file)).toBe(false);
      expect((await docRow(file)).status).toBe("active");

      failAfter.delete(key);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({
        destroyed: 1,
        failed: 0,
      });
      expect(await gone(ORG_A, file)).toBe(true);
    });
  });

  describe("an abandoned `ready` file whose destroy fails, and a hold that gets in after the bytes went", () => {
    it("the run stays cancelled, the pass alarms (failed), and the next run finishes the file at once: no 30-day grace is owed on a batch older than the floor", async () => {
      const file = await seedFile(ORG_A, 420);
      const runId = await seedRun(ORG_A, file, { status: "ready", generatedDaysAgo: 420 });
      const key = await keyOf(file);
      failBefore.add(key);
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({
        due: 1,
        destroyed: 0,
        failed: 1,
        runsCancelled: 1,
      });
      expect((await runRow(runId)).status).toBe("cancelled");
      expect(await intact(ORG_A, file)).toBe(true);

      failBefore.delete(key);
      // the cancelled run's `updated_at` is fresh, but its batch was generated more than a floor ago
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({
        due: 1,
        destroyed: 1,
        failed: 0,
      });
      expect(await gone(ORG_A, file)).toBe(true);
    });

    it("a hold that gets in after the objects went is an ALARM counted as failed (the tick throws for the DLQ alert), never a quiet refusal", async () => {
      const file = await seedFile(ORG_A, 30);
      const alarming = deps({
        orgDocuments: () => ({
          ...provider,
          destroyOrgDocument: async () => ({
            refused: true as const,
            reason: "held_after_destroy" as const,
          }),
        }),
      });
      logged.length = 0;
      expect(await purgeMailingFilesForOrg(alarming, ORG_A)).toMatchObject({
        due: 1,
        destroyed: 0,
        refused: 0,
        failed: 1,
      });
      expect(logged.join("\n")).toContain("ALARM");
      await expect(
        runMailingFilePurgeCron({
          ...alarming,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        }),
      ).rejects.toThrow(/0 org\(s\) refused or failed, 1 file\(s\) failed/);
      // finish: an ordinary run destroys it
      expect(await purgeMailingFilesForOrg(deps(), ORG_A)).toMatchObject({ destroyed: 1 });
      expect(await gone(ORG_A, file)).toBe(true);
    });
  });

  describe("the app role is the only credential this ran on", () => {
    it("the purge needed no DELETE: the app role holds none on document, and the row survives as a tombstone", async () => {
      const grants = (
        await admin.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee='chartwarden_app' AND table_name='document'`,
        )
      ).rows.map((r) => r.privilege_type as string);
      expect(grants).not.toContain("DELETE");
      expect((await docRow(a.mailedOld as string)).status).toBe("destroyed_tombstone");
    });
  });
});
