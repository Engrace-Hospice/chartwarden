/**
 * GAP-158 / GAP-159 - the portal invitation -> caregiver link end to end, LIVE Postgres, as the RLS-enforced
 * `chartwarden_app` role with the REAL catalog-validating outbox publisher.
 *
 * Proves: issuing an invitation for a roster caregiver emits `m31.portal_account.invited` in the issue transaction;
 * accepting it activates the account, inserts the grant, emits `activated` + `portal_access_grant.granted`, and
 * stamps `caregiver.user_id` in the SAME transaction; a caregiver already linked to a DIFFERENT login refuses the
 * accept and rolls everything back (the token stays unconsumed, no grant, no events). Gated on a live DB:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:gap-158-invitation:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { linkCaregiverToUserInTx } from "../src/modules/05-patient/caregiver-user-link";
import { createM31EventEmitter } from "../src/modules/31-portal/events";
import { M31_OUTBOX_EVENTS } from "../src/modules/31-portal/events-by-m31";
import { createPortalPhiCipher } from "../src/modules/31-portal/portal-crypto";
import { createPortalInvitations } from "../src/modules/31-portal/provisioning/invitations";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-4111-8111-111111115811";

describe.skipIf(!DB_URL)("GAP-158 portal invitation -> caregiver link, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let patientId = "";
  let providerEntityId = "";
  let caregiverId = "";
  let consentRecordId = "";
  const users = new Map<string, string>();
  const delivered: string[] = [];

  const build = () => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M31_OUTBOX_EVENTS]));
    const key = randomBytes(32);
    return createPortalInvitations({
      db: app.db,
      cipher: createPortalPhiCipher({
        dekForOrg: async () => ({ version: "v1", key }),
        dekForOrgVersion: async (_org: string, version: string) => ({ version, key }),
      }),
      users: {
        ensureUser: async (_org, input) => {
          const existing = users.get(input.email);
          if (existing) return { userId: existing };
          const id = (
            await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [input.email])
          ).rows[0].id as string;
          users.set(input.email, id);
          return { userId: id };
        },
        markEmailVerified: async () => undefined,
      },
      consent: {
        governingConsent: async () => ({ consentRecordId, consentVersion: "1" }),
      },
      site: { siteForPatient: async () => ({ providerEntityId, locationId: null }) },
      delivery: {
        deliver: async (input) => {
          delivered.push(input.token);
          return { inviteUrl: `https://portal.test/accept?t=${input.token}` };
        },
      },
      caregiverLink: { linkInTx: linkCaregiverToUserInTx as never },
      events: createM31EventEmitter({
        db: app.db,
        publisher: {
          publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m31" } as never),
        },
      }),
    });
  };
  const emitted = async (name: string) =>
    (await admin.query("SELECT payload FROM outbox_event WHERE event_type = $1", [name])).rows;

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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'g158i','g158i','g158i')",
      [ORG],
    );
    providerEntityId = (
      await admin.query(
        "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE','123456','1234567893','x','1231','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id;
    patientId = (
      await admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'G158I','A','B','1990-01-01','M','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id;
    caregiverId = (
      await admin.query(
        "INSERT INTO caregiver (organization_id, first_name, last_name) VALUES ($1,'Cara','Giver') RETURNING id",
        [ORG],
      )
    ).rows[0].id;
    await admin.query(
      "INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, is_primary, involvement_from) VALUES ($1,$2,$3,'child',true,'2026-01-01')",
      [patientId, caregiverId, ORG],
    );
    consentRecordId = (await admin.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it("issue emits invited; accept activates, grants, emits, and links the caregiver in one transaction", async () => {
    const svc = build();
    await svc.issue({
      organizationId: ORG,
      actingUserId: "",
      patientId,
      relationship: "family_caregiver",
      caregiverId,
      inviteeDisplayName: "Cara Giver",
      inviteeEmail: "cara@g158i.test",
      proposedScopeSet: [],
    });
    expect(await emitted("m31.portal_account.invited")).toHaveLength(1);
    const token = delivered.at(-1) as string;

    const accepted = await svc.accept(token);
    expect(accepted).toMatchObject({ status: "active", replayed: false });
    expect(await emitted("m31.portal_account.activated")).toHaveLength(1);
    expect(await emitted("m31.portal_access_grant.granted")).toHaveLength(1);
    const { rows } = await admin.query("SELECT user_id FROM caregiver WHERE id = $1", [
      caregiverId,
    ]);
    expect(rows[0].user_id).toBe(users.get("cara@g158i.test"));
  });

  it("a caregiver already linked to a DIFFERENT login refuses the accept and rolls everything back", async () => {
    const other = (
      await admin.query(
        "INSERT INTO caregiver (organization_id, first_name, last_name) VALUES ($1,'Dee','Two') RETURNING id",
        [ORG],
      )
    ).rows[0].id as string;
    const squatter = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('squat@g158i.test') RETURNING id`)
    ).rows[0].id as string;
    await admin.query("UPDATE caregiver SET user_id = $1 WHERE id = $2", [squatter, other]);
    const svc = build();
    await svc.issue({
      organizationId: ORG,
      actingUserId: "",
      patientId,
      relationship: "dpoa_healthcare_agent",
      caregiverId: other,
      inviteeDisplayName: "Dee Two",
      inviteeEmail: "dee@g158i.test",
      proposedScopeSet: [],
    });
    const grantsBefore = (await emitted("m31.portal_access_grant.granted")).length;
    await expect(svc.accept(delivered.at(-1) as string)).rejects.toMatchObject({ statusCode: 409 });
    expect((await emitted("m31.portal_access_grant.granted")).length).toBe(grantsBefore);
    const inv = await admin.query(
      "SELECT accepted_at FROM portal_invitation WHERE caregiver_id = $1",
      [other],
    );
    expect(inv.rows[0].accepted_at).toBeNull();
    const cg = await admin.query("SELECT user_id FROM caregiver WHERE id = $1", [other]);
    expect(cg.rows[0].user_id).toBe(squatter);
  });
});
