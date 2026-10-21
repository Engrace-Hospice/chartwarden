/**
 * M23 tenant-entered SEQUESTRATION POLICY — LIVE Postgres proof (F-212).
 *
 * `POST /claims/assemble` fails closed with `SEQUESTRATION_POLICY_UNAVAILABLE` unless a policy row covers the service date, and the
 * only write path (forward-dating) refused any start <= today, so a tenant could never cover a current or past service date. The
 * table is now append-only + overlap-safe (migration 0281) and `buildDrizzleSequestrationPolicyService` enters/supersedes rows.
 * This proves, against real rows under REAL RLS (every service call runs on the migrated NOBYPASSRLS `wardenx_app` role via
 * `_live-app-role.ts`; the superuser client only seeds and inspects):
 *   - create (incl. a PAST-dated backfill) / list / get / active / effective-on, and the audit trail the M4 trigger writes;
 *   - validation (band 0-2%, reason off-2%, window) as a typed 422 with nothing written, and the database CHECKs as a second wall;
 *   - non-overlap: the service pre-check (409 naming the clash) AND the database EXCLUDE backstop; the open-ended takeover close;
 *   - supersede (append-only correction), including the same-start open correction the old unique index would have refused;
 *   - append-only at the database: the app role cannot edit a percentage or delete a row; closed/superseded rows are frozen;
 *   - cross-tenant isolation (read, lookup, forged organization_id, FORCEd RLS);
 *   - the claim-assembly adapter's `activeSequestrationPolicy` reads only LIVE rows for the service date, per org.
 * No outbox event is emitted by this surface, so there is no publisher to bind.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-sequestration-policy.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import { buildDrizzleSequestrationPolicyService } from "../src/modules/23-billing-medicare/routes/sequestration-policy-service";
import type { CreateSequestrationPolicyBody } from "../src/modules/23-billing-medicare/routes/sequestration-policy-typebox";
import { buildM23ReferenceDataAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const PE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE_A2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PE_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PE_C = "99999999-9999-4999-8999-999999999999";

const actorA: M23WriteActor = {
  organizationId: ORG_A,
  userId: USER_A,
  roles: ["org_admin"],
  membershipId: MEMBERSHIP_A,
  stepUpRecent: false,
  actorKind: "user",
};
const actorB: M23WriteActor = {
  organizationId: ORG_B,
  userId: USER_B,
  roles: ["org_admin"],
  membershipId: MEMBERSHIP_B,
  stepUpRecent: false,
  actorKind: "user",
};

/** The standard 2% open-ended schedule from the post-moratorium restoration date. */
function policy(over: Partial<CreateSequestrationPolicyBody> = {}): CreateSequestrationPolicyBody {
  return {
    providerEntityId: PE_A,
    percentage: "2.00",
    effectiveFrom: "2022-07-01",
    ...over,
  };
}

describe.skipIf(!DB_URL)("M23 sequestration policy — LIVE Postgres (F-212)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;
  const svc = () => buildDrizzleSequestrationPolicyService(handle.db);

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  async function reset() {
    // The app role cannot delete; the superuser resets between tests (the guard trigger admits only the destruction role,
    // so disable it for the reset only).
    await admin.query(
      "ALTER TABLE sequestration_policy DISABLE TRIGGER trg_sequestration_policy_guard",
    );
    await admin.query("DELETE FROM sequestration_policy");
    await admin.query(
      "ALTER TABLE sequestration_policy ENABLE TRIGGER trg_sequestration_policy_guard",
    );
  }

  async function asApp<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    // The M4 audit trigger dereferences app.user_id as an FK: real user rows.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f212a@x.test'),($2,'f212b@x.test')`,
      [USER_A, USER_B],
    );
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  describe("create / list / get / active / effective-on", () => {
    it("creates a PAST-dated open-ended policy (the case the old forward-only path refused) and reads it back", async () => {
      await reset();
      const created = await svc().createPolicy(actorA, policy({ setReason: "restored 2% rate" }));
      expect(created).toMatchObject({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        percentage: "2.00",
        effectiveFrom: "2022-07-01",
        effectiveTo: null,
        setByMembershipId: MEMBERSHIP_A,
        setReason: "restored 2% rate",
        supersededAt: null,
        supersededById: null,
      });
      expect(await svc().getPolicy(actorA, PE_A, created.policyId)).toEqual(created);
      expect((await svc().listPolicies(actorA, PE_A, {})).map((r) => r.policyId)).toEqual([
        created.policyId,
      ]);
      expect((await svc().activePolicy(actorA, PE_A))?.policyId).toBe(created.policyId);
    });

    it("the M4 audit trigger records the entry (insert) in audit_event", async () => {
      await reset();
      const created = await svc().createPolicy(actorA, policy());
      const { rows } = await admin.query(
        "SELECT event_type, actor_user_id FROM audit_event WHERE resource_kind='sequestration_policy' AND resource_id=$1",
        [created.policyId],
      );
      expect(rows).toEqual([{ event_type: "sequestration_policy.insert", actor_user_id: USER_A }]);
    });

    it("models the real timeline: 2% / 0% moratorium / 1% step-down / 2% - and looks up by service date with inclusive edges", async () => {
      await reset();
      await svc().createPolicy(
        actorA,
        policy({ effectiveFrom: "2013-04-01", effectiveTo: "2020-04-30" }),
      );
      await svc().createPolicy(
        actorA,
        policy({
          percentage: "0.00",
          effectiveFrom: "2020-05-01",
          effectiveTo: "2022-03-31",
          setReason: "CARES Act / PAYGO moratorium",
        }),
      );
      await svc().createPolicy(
        actorA,
        policy({
          percentage: "1.00",
          effectiveFrom: "2022-04-01",
          effectiveTo: "2022-06-30",
          setReason: "statutory step-down",
        }),
      );
      await svc().createPolicy(actorA, policy());
      const at = async (d: string) => (await svc().effectivePolicy(actorA, PE_A, d))?.percentage;
      expect(await at("2020-04-30")).toBe("2.00");
      expect(await at("2020-05-01")).toBe("0.00");
      expect(await at("2022-03-31")).toBe("0.00");
      expect(await at("2022-04-01")).toBe("1.00");
      expect(await at("2022-06-30")).toBe("1.00");
      expect(await at("2022-07-01")).toBe("2.00");
      expect(await at("2030-01-01")).toBe("2.00"); // open-ended
      expect(await at("2013-03-31")).toBeUndefined(); // before any window: null, never a default
    });

    it("scopes rows to the provider entity", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      expect(await svc().effectivePolicy(actorA, PE_A2, "2026-01-01")).toBeNull();
      await svc().createPolicy(actorA, policy({ providerEntityId: PE_A2 }));
      expect(await svc().effectivePolicy(actorA, PE_A2, "2026-01-01")).not.toBeNull();
    });
  });

  describe("validation (typed 422, nothing written)", () => {
    it.each([
      [
        "a whole-number percent above the cap",
        { percentage: "20", setReason: "x" },
        /plausible band/,
      ],
      [
        "a fraction keyed as a percent with too many digits",
        { percentage: "1.23456", setReason: "x" },
        /decimal string/,
      ],
      ["0% without a documented reason", { percentage: "0.00" }, /requires a setReason/],
      [
        "a start before sequestration existed",
        { effectiveFrom: "2012-06-01" },
        /precedes 2013-04-01/,
      ],
      ["a start decades ahead (year typo)", { effectiveFrom: "2062-07-01" }, /days in the future/],
      ["a window ending before it starts", { effectiveTo: "2022-06-30" }, /must not precede/],
    ])("rejects %s", async (_name, over, message) => {
      await reset();
      await expect(svc().createPolicy(actorA, policy(over))).rejects.toMatchObject({
        code: "SEQUESTRATION_POLICY_INVALID",
        statusCode: 422,
        message: expect.stringMatching(message),
      });
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM sequestration_policy");
      expect(rows[0].n).toBe(0);
    });

    it("the database CHECKs are a second wall: direct app-role inserts of a bad percentage / early start are refused", async () => {
      await reset();
      for (const [pct, from] of [
        ["20", "2022-07-01"],
        ["2.5", "2022-07-01"],
        ["abc", "2022-07-01"],
        ["2.00", "2012-01-01"],
      ] as const) {
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
               VALUES ($1,$2,$3,$4,$5)`,
              [ORG_A, PE_A, pct, from, MEMBERSHIP_A],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        });
      }
    });
  });

  describe("non-overlap", () => {
    it("rejects an overlapping window with a 409 naming the clashing row", async () => {
      await reset();
      const first = await svc().createPolicy(actorA, policy({ effectiveTo: "2023-06-30" }));
      await expect(
        svc().createPolicy(
          actorA,
          policy({ effectiveFrom: "2023-06-30", effectiveTo: "2023-12-31" }),
        ),
      ).rejects.toMatchObject({
        code: "SEQUESTRATION_POLICY_OVERLAP",
        statusCode: 409,
        message: expect.stringContaining(first.policyId),
      });
    });

    it("a closed entry inside a live OPEN-ENDED row is a conflict (supersede it instead), never a silent split", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      await expect(
        svc().createPolicy(
          actorA,
          policy({
            percentage: "1.00",
            effectiveFrom: "2023-01-01",
            effectiveTo: "2023-03-31",
            setReason: "x",
          }),
        ),
      ).rejects.toMatchObject({ code: "SEQUESTRATION_POLICY_OVERLAP", statusCode: 409 });
    });

    it("an open-ended entry starting later TAKES OVER: the prior open row is closed the day before", async () => {
      await reset();
      const first = await svc().createPolicy(actorA, policy());
      const second = await svc().createPolicy(
        actorA,
        policy({
          percentage: "1.00",
          effectiveFrom: "2026-10-01",
          setReason: "hypothetical change",
        }),
      );
      expect(second.effectiveTo).toBeNull();
      const closed = await svc().getPolicy(actorA, PE_A, first.policyId);
      expect(closed.effectiveTo).toBe("2026-09-30");
      expect(closed.supersededAt).toBeNull(); // closed, not superseded: still live history for past dates
      expect((await svc().effectivePolicy(actorA, PE_A, "2026-09-30"))?.policyId).toBe(
        first.policyId,
      );
      expect((await svc().effectivePolicy(actorA, PE_A, "2026-10-01"))?.policyId).toBe(
        second.policyId,
      );
      expect((await svc().activePolicy(actorA, PE_A))?.policyId).toBe(second.policyId);
    });

    it("an open-ended entry with the SAME start as a live open row is a conflict (supersede, do not duplicate)", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      await expect(svc().createPolicy(actorA, policy())).rejects.toMatchObject({
        code: "SEQUESTRATION_POLICY_OVERLAP",
        statusCode: 409,
      });
    });

    it("the EXCLUDE constraint is the race-safe backstop: a direct overlapping insert is refused (23P01)", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, effective_to, set_by_membership_id)
             VALUES ($1,$2,'2.00','2023-01-01','2023-01-31',$3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "23P01" });
      });
    });

    it("two tenants (and two provider entities) may hold the same dates", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      await svc().createPolicy(actorA, policy({ providerEntityId: PE_A2 }));
      await expect(
        svc().createPolicy(actorB, policy({ providerEntityId: PE_B })),
      ).resolves.toMatchObject({ organizationId: ORG_B });
    });
  });

  describe("supersede (append-only correction)", () => {
    it("keeps the old row as history, makes the successor live (same-start open correction included), and rejects a second supersede", async () => {
      await reset();
      const v1 = await svc().createPolicy(
        actorA,
        policy({ percentage: "1.00", setReason: "mis-keyed" }),
      );
      // Same start, still open-ended: the old partial unique index would have refused this pair.
      const v2 = await svc().supersedePolicy(
        actorA,
        v1.policyId,
        policy({ percentage: "2.00", setReason: "corrected: 2% applies from restoration" }),
      );
      expect(v2.policyId).not.toBe(v1.policyId);
      expect(v2).toMatchObject({ percentage: "2.00", supersededAt: null });

      expect((await svc().effectivePolicy(actorA, PE_A, "2024-01-01"))?.policyId).toBe(v2.policyId);
      const old = await svc().getPolicy(actorA, PE_A, v1.policyId);
      expect(old.supersededById).toBe(v2.policyId);
      expect(old.supersededAt).not.toBeNull();
      expect(old.percentage).toBe("1.00");
      expect((await svc().listPolicies(actorA, PE_A, {})).map((r) => r.policyId)).toEqual([
        v2.policyId,
      ]);
      expect(
        (await svc().listPolicies(actorA, PE_A, { includeSuperseded: true }))
          .map((r) => r.policyId)
          .sort(),
      ).toEqual([v1.policyId, v2.policyId].sort());
      await expect(svc().supersedePolicy(actorA, v1.policyId, policy())).rejects.toMatchObject({
        code: "SEQUESTRATION_POLICY_ALREADY_SUPERSEDED",
        statusCode: 409,
      });
      expect((await svc().activePolicy(actorA, PE_A))?.policyId).toBe(v2.policyId);
    });

    it("the audit trail records both the successor insert and the supersede update", async () => {
      await reset();
      const v1 = await svc().createPolicy(actorA, policy());
      const v2 = await svc().supersedePolicy(actorA, v1.policyId, policy({ setReason: "fix" }));
      const { rows } = await admin.query(
        "SELECT event_type, resource_id FROM audit_event WHERE resource_kind='sequestration_policy'",
      );
      const kinds = rows.map(
        (r: { event_type: string; resource_id: string }) => `${r.event_type}:${r.resource_id}`,
      );
      expect(kinds).toEqual(
        expect.arrayContaining([
          `sequestration_policy.insert:${v1.policyId}`,
          `sequestration_policy.update:${v1.policyId}`,
          `sequestration_policy.insert:${v2.policyId}`,
        ]),
      );
    });

    it("an invalid successor leaves the original live (validation runs before any write)", async () => {
      await reset();
      const v1 = await svc().createPolicy(actorA, policy());
      await expect(
        svc().supersedePolicy(actorA, v1.policyId, policy({ percentage: "200" })),
      ).rejects.toMatchObject({ code: "SEQUESTRATION_POLICY_INVALID" });
      expect((await svc().getPolicy(actorA, PE_A, v1.policyId)).supersededAt).toBeNull();
    });

    it("a successor overlapping ANOTHER live row rolls back and leaves the original live", async () => {
      await reset();
      const h1 = await svc().createPolicy(
        actorA,
        policy({ effectiveFrom: "2022-07-01", effectiveTo: "2023-06-30" }),
      );
      await svc().createPolicy(actorA, policy({ effectiveFrom: "2023-07-01" }));
      await expect(
        svc().supersedePolicy(
          actorA,
          h1.policyId,
          policy({ effectiveFrom: "2022-07-01", effectiveTo: "2023-12-31" }),
        ),
      ).rejects.toMatchObject({ code: "SEQUESTRATION_POLICY_OVERLAP", statusCode: 409 });
      expect((await svc().getPolicy(actorA, PE_A, h1.policyId)).supersededAt).toBeNull();
    });

    it("404s a provider-entity mismatch and another tenant's row (no existence leak)", async () => {
      await reset();
      const v1 = await svc().createPolicy(actorA, policy());
      await expect(
        svc().supersedePolicy(actorA, v1.policyId, policy({ providerEntityId: PE_A2 })),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        svc().supersedePolicy(actorB, v1.policyId, policy({ providerEntityId: PE_A })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("append-only at the database (the app role cannot edit a percentage or delete a row)", () => {
    it("refuses UPDATE of a value column and DELETE at the GRANT level", async () => {
      await reset();
      const v1 = await svc().createPolicy(actorA, policy());
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query("UPDATE sequestration_policy SET percentage = '0.00' WHERE id = $1", [
            v1.policyId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query("DELETE FROM sequestration_policy WHERE id = $1", [v1.policyId]),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("the guard trigger freezes a superseded row and a closed period, but lets an open period close", async () => {
      await reset();
      const v1 = await svc().createPolicy(actorA, policy());
      // closing an OPEN period is the one permitted in-place change
      await asApp(ORG_A, async (c) => {
        const r = await c.query(
          "UPDATE sequestration_policy SET effective_to = '2030-12-31' WHERE id = $1 RETURNING effective_to",
          [v1.policyId],
        );
        expect(r.rowCount).toBe(1);
      });
      // ...but a closed period can be neither moved nor re-opened
      await svc().createPolicy(
        actorA,
        policy({ providerEntityId: PE_A2, effectiveTo: "2023-01-31" }),
      );
      const { rows } = await admin.query(
        "SELECT id FROM sequestration_policy WHERE provider_entity_id = $1",
        [PE_A2],
      );
      for (const set of ["effective_to = '2023-12-31'", "effective_to = NULL"]) {
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(`UPDATE sequestration_policy SET ${set} WHERE id = $1`, [rows[0].id]),
          ).rejects.toMatchObject({ code: "23001" });
        });
      }
      // a superseded row is frozen even for the supersede columns
      const v3 = await svc().createPolicy(actorA, policy({ providerEntityId: PE_C }));
      await svc().supersedePolicy(
        actorA,
        v3.policyId,
        policy({ providerEntityId: v3.providerEntityId }),
      );
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            "UPDATE sequestration_policy SET superseded_by_id = gen_random_uuid() WHERE id = $1",
            [v3.policyId],
          ),
        ).rejects.toMatchObject({ code: "23001" });
      });
    });
  });

  describe("cross-tenant isolation (real RLS on wardenx_app)", () => {
    it("org B never sees, fetches or resolves org A's policy", async () => {
      await reset();
      const a = await svc().createPolicy(actorA, policy());
      expect(await svc().listPolicies(actorB, PE_A, { includeSuperseded: true })).toEqual([]);
      await expect(svc().getPolicy(actorB, PE_A, a.policyId)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await svc().effectivePolicy(actorB, PE_A, "2026-01-01")).toBeNull();
      expect(await svc().activePolicy(actorB, PE_A)).toBeNull();
    });

    it("RLS WITH CHECK refuses a row forged into another organization", async () => {
      await reset();
      await asApp(ORG_B, async (c) => {
        await expect(
          c.query(
            `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
             VALUES ($1,$2,'2.00','2022-07-01',$3)`,
            [ORG_A, PE_A, MEMBERSHIP_A],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("no organization context, no rows (RLS is FORCED, not just enabled)", async () => {
      await reset();
      await svc().createPolicy(actorA, policy());
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        const { rows } = await c.query("SELECT count(*)::int AS n FROM sequestration_policy");
        expect(rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    });
  });

  describe("referenceData adapter (what POST /claims/assemble reads)", () => {
    it("activeSequestrationPolicy resolves the LIVE row covering the service date, per org", async () => {
      await reset();
      const a = await svc().createPolicy(actorA, policy());
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.activeSequestrationPolicy(ORG_A, PE_A, "2026-02-14")).toEqual({
        sequestrationPolicyId: a.policyId,
        percentage: "2.00",
        effectiveFrom: "2022-07-01",
        effectiveTo: null,
      });
      // never another tenant's, another entity's, or a date before every window: null (assembly then fails closed)
      expect(await adapter.activeSequestrationPolicy(ORG_B, PE_A, "2026-02-14")).toBeNull();
      expect(await adapter.activeSequestrationPolicy(ORG_A, PE_A2, "2026-02-14")).toBeNull();
      expect(await adapter.activeSequestrationPolicy(ORG_A, PE_A, "2022-06-30")).toBeNull();
    });

    it("a superseded row never answers, even where the correction leaves a gap (fail closed, not stale)", async () => {
      await reset();
      const wrong = await svc().createPolicy(
        actorA,
        policy({ percentage: "1.00", setReason: "mis-keyed" }),
      );
      // The correction starts later than the mis-keyed row did: 2022-07-01..2022-12-31 is now uncovered on purpose.
      await svc().supersedePolicy(actorA, wrong.policyId, policy({ effectiveFrom: "2023-01-01" }));
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.activeSequestrationPolicy(ORG_A, PE_A, "2022-12-01")).toBeNull();
      expect(await svc().effectivePolicy(actorA, PE_A, "2022-12-01")).toBeNull();
      expect(await adapter.activeSequestrationPolicy(ORG_A, PE_A, "2023-01-01")).not.toBeNull();
    });

    it("ignores a superseded row and follows the correction", async () => {
      await reset();
      const v1 = await svc().createPolicy(
        actorA,
        policy({ percentage: "1.00", setReason: "mis-keyed" }),
      );
      const v2 = await svc().supersedePolicy(actorA, v1.policyId, policy());
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      const got = await adapter.activeSequestrationPolicy(ORG_A, PE_A, "2026-02-14");
      expect(got?.sequestrationPolicyId).toBe(v2.policyId);
      expect(got?.percentage).toBe("2.00");
    });
  });
});
