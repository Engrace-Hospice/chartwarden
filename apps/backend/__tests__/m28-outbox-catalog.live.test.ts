/**
 * M28's outbox-catalog gap — LIVE Postgres, real catalog-validating publisher.
 *
 * M28 had NO catalog contribution at all (alongside M2 and M36; #205): no `M28_OUTBOX_EVENTS` and no
 * entry in the boot dispatcher's `buildBootOutboxCatalog([...])`. `packages/fhir/src/lifecycle/*.ts`
 * (M28-T07) has built and typed every one of these event envelopes since T07
 * (`packages/fhir/src/outbox-events.ts`'s `M28OutboxEvent`), and `routes/store-drizzle.ts` had no outbox
 * dependency at all — so nothing could ever publish one. The fail-closed dispatcher refuses any publish
 * whose event name is not in the boot catalog, so this was not "publishes but nobody's listening"; a
 * publish attempt against the real production catalog would have thrown `unknown_event` and rolled back
 * the caller's write.
 *
 * THIS SUITE IS LIVE BY NECESSITY, the M6/M29 precedent: it proves the catalog entry's payload SCHEMA
 * actually matches what the store publishes (`Value.Check`, refuse-on-failure — a schema mismatch throws
 * and rolls back the whole mutation, which an in-memory or no-op-outboxed suite cannot exhibit) and that
 * the composition-root wiring (`m28OutboxPublisher` threaded into `createDrizzleFhirGatewayStore`) is
 * real, not just typed.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m28:outbox-catalog:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDrizzleFhirGatewayStore } from "../src/modules/28-fhir/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { validatingM28Outbox } from "./_m28-outbox";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f2280001";
const ADMIN_MEMBERSHIP = "33333333-3333-4333-8333-3333f2280003";
const COMPLIANCE_MEMBERSHIP = "44444444-4444-4444-8444-4444f2280004";

describe.skipIf(!DB_URL)("M28 outbox catalog — LIVE Postgres, real publisher", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleFhirGatewayStore>;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  // Read via the SUPERUSER connection, not the pooled `wardenx_app` handle: `outbox_event_org`'s RLS
  // policy casts `current_setting('app.org_id', true)::uuid` with no NULLIF guard (the exact
  // device_attestation shape migration 0246 fixed, unaddressed here since the table's own doc says only
  // the privileged dispatcher ever reads it directly) — a bare read on a connection a prior
  // `withOrgContext` call has touched throws `22P02` on the empty-string revert. Reading as admin sidesteps
  // that entirely and is what this suite is actually asserting: what the store WROTE, not who may read it.
  async function eventsFor(
    aggregateId: string,
  ): Promise<{ eventType: string; payload: unknown; organizationId: string | null }[]> {
    const { rows } = await admin.query(
      `SELECT event_type, payload, organization_id FROM outbox_event WHERE aggregate_id = $1`,
      [aggregateId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      eventType: r.event_type as string,
      payload: r.payload,
      organizationId: r.organization_id as string | null,
    }));
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
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f228-a','Alpha Hospice LLC','Alpha Hospice','active')`,
      [ORG_A],
    );
    // The M4 write-audit trigger's `actor_user_id` FK requires a real `user` row for whatever the store's
    // `withOrgContext` call stamps into `app.user_id` — the store's own "M18 idiom" comment notwithstanding,
    // the FK is against `user.id`, not `membership.id`.
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES
         ($1,'f228-admin@example.test','F228 Admin'),
         ($2,'f228-compliance@example.test','F228 Compliance')`,
      [ADMIN_MEMBERSHIP, COMPLIANCE_MEMBERSHIP],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDrizzleFhirGatewayStore(handle.db, { outbox: validatingM28Outbox() });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("createClient publishes m28.fhir.client.pending_approval against the real catalog", async () => {
    const { client } = await store.createClient(ORG_A, {
      name: "Live Partner",
      type: "api_key",
      allowedScopes: ["system/Patient.read"],
      tier: "tier-2",
      rateLimitRps: 10,
      ipAllowlist: [],
      baaContractReference: "baa-live",
      proposedByMembershipId: ADMIN_MEMBERSHIP,
    });
    const events = await eventsFor(client.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "m28.fhir.client.pending_approval",
      organizationId: ORG_A,
      payload: {
        clientId: client.id,
        proposedByMembershipId: ADMIN_MEMBERSHIP,
        tier: "tier-2",
      },
    });
  });

  it("approveClient publishes m28.fhir.client.activated, and revokeClient cascades a cancellation onto its inflight job", async () => {
    const created = await store.createClient(ORG_A, {
      name: "Cascade Partner",
      type: "api_key",
      allowedScopes: ["system/Patient.read"],
      tier: "tier-2",
      rateLimitRps: 10,
      ipAllowlist: [],
      baaContractReference: "baa-live",
      proposedByMembershipId: ADMIN_MEMBERSHIP,
    });
    const clientId = created.client.id;

    await store.approveClient(ORG_A, clientId, COMPLIANCE_MEMBERSHIP, "dual approval");
    const activated = await eventsFor(clientId);
    expect(activated.map((e) => e.eventType)).toContain("m28.fhir.client.activated");

    const job = await store.createJob(ORG_A, {
      clientId,
      requestKind: "system",
      resourceTypes: ["Patient"],
      initiatedByMembershipId: ADMIN_MEMBERSHIP,
    });
    const jobEvents = await eventsFor(job.id);
    expect(jobEvents[0]).toMatchObject({
      eventType: "m28.fhir.bulk_export.accepted",
      payload: { jobId: job.id, clientId, requestKind: "system" },
    });

    // The W-FHIR-12 cascade: revoking the client cancels its one inflight job in the SAME transaction,
    // and the cascade path (cascadePortIn.cancelJob) publishes its own bulk_export.cancelled — proving
    // the outbox wiring reaches the cascade, not just the direct route methods.
    await store.revokeClient(ORG_A, clientId, ADMIN_MEMBERSHIP, "partner offboarded");
    const revoked = await eventsFor(clientId);
    expect(revoked.map((e) => e.eventType)).toContain("m28.fhir.client.revoked");
    const cancelled = await eventsFor(job.id);
    const cascadeCancel = cancelled.find((e) => e.eventType === "m28.fhir.bulk_export.cancelled");
    expect(cascadeCancel).toMatchObject({
      payload: { jobId: job.id, clientId, cancelledByMembershipId: null },
    });
  });

  it("acceptProposal and rejectProposal publish against the real catalog, keyed on the payload's own ownerModule", async () => {
    const created = await store.createClient(ORG_A, {
      name: "Inbound Partner",
      type: "api_key",
      allowedScopes: ["system/Patient.read"],
      tier: "tier-2",
      rateLimitRps: 10,
      ipAllowlist: [],
      baaContractReference: "baa-live",
      proposedByMembershipId: ADMIN_MEMBERSHIP,
    });
    const sourceClientId = created.client.id;

    const staged = await store.stageInbound(ORG_A, {
      sourceClientId,
      resourceType: "Patient",
      sourceFhirId: "external-123",
      payload: { resourceType: "Patient", id: "external-123" },
    });
    const proposedEvents = await eventsFor(staged.id);
    expect(proposedEvents[0]).toMatchObject({
      eventType: "m28.fhir.inbound.proposed",
      payload: {
        proposalId: staged.id,
        ownerModule: "m5",
        resourceType: "Patient",
        sourceClientId,
      },
    });

    const acceptedAggregateId = "55555555-5555-4555-8555-5555f2280005";
    const accepted = await store.acceptProposal(
      ORG_A,
      staged.id,
      ADMIN_MEMBERSHIP,
      acceptedAggregateId,
      "matched to existing chart",
    );
    expect(accepted.proposalStatus).toBe("accepted");
    const acceptedEvents = await eventsFor(staged.id);
    const acceptedEvent = acceptedEvents.find((e) => e.eventType === "m28.fhir.inbound.accepted");
    expect(acceptedEvent).toMatchObject({
      payload: {
        proposalId: staged.id,
        ownerModule: "m5",
        acceptedAggregateId,
        decidedByMembershipId: ADMIN_MEMBERSHIP,
      },
    });

    // A second proposal, rejected instead — the catalog's rejection payload requires the >=1-char
    // rationale the port already enforces at the store layer (the FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS
    // gate is a separate, pre-existing check; this proves the CATALOG'S schema accepts the real payload
    // shape the store sends, not merely that the store's own input validation ran).
    const staged2 = await store.stageInbound(ORG_A, {
      sourceClientId,
      resourceType: "Patient",
      sourceFhirId: "external-456",
      payload: { resourceType: "Patient", id: "external-456" },
    });
    await store.rejectProposal(
      ORG_A,
      staged2.id,
      ADMIN_MEMBERSHIP,
      "duplicate of an existing patient record already on the chart",
    );
    const rejectedEvents = await eventsFor(staged2.id);
    const rejectedEvent = rejectedEvents.find((e) => e.eventType === "m28.fhir.inbound.rejected");
    expect(rejectedEvent).toMatchObject({
      payload: { proposalId: staged2.id, decidedByMembershipId: ADMIN_MEMBERSHIP },
    });
  });

  it("a payload the catalog schema refuses rolls back the whole mutation (the no-op outbox cannot show this)", async () => {
    // suspendClient's `reason` is required non-empty by the catalog's payloadSchema. Passing an empty
    // string is accepted by TypeScript (the store's own signature has no runtime length check on it) but
    // is refused by the catalog's Value.Check — proving the real publisher's fail-closed validation is
    // actually wired, not just present in the type contract.
    const created = await store.createClient(ORG_A, {
      name: "Refusal Partner",
      type: "api_key",
      allowedScopes: ["system/Patient.read"],
      tier: "tier-2",
      rateLimitRps: 10,
      ipAllowlist: [],
      baaContractReference: "baa-live",
      proposedByMembershipId: ADMIN_MEMBERSHIP,
    });
    await store.approveClient(ORG_A, created.client.id, COMPLIANCE_MEMBERSHIP, "dual approval");
    await expect(
      store.suspendClient(ORG_A, created.client.id, ADMIN_MEMBERSHIP, ""),
    ).rejects.toThrow();
    // Rolled back: the client's status write and the outbox insert shared one transaction, so a schema
    // refusal on the SECOND statement undoes the FIRST too.
    const stillActive = await store.getClient(ORG_A, created.client.id);
    expect(stillActive?.status).toBe("active");
  });
});
