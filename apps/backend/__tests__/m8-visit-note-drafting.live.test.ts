/**
 * ADR-0114 (visit-note drafting) - the data layer and the per-tenant switch, proven against real Postgres as the NOBYPASSRLS
 * `chartwarden_app` role. PR C2 extends this suite with the draft and the sign gate.
 *
 *   1. RLS isolates `encounter_draft_confirmation`, `hearthnote_signed_section` and `visit_note_draft_policy` per tenant (negative control:
 *      RLS off), a write into another tenant is refused (the org guard, then RLS's own WITH CHECK), and an encounter, output or member of
 *      another tenant cannot be referenced.
 *   2. The unique constraints and CHECKs hold; a confirmation upserts (INSERT + UPDATE), the application role holds DELETE on none of them.
 *   3. `hearthnote_signed_section` is append-only for the application role: UPDATE and DELETE are refused, and `part2_derived` has no default.
 *   4. The switch: absent row = off, enabling is refused (409 CORPUS_REVIEW_PENDING) while the corpus review is pending and writes nothing,
 *      enabled_at follows the switch (and the table CHECK backs it), disabling is always allowed.
 *   5. Every switch write lands the row trigger's record AND the explicit warn-severity `m8.encounter.draft_policy_changed` event, attributed
 *      to the actor; a refused write lands neither. The confirmation's source ids reach the audit trail; the sealed text never does.
 *   6. The encounter eraser (a real `chartwarden_destruction` login) shreds the sealed text, then deletes the new rows, leaves the root and
 *      another tenant's rows alone.
 *   7. Migration 1520 grants encounter.draft_policy_admin to the DON keys and the administrators, and to nobody else.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Never point this at the shared Docker cluster.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditContext } from "@chartwarden/audit";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { CORPUS_CLINICAL_REVIEW } from "@chartwarden/narrative-vocab";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CORPUS_REVIEW_PENDING_CODE,
  DRAFT_POLICY_AUDIT_EVENT,
  createDbDraftRouteService,
  isVisitNoteDraftEnabled,
  putDraftPolicy,
  readDraftPolicy,
} from "../src/modules/08-encounters/drafting/index";
import { createDrizzleEncounterEraseStore } from "../src/modules/08-encounters/erasers/encounter-eraser";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleConnectionString,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SERVICE_DATE = "2026-01-15"; // `encounter_service_date_not_future` forbids the future
const APPROVED = { reviewer: "ADA", status: "approved" } as const;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const hash = (char: string): string => char.repeat(64);
const SEALED_A = "v1.dek-1.bm9uY2U.dGFn.U0VDUkVULVNFQUxFRC1TRUNUSU9OLVRFWFQ"; // a synthetic envelope-shaped string, not real ciphertext

interface Member {
  readonly userId: string;
  readonly membershipId: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly author: Member;
  /** An encounter of the org, its patient and the org's assembled output for it. */
  readonly encounterId: string;
  readonly patientId: string;
  readonly outputId: string;
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return first;
}

function auditContextOf(org: string, userId: string): AuditContext {
  return {
    organizationId: org,
    userId,
    actorKind: "user",
    correlationId: `draft-live-${randomUUID()}`,
    requestId: randomUUID(),
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
  };
}

describe.skipIf(!DB_URL)(
  "M8 visit-note drafting data layer and switch (ADR-0114) - LIVE Postgres",
  () => {
    let admin: Client;
    let appPg: Client;
    let destructionPg: Client;
    let handle: ReturnType<typeof createDbClient>;
    let destructionHandle: ReturnType<typeof createDbClient>;
    const orgs = {} as Record<"A" | "B", OrgFixture>;
    let counter = 0;

    // ---------------------------------------------------------------------------------------------------------------
    // fixtures (seeded as the superuser; every assertion about behaviour runs as chartwarden_app)
    // ---------------------------------------------------------------------------------------------------------------
    async function seedMember(orgId: string, label: string): Promise<Member> {
      const user = await admin.query<{ id: string }>(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${label}-${randomUUID().slice(0, 8)}@drafting.test`],
      );
      const userId = one(user.rows).id;
      const membership = await admin.query<{ id: string }>(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, orgId],
      );
      return { userId, membershipId: one(membership.rows).id };
    }

    async function seedEncounter(
      orgId: string,
      providerEntityId: string,
      locationId: string,
      author: Member,
    ): Promise<{ encounterId: string; patientId: string }> {
      const patientId = randomUUID();
      const result = await admin.query<{ id: string }>(
        // `finalized`: the state sign finds a note in, and the only one in which migration 1525 lets its sealed sections be written.
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type,
         discipline, authored_by_membership_id, service_date, status, vocab_version_id)
       VALUES ($1,$2,$3,$4,$5,'routine_visit','rn',$6,$7,'finalized', gen_random_uuid()) RETURNING id`,
        [
          orgId,
          providerEntityId,
          locationId,
          patientId,
          randomUUID(),
          author.membershipId,
          SERVICE_DATE,
        ],
      );
      return { encounterId: one(result.rows).id, patientId };
    }

    async function seedOutput(
      org: Pick<OrgFixture, "orgId" | "providerEntityId" | "locationId">,
      encounterId: string,
    ) {
      const result = await admin.query<{ id: string }>(
        `INSERT INTO hearthnote_assembled_output (organization_id, provider_entity_id, location_id, encounter_id, kind,
         layer1_cipher, final_cipher, layer2_eligibility, assembly_template_key, vocab_version_id)
       VALUES ($1,$2,$3,$4,'primary_finalize',$5,$5,'tenant_flag_off','routine_visit:rn',$6) RETURNING id`,
        [org.orgId, org.providerEntityId, org.locationId, encounterId, SEALED_A, randomUUID()],
      );
      return one(result.rows).id;
    }

    async function seedOrg(orgId: string, slug: string): Promise<OrgFixture> {
      counter += 1;
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, `visit-note-drafting-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `VD-${slug}`, `PE ${slug}`, String(1_400_000_000 + counter)],
      );
      const providerEntityId = one(pe.rows).id;
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [providerEntityId],
      );
      const locationId = one(loc.rows).id;
      const author = await seedMember(orgId, `author-${slug}`);
      const { encounterId, patientId } = await seedEncounter(
        orgId,
        providerEntityId,
        locationId,
        author,
      );
      const outputId = await seedOutput({ orgId, providerEntityId, locationId }, encounterId);
      return { orgId, providerEntityId, locationId, author, encounterId, patientId, outputId };
    }

    /** One transaction as `chartwarden_app` on a raw pg connection, with the GUCs `withOrgContext` sets (or none). */
    async function asApp<T>(
      org: string | null,
      userId: string,
      fn: (client: Client) => Promise<T>,
    ): Promise<T> {
      await appPg.query("BEGIN");
      try {
        if (org !== null) {
          await appPg.query(
            "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
            [org, userId],
          );
        }
        const result = await fn(appPg);
        await appPg.query("COMMIT");
        return result;
      } catch (error) {
        await appPg.query("ROLLBACK");
        throw error;
      }
    }

    /** One transaction as a `chartwarden_destruction` login (the eraser's role) on a raw pg connection, org context set. */
    async function asDestruction<T>(org: string, fn: (client: Client) => Promise<T>): Promise<T> {
      await destructionPg.query("BEGIN");
      try {
        await destructionPg.query("SELECT set_config('app.org_id', $1, true)", [org]);
        const result = await fn(destructionPg);
        await destructionPg.query("COMMIT");
        return result;
      } catch (error) {
        await destructionPg.query("ROLLBACK");
        throw error;
      }
    }

    async function sqlFailure(
      run: Promise<unknown>,
    ): Promise<{ code?: string; constraint?: string }> {
      try {
        await run;
      } catch (error) {
        return error as { code?: string; constraint?: string };
      }
      throw new Error("expected the statement to fail, but it succeeded");
    }

    const countAs = (org: string | null, userId: string, table: string, where = "true") =>
      asApp(org, userId, async (c) => {
        const result = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        );
        return one(result.rows).n;
      });

    const inOrg = <T>(
      orgId: string,
      userId: string,
      fn: (tx: DbClient) => Promise<T>,
    ): Promise<T> =>
      withOrgContext(handle.db, { organizationId: orgId, userId }, (tx) =>
        fn(tx as unknown as DbClient),
      );

    const CONFIRMATION_COLUMNS =
      "organization_id, provider_entity_id, location_id, encounter_id, section_id, resolution, content_hash, corpus_version, edited, source_refs, resolved_by_membership_id, part2_derived";
    const confirmationValues = (
      org: OrgFixture,
      o: {
        sectionId?: string;
        resolution?: string;
        contentHash?: string;
        edited?: boolean;
        sourceRefs?: unknown;
        encounterId?: string;
        organizationId?: string;
        membershipId?: string;
        part2Derived?: boolean;
      } = {},
    ): unknown[] => [
      o.organizationId ?? org.orgId,
      org.providerEntityId,
      org.locationId,
      o.encounterId ?? org.encounterId,
      o.sectionId ?? "vitals_review",
      o.resolution ?? "confirmed",
      o.contentHash ?? hash("a"),
      "2026.11.0",
      o.edited ?? false,
      JSON.stringify(o.sourceRefs ?? [{ kind: "vitals", id: randomUUID() }]),
      o.membershipId ?? org.author.membershipId,
      o.part2Derived ?? false,
    ];
    const insertConfirmation = (client: Client, values: unknown[]) =>
      client.query(
        `INSERT INTO encounter_draft_confirmation (${CONFIRMATION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        values,
      );

    const SECTION_COLUMNS =
      "organization_id, provider_entity_id, location_id, encounter_id, assembled_output_id, section_id, position, text_cipher, content_hash, part2_derived, source_refs";
    const sectionValues = (
      org: OrgFixture,
      o: {
        sectionId?: string;
        position?: number;
        part2Derived?: boolean | null;
        outputId?: string;
        encounterId?: string;
        organizationId?: string;
        textCipher?: string;
        sourceRefs?: unknown;
        /** Overrides the row's siting pair (a sited encounter's rows must carry the encounter's own). */
        locationId?: string | null;
      } = {},
    ): unknown[] => [
      o.organizationId ?? org.orgId,
      org.providerEntityId,
      o.locationId === undefined ? org.locationId : o.locationId,
      o.encounterId ?? org.encounterId,
      o.outputId ?? org.outputId,
      o.sectionId ?? "assessment",
      o.position ?? 0,
      o.textCipher ?? SEALED_A,
      hash("b"),
      o.part2Derived === undefined ? false : o.part2Derived,
      JSON.stringify(o.sourceRefs ?? [{ kind: "care_plan_goal", id: randomUUID() }]),
    ];
    const insertSection = (client: Client, values: unknown[]) =>
      client.query(
        `INSERT INTO hearthnote_signed_section (${SECTION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        values,
      );

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
      orgs.A = await seedOrg(ORG_A, "a");
      orgs.B = await seedOrg(ORG_B, "b");

      const appUrl = await appRoleConnectionString(admin, DB_URL as string);
      appPg = new Client({ connectionString: appUrl });
      await appPg.connect();
      handle = createDbClient({ connectionString: appUrl });

      // The eraser's delete half runs as a real `chartwarden_destruction` login (migration 0157 / 1517-1519 grants).
      await admin.query(
        `ALTER ROLE chartwarden_destruction LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`,
      );
      const destructionUrl = new URL(DB_URL as string);
      destructionUrl.username = "chartwarden_destruction";
      destructionUrl.password = LIVE_APP_ROLE_PASSWORD;
      destructionHandle = createDbClient({ connectionString: destructionUrl.toString() });
      destructionPg = new Client({ connectionString: destructionUrl.toString() });
      await destructionPg.connect();
    }, 600_000);

    afterAll(async () => {
      await handle?.close();
      await destructionHandle?.close();
      if (appPg) await appPg.end();
      if (destructionPg) await destructionPg.end();
      if (admin) await admin.end();
    });

    // ===============================================================================================================
    // 1. tenant isolation
    // ===============================================================================================================
    describe("1. cross-tenant isolation of the three tables (RLS, as chartwarden_app)", () => {
      const tables = [
        "encounter_draft_confirmation",
        "hearthnote_signed_section",
        "visit_note_draft_policy",
      ] as const;

      beforeAll(async () => {
        for (const org of [orgs.A, orgs.B]) {
          await asApp(org.orgId, org.author.userId, async (c) => {
            await insertConfirmation(c, confirmationValues(org, { sectionId: "iso_section" }));
            await insertSection(c, sectionValues(org, { sectionId: "iso_section", position: 9 }));
          });
          await admin.query(
            "INSERT INTO visit_note_draft_policy (organization_id, changed_by_membership_id) VALUES ($1,$2)",
            [org.orgId, org.author.membershipId],
          );
        }
      });

      it("each tenant reads exactly its own rows, and a session with no org context reads none", async () => {
        for (const table of tables) {
          expect(
            await countAs(ORG_A, orgs.A.author.userId, table),
            `${table} as A`,
          ).toBeGreaterThan(0);
          expect(
            await countAs(ORG_B, orgs.B.author.userId, table),
            `${table} as B`,
          ).toBeGreaterThan(0);
          expect(
            await countAs(ORG_B, orgs.B.author.userId, table, `organization_id='${ORG_A}'`),
          ).toBe(0);
          expect(
            await countAs(ORG_A, orgs.A.author.userId, table, `organization_id='${ORG_B}'`),
          ).toBe(0);
          expect(await countAs(null, orgs.A.author.userId, table), `${table} with no GUC`).toBe(0);
        }
      });

      it("negative control: with RLS switched off org B DOES see org A's rows, so the zero counts above are the policy", async () => {
        for (const table of tables) {
          await admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
          try {
            const leaked = await countAs(
              ORG_B,
              orgs.B.author.userId,
              table,
              `organization_id='${ORG_A}'`,
            );
            expect(leaked, `${table} with RLS off`).toBeGreaterThan(0);
          } finally {
            await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
          }
          expect(
            await countAs(ORG_B, orgs.B.author.userId, table, `organization_id='${ORG_A}'`),
          ).toBe(0);
        }
      });

      it("org B cannot write into org A: the org guard refuses a reference to A's encounter, output or member, and RLS's WITH CHECK backs it", async () => {
        const b = orgs.B;
        const a = orgs.A;
        // B's own organization id on A's encounter: the guard (the encounter is invisible to B's session)
        const crossEncounter = await sqlFailure(
          asApp(ORG_B, b.author.userId, (c) =>
            insertConfirmation(c, confirmationValues(b, { encounterId: a.encounterId })),
          ),
        );
        expect(crossEncounter.code).toBe("23503");
        // B's own encounter, but A's member as the resolver
        const crossMember = await sqlFailure(
          asApp(ORG_B, b.author.userId, (c) =>
            insertConfirmation(c, confirmationValues(b, { membershipId: a.author.membershipId })),
          ),
        );
        expect(crossMember.code).toBe("23503");
        const crossOutput = await sqlFailure(
          asApp(ORG_B, b.author.userId, (c) =>
            insertSection(c, sectionValues(b, { sectionId: "x", outputId: a.outputId })),
          ),
        );
        expect(crossOutput.code).toBe("23503");
        // A's organization id under B's session: the guard refuses first (A's encounter is invisible to B) ...
        const wrongOrg = () =>
          asApp(ORG_B, b.author.userId, (c) =>
            insertConfirmation(c, confirmationValues(a, { organizationId: ORG_A })),
          );
        const wrongOrgSection = () =>
          asApp(ORG_B, b.author.userId, (c) =>
            insertSection(c, sectionValues(a, { sectionId: "x", organizationId: ORG_A })),
          );
        expect((await sqlFailure(wrongOrg())).code).toBe("23503");
        expect((await sqlFailure(wrongOrgSection())).code).toBe("23503");
        // ... and with the guards off RLS's own WITH CHECK is what refuses it: both layers are real, neither is the other's alibi.
        const guards = [
          ["encounter_draft_confirmation", "trg_encounter_draft_confirmation_org_guard"],
          ["hearthnote_signed_section", "trg_hearthnote_signed_section_org_guard"],
        ] as const;
        for (const [table, trigger] of guards) {
          await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        }
        try {
          expect((await sqlFailure(wrongOrg())).code).toBe("42501");
          expect((await sqlFailure(wrongOrgSection())).code).toBe("42501");
        } finally {
          for (const [table, trigger] of guards) {
            await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
          }
        }
        // the switch row of A, written by B's session
        const crossPolicy = await sqlFailure(
          asApp(ORG_B, b.author.userId, (c) =>
            c.query(
              "INSERT INTO visit_note_draft_policy (organization_id, changed_by_membership_id) VALUES ($1,$2)",
              [ORG_A, b.author.membershipId],
            ),
          ),
        );
        expect(["23503", "42501", "23505"]).toContain(crossPolicy.code);
        // a member of another tenant cannot be the acting member of B's own switch row either
        await admin.query("DELETE FROM visit_note_draft_policy WHERE organization_id=$1", [ORG_B]);
        const crossActor = await sqlFailure(
          asApp(ORG_B, b.author.userId, (c) =>
            c.query(
              "INSERT INTO visit_note_draft_policy (organization_id, changed_by_membership_id) VALUES ($1,$2)",
              [ORG_B, a.author.membershipId],
            ),
          ),
        );
        expect(crossActor.code).toBe("23503");
        await admin.query(
          "INSERT INTO visit_note_draft_policy (organization_id, changed_by_membership_id) VALUES ($1,$2)",
          [ORG_B, b.author.membershipId],
        );
      });

      it("org B's UPDATEs and org A's rows: an update from the wrong tenant touches nothing", async () => {
        const update = await asApp(ORG_B, orgs.B.author.userId, (c) =>
          c.query(
            "UPDATE encounter_draft_confirmation SET resolution='deselected' WHERE organization_id=$1",
            [ORG_A],
          ),
        );
        expect(update.rowCount).toBe(0);
        const policy = await asApp(ORG_B, orgs.B.author.userId, (c) =>
          c.query("UPDATE visit_note_draft_policy SET updated_at=now() WHERE organization_id=$1", [
            ORG_A,
          ]),
        );
        expect(policy.rowCount).toBe(0);
      });
    });

    // ===============================================================================================================
    // 2. constraints and the confirmation upsert
    // ===============================================================================================================
    describe("2. encounter_draft_confirmation: unique per (encounter, section), constrained, upsertable, never deletable by the app", () => {
      const a = () => orgs.A;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);

      it("a second confirmation of the same section is refused by the unique constraint, and a different section is fine", async () => {
        await run((c) =>
          insertConfirmation(c, confirmationValues(a(), { sectionId: "uniq_section" })),
        );
        const duplicate = await sqlFailure(
          run((c) => insertConfirmation(c, confirmationValues(a(), { sectionId: "uniq_section" }))),
        );
        expect(duplicate.code).toBe("23505");
        expect(duplicate.constraint).toBe("encounter_draft_confirmation_encounter_section_uniq");
        await run((c) =>
          insertConfirmation(c, confirmationValues(a(), { sectionId: "uniq_other" })),
        );
      });

      it("a re-confirmation UPSERTS as the app role: one row, the new hash, and the update is audited", async () => {
        const upsert = (resolution: string, contentHash: string, edited: boolean) =>
          run((c) =>
            c.query(
              `INSERT INTO encounter_draft_confirmation (${CONFIRMATION_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (encounter_id, section_id) DO UPDATE
               SET resolution=EXCLUDED.resolution, content_hash=EXCLUDED.content_hash, edited=EXCLUDED.edited,
                   part2_derived=EXCLUDED.part2_derived, source_refs=EXCLUDED.source_refs, resolved_by_membership_id=EXCLUDED.resolved_by_membership_id, resolved_at=now()`,
              confirmationValues(a(), {
                sectionId: "upsert_section",
                resolution,
                contentHash,
                edited,
              }),
            ),
          );
        await upsert("confirmed", hash("c"), false);
        await upsert("deselected", hash("d"), true);
        const rows = await admin.query(
          "SELECT resolution, content_hash, edited FROM encounter_draft_confirmation WHERE encounter_id=$1 AND section_id='upsert_section'",
          [a().encounterId],
        );
        expect(one(rows.rows)).toEqual({
          resolution: "deselected",
          content_hash: hash("d"),
          edited: true,
        });
        const updates = await admin.query(
          `SELECT before, after FROM audit_event
          WHERE organization_id=$1 AND event_type='encounter_draft_confirmation.update' AND after->>'section_id'='upsert_section'`,
          [ORG_A],
        );
        expect(one(updates.rows).before.resolution).toBe("confirmed");
        expect(one(updates.rows).after.resolution).toBe("deselected");
      });

      it.each([
        [
          "an unknown resolution",
          { resolution: "skipped" },
          "encounter_draft_confirmation_resolution_check",
        ],
        [
          "an uppercase content hash",
          { contentHash: "A".repeat(64) },
          "encounter_draft_confirmation_content_hash_check",
        ],
        [
          "a 63-character content hash",
          { contentHash: "a".repeat(63) },
          "encounter_draft_confirmation_content_hash_check",
        ],
        [
          "source refs that are not an array",
          { sourceRefs: { kind: "vitals" } },
          "encounter_draft_confirmation_source_refs_array",
        ],
      ])("refuses %s", async (_label, overrides, constraint) => {
        const failure = await sqlFailure(
          run((c) =>
            insertConfirmation(
              c,
              confirmationValues(a(), {
                sectionId: `bad_${randomUUID().slice(0, 6)}`,
                ...overrides,
              }),
            ),
          ),
        );
        expect(failure.code).toBe("23514");
        expect(failure.constraint).toBe(constraint);
      });

      it("the application role cannot DELETE a confirmation or the switch row", async () => {
        const confirmation = await sqlFailure(
          run((c) =>
            c.query("DELETE FROM encounter_draft_confirmation WHERE organization_id=$1", [ORG_A]),
          ),
        );
        expect(confirmation.code).toBe("42501");
        const policy = await sqlFailure(
          run((c) =>
            c.query("DELETE FROM visit_note_draft_policy WHERE organization_id=$1", [ORG_A]),
          ),
        );
        expect(policy.code).toBe("42501");
      });

      it("the source ids reach the audit trail through the row trigger (VN-D7: ids only)", async () => {
        const refs = [
          { kind: "care_plan_goal", id: randomUUID() },
          { kind: "vitals", id: randomUUID() },
        ];
        await run((c) =>
          insertConfirmation(
            c,
            confirmationValues(a(), { sectionId: "audit_section", sourceRefs: refs }),
          ),
        );
        const event = await admin.query(
          `SELECT after, actor_user_id::text AS actor FROM audit_event
          WHERE organization_id=$1 AND event_type='encounter_draft_confirmation.insert' AND after->>'section_id'='audit_section'`,
          [ORG_A],
        );
        expect(one(event.rows).after.source_refs).toEqual(refs);
        expect(one(event.rows).actor).toBe(a().author.userId);
      });
    });

    // ===============================================================================================================
    // 3. the sealed sections are append-only
    // ===============================================================================================================
    describe("3. hearthnote_signed_section is append-only for the app role", () => {
      const a = () => orgs.A;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);
      let sectionId: string;

      beforeAll(async () => {
        sectionId = one(
          (
            await run((c) =>
              insertSection(c, sectionValues(a(), { sectionId: "append_only", position: 1 })),
            )
          ).rows,
        ).id;
      });

      it("INSERT and SELECT work, UPDATE and DELETE are refused with insufficient_privilege", async () => {
        expect(
          await countAs(ORG_A, a().author.userId, "hearthnote_signed_section", `id='${sectionId}'`),
        ).toBe(1);
        const update = await sqlFailure(
          run((c) =>
            c.query("UPDATE hearthnote_signed_section SET content_hash=$2 WHERE id=$1", [
              sectionId,
              hash("e"),
            ]),
          ),
        );
        expect(update.code).toBe("42501");
        const shred = await sqlFailure(
          run((c) =>
            c.query("UPDATE hearthnote_signed_section SET text_cipher='' WHERE id=$1", [sectionId]),
          ),
        );
        expect(shred.code).toBe("42501");
        const del = await sqlFailure(
          run((c) => c.query("DELETE FROM hearthnote_signed_section WHERE id=$1", [sectionId])),
        );
        expect(del.code).toBe("42501");
        const stored = await admin.query(
          "SELECT content_hash, text_cipher FROM hearthnote_signed_section WHERE id=$1",
          [sectionId],
        );
        expect(one(stored.rows)).toEqual({ content_hash: hash("b"), text_cipher: SEALED_A });
      });

      it("a section is unique per (output, section) and per (output, position)", async () => {
        const sameSection = await sqlFailure(
          run((c) =>
            insertSection(c, sectionValues(a(), { sectionId: "append_only", position: 7 })),
          ),
        );
        expect(sameSection.constraint).toBe("hearthnote_signed_section_output_section_uniq");
        const samePosition = await sqlFailure(
          run((c) => insertSection(c, sectionValues(a(), { sectionId: "another", position: 1 }))),
        );
        expect(samePosition.constraint).toBe("hearthnote_signed_section_output_position_uniq");
        expect(samePosition.code).toBe("23505");
      });

      it("part2_derived has no default (the writer decides, fail closed), and a negative position is refused", async () => {
        const noFlag = await sqlFailure(
          run((c) =>
            insertSection(
              c,
              sectionValues(a(), { sectionId: "no_flag", position: 20, part2Derived: null }),
            ),
          ),
        );
        expect(noFlag.code).toBe("23502");
        const negative = await sqlFailure(
          run((c) => insertSection(c, sectionValues(a(), { sectionId: "neg", position: -1 }))),
        );
        expect(negative.constraint).toBe("hearthnote_signed_section_position_check");
      });

      it("the audit trail records the insert but never the sealed text", async () => {
        const event = await admin.query(
          `SELECT after FROM audit_event
          WHERE organization_id=$1 AND event_type='hearthnote_signed_section.insert' AND resource_id=$2`,
          [ORG_A, sectionId],
        );
        const after = one(event.rows).after as Record<string, unknown>;
        expect(JSON.stringify(after)).not.toContain(SEALED_A);
        expect(after.text_cipher).not.toBe(SEALED_A);
        expect(after.section_id).toBe("append_only");
        expect(after.part2_derived).toBe(false);
      });
    });

    // ===============================================================================================================
    // 4. + 5. the switch and its audit trail
    // ===============================================================================================================
    describe("4. the per-tenant switch", () => {
      const actor = () => orgs.A.author;
      const put = (enabled: boolean, now?: Date) =>
        inOrg(ORG_A, actor().userId, (tx) =>
          putDraftPolicy(tx, {
            organizationId: ORG_A,
            enabled,
            actorMembershipId: actor().membershipId,
            audit: auditContextOf(ORG_A, actor().userId),
            corpusReview: APPROVED,
            ...(now ? { now } : {}),
          }),
        );
      const stored = async () =>
        one(
          (
            await admin.query(
              "SELECT enabled, enabled_at, changed_by_membership_id::text AS changed_by FROM visit_note_draft_policy WHERE organization_id=$1",
              [ORG_A],
            )
          ).rows,
        );

      it("an organization with no row is OFF", async () => {
        await admin.query("DELETE FROM visit_note_draft_policy WHERE organization_id=$1", [ORG_A]);
        expect(await inOrg(ORG_A, actor().userId, (tx) => readDraftPolicy(tx, ORG_A))).toEqual({
          enabled: false,
          enabledAt: null,
        });
        expect(await inOrg(ORG_A, actor().userId, (tx) => isVisitNoteDraftEnabled(tx, ORG_A))).toBe(
          false,
        );
      });

      it("enabling stamps enabled_at, a repeat keeps it, disabling clears it, and the next enable stamps afresh", async () => {
        const T0 = new Date("2026-11-18T09:00:00.000Z");
        const T1 = new Date("2026-11-18T10:00:00.000Z");
        const T2 = new Date("2026-11-18T11:00:00.000Z");
        await put(true, T0);
        expect((await stored()).enabled_at.toISOString()).toBe(T0.toISOString());
        expect((await stored()).changed_by).toBe(actor().membershipId);
        expect(await inOrg(ORG_A, actor().userId, (tx) => isVisitNoteDraftEnabled(tx, ORG_A))).toBe(
          true,
        );

        await put(true, T1);
        expect((await stored()).enabled_at.toISOString()).toBe(T0.toISOString());

        await put(false, T1);
        expect(await stored()).toMatchObject({ enabled: false, enabled_at: null });
        expect(await inOrg(ORG_A, actor().userId, (tx) => isVisitNoteDraftEnabled(tx, ORG_A))).toBe(
          false,
        );

        await put(true, T2);
        expect((await stored()).enabled_at.toISOString()).toBe(T2.toISOString());
      });

      it("the table CHECK backs the pairing: a row cannot say enabled without an instant, or an instant while off", async () => {
        const unpaired = await sqlFailure(
          asApp(ORG_A, actor().userId, (c) =>
            c.query(
              "UPDATE visit_note_draft_policy SET enabled=true, enabled_at=NULL WHERE organization_id=$1",
              [ORG_A],
            ),
          ),
        );
        expect(unpaired.constraint).toBe("visit_note_draft_policy_enabled_at_check");
        const stale = await sqlFailure(
          asApp(ORG_A, actor().userId, (c) =>
            c.query(
              "UPDATE visit_note_draft_policy SET enabled=false, enabled_at=now() WHERE organization_id=$1",
              [ORG_A],
            ),
          ),
        );
        expect(stale.constraint).toBe("visit_note_draft_policy_enabled_at_check");
      });

      it.skipIf(CORPUS_CLINICAL_REVIEW.status === "approved")(
        "enabling is REFUSED through the real service while the corpus review is pending: 409 CORPUS_REVIEW_PENDING, nothing written, nothing audited",
        async () => {
          await put(false);
          const service = createDbDraftRouteService({ db: handle.db });
          const events = () =>
            admin.query(
              "SELECT 1 FROM audit_event WHERE organization_id=$1 AND (event_type=$2 OR event_type LIKE 'visit_note_draft_policy.%')",
              [ORG_A, DRAFT_POLICY_AUDIT_EVENT],
            );
          const before = (await events()).rowCount;
          const refusal = await service
            .putPolicy(
              { organizationId: ORG_A, userId: actor().userId, membershipId: actor().membershipId },
              { enabled: true },
              auditContextOf(ORG_A, actor().userId),
            )
            .catch((error: unknown) => error);
          expect(refusal).toBeInstanceOf(ChartWardenError);
          expect(refusal).toMatchObject({ code: CORPUS_REVIEW_PENDING_CODE, statusCode: 409 });
          expect((await stored()).enabled).toBe(false);
          expect((await events()).rowCount).toBe(before);
          // the read side answers the review state the settings screen needs
          expect(await service.getPolicy(ORG_A)).toEqual({
            enabled: false,
            reviewStatus: "pending",
            reviewer: "ADA",
          });
        },
      );

      it("disabling is always allowed, even with the corpus review pending", async () => {
        await put(true);
        const service = createDbDraftRouteService({
          db: handle.db,
          corpusReview: { reviewer: "ADA", status: "pending" },
        });
        const result = await service.putPolicy(
          { organizationId: ORG_A, userId: actor().userId, membershipId: actor().membershipId },
          { enabled: false },
          auditContextOf(ORG_A, actor().userId),
        );
        expect(result).toEqual({ enabled: false, reviewStatus: "pending", reviewer: "ADA" });
        expect((await stored()).enabled).toBe(false);
      });
    });

    describe("5. every switch write is audited twice: the row trigger and the explicit warn-severity event", () => {
      const actor = () => orgs.B.author;
      const audited = async (eventType: string) =>
        (
          await admin.query(
            `SELECT event_type, resource_kind, resource_id::text AS resource_id, severity, retention_class,
                  actor_user_id::text AS actor, before, after
             FROM audit_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at, id`,
            [ORG_B, eventType],
          )
        ).rows;
      const put = (enabled: boolean, now: Date) =>
        inOrg(ORG_B, actor().userId, (tx) =>
          putDraftPolicy(tx, {
            organizationId: ORG_B,
            enabled,
            actorMembershipId: actor().membershipId,
            audit: auditContextOf(ORG_B, actor().userId),
            corpusReview: APPROVED,
            now,
          }),
        );

      it("the first write (an insert) and a disable (an update) each land the trigger row AND the explicit event, attributed to the actor", async () => {
        const T0 = new Date("2026-11-18T09:00:00.000Z");
        const T1 = new Date("2026-11-18T10:00:00.000Z");
        await admin.query("DELETE FROM visit_note_draft_policy WHERE organization_id=$1", [ORG_B]);
        const seen = {
          insert: (await audited("visit_note_draft_policy.insert")).length,
          update: (await audited("visit_note_draft_policy.update")).length,
          explicit: (await audited(DRAFT_POLICY_AUDIT_EVENT)).length,
        };

        await put(true, T0); // first write: the default (off) -> on
        await put(false, T1); // disable

        const inserted = one((await audited("visit_note_draft_policy.insert")).slice(seen.insert));
        expect(inserted.actor).toBe(actor().userId);
        expect(inserted.before).toBeNull();
        expect(inserted.after).toMatchObject({
          enabled: true,
          changed_by_membership_id: actor().membershipId,
        });
        const updated = one((await audited("visit_note_draft_policy.update")).slice(seen.update));
        expect(updated.before).toMatchObject({ enabled: true });
        expect(updated.after).toMatchObject({ enabled: false, enabled_at: null });

        const [first, second, ...extra] = (await audited(DRAFT_POLICY_AUDIT_EVENT)).slice(
          seen.explicit,
        );
        expect(extra).toEqual([]);
        for (const event of [first, second]) {
          expect(event?.resource_kind).toBe("visit_note_draft_policy");
          expect(event?.resource_id).toBe(ORG_B);
          expect(event?.severity).toBe("warn");
          expect(event?.retention_class).toBe("compliance");
          expect(event?.actor).toBe(actor().userId);
        }
        expect(first?.after).toEqual({
          previousEnabled: false,
          enabled: true,
          enabledAt: T0.toISOString(),
        });
        expect(second?.after).toEqual({ previousEnabled: true, enabled: false, enabledAt: null });
      });

      it("a refused write (the corpus pending) leaves neither a row change nor an event", async () => {
        const before = (await audited(DRAFT_POLICY_AUDIT_EVENT)).length;
        await expect(
          inOrg(ORG_B, actor().userId, (tx) =>
            putDraftPolicy(tx, {
              organizationId: ORG_B,
              enabled: true,
              actorMembershipId: actor().membershipId,
              audit: auditContextOf(ORG_B, actor().userId),
              corpusReview: { reviewer: "ADA", status: "pending" },
            }),
          ),
        ).rejects.toMatchObject({ code: CORPUS_REVIEW_PENDING_CODE });
        expect((await audited(DRAFT_POLICY_AUDIT_EVENT)).length).toBe(before);
      });

      it("the explicit event commits or rolls back with the write", async () => {
        const before = (await audited(DRAFT_POLICY_AUDIT_EVENT)).length;
        await expect(
          inOrg(ORG_B, actor().userId, async (tx) => {
            await putDraftPolicy(tx, {
              organizationId: ORG_B,
              enabled: true,
              actorMembershipId: actor().membershipId,
              audit: auditContextOf(ORG_B, actor().userId),
              corpusReview: APPROVED,
            });
            throw new Error("force a rollback after the write");
          }),
        ).rejects.toThrow("force a rollback after the write");
        expect((await audited(DRAFT_POLICY_AUDIT_EVENT)).length).toBe(before);
        expect(
          one(
            (
              await admin.query(
                "SELECT enabled FROM visit_note_draft_policy WHERE organization_id=$1",
                [ORG_B],
              )
            ).rows,
          ).enabled,
        ).toBe(false);
      });
    });

    // ===============================================================================================================
    // 6. the encounter eraser
    // ===============================================================================================================
    describe("6. tenant destruction: the encounter eraser shreds the sealed text, then deletes the new rows", () => {
      it("shreds text_cipher first, deletes confirmations and sections of the patient only, keeps the root and the other tenant's rows", async () => {
        const a = orgs.A;
        const target = await seedEncounter(ORG_A, a.providerEntityId, a.locationId, a.author);
        const targetOutput = await seedOutput(a, target.encounterId);
        const targetOrg = { ...a, encounterId: target.encounterId, outputId: targetOutput };
        await asApp(ORG_A, a.author.userId, async (c) => {
          await insertConfirmation(c, confirmationValues(targetOrg, { sectionId: "erase_1" }));
          await insertConfirmation(
            c,
            confirmationValues(targetOrg, { sectionId: "erase_2", resolution: "deselected" }),
          );
          await insertSection(c, sectionValues(targetOrg, { sectionId: "erase_1", position: 0 }));
          await insertSection(c, sectionValues(targetOrg, { sectionId: "erase_2", position: 1 }));
          await insertSection(c, sectionValues(targetOrg, { sectionId: "erase_3", position: 2 }));
        });
        const keptA = await countAs(
          ORG_A,
          a.author.userId,
          "encounter_draft_confirmation",
          `encounter_id='${a.encounterId}'`,
        );
        const keptB = await countAs(ORG_B, orgs.B.author.userId, "hearthnote_signed_section");
        expect(keptA).toBeGreaterThan(0);
        expect(keptB).toBeGreaterThan(0);

        const store = createDrizzleEncounterEraseStore(destructionHandle.db);
        // Shred-before-delete: after the crypto-erase alone the rows are still there, but the sealed text is gone.
        await store.cryptoEraseHearthnote(ORG_A, target.patientId);
        const shredded = await admin.query(
          "SELECT text_cipher FROM hearthnote_signed_section WHERE encounter_id=$1",
          [target.encounterId],
        );
        expect(shredded.rows.map((r) => r.text_cipher)).toEqual(["", "", ""]);

        // The two steps this PR changed. `tombstoneEncounters` is not driven: it flips the root to voided and scrubs voided_reason, which the
        // root's own CHECK (encounter_voided_consistency) refuses on a real database, whatever the satellites hold.
        const counts = await store.eraseEncounterSubtree(ORG_A, target.patientId);
        expect(counts).toMatchObject({
          draftConfirmations: 2,
          signedSections: 3,
          hearthnoteAssembledOutputs: 1,
        });

        for (const table of [
          "encounter_draft_confirmation",
          "hearthnote_signed_section",
          "hearthnote_assembled_output",
        ]) {
          const left = await admin.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE encounter_id=$1`,
            [target.encounterId],
          );
          expect(one(left.rows).n, table).toBe(0);
        }
        const root = await admin.query("SELECT status FROM encounter WHERE id=$1", [
          target.encounterId,
        ]);
        expect(one(root.rows).status).toBe("finalized"); // the root is never deleted
        // the other patient of the same tenant and the other tenant keep every row
        expect(
          await countAs(
            ORG_A,
            a.author.userId,
            "encounter_draft_confirmation",
            `encounter_id='${a.encounterId}'`,
          ),
        ).toBe(keptA);
        expect(await countAs(ORG_B, orgs.B.author.userId, "hearthnote_signed_section")).toBe(keptB);
      });
    });

    // ===============================================================================================================
    // 7. migration 1520
    // ===============================================================================================================
    describe("7. migration 1520 mirrors encounter.draft_policy_admin: the DON keys and the administrators, nobody else", () => {
      const KEY = "encounter.draft_policy_admin";
      const EXPECTED: Record<string, string[]> = {
        director_of_nursing: [KEY],
        don: [KEY],
        org_admin: [KEY],
        administrator: [KEY],
        clinical_supervisor: [],
        clinical_lead: [],
        rn: [],
      };
      const migration = () =>
        readFileSync(join(MIGRATIONS_DIR, "1520_m8_visit_note_draft_permissions.sql"), "utf8");
      const grantsFor = async (roleKey: string) =>
        (
          await admin.query(
            `SELECT rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
            WHERE r.key=$1 AND r.organization_id=$2 AND rp.permission_key=$3`,
            [roleKey, ORG_A, KEY],
          )
        ).rows.map((r) => r.permission_key as string);

      it("the permission row exists in the catalog (compliance category, no ABAC default)", async () => {
        const rows = await admin.query(
          "SELECT key, resource, action, category::text AS category, default_abac::text AS default_abac FROM permission WHERE key=$1",
          [KEY],
        );
        expect(rows.rows).toEqual([
          {
            key: KEY,
            resource: "encounter",
            action: "draft_policy_admin",
            category: "compliance",
            default_abac: "none",
          },
        ]);
      });

      it("grants each existing role exactly its share, and a re-run is idempotent", async () => {
        // The migration ran over an empty tenant set: roles created since hold no grant yet (the control).
        for (const roleKey of Object.keys(EXPECTED)) {
          await admin.query(
            "INSERT INTO role (organization_id,key,name,category) VALUES ($1,$2,$2,'clinical_staff')",
            [ORG_A, roleKey],
          );
          expect(await grantsFor(roleKey), `${roleKey} before`).toEqual([]);
        }
        await admin.query(migration());
        for (const [roleKey, expected] of Object.entries(EXPECTED)) {
          expect(await grantsFor(roleKey), `${roleKey} after`).toEqual(expected);
        }
        const count = async () =>
          one(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM role_permission WHERE permission_key=$1",
                [KEY],
              )
            ).rows,
          ).n;
        const before = await count();
        await admin.query(migration());
        expect(await count()).toBe(before);
      });
    });

    // ===============================================================================================================
    // 8. the signed-section guard and the destruction grant
    // ===============================================================================================================
    describe("8. hearthnote_signed_section is tied to its own encounter and siting; the eraser may write text_cipher and nothing else", () => {
      const a = () => orgs.A;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);

      it("refuses an output that belongs to ANOTHER encounter of the same organization", async () => {
        const other = await seedEncounter(ORG_A, a().providerEntityId, a().locationId, a().author);
        const otherOutput = await seedOutput(a(), other.encounterId);
        const failure = await sqlFailure(
          run((c) =>
            insertSection(
              c,
              sectionValues(a(), { sectionId: "cross_encounter", position: 40, outputId: otherOutput }),
            ),
          ),
        );
        expect(failure.code).toBe("23503");
      });

      it("refuses a siting pair that is not the encounter's own", async () => {
        const failure = await sqlFailure(
          run((c) =>
            insertSection(
              c,
              sectionValues(a(), { sectionId: "wrong_siting", position: 41, locationId: null }),
            ),
          ),
        );
        expect(failure.code).toBe("23503");
      });

      it("accepts the encounter's own output with the encounter's own siting", async () => {
        await run((c) => insertSection(c, sectionValues(a(), { sectionId: "own_output", position: 42 })));
      });

      it("the eraser's role may UPDATE text_cipher (the shred) but no other column", async () => {
        const id = one(
          (await run((c) => insertSection(c, sectionValues(a(), { sectionId: "grant_probe", position: 43 }))))
            .rows,
        ).id;
        await asDestruction(ORG_A, (c) =>
          c.query("UPDATE hearthnote_signed_section SET text_cipher='' WHERE id=$1", [id]),
        );
        for (const column of ["content_hash=repeat('c',64)", "part2_derived=true", "section_id='x'"]) {
          const refused = await sqlFailure(
            asDestruction(ORG_A, (c) =>
              c.query(`UPDATE hearthnote_signed_section SET ${column} WHERE id=$1`, [id]),
            ),
          );
          expect(refused.code, column).toBe("42501");
        }
      });
    });

    // ===============================================================================================================
    // 9. the signed narrative is frozen in the database
    // ===============================================================================================================
    describe("9. hearthnote_assembled_output: once the encounter is signed the ciphers are frozen, bar the eraser's shred", () => {
      const a = () => orgs.A;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);
      const SIGNED_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;

      async function seedAt(status: "finalized" | "signed" | "cosign_pending" | "cosigned") {
        const encounter = await seedEncounter(ORG_A, a().providerEntityId, a().locationId, a().author);
        const outputId = await seedOutput(a(), encounter.encounterId);
        await setStatus(encounter.encounterId, status);
        return { ...encounter, outputId };
      }
      async function setStatus(encounterId: string, status: string) {
        const signedAt = ["signed", "cosign_pending", "cosigned"].includes(status) ? "now()" : "NULL";
        await admin.query(
          `UPDATE encounter SET status=$2::encounter_status, vocab_version_id=gen_random_uuid(), signed_at=${signedAt} WHERE id=$1`,
          [encounterId, status],
        );
      }
      const cipherOf = async (outputId: string) =>
        one(
          (
            await admin.query(
              "SELECT layer1_cipher, layer2_cipher, final_cipher FROM hearthnote_assembled_output WHERE id=$1",
              [outputId],
            )
          ).rows,
        );

      it("a finalized encounter's pin is still writable by the app role (the sign path writes it before the status flips)", async () => {
        const { outputId } = await seedAt("finalized");
        const result = await run((c) =>
          c.query(
            "UPDATE hearthnote_assembled_output SET layer1_cipher='v1.new', final_cipher='v1.new' WHERE id=$1",
            [outputId],
          ),
        );
        expect(result.rowCount).toBe(1);
        expect((await cipherOf(outputId)).final_cipher).toBe("v1.new");
      });

      it("pin, then status flip, in ONE app-role transaction: the sign shape works", async () => {
        const { encounterId, outputId } = await seedAt("finalized");
        await run(async (c) => {
          await c.query("UPDATE hearthnote_assembled_output SET final_cipher='v1.signed' WHERE id=$1", [outputId]);
          await c.query("UPDATE encounter SET status='signed', signed_at=now() WHERE id=$1", [encounterId]);
        });
        expect((await cipherOf(outputId)).final_cipher).toBe("v1.signed");
        // ... and the same two statements in the other order are refused: the freeze is real, the order is the contract.
        const second = await seedAt("finalized");
        const reordered = await sqlFailure(
          run(async (c) => {
            await c.query("UPDATE encounter SET status='signed', signed_at=now() WHERE id=$1", [second.encounterId]);
            await c.query("UPDATE hearthnote_assembled_output SET final_cipher='v1.late' WHERE id=$1", [second.outputId]);
          }),
        );
        expect(reordered.code).toBe("23001");
        expect((await cipherOf(second.outputId)).final_cipher).toBe(SEALED_A);
      });

      it.each(SIGNED_STATUSES)("a %s encounter's layer1, layer2 and final ciphers are refused to the app role", async (status) => {
        const { outputId } = await seedAt(status);
        for (const set of ["layer1_cipher='v1.x'", "layer2_cipher='v1.x'", "final_cipher='v1.x'", "final_cipher=''", "layer2_cipher=NULL, final_cipher='v1.x'"]) {
          const refused = await sqlFailure(
            run((c) => c.query(`UPDATE hearthnote_assembled_output SET ${set} WHERE id=$1`, [outputId])),
          );
          expect(refused.code, `${status}: ${set}`).toBe("23001");
        }
        expect(await cipherOf(outputId)).toEqual({ layer1_cipher: SEALED_A, layer2_cipher: null, final_cipher: SEALED_A });
      });

      it("a write that changes no cipher is not refused after sign", async () => {
        const { outputId } = await seedAt("signed");
        const result = await run((c) =>
          c.query("UPDATE hearthnote_assembled_output SET final_cipher=final_cipher WHERE id=$1", [outputId]),
        );
        expect(result.rowCount).toBe(1);
      });

      it("the eraser's role still shreds a signed note (the sentinel), and writes nothing else to a cipher", async () => {
        const { outputId } = await seedAt("signed");
        const arbitrary = await sqlFailure(
          asDestruction(ORG_A, (c) =>
            c.query("UPDATE hearthnote_assembled_output SET final_cipher='v1.other' WHERE id=$1", [outputId]),
          ),
        );
        expect(arbitrary.code).toBe("23001");
        await asDestruction(ORG_A, (c) =>
          c.query(
            "UPDATE hearthnote_assembled_output SET layer1_cipher='', layer2_cipher=NULL, final_cipher='' WHERE id=$1",
            [outputId],
          ),
        );
        expect(await cipherOf(outputId)).toEqual({ layer1_cipher: "", layer2_cipher: null, final_cipher: "" });
      });
    });

    // ===============================================================================================================
    // 10. what the row triggers write to the audit trail
    // ===============================================================================================================
    describe("10. the row audit keeps content hashes out, files Part 2 rows under the Part 2 class and withholds their source ids", () => {
      const a = () => orgs.A;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);
      const auditOf = async (eventType: string, sectionId: string) =>
        one(
          (
            await admin.query(
              `SELECT after, retention_class::text AS retention FROM audit_event
              WHERE organization_id=$1 AND event_type=$2 AND after->>'section_id'=$3`,
              [ORG_A, eventType, sectionId],
            )
          ).rows,
        );

      it("a confirmation: the hash is scrubbed, a plain row keeps its source ids under the 7-year class", async () => {
        const refs = [{ kind: "care_plan_goal", id: randomUUID() }];
        await run((c) =>
          insertConfirmation(c, confirmationValues(a(), { sectionId: "audit_plain", contentHash: hash("7"), sourceRefs: refs })),
        );
        const event = await auditOf("encounter_draft_confirmation.insert", "audit_plain");
        expect(event.after.content_hash).toBe("<changed>");
        expect(JSON.stringify(event.after)).not.toContain(hash("7"));
        expect(event.after.source_refs).toEqual(refs);
        expect(event.retention).toBe("compliance");
      });

      it("a Part 2 confirmation: Part 2 retention class, the source ids withheld, the flag kept", async () => {
        const refs = [{ kind: "medication_order", id: randomUUID() }];
        await run((c) =>
          insertConfirmation(c, confirmationValues(a(), { sectionId: "audit_part2", sourceRefs: refs, part2Derived: true })),
        );
        const event = await auditOf("encounter_draft_confirmation.insert", "audit_part2");
        expect(event.retention).toBe("compliance_42cfr_part2");
        expect(event.after.part2_derived).toBe(true);
        expect(event.after.source_refs).toBe("<changed>");
        expect(JSON.stringify(event.after)).not.toContain(refs[0]?.id);
      });

      it("a Part 2 re-confirmation's before image withholds the source ids too", async () => {
        const refs = [{ kind: "medication_order", id: randomUUID() }];
        await run((c) =>
          insertConfirmation(c, confirmationValues(a(), { sectionId: "audit_part2_update", sourceRefs: refs, part2Derived: true })),
        );
        await run((c) =>
          c.query(
            "UPDATE encounter_draft_confirmation SET resolution='deselected' WHERE encounter_id=$1 AND section_id='audit_part2_update'",
            [a().encounterId],
          ),
        );
        const updated = one(
          (
            await admin.query(
              `SELECT before, after, retention_class::text AS retention FROM audit_event
              WHERE organization_id=$1 AND event_type='encounter_draft_confirmation.update' AND after->>'section_id'='audit_part2_update'`,
              [ORG_A],
            )
          ).rows,
        );
        expect(updated.retention).toBe("compliance_42cfr_part2");
        expect(JSON.stringify(updated)).not.toContain(refs[0]?.id);
      });

      it("a signed section: the hash and the sealed text are scrubbed; a Part 2 section is filed under the Part 2 class with its source ids withheld", async () => {
        const plainRefs = [{ kind: "care_plan_goal", id: randomUUID() }];
        const part2Refs = [{ kind: "medication_order", id: randomUUID() }];
        await run(async (c) => {
          await insertSection(c, sectionValues(a(), { sectionId: "sig_audit_plain", position: 50, sourceRefs: plainRefs }));
          await insertSection(c, sectionValues(a(), { sectionId: "sig_audit_part2", position: 51, sourceRefs: part2Refs, part2Derived: true }));
        });
        const plain = await auditOf("hearthnote_signed_section.insert", "sig_audit_plain");
        expect(plain.after.content_hash).toBe("<changed>");
        expect(plain.after.source_refs).toEqual(plainRefs);
        expect(plain.retention).toBe("compliance");
        const part2 = await auditOf("hearthnote_signed_section.insert", "sig_audit_part2");
        expect(part2.after.content_hash).toBe("<changed>");
        expect(part2.after.source_refs).toBe("<changed>");
        expect(part2.after.part2_derived).toBe(true);
        expect(part2.retention).toBe("compliance_42cfr_part2");
        expect(JSON.stringify(part2.after)).not.toContain(part2Refs[0]?.id);
      });
    });

    // ===============================================================================================================
    // 11. migration 1525: the guards behind the signed note
    // ===============================================================================================================
    describe("11. migration 1525: a signed note, its pin, its confirmations and its signatures cannot be rewritten", () => {
      const a = () => orgs.A;
      const b = () => orgs.B;
      const run = <T>(fn: (c: Client) => Promise<T>) => asApp(ORG_A, a().author.userId, fn);
      const SIGNED_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;
      const RESTRICT = "23001";
      const TENANCY = "23503";

      async function setStatus(encounterId: string, status: string) {
        const signedAt = (SIGNED_STATUSES as readonly string[]).includes(status) ? "now()" : "NULL";
        const voided =
          status === "voided"
            ? ", voided_at=now(), voided_by=authored_by_membership_id, voided_reason=repeat('v',40)"
            : "";
        await admin.query(
          `UPDATE encounter SET status=$2::encounter_status, vocab_version_id=gen_random_uuid(), signed_at=${signedAt}${voided} WHERE id=$1`,
          [encounterId, status],
        );
      }
      /** An encounter of org A with its pin, in the given status (`seedEncounter` makes it `finalized`, the state sign finds a note in). */
      async function encounterAt(status: string) {
        const encounter = await seedEncounter(ORG_A, a().providerEntityId, a().locationId, a().author);
        const outputId = await seedOutput(a(), encounter.encounterId);
        if (status !== "finalized") await setStatus(encounter.encounterId, status);
        return { ...encounter, outputId };
      }
      async function seedAddendum(encounterId: string, status: "draft" | "finalized" | "signed" | "voided") {
        const result = await admin.query<{ id: string }>(
          `INSERT INTO encounter_addendum (organization_id, provider_entity_id, location_id, encounter_id, authored_by_membership_id,
             reason, status, signed_at)
           VALUES ($1,$2,$3,$4,$5,'a reason of at least twenty characters',$6::encounter_status, ${status === "signed" ? "now()" : "NULL"}) RETURNING id`,
          [ORG_A, a().providerEntityId, a().locationId, encounterId, a().author.membershipId, status],
        );
        return one(result.rows).id;
      }
      const pinOf = async (outputId: string) =>
        one(
          (
            await admin.query(
              "SELECT encounter_id, kind::text AS kind, part2_derived, final_cipher FROM hearthnote_assembled_output WHERE id=$1",
              [outputId],
            )
          ).rows,
        );

      const PIN_COLUMNS =
        "organization_id, provider_entity_id, location_id, encounter_id, addendum_id, kind, layer1_cipher, final_cipher, layer2_eligibility, assembly_template_key, vocab_version_id";
      const insertPin = (
        c: Client,
        o: { kind: string; encounterId?: string | null; addendumId?: string | null },
      ) =>
        c.query(
          `INSERT INTO hearthnote_assembled_output (${PIN_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6::assembled_output_kind,$7,$7,'tenant_flag_off','routine_visit:rn',$8) RETURNING id`,
          [
            ORG_A,
            a().providerEntityId,
            a().locationId,
            o.encounterId ?? null,
            o.addendumId ?? null,
            o.kind,
            SEALED_A,
            randomUUID(),
          ],
        );

      const SIGNATURE_COLUMNS =
        "organization_id, provider_entity_id, location_id, encounter_id, addendum_id, kind, signed_by_membership_id, signed_by_discipline, method, session_id, step_up_auth_at, attestation_text, layer2_involved_at_signing";
      const insertSignature = (
        c: Client,
        o: { encounterId: string; addendumId: string | null; kind?: string },
      ) =>
        c.query(
          `INSERT INTO encounter_signature (${SIGNATURE_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6::signature_kind,$7,'rn','passkey',$8,now(),'I attest that this cosignature of the addendum is accurate and complete.',false) RETURNING id`,
          [
            ORG_A,
            a().providerEntityId,
            a().locationId,
            o.encounterId,
            o.addendumId,
            o.kind ?? "addendum_cosignature",
            a().author.membershipId,
            randomUUID(),
          ],
        );

      describe("D1: a signed pin keeps its parent, kind and flag", () => {
        it("re-parenting a signed pin onto a draft encounter (with or without a cipher rewrite) is refused and changes nothing", async () => {
          const signed = await encounterAt("signed");
          const draft = await encounterAt("finalized");
          for (const set of [
            "encounter_id=$2, final_cipher='v1.x'",
            "encounter_id=$2",
            "encounter_id=$2, kind='addendum_finalize'",
          ]) {
            const refused = await sqlFailure(
              run((c) =>
                c.query(`UPDATE hearthnote_assembled_output SET ${set} WHERE id=$1`, [
                  signed.outputId,
                  draft.encounterId,
                ]),
              ),
            );
            expect(refused.code, set).toBe(RESTRICT);
          }
          expect(await pinOf(signed.outputId)).toMatchObject({
            encounter_id: signed.encounterId,
            kind: "primary_finalize",
            final_cipher: SEALED_A,
          });
        });

        it("a pin cannot be moved onto a signed encounter either (it would replace that note's newest pin)", async () => {
          const signed = await encounterAt("signed");
          const draft = await encounterAt("finalized");
          const refused = await sqlFailure(
            run((c) =>
              c.query("UPDATE hearthnote_assembled_output SET encounter_id=$2 WHERE id=$1", [
                draft.outputId,
                signed.encounterId,
              ]),
            ),
          );
          expect(refused.code).toBe(RESTRICT);
        });

        it("the Part 2 flag moves with sign's own write (finalized) and is frozen once the encounter is signed", async () => {
          const e = await encounterAt("finalized");
          await run(async (c) => {
            await c.query(
              "UPDATE hearthnote_assembled_output SET part2_derived=true, final_cipher='v1.s' WHERE id=$1",
              [e.outputId],
            );
            await c.query("UPDATE encounter SET status='signed', signed_at=now() WHERE id=$1", [e.encounterId]);
          });
          expect((await pinOf(e.outputId)).part2_derived).toBe(true);
          const refused = await sqlFailure(
            run((c) =>
              c.query("UPDATE hearthnote_assembled_output SET part2_derived=false WHERE id=$1", [e.outputId]),
            ),
          );
          expect(refused.code).toBe(RESTRICT);
          expect((await pinOf(e.outputId)).part2_derived).toBe(true);
        });
      });

      describe("D2: a new pin cannot replace a signed one", () => {
        it.each([...SIGNED_STATUSES, "voided"])("refuses a primary pin on a %s encounter", async (status) => {
          const e = await encounterAt(status);
          const refused = await sqlFailure(
            run((c) => insertPin(c, { kind: "primary_finalize", encounterId: e.encounterId })),
          );
          expect(refused.code).toBe(RESTRICT);
        });

        it("accepts the finalize shape: the status flips to finalized, then the pin is written", async () => {
          const e = await encounterAt("finalized");
          await run((c) => insertPin(c, { kind: "primary_finalize", encounterId: e.encounterId }));
        });

        it("refuses a kind that does not match its parent column", async () => {
          const signed = await encounterAt("signed");
          const addendumId = await seedAddendum(signed.encounterId, "finalized");
          const mismatches = [
            { kind: "addendum_finalize", encounterId: signed.encounterId },
            { kind: "primary_finalize", addendumId },
          ];
          for (const mismatch of mismatches) {
            const refused = await sqlFailure(run((c) => insertPin(c, mismatch)));
            expect(refused.code, JSON.stringify(mismatch)).toBe(RESTRICT);
          }
        });

        it("tests the ADDENDUM for an addendum pin: its parent is already signed, a finalized addendum may pin, a signed or voided one may not", async () => {
          const parent = await encounterAt("signed");
          const finalized = await seedAddendum(parent.encounterId, "finalized");
          await run((c) => insertPin(c, { kind: "addendum_finalize", addendumId: finalized }));
          for (const status of ["signed", "voided"] as const) {
            const addendumId = await seedAddendum(parent.encounterId, status);
            const refused = await sqlFailure(
              run((c) => insertPin(c, { kind: "addendum_finalize", addendumId })),
            );
            expect(refused.code, status).toBe(RESTRICT);
          }
        });

        it("fails closed on a parent of another organization", async () => {
          const refusedEncounter = await sqlFailure(
            run((c) => insertPin(c, { kind: "primary_finalize", encounterId: b().encounterId })),
          );
          expect(refusedEncounter.code).toBe(TENANCY);
          const foreignAddendum = await admin.query<{ id: string }>(
            `INSERT INTO encounter_addendum (organization_id, provider_entity_id, location_id, encounter_id, authored_by_membership_id, reason, status)
             VALUES ($1,$2,$3,$4,$5,'a reason of at least twenty characters','finalized') RETURNING id`,
            [ORG_B, b().providerEntityId, b().locationId, b().encounterId, b().author.membershipId],
          );
          const refusedAddendum = await sqlFailure(
            run((c) => insertPin(c, { kind: "addendum_finalize", addendumId: one(foreignAddendum.rows).id })),
          );
          expect(refusedAddendum.code).toBe(TENANCY);
        });
      });

      describe("D3: an original sealed row is written by sign, while the encounter is finalized", () => {
        it.each([...SIGNED_STATUSES, "voided", "draft"])("refuses an original row on a %s encounter", async (status) => {
          const e = await encounterAt(status);
          const refused = await sqlFailure(
            run((c) =>
              insertSection(
                c,
                sectionValues(a(), { sectionId: "late", position: 0, encounterId: e.encounterId, outputId: e.outputId }),
              ),
            ),
          );
          expect(refused.code).toBe(RESTRICT);
        });

        it("the sign shape works (rows, then the status flip in one transaction) and a row after the flip is refused", async () => {
          const e = await encounterAt("finalized");
          await run(async (c) => {
            await insertSection(
              c,
              sectionValues(a(), { sectionId: "first", position: 0, encounterId: e.encounterId, outputId: e.outputId }),
            );
            await c.query("UPDATE encounter SET status='signed', signed_at=now() WHERE id=$1", [e.encounterId]);
          });
          const refused = await sqlFailure(
            run((c) =>
              insertSection(
                c,
                sectionValues(a(), { sectionId: "second", position: 1, encounterId: e.encounterId, outputId: e.outputId }),
              ),
            ),
          );
          expect(refused.code).toBe(RESTRICT);
        });
      });

      describe("D4: an addendum's cosignature request keeps its tenancy on UPDATE", () => {
        async function seedRequest() {
          const parent = await encounterAt("signed");
          const addendumId = await seedAddendum(parent.encounterId, "signed");
          const request = await admin.query<{ id: string }>(
            `INSERT INTO addendum_cosignature_request (organization_id, provider_entity_id, location_id, encounter_id, addendum_id, routed_to_membership_id, status)
             VALUES ($1,$2,$3,$4,$5,$6,'routed') RETURNING id`,
            [ORG_A, a().providerEntityId, a().locationId, parent.encounterId, addendumId, a().author.membershipId],
          );
          return { parent, addendumId, requestId: one(request.rows).id };
        }
        const update = (c: Client, set: string, params: unknown[]) =>
          c.query(`UPDATE addendum_cosignature_request SET ${set} WHERE id=$1`, params);

        it("refuses pointing the routing or the release at a member of ANOTHER tenant (the foreign key alone ignores RLS)", async () => {
          const { requestId } = await seedRequest();
          for (const column of ["routed_to_membership_id", "supervisor_released_by"]) {
            const refused = await sqlFailure(
              run((c) => update(c, `${column}=$2`, [requestId, b().author.membershipId])),
            );
            expect(refused.code, column).toBe(TENANCY);
          }
          const row = one(
            (await admin.query("SELECT routed_to_membership_id, supervisor_released_by FROM addendum_cosignature_request WHERE id=$1", [requestId])).rows,
          );
          expect(row).toEqual({ routed_to_membership_id: a().author.membershipId, supervisor_released_by: null });
        });

        it("refuses moving the request to another organization, encounter, addendum or siting", async () => {
          const { requestId } = await seedRequest();
          const other = await seedRequest();
          for (const [set, value] of [
            ["organization_id=$2", ORG_B],
            ["encounter_id=$2", other.parent.encounterId],
            ["addendum_id=$2", other.addendumId],
            ["location_id=$2", null],
          ] as const) {
            const refused = await sqlFailure(run((c) => update(c, set, [requestId, value])));
            expect(refused.code, set).toBe(RESTRICT);
          }
        });

        it("still lets the workflow write: an acknowledgement, and a re-route to another member of the same organization", async () => {
          const { requestId } = await seedRequest();
          const colleague = await seedMember(ORG_A, "cosigner");
          await run((c) => update(c, "acknowledged_at=now()", [requestId]));
          await run((c) => update(c, "routed_to_membership_id=$2", [requestId, colleague.membershipId]));
          await run((c) => update(c, "supervisor_released_by=$2", [requestId, colleague.membershipId]));
        });
      });

      describe("D5: one provenance row per amending addendum's cosignature", () => {
        it("refuses an addendum cosignature that names no addendum, or an addendum of another encounter", async () => {
          const parent = await encounterAt("signed");
          const other = await encounterAt("signed");
          const addendumId = await seedAddendum(parent.encounterId, "signed");
          const noAddendum = await sqlFailure(run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId: null })));
          expect(noAddendum.code).toBe(TENANCY);
          const wrongEncounter = await sqlFailure(run((c) => insertSignature(c, { encounterId: other.encounterId, addendumId })));
          expect(wrongEncounter.code).toBe(TENANCY);
        });

        it("accepts the first and refuses a second row for the same addendum; other kinds are untouched", async () => {
          const parent = await encounterAt("signed");
          const addendumId = await seedAddendum(parent.encounterId, "signed");
          await run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId }));
          const duplicate = await sqlFailure(run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId })));
          expect(duplicate.code).toBe(RESTRICT);
          await run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId, kind: "addendum" }));
          await run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId: null, kind: "primary" }));
        });

        it("two concurrent transactions for one addendum take turns: the second sees the first and is refused", async () => {
          const parent = await encounterAt("signed");
          const addendumId = await seedAddendum(parent.encounterId, "signed");
          await admin.query("BEGIN");
          try {
            await insertSignature(admin, { encounterId: parent.encounterId, addendumId });
            const second = sqlFailure(run((c) => insertSignature(c, { encounterId: parent.encounterId, addendumId })));
            await new Promise((resolve) => setTimeout(resolve, 300));
            await admin.query("COMMIT");
            expect((await second).code).toBe(RESTRICT);
          } catch (error) {
            await admin.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        });
      });

      describe("C5 / D6 / D7: a confirmation is frozen with the note and carries the encounter's siting", () => {
        it.each([...SIGNED_STATUSES, "voided"])("a confirmation of a %s encounter can be neither rewritten nor added to", async (status) => {
          const e = await encounterAt("finalized");
          await run((c) => insertConfirmation(c, confirmationValues(a(), { sectionId: "c5", encounterId: e.encounterId })));
          await setStatus(e.encounterId, status);
          const rewrite = await sqlFailure(
            run((c) =>
              c.query("UPDATE encounter_draft_confirmation SET resolution='deselected' WHERE encounter_id=$1 AND section_id='c5'", [e.encounterId]),
            ),
          );
          expect(rewrite.code).toBe(RESTRICT);
          const added = await sqlFailure(
            run((c) => insertConfirmation(c, confirmationValues(a(), { sectionId: "c5_late", encounterId: e.encounterId }))),
          );
          expect(added.code).toBe(RESTRICT);
          const row = one(
            (await admin.query("SELECT resolution FROM encounter_draft_confirmation WHERE encounter_id=$1", [e.encounterId])).rows,
          );
          expect(row.resolution).toBe("confirmed");
        });

        it.each(["draft", "finalized"])("an unsigned (%s) encounter's confirmation is still written and rewritten", async (status) => {
          const e = await encounterAt(status);
          await run((c) => insertConfirmation(c, confirmationValues(a(), { sectionId: "open", encounterId: e.encounterId })));
          await run((c) =>
            c.query("UPDATE encounter_draft_confirmation SET resolution='deselected' WHERE encounter_id=$1 AND section_id='open'", [e.encounterId]),
          );
        });

        it("refuses a siting pair that is not the encounter's own", async () => {
          for (const [index, label] of [[1, "provider_entity_id"], [2, "location_id"]] as const) {
            const values = confirmationValues(a(), { sectionId: `siting_${label}` });
            values[index] = null;
            const refused = await sqlFailure(run((c) => insertConfirmation(c, values)));
            expect(refused.code, label).toBe(TENANCY);
          }
        });
      });
    });
  },
);
