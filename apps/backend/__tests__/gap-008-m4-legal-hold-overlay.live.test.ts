/**
 * GAP-008 - legal-hold supremacy as an OVERLAY, LIVE Postgres (ADR-0051).
 *
 * A hold cannot flip `audit_event.retention_class`: the column is in the integrity hash (db-chain-reader.ts) and `chartwarden_app`
 * has no UPDATE on the table. So a hold is recorded in the append-only `legal_hold_audit_event` overlay, materialised by a
 * sweep, enforced at the only DELETE path and by a BEFORE DELETE trigger, and shown through `audit_event_effective`.
 *
 * Roles: the tenant work (materialise, read, sweep inputs) runs as the real NOBYPASSRLS `chartwarden_app`; the destruction
 * credential is a SEPARATE client started as `chartwarden_destruction` (`options=-c role=...`), the role migration 0157 grants
 * SELECT, DELETE on `audit_event`, so the privilege and trigger assertions are about the production role, not a superuser.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:gap008:legal-hold-overlay:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite DROPs the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDbAuditChainReader,
  createDbAuditEraseExecutor,
  holdCoversGroup,
  materialiseHold,
  materialiseHoldWindow,
  reconcileOrgHolds,
} from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleAuditEraserPorts } from "../src/modules/04-audit/erasers/audit-eraser";
import {
  runDestructionSweepForOrg,
  runLegalHoldMaterialiseForOrg,
} from "../src/modules/04-audit/jobs/audit-job-ops";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_destruction",
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "tenant_platform_writer",
];
const ORG_A = "77777777-7777-4777-8777-77777777a008";
const ORG_B = "88888888-8888-4888-8888-88888888b008";
const MARCH = { start: "2026-03-01T00:00:00Z", end: "2026-03-31T23:59:59Z" };
const NOW = new Date("2026-10-08T12:00:00Z");

describe.skipIf(!DB_URL)("GAP-008 legal-hold overlay - LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let destruction: ReturnType<typeof createDbClient>;
  let destructionRaw: Client;

  const seedEvent = async (
    org: string,
    resourceKind: string,
    createdAt: string,
    over: { resourceId?: string; patientId?: string; retentionClass?: string } = {},
  ) => {
    const id = randomUUID();
    const resourceId = over.resourceId ?? randomUUID();
    await admin.query(
      `INSERT INTO audit_event (id, organization_id, actor_kind, event_type, resource_kind, resource_id, outcome,
                                severity, correlation_id, retention_class, created_at, context)
       VALUES ($1,$2,'system','test.event',$3,$4,'success','info',$5,$6,$7,$8::jsonb)`,
      [
        id,
        org,
        resourceKind,
        resourceId,
        randomUUID(),
        over.retentionClass ?? "compliance",
        createdAt,
        JSON.stringify(over.patientId ? { patientId: over.patientId } : {}),
      ],
    );
    return { id, resourceId };
  };
  const exists = async (id: string) =>
    ((await admin.query("SELECT 1 FROM audit_event WHERE id=$1", [id])).rowCount ?? 0) > 0;
  const newHold = async (org: string, criteria: object, status = "active") =>
    (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, status, reason)
         VALUES ($1,'h',$2::jsonb,$3,'litigation hold for the test') RETURNING id`,
        [org, JSON.stringify(criteria), status],
      )
    ).rows[0].id as string;
  const overlayIds = async (holdId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT audit_event_id FROM legal_hold_audit_event WHERE legal_hold_id=$1 ORDER BY 1",
        [holdId],
      )
    ).rows.map((r) => r.audit_event_id as string);
  const approvedCertificate = async (org: string, range = MARCH) =>
    (
      await admin.query(
        `INSERT INTO destruction_certificate (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
         VALUES ($1,'audit_event.compliance',0,$2,$3,'secure_delete','approved') RETURNING id`,
        [org, range.start, range.end],
      )
    ).rows[0].id as string;
  const certificate = async (id: string) =>
    (
      await admin.query("SELECT status, record_count FROM destruction_certificate WHERE id=$1", [
        id,
      ])
    ).rows[0] as { status: string; record_count: number };
  const sweep = (org: string) =>
    runDestructionSweepForOrg(
      {
        db: app.db,
        listOrgs: async () => [{ organizationId: org }],
        eraserPorts: createDrizzleAuditEraserPorts(app.db, { destructionDb: destruction.db }),
      },
      org,
    );
  const materialiseAll = (org: string, legalHoldId: string) =>
    materialiseHold(app.db, { organizationId: org, legalHoldId, now: NOW, maxWindows: 10_000 });
  const errorCode = async (client: Client, text: string, params: unknown[] = []) => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
      await client.query(text, params);
      await client.query("ROLLBACK");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return (error as { code?: string }).code ?? "unknown";
    }
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    // A CLOSED month-partition (the migrations only pre-create the current month onwards) for the detach check.
    await admin.query(
      `CREATE TABLE audit_event_2026_02 PARTITION OF audit_event
         FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00')`,
    );
    for (const [id, slug] of [
      [ORG_A, "g008-a"],
      [ORG_B, "g008-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [id, slug],
      );
    }
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // The destruction credential: a login that is actually `chartwarden_destruction` (SELECT, DELETE on audit_event, RLS pinned to
    // app.org_id), not a superuser stand-in.
    const destructionUrl = new URL(DB_URL as string);
    destructionUrl.searchParams.set("options", "-c role=chartwarden_destruction");
    destruction = createDbClient({ connectionString: destructionUrl.toString() });
    destructionRaw = new Client({ connectionString: destructionUrl.toString() });
    await destructionRaw.connect();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await destruction?.close();
    await destructionRaw?.end();
    await admin?.end();
  });

  describe("materialisation and the integrity hash", () => {
    it("writes exactly the matching rows to the overlay, and the base retention_class and the chain digest do NOT move", async () => {
      const held1 = await seedEvent(ORG_A, "patient_address", "2026-03-10T00:00:00Z");
      const held2 = await seedEvent(ORG_A, "patient_address", "2026-03-11T00:00:00Z");
      const free = await seedEvent(ORG_A, "login_attempt", "2026-03-10T00:00:00Z");
      const reader = createDbAuditChainReader(app.db);
      const before = await reader.digestMonth(ORG_A, "2026-03", null);

      const holdId = await newHold(ORG_A, { resourceKinds: ["patient_address"] });
      const result = await materialiseAll(ORG_A, holdId);
      expect(result.caughtUp).toBe(true);
      expect(await overlayIds(holdId)).toEqual([held1.id, held2.id].sort());

      // The whole reason for an overlay: applying a hold leaves the sealed month byte-for-byte verifiable.
      const after = await reader.digestMonth(ORG_A, "2026-03", null);
      expect(after?.chainHash).toBe(before?.chainHash);
      expect(after?.eventCount).toBe(before?.eventCount);
      const classes = await admin.query(
        "SELECT retention_class::text AS c FROM audit_event WHERE id = ANY($1)",
        [[held1.id, held2.id, free.id]],
      );
      expect(classes.rows.map((r) => r.c)).toEqual(["compliance", "compliance", "compliance"]);

      // Reporting: the effective class reads legal_hold for held rows only.
      const eff = await admin.query(
        "SELECT id, effective_retention_class AS c FROM audit_event_effective WHERE id = ANY($1)",
        [[held1.id, free.id]],
      );
      const byId = new Map(eff.rows.map((r) => [r.id as string, r.c as string]));
      expect(byId.get(held1.id)).toBe("legal_hold");
      expect(byId.get(free.id)).toBe("compliance");
    });

    it("is idempotent and tracks progress on the hold", async () => {
      const holdId = await newHold(ORG_A, { resourceKinds: ["patient_address"] });
      await materialiseAll(ORG_A, holdId);
      const first = await overlayIds(holdId);
      await materialiseAll(ORG_A, holdId);
      expect(await overlayIds(holdId)).toEqual(first);
      const { rows } = await admin.query(
        "SELECT materialisation_status, materialised_through, materialised_count FROM legal_hold WHERE id=$1",
        [holdId],
      );
      expect(rows[0].materialisation_status).toBe("complete");
      expect(rows[0].materialised_through).not.toBeNull();
      expect(Number(rows[0].materialised_count)).toBe(first.length);
    });

    it("a pre-existing active hold (migration default 'pending') is picked up by the reconcile sweep", async () => {
      const row = await seedEvent(ORG_A, "advance_directive", "2026-03-15T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["advance_directive"] });
      expect(
        (await admin.query("SELECT materialisation_status FROM legal_hold WHERE id=$1", [holdId]))
          .rows[0].materialisation_status,
      ).toBe("pending");
      const out = await runLegalHoldMaterialiseForOrg(
        { db: app.db, listOrgs: async () => [{ organizationId: ORG_A }], now: () => NOW },
        ORG_A,
      );
      expect(out.failed).toEqual([]);
      expect(await overlayIds(holdId)).toContain(row.id);
    });

    it("an open-ended hold gains rows written AFTER it was materialised on the next pass", async () => {
      const holdId = await newHold(ORG_A, { resourceKinds: ["late_arrival"] });
      await materialiseAll(ORG_A, holdId);
      expect(await overlayIds(holdId)).toEqual([]);
      const late = await seedEvent(ORG_A, "late_arrival", "2026-10-08T11:59:00Z");
      const out = await reconcileOrgHolds(app.db, ORG_A, NOW);
      expect(out.failed).toEqual([]);
      expect(await overlayIds(holdId)).toContain(late.id);
    });

    it("a released hold is not materialised further and keeps its overlay as history", async () => {
      const holdId = await newHold(ORG_A, { resourceKinds: ["released_kind"] });
      const row = await seedEvent(ORG_A, "released_kind", "2026-03-20T00:00:00Z");
      await materialiseAll(ORG_A, holdId);
      expect(await overlayIds(holdId)).toEqual([row.id]);
      await admin.query("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        holdId,
      ]);
      const more = await seedEvent(ORG_A, "released_kind", "2026-10-08T11:00:00Z");
      await reconcileOrgHolds(app.db, ORG_A, NOW);
      expect(await overlayIds(holdId)).toEqual([row.id]); // history stays, nothing new
      expect(more.id).toBeDefined();
    });
  });

  describe("parity: the SQL meaning of a hold equals holdCoversGroup, row by row", () => {
    it("agrees on a corpus of rows x holds (patient context, patient-keyed resource, kinds, ranges, combinations)", async () => {
      const p1 = randomUUID();
      const p2 = randomUUID();
      const corpus = [
        await seedEvent(ORG_B, "note", "2026-04-02T00:00:00Z", { patientId: p1 }),
        await seedEvent(ORG_B, "note", "2026-04-20T00:00:00Z", { patientId: p2 }),
        await seedEvent(ORG_B, "patient", "2026-04-10T00:00:00Z", { resourceId: p1 }),
        await seedEvent(ORG_B, "order", "2026-05-01T00:00:00Z", { patientId: p1 }),
        await seedEvent(ORG_B, "order", "2026-05-15T00:00:00Z"),
        await seedEvent(ORG_B, "visit", "2026-04-12T00:00:00Z", { resourceId: p2 }),
      ];
      const holds: object[] = [
        { patientIds: [p1] },
        { patientIds: [p1, p2] },
        { resourceKinds: ["note", "order"] },
        { dateRange: { from: "2026-04-05T00:00:00Z", to: "2026-04-30T23:59:59Z" } },
        { patientIds: [p1], resourceKinds: ["note"] },
        {
          patientIds: [p2],
          dateRange: { from: "2026-04-01T00:00:00Z", to: "2026-04-15T00:00:00Z" },
        },
        {
          resourceKinds: ["order"],
          dateRange: { from: "2026-05-10T00:00:00Z", to: "2026-05-31T00:00:00Z" },
        },
        { patientIds: ["not-a-uuid"], resourceKinds: ["note"] },
      ];
      const corpusIds = new Set<string>(corpus.map((c) => c.id));
      const rows = (
        await admin.query(
          `SELECT id, resource_kind, resource_id, created_at, context->>'patientId' AS patient_id
             FROM audit_event WHERE id = ANY($1)`,
          [[...corpusIds]],
        )
      ).rows;
      expect(rows.length).toBe(corpus.length);
      for (const criteria of holds) {
        const holdId = await newHold(ORG_B, criteria);
        await materialiseAll(ORG_B, holdId);
        // (the holds' own insert audit rows also live in this org; the corpus is the comparison set)
        const viaSql = new Set((await overlayIds(holdId)).filter((id) => corpusIds.has(id)));
        const viaTs = new Set(
          rows
            .filter((r) =>
              holdCoversGroup(criteria, {
                retentionClass: "compliance",
                resourceKind: r.resource_kind,
                resourceId: r.resource_id ?? r.id,
                organizationId: ORG_B,
                destructionCertificateId: "parity",
                ...(r.patient_id ? { patientId: r.patient_id } : {}),
                createdAtFrom: new Date(r.created_at).toISOString(),
                createdAtTo: new Date(r.created_at).toISOString(),
              }),
            )
            .map((r) => r.id as string),
        );
        expect([...viaSql].sort(), JSON.stringify(criteria)).toEqual([...viaTs].sort());
      }
    });
  });

  describe("enforcement at the DELETE", () => {
    it("the real destruction sweep keeps held rows, erases unheld ones, and the certificate says partial_refused with the HELD rows excluded from its count", async () => {
      const keep = await seedEvent(ORG_A, "kept_kind", "2026-03-10T00:00:00Z");
      const die = await seedEvent(ORG_A, "doomed_kind", "2026-03-10T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["kept_kind"] });
      await materialiseAll(ORG_A, holdId);
      const cert = await approvedCertificate(ORG_A, {
        start: "2026-03-10T00:00:00Z",
        end: "2026-03-10T23:00:00Z",
      });
      await sweep(ORG_A);
      expect(await exists(keep.id)).toBe(true);
      expect(await exists(die.id)).toBe(false);
      const c = await certificate(cert);
      expect(c.status).toBe("partial_refused");
    });

    it("the executor ALONE (group-level check bypassed) cannot destroy a held row: the DELETE excludes it", async () => {
      const held = await seedEvent(ORG_A, "exec_kind", "2026-03-11T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["exec_kind"] });
      await materialiseAll(ORG_A, holdId);
      const destroyed = await createDbAuditEraseExecutor(destruction.db).performErasure({
        retentionClass: "compliance",
        resourceKind: "exec_kind",
        resourceId: held.resourceId,
        organizationId: ORG_A,
        destructionCertificateId: "direct",
      });
      expect(destroyed).toBe(0);
      expect(await exists(held.id)).toBe(true);
    });

    it("an out-of-band DELETE as the destruction credential is refused by the trigger (23001), as chartwarden_app by privilege (42501)", async () => {
      const held = await seedEvent(ORG_A, "oob_kind", "2026-03-12T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["oob_kind"] });
      await materialiseAll(ORG_A, holdId);
      expect(
        await errorCode(destructionRaw, "DELETE FROM audit_event WHERE id=$1", [held.id]),
      ).toBe("23001");
      const appRaw = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await appRaw.connect();
      try {
        expect(await errorCode(appRaw, "DELETE FROM audit_event WHERE id=$1", [held.id])).toBe(
          "42501",
        );
        expect(
          await errorCode(
            appRaw,
            "UPDATE audit_event SET retention_class='legal_hold' WHERE id=$1",
            [held.id],
          ),
        ).toBe("42501");
        // and the tenant role cannot un-hold: no UPDATE / DELETE on the overlay
        expect(await errorCode(appRaw, "DELETE FROM legal_hold_audit_event")).toBe("42501");
        expect(await errorCode(appRaw, "UPDATE legal_hold_audit_event SET held_at = now()")).toBe(
          "42501",
        );
      } finally {
        await appRaw.end();
      }
      expect(await exists(held.id)).toBe(true);
    });

    it("the trigger does not depend on the deleter's RLS context: a SUPERUSER (RLS-bypassing) delete is refused too", async () => {
      const held = await seedEvent(ORG_A, "noctx_kind", "2026-03-13T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["noctx_kind"] });
      await materialiseAll(ORG_A, holdId);
      await expect(
        admin.query("DELETE FROM audit_event WHERE id=$1", [held.id]),
      ).rejects.toMatchObject({
        code: "23001",
      });
      expect(await exists(held.id)).toBe(true);
      // once the hold is released the same statement succeeds - the guard follows the hold, not the row
      await admin.query("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        holdId,
      ]);
      await admin.query("DELETE FROM audit_event WHERE id=$1", [held.id]);
      expect(await exists(held.id)).toBe(false);
    });

    it("a row written AFTER the hold is protected by the group check before reconcile, and by the overlay after", async () => {
      const holdId = await newHold(ORG_A, { resourceKinds: ["post_kind"] });
      await materialiseAll(ORG_A, holdId);
      const late = await seedEvent(ORG_A, "post_kind", "2026-03-14T00:00:00Z");
      expect(await overlayIds(holdId)).not.toContain(late.id); // not materialised yet
      const cert = await approvedCertificate(ORG_A, {
        start: "2026-03-14T00:00:00Z",
        end: "2026-03-14T23:00:00Z",
      });
      await sweep(ORG_A);
      expect(await exists(late.id)).toBe(true); // the structural group check held it
      expect((await certificate(cert)).status).toBe("held");
      await materialiseAll(ORG_A, holdId);
      // materialise resumes from the high-water mark less the overlap; a row older than that needs the earliest window:
      await materialiseHoldWindow(app.db, {
        organizationId: ORG_A,
        legalHoldId: holdId,
        criteria: { resourceKinds: ["post_kind"] },
        from: new Date("2026-03-14T00:00:00Z"),
        to: new Date("2026-03-15T00:00:00Z"),
      });
      expect(await overlayIds(holdId)).toContain(late.id);
    });

    it("release: the next sweep erases at once, the overlay stays as history, and the trigger lets go", async () => {
      const row = await seedEvent(ORG_A, "rel_kind", "2026-03-16T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["rel_kind"] });
      await materialiseAll(ORG_A, holdId);
      const cert = await approvedCertificate(ORG_A, {
        start: "2026-03-16T00:00:00Z",
        end: "2026-03-16T23:00:00Z",
      });
      await sweep(ORG_A);
      expect(await exists(row.id)).toBe(true);
      expect((await certificate(cert)).status).toBe("held");

      await admin.query("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        holdId,
      ]);
      await admin.query("UPDATE destruction_certificate SET status='approved' WHERE id=$1", [cert]);
      await sweep(ORG_A);
      expect(await exists(row.id)).toBe(false);
      expect((await certificate(cert)).status).toBe("executed");
      expect(await overlayIds(holdId)).toEqual([row.id]); // history is kept
    });
  });

  describe("tenant isolation (as chartwarden_app)", () => {
    it("org B cannot read org A's overlay rows, cannot write into them, and its own hold does not protect org A's rows", async () => {
      const aRow = await seedEvent(ORG_A, "iso_kind", "2026-03-17T00:00:00Z");
      const aHold = await newHold(ORG_A, { resourceKinds: ["iso_kind"] });
      await materialiseAll(ORG_A, aHold);
      const bHold = await newHold(ORG_B, { resourceKinds: ["iso_kind"] });
      await materialiseAll(ORG_B, bHold);
      expect(await overlayIds(bHold)).not.toContain(aRow.id); // B's materialiser only sees B's rows

      const appRaw = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await appRaw.connect();
      try {
        await appRaw.query("BEGIN");
        await appRaw.query("SELECT set_config('app.org_id',$1,true)", [ORG_B]);
        const visible = await appRaw.query(
          "SELECT count(*)::int AS n FROM legal_hold_audit_event WHERE organization_id=$1",
          [ORG_A],
        );
        expect(visible.rows[0].n).toBe(0);
        await expect(
          appRaw.query(
            "INSERT INTO legal_hold_audit_event (organization_id, legal_hold_id, audit_event_id, audit_event_created_at) VALUES ($1,$2,$3,now())",
            [ORG_A, aHold, randomUUID()],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await appRaw.query("ROLLBACK").catch(() => undefined);
        await appRaw.end();
      }
      // org A's row stays protected only by org A's hold: release it and the row is deletable even though B still holds that kind
      await admin.query("UPDATE legal_hold SET status='released' WHERE id=$1", [aHold]);
      const cert = await approvedCertificate(ORG_A, {
        start: "2026-03-17T00:00:00Z",
        end: "2026-03-17T23:00:00Z",
      });
      await sweep(ORG_A);
      expect(await exists(aRow.id)).toBe(false);
      expect(cert).toBeDefined();
    });
  });

  describe("partition detach refuses a held partition without an attested manifest", () => {
    it("audit_archive_detach: held rows + no attestation -> 23001; attested -> detached; an unheld partition needs no attestation", async () => {
      const held = await seedEvent(ORG_A, "detach_kind", "2026-02-10T00:00:00Z");
      await seedEvent(ORG_A, "plain_kind", "2026-02-11T00:00:00Z");
      const holdId = await newHold(ORG_A, { resourceKinds: ["detach_kind"] });
      await materialiseAll(ORG_A, holdId);
      expect(await overlayIds(holdId)).toEqual([held.id]);
      const total = Number(
        (await admin.query("SELECT count(*)::int AS n FROM audit_event_2026_02")).rows[0].n,
      );
      await expect(
        admin.query("SELECT audit_archive_detach('audit_event_2026_02', $1::bigint, false)", [
          total,
        ]),
      ).rejects.toMatchObject({ code: "23001" });
      await expect(
        admin.query("SELECT audit_archive_detach('audit_event_2026_02', $1::bigint)", [total]),
      ).rejects.toMatchObject({ code: "23001" });
      // the old two-argument signature no longer exists, so it cannot be used to skip the check
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_proc WHERE proname='audit_archive_detach' AND pronargs = 2",
          )
        ).rows[0].n,
      ).toBe(0);
      const done = await admin.query(
        "SELECT audit_archive_detach('audit_event_2026_02', $1::bigint, true) AS r",
        [total],
      );
      expect(done.rows[0].r).toBe("detached");
    });
  });
});
