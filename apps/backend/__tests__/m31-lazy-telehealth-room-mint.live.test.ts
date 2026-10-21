/**
 * F-220 (#248) — LIVE Postgres proof of M31's LAZY telehealth room mint (`ensureTelehealthRoomForVisit` over the
 * real Drizzle `PortalStore`), connected as the real NOBYPASSRLS `chartwarden_app` role. Replaces the never-built
 * `m17.visit.published` -> `m31.telehealth-room-mint` push.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m31:lazy-room-mint:live
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortalRoomCipher } from "../src/modules/31-portal/portal-crypto";
import { buildDrizzlePortalStore } from "../src/modules/31-portal/routes/store";
import {
  type M17VisitForRoom,
  type RoomMintPorts,
  ensureTelehealthRoomForVisit,
} from "../src/modules/31-portal/telehealth/room-mint";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const KEY = Buffer.alloc(32, 7);

describe.skipIf(!DB_URL)("F-220 — M31 lazy telehealth room mint — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const pe: Record<string, string> = {};
  let mintCalls = 0;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  async function seedOrg(orgId: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [orgId, slug, slug],
    );
    const row = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
      [orgId, `CCN-${slug}`, `NPI-${slug}`],
    );
    pe[orgId] = row.rows[0].id as string;
  }

  const visitFor = (orgId: string, over: Partial<M17VisitForRoom> = {}): M17VisitForRoom => ({
    id: crypto.randomUUID(),
    organizationId: orgId,
    patientId: crypto.randomUUID(),
    providerEntityId: pe[orgId] as string,
    locationId: null,
    assignedMembershipId: crypto.randomUUID(),
    visitSetting: "telephonic",
    scheduledStartedAt: new Date().toISOString(),
    status: "published",
    ...over,
  });

  function ports(visits: Map<string, M17VisitForRoom>, canMint = true): RoomMintPorts {
    return {
      // Deliberately NOT tenant-filtering: the pure eligibility check must itself refuse a foreign visit.
      visits: { visitForOrg: async (_org, id) => visits.get(id) ?? null },
      cipher: createPortalRoomCipher({ dekForOrg: async () => ({ version: "k1", key: KEY }) }),
      adapter: {
        vendor: "daily_co",
        ...(canMint
          ? {
              async mintRoom(input: { telehealthVisitId: string }) {
                mintCalls++;
                return {
                  vendorRoomId: `room-${input.telehealthVisitId}`,
                  vendorRoomUrl: `https://vendor.invalid/room-${input.telehealthVisitId}`,
                };
              },
            }
          : {}),
      },
      store: buildDrizzlePortalStore(handle.db),
    };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await seedOrg(ORG_A, "a");
    await seedOrg(ORG_B, "b");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("mints one real row for a telephonic visit, sealing both room columns (AAD-bound to column + tenant)", async () => {
    const v = visitFor(ORG_A);
    const p = ports(new Map([[v.id, v]]));
    const digest = await ensureTelehealthRoomForVisit(p, ORG_A, "", v.id);
    expect(digest?.m17VisitId).toBe(v.id);
    expect(digest?.lifecycleState).toBe("room_minted");
    expect(digest?.scheduledVisitSetting).toBe("telephonic");

    const { rows } = await admin.query(
      "SELECT provider_entity_id, patient_id, vendor_room_id_cipher, vendor_room_url_cipher FROM telehealth_visit WHERE m17_visit_id=$1",
      [v.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_entity_id).toBe(pe[ORG_A]);
    expect(rows[0].patient_id).toBe(v.patientId);
    for (const c of [rows[0].vendor_room_id_cipher, rows[0].vendor_room_url_cipher]) {
      expect(c).toMatch(/^v1\.k1\./);
      expect(c).not.toContain("room-");
    }
    // The envelope opens ONLY with the matching AAD (column + tenant): the row-id cipher is not openable as the
    // url column, nor under another org.
    const open = (blob: string, aad: string) => {
      const [, , nonce, tag, ct] = blob.split(".") as [string, string, string, string, string];
      const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(nonce, "base64url"));
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    };
    expect(
      open(rows[0].vendor_room_id_cipher, `m31:telehealth_visit:vendor_room_id:${ORG_A}`),
    ).toBe(`room-${digest?.telehealthVisitId}`);
    expect(() =>
      open(rows[0].vendor_room_id_cipher, `m31:telehealth_visit:vendor_room_url:${ORG_A}`),
    ).toThrow();
    expect(() =>
      open(rows[0].vendor_room_id_cipher, `m31:telehealth_visit:vendor_room_id:${ORG_B}`),
    ).toThrow();
  });

  it("is idempotent, including under a concurrent double join (one row wins, both callers get it)", async () => {
    const v = visitFor(ORG_A);
    const p = ports(new Map([[v.id, v]]));
    const [a, b] = await Promise.all([
      ensureTelehealthRoomForVisit(p, ORG_A, "", v.id),
      ensureTelehealthRoomForVisit(p, ORG_A, "", v.id),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.telehealthVisitId).toBe(b?.telehealthVisitId);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM telehealth_visit WHERE m17_visit_id=$1",
      [v.id],
    );
    expect(rows[0].n).toBe(1);
    // a later call returns the existing row without minting again.
    const before = mintCalls;
    const c = await ensureTelehealthRoomForVisit(p, ORG_A, "", v.id);
    expect(c?.telehealthVisitId).toBe(a?.telehealthVisitId);
    expect(mintCalls).toBe(before);
  });

  it("the store INSERT loses the unique-index race cleanly: a second insert for the same M17 visit returns null", async () => {
    const v = visitFor(ORG_A);
    const store = buildDrizzlePortalStore(handle.db);
    const row = (id: string) => ({
      id,
      providerEntityId: pe[ORG_A] as string,
      locationId: null,
      m17VisitId: v.id,
      patientId: v.patientId,
      assignedMembershipId: v.assignedMembershipId,
      vendor: "daily_co" as const,
      vendorRoomIdCipher: "c1",
      vendorRoomUrlCipher: "c2",
      scheduledVisitSetting: "telephonic" as const,
    });
    expect(
      await store.insertTelehealthVisitIfAbsent(ORG_A, "", row(crypto.randomUUID())),
    ).not.toBeNull();
    expect(
      await store.insertTelehealthVisitIfAbsent(ORG_A, "", row(crypto.randomUUID())),
    ).toBeNull();
  });

  it("writes nothing for non-telephonic, terminal, unknown, or wrong-tenant visits", async () => {
    const home = visitFor(ORG_A, { visitSetting: "patient_home" });
    const done = visitFor(ORG_A, { status: "completed" });
    const foreign = visitFor(ORG_B); // a real org-B visit asked for under org A
    const p = ports(new Map([home, done, foreign].map((v) => [v.id, v])));
    for (const v of [home, done, foreign, visitFor(ORG_A)]) {
      expect(await ensureTelehealthRoomForVisit(p, ORG_A, "", v.id)).toBeNull();
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM telehealth_visit WHERE m17_visit_id=$1",
        [v.id],
      );
      expect(rows[0].n).toBe(0);
    }
  });

  it("fails closed (TELEHEALTH_VENDOR_UNAVAILABLE) with no mintRoom, leaving no row", async () => {
    const v = visitFor(ORG_A);
    await expect(
      ensureTelehealthRoomForVisit(ports(new Map([[v.id, v]]), false), ORG_A, "", v.id),
    ).rejects.toMatchObject({ code: "TELEHEALTH_VENDOR_UNAVAILABLE" });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM telehealth_visit WHERE m17_visit_id=$1",
      [v.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("cross-tenant: org B cannot see or re-use org A's room (RLS as chartwarden_app)", async () => {
    const v = visitFor(ORG_A);
    const p = ports(new Map([[v.id, v]]));
    const minted = await ensureTelehealthRoomForVisit(p, ORG_A, "", v.id);
    expect(minted).not.toBeNull();
    const store = buildDrizzlePortalStore(handle.db);
    expect(await store.telehealthByM17VisitId(ORG_B, v.id)).toBeNull();
    expect(await store.telehealthById(ORG_B, minted?.telehealthVisitId as string)).toBeNull();
    expect(await store.telehealthByM17VisitId(ORG_A, v.id)).not.toBeNull();
  });
});
