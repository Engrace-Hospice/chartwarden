/**
 * F-111 (#249) — M20's §4.8 `m20.sos-sla-watchdog.cron` finally has a production caller.
 *
 * THE FINDING. `lifecycle/sos-escalator.ts`'s `decideSosWatchdog` — the 5-second stale-cancel-window
 * sweep, the tier-1/2/3 SLA-dwell escalation, the `emergency_terminus` re-page loop — has been complete
 * and unit-tested since M20-T03 with NO production caller anywhere. No file under `20-field-safety`
 * matched `*cron*`/`*worker*`/`*job*`; the composition root wired M20's outbox consumers but registered
 * no cron worker for this module at all. An SOS alert nobody acknowledged within its tier's SLA sat
 * there forever — silently, since this is the absence of a background process, not an error path
 * anything logs.
 *
 * WHY THIS SUITE IS LIVE. The whole point is proving the WORKER, not the decider (already unit-tested
 * with no database). `runSosSlaWatchdogCron` fans out over active orgs via `withOrgContext`, resolves
 * the pinned policy through the real `SafetyPolicyProvider`, and applies the decision with the same
 * §2.5 version-guarded UPDATE the route layer and `consumers/m36-delivery-failed.ts` use — none of that
 * is representable against an in-memory double, and the double-escalation lock in particular is a
 * statement about how Postgres serializes two concurrent `UPDATE ... WHERE version = ?` statements
 * against the SAME row, not about anything this suite could fake.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m20:sos-sla-watchdog:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type M20WorkerDeps,
  M20_OUTBOX_EVENTS,
  OpsPageError,
  buildDrizzleSafetySeamStore,
  buildM20WorkerDeps,
  createSafetyCiphers,
  createSafetyPolicyProvider,
  runSosSlaWatchdogCron,
  runTerminusExecutorForOrg,
} from "../src/modules/20-field-safety/index";
import {
  psapForAlert,
  terminusActionsForAlert,
  terminusReadiness,
} from "../src/modules/20-field-safety/routes/terminus.routes";
import { buildEmergencyServiceJurisdictionReader } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f111a001";
const ORG_B = "22222222-2222-4222-8222-2222f222b002";
const PSAP_ID = "33333333-3333-4333-8333-333333333333";

type Seed = { pe: string; location: string; member: string };

describe.skipIf(!DB_URL)("F-111 M20 SOS SLA watchdog cron — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let deps: M20WorkerDeps;
  let clock = new Date("2026-09-01T17:00:00.000Z");
  const seeded: Record<string, Seed> = {};

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  /** Seeds the §3.2 Phase-E policy floor for an org verbatim (`SAFETY_POLICY_FLOOR` — tier SLAs
   *  60s / 120s / 300s), done here with a plain INSERT so the test controls the version id directly
   *  (mirrors `ensurePolicyVersionForConsumer`'s own floor values). */
  async function seedPolicyVersion(org: string, effectiveFrom: Date): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO safety_policy (organization_id) VALUES ($1)
         ON CONFLICT (organization_id) DO UPDATE SET organization_id = EXCLUDED.organization_id
         RETURNING id`,
      [org],
    );
    const policyId = rows[0].id as string;
    const version = await admin.query(
      `INSERT INTO safety_policy_version
         (organization_id, safety_policy_id, effective_from,
          mid_visit_cadence_minutes, mid_visit_min_visit_duration_minutes,
          pre_visit_window_minutes, post_visit_window_minutes,
          gentle_reminder_minutes, supervisor_alert_minutes, escalation_minutes, sos_equivalent_minutes,
          sos_cancel_window_seconds, sos_tier_1_sla_seconds, sos_tier_2_sla_seconds, sos_tier_3_sla_seconds)
       VALUES ($1,$2,$3,60,60,15,5,5,15,30,60,5,60,120,300)
       RETURNING id`,
      [org, policyId, effectiveFrom],
    );
    return version.rows[0].id as string;
  }

  /** A real `safety_sos_alert` row, seeded directly (not through the press route) — the M20 consumer
   *  live test's own `seedSos` shape. `historyFromState` optionally back-dates a state-history row so
   *  `stateEnteredAt` is a controlled instant rather than falling back to `posted_at`. */
  async function seedSos(input: {
    org: string;
    lifecycleState: string;
    postedAt: Date;
    policyVersionId: string;
    history?: { fromState: string | null; enteredAt: Date };
  }): Promise<string> {
    const s = seeded[input.org] as Seed;
    const acked = ["acknowledged", "resolving", "resolved"].includes(input.lifecycleState);
    const { rows } = await admin.query(
      `INSERT INTO safety_sos_alert
         (organization_id, provider_entity_id, posted_by_membership_id, posted_at,
          posted_coordinates_cipher, posted_coordinates_accuracy_m, coordinates_consent_at,
          cancel_window_expired_at, lifecycle_state, safety_policy_version_id,
          acknowledged_at, acknowledged_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,10,$4,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.org,
        s.pe,
        s.member,
        input.postedAt,
        Buffer.from([0]),
        new Date(input.postedAt.getTime() + 5_000),
        input.lifecycleState,
        input.policyVersionId,
        acked ? input.postedAt : null,
        acked ? s.member : null,
      ],
    );
    const sosAlertId = rows[0].id as string;
    if (input.history) {
      await admin.query(
        `INSERT INTO safety_sos_alert_state_history
           (organization_id, provider_entity_id, sos_alert_id, from_state, to_state, transitioned_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.org,
          s.pe,
          sosAlertId,
          input.history.fromState,
          input.lifecycleState,
          input.history.enteredAt,
        ],
      );
    }
    return sosAlertId;
  }

  async function alertRow(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
      [sosAlertId],
    );
    return rows[0] as { lifecycle_state: string; version: number };
  }

  async function historyFor(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT from_state, to_state, transitioned_by_membership_id FROM safety_sos_alert_state_history WHERE sos_alert_id=$1 ORDER BY transitioned_at",
      [sosAlertId],
    );
    return rows as {
      from_state: string | null;
      to_state: string;
      transitioned_by_membership_id: string | null;
    }[];
  }

  async function outboxFor(sosAlertId: string) {
    const { rows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
      [sosAlertId],
    );
    return rows as { event_type: string; payload: Record<string, unknown> }[];
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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f111-a','A','A','active'),($2,'f111-b','B','B','active')",
      [ORG_A, ORG_B],
    );

    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f111-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-F111-${org.slice(0, 4)}`,
            `F111 ${org.slice(0, 4)}`,
            `NPI-F111-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, location, member };
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M20_OUTBOX_EVENTS]));
    deps = {
      ...buildM20WorkerDeps({
        connection: { host: "unused", port: 0 }, // never used — this suite calls runSosSlaWatchdogCron directly, not the BullMQ Worker.
        db: handle.db,
        outbox: {
          publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m20" }),
        },
        policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(handle.db)),
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      }),
      // Closes over the mutable `clock` variable so each test can advance time without rebuilding `deps`.
      now: () => clock,
    };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM outbox_event");
    await admin.query("DELETE FROM safety_sos_terminus_action");
    await admin.query("DELETE FROM safety_emergency_contact_consent");
    await admin.query(
      "DELETE FROM audit_event WHERE event_type LIKE 'safety_emergency_contact_consent.%'",
    );
    await admin.query("DELETE FROM safety_sos_alert_state_history");
    await admin.query("DELETE FROM safety_sos_alert");
    clock = new Date("2026-09-01T17:00:00.000Z");
  });

  it("the stale-cancel-window sweep expires a lost delayed-job alert into acknowledging", async () => {
    const postedAt = new Date("2026-09-01T16:55:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "cancel_window_open",
      postedAt,
      policyVersionId,
    });
    // cancel_window_expired_at = postedAt + 5s; the clock is already 5 minutes past that.
    await runSosSlaWatchdogCron({
      ...deps,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
    });

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "acknowledging",
      version: 2,
    });
    const history = await historyFor(sosAlertId);
    expect(history).toEqual([
      {
        from_state: "cancel_window_open",
        to_state: "acknowledging",
        transitioned_by_membership_id: null,
      },
    ]);
  });

  it("an alert overdue on its tier-1 SLA escalates to escalation_tier_1", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId,
    });
    // stateEnteredAt falls back to posted_at (no history row); tier-1 SLA is 60s and clock is 17:00 —
    // 120s past posting, well past the SLA.
    await runSosSlaWatchdogCron(deps);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_1",
      version: 2,
    });
    const history = await historyFor(sosAlertId);
    expect(history).toEqual([
      {
        from_state: "acknowledging",
        to_state: "escalation_tier_1",
        transitioned_by_membership_id: null,
      },
    ]);
    const outbox = await outboxFor(sosAlertId);
    expect(outbox.map((r) => r.event_type)).toEqual(["m20.safety.sos_alert_escalated"]);
    expect(outbox[0]?.payload).toMatchObject({
      fromTier: "acknowledging",
      toTier: "escalation_tier_1",
      reasonCode: "sla_breach",
    });
  });

  it("escalation_tier_2 overdue on its SLA escalates to escalation_tier_3", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    // `sosTierDwellSeconds`: the dwell for `escalation_tier_2` is `sosTier3SlaSeconds` (300s) — the SAME
    // knob that governs tier-3/terminus, per `sos-escalator.ts`'s own header note 1 (no tier-4 knob
    // exists). 360s before the clock, safely past it.
    const enteredTier2At = new Date("2026-09-01T16:54:00.000Z");
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "escalation_tier_2",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_1", enteredAt: enteredTier2At },
    });
    await runSosSlaWatchdogCron(deps);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_3",
      version: 2,
    });
  });

  // ── GAP-032 — the SOS emergency terminus: durable intent ledger + out-of-tx executor ─────────────────

  const TIER3_ENTERED = new Date("2026-09-01T16:50:00.000Z"); // 600s before the clock; tier-3 SLA 300s

  async function seedTier3(): Promise<string> {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    return seedSos({
      org: ORG_A,
      lifecycleState: "escalation_tier_3",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_2", enteredAt: TIER3_ENTERED },
    });
  }

  const singleOrg = () => ({
    ...deps,
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
  });

  async function actionsFor(sosAlertId: string) {
    const { rows } = await admin.query(
      `SELECT action_kind, loop_iteration, attempt_no, status, outcome_code, external_ref,
              jurisdiction_id, attempts
         FROM safety_sos_terminus_action WHERE sos_alert_id=$1
        ORDER BY loop_iteration, action_kind, attempt_no`,
      [sosAlertId],
    );
    return rows as Array<{
      action_kind: string;
      loop_iteration: number;
      attempt_no: number;
      status: string;
      outcome_code: string | null;
      external_ref: string | null;
      jurisdiction_id: string | null;
      attempts: number;
    }>;
  }
  const kindRows = async (id: string, kind: string) =>
    (await actionsFor(id)).filter((r) => r.action_kind === kind);

  const TEST_KEY = randomBytes(32);
  const ciphers = createSafetyCiphers({
    dekForOrg: async () => ({ version: "1", key: TEST_KEY }),
    dekForOrgVersion: async () => ({ version: "1", key: TEST_KEY }),
  });

  /** Grants the clinician's `emergency_contact_call` consent with a REALLY sealed contact. */
  async function seedContactConsent(phone: string, status: "granted" | "revoked" = "granted") {
    const s = seeded[ORG_A] as Seed;
    const sealed = await ciphers.cipher.encrypt({
      organizationId: ORG_A,
      plaintext: JSON.stringify({ name: "Pat Example", phone, relationship: "spouse" }),
    });
    await admin.query(
      `INSERT INTO safety_emergency_contact_consent
         (organization_id, clinician_membership_id, consent_purpose, consent_scope_detail, status,
          revoked_at, acknowledgment_text_snapshot, granted_at)
       VALUES ($1,$2,'emergency_contact_call',$3,$4,$5,'I consent','2026-08-01T00:00:00Z')`,
      [
        ORG_A,
        s.member,
        JSON.stringify({ contact: Buffer.from(sealed).toString("base64"), enc: "dek" }),
        status,
        status === "revoked" ? new Date("2026-09-01T10:00:00.000Z") : null,
      ],
    );
  }

  interface Fakes {
    pages: Array<{ sosAlertId: string; loopIteration: number; idempotencyKey?: string }>;
    calls: Array<{ toE164: string; idempotencyKey: string; agencyName: string }>;
  }

  function terminusBag(
    over: Partial<{
      pagerFails: boolean;
      pager: boolean;
      caller: "accept" | "deny" | "refuse_terminal" | "none";
      dialEnabled: boolean;
      jurisdiction: "resolved" | "none" | "unbound";
    }> = {},
  ): { bag: NonNullable<M20WorkerDeps["terminus"]>; fakes: Fakes } {
    const fakes: Fakes = { pages: [], calls: [] };
    const o = {
      pager: true,
      caller: "accept",
      dialEnabled: true,
      jurisdiction: "resolved",
      ...over,
    };
    const bag: NonNullable<M20WorkerDeps["terminus"]> = {
      ...(o.pager
        ? {
            pager: {
              async pageOps(input) {
                if (over.pagerFails) throw new OpsPageError("receiver_non_2xx", "down");
                fakes.pages.push({
                  sosAlertId: input.sosAlertId,
                  loopIteration: input.loopIteration,
                  ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                });
              },
            },
          }
        : {}),
      ...(o.caller === "none"
        ? {}
        : {
            caller: {
              async place(input) {
                if (o.caller === "deny")
                  return { kind: "refused", reason: "transport_not_configured", retryable: false };
                if (o.caller === "refuse_terminal")
                  return { kind: "refused", reason: "vendor_refused", retryable: false };
                fakes.calls.push({
                  toE164: input.toE164,
                  idempotencyKey: input.idempotencyKey,
                  agencyName: input.agencyName,
                });
                return { kind: "accepted", vendorCallId: `CA${fakes.calls.length}` };
              },
            },
          }),
      dialEnabled: o.dialEnabled,
      decipher: ciphers.decipher,
      store: buildDrizzleSafetySeamStore(handle.db),
      ...(o.jurisdiction === "unbound"
        ? {}
        : {
            jurisdictions: () => ({
              async forSosAlert() {
                return o.jurisdiction === "none"
                  ? { kind: "none" as const }
                  : {
                      kind: "resolved" as const,
                      jurisdictionId: PSAP_ID,
                      confidence: "org_default" as const,
                      stale: false,
                    };
              },
              async byId() {
                return null;
              },
            }),
          }),
      speakNames: async () => ({ agencyName: "Cedar Hospice", subjectDisplayName: "Dana Reyes" }),
    };
    return { bag, fakes };
  }

  it("GAP-032: a breached tier 3 ENTERS emergency_terminus immediately; the entry event is honest and the effects run from the ledger", async () => {
    await seedContactConsent("(415) 555-2671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag();
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "emergency_terminus",
      version: 2,
    });
    const history = await historyFor(sosAlertId);
    expect(history.map((h) => h.to_state)).toEqual(["escalation_tier_3", "emergency_terminus"]);

    // The entry event reports what had happened AT emit time: only intents existed.
    const entry = (await outboxFor(sosAlertId)).find(
      (r) => r.event_type === "m20.safety.sos_terminus_reached",
    );
    expect(entry?.payload).toMatchObject({
      loopIteration: 0,
      wardenxOpsPaged: false,
      emergencyContactCallInitiated: false,
      psapJurisdictionId: null,
    });

    // The ledger then carries the truth of every effect.
    expect(await actionsFor(sosAlertId)).toEqual([
      expect.objectContaining({
        action_kind: "dial_contact",
        status: "succeeded",
        outcome_code: "ok",
        external_ref: "CA1",
      }),
      expect.objectContaining({ action_kind: "page_ops", status: "succeeded", outcome_code: "ok" }),
      expect.objectContaining({
        action_kind: "resolve_psap",
        status: "succeeded",
        jurisdiction_id: PSAP_ID,
      }),
    ]);
    // Exactly one call, to the DECRYPTED + normalised number, naming the agency; exactly one page.
    expect(fakes.calls).toEqual([
      expect.objectContaining({ toE164: "+14155552671", agencyName: "Cedar Hospice" }),
    ]);
    expect(fakes.pages).toEqual([
      { sosAlertId, loopIteration: 0, idempotencyKey: `m20:sos:${sosAlertId}:page_ops:0:0` },
    ]);
    // The contact open left a read-audit trail (resource id = the consent uuid, so the uuid cast holds).
    const audit = await admin.query(
      "SELECT resource_id FROM audit_event WHERE event_type='safety_emergency_contact_consent.viewed'",
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("GAP-032: the re-page loop is idempotent per period - 20 ticks in one period, one event; the next period, one more and NO redial", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag();
    const d = { ...singleOrg(), terminus: bag };
    await runSosSlaWatchdogCron(d); // entry (iteration 0)
    for (let i = 1; i <= 20; i++) {
      clock = new Date(clock.getTime() + 10_000); // 200s of 15s-class ticks: still inside the first loop period
      await runSosSlaWatchdogCron(d);
    }
    let events = (await outboxFor(sosAlertId)).filter(
      (r) => r.event_type === "m20.safety.sos_terminus_reached",
    );
    expect(events).toHaveLength(1);
    expect(await kindRows(sosAlertId, "page_ops")).toHaveLength(1);

    clock = new Date("2026-09-01T17:06:00.000Z"); // > entry (17:00) + 300s loop
    await runSosSlaWatchdogCron(d);
    await runSosSlaWatchdogCron(d); // a second tick in the SAME new period creates nothing
    events = (await outboxFor(sosAlertId)).filter(
      (r) => r.event_type === "m20.safety.sos_terminus_reached",
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({
      loopIteration: 1,
      wardenxOpsPaged: true,
      emergencyContactCallInitiated: true,
      psapJurisdictionId: PSAP_ID,
    });
    expect((await kindRows(sosAlertId, "page_ops")).map((r) => r.loop_iteration)).toEqual([0, 1]);
    expect(fakes.pages).toHaveLength(2);
    // The accepted call is never repeated.
    expect(fakes.calls).toHaveLength(1);
    expect(await kindRows(sosAlertId, "dial_contact")).toHaveLength(1);
  });

  it("GAP-032: with NO pager bound the terminus is still entered and the page is recorded as skipped, not refused", async () => {
    const sosAlertId = await seedTier3();
    await runSosSlaWatchdogCron(singleOrg()); // no terminus bag at all
    expect(await alertRow(sosAlertId)).toMatchObject({ lifecycle_state: "emergency_terminus" });
    expect(await kindRows(sosAlertId, "page_ops")).toEqual([
      expect.objectContaining({ status: "skipped", outcome_code: "pager_unbound" }),
    ]);
    // No consent on file -> the dial is a recorded decision, not silence.
    expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
      expect.objectContaining({ status: "skipped", outcome_code: "consent_absent" }),
    ]);
  });

  it("GAP-032: a DOWN ops receiver no longer hides the terminus - the alert is entered and the page retries with backoff", async () => {
    const sosAlertId = await seedTier3();
    const { bag } = terminusBag({ pagerFails: true });
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });
    expect(await alertRow(sosAlertId)).toMatchObject({ lifecycle_state: "emergency_terminus" });
    const [page] = await kindRows(sosAlertId, "page_ops");
    expect(page).toMatchObject({
      status: "pending",
      outcome_code: "receiver_non_2xx",
      attempts: 1,
    });
    const due = await admin.query(
      "SELECT next_attempt_at > $2 AS later FROM safety_sos_terminus_action WHERE sos_alert_id=$1 AND action_kind='page_ops'",
      [sosAlertId, clock],
    );
    expect(due.rows[0].later).toBe(true);
    // The event still says nobody was paged.
    const entry = (await outboxFor(sosAlertId)).find(
      (r) => r.event_type === "m20.safety.sos_terminus_reached",
    );
    expect(entry?.payload).toMatchObject({ wardenxOpsPaged: false });
  });

  it("GAP-032: the contact auto-dial is gated OFF by the platform flag (dial_disabled, zero calls)", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag({ dialEnabled: false });
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });
    expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
      expect.objectContaining({ status: "skipped", outcome_code: "dial_disabled" }),
    ]);
    expect(fakes.calls).toHaveLength(0);
  });

  it("GAP-032: voice unbound, an invalid number and a terminal vendor refusal each leave a precise outcome", async () => {
    const cases: Array<{
      phone: string;
      caller: "deny" | "accept" | "refuse_terminal";
      status: string;
      outcome: string;
    }> = [
      { phone: "+14155552671", caller: "deny", status: "skipped", outcome: "voice_unbound" },
      { phone: "(555) 123", caller: "accept", status: "failed", outcome: "number_invalid" },
      { phone: "911", caller: "accept", status: "failed", outcome: "number_invalid" },
      {
        phone: "+14155552671",
        caller: "refuse_terminal",
        status: "failed",
        outcome: "vendor_refused",
      },
    ];
    for (const c of cases) {
      await admin.query("DELETE FROM safety_sos_terminus_action");
      await admin.query("DELETE FROM safety_emergency_contact_consent");
      await admin.query("DELETE FROM outbox_event");
      await admin.query("DELETE FROM safety_sos_alert_state_history");
      await admin.query("DELETE FROM safety_sos_alert");
      await seedContactConsent(c.phone);
      const sosAlertId = await seedTier3();
      const { bag, fakes } = terminusBag({ caller: c.caller });
      await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });
      expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
        expect.objectContaining({ status: c.status, outcome_code: c.outcome }),
      ]);
      expect(fakes.calls).toHaveLength(0);
    }
  });

  it("GAP-032: an acknowledgment between decision and effect wins - every pending intent settles superseded, zero calls or pages", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag();
    // Enter the terminus WITHOUT executing (no executor bag effects: run the pass with nothing bound, then
    // re-pend the rows as if the executor had not got to them yet).
    await runSosSlaWatchdogCron({
      ...singleOrg(),
      terminus: { ...bag, pager: undefined, caller: undefined, dialEnabled: false },
    });
    await admin.query(
      "UPDATE safety_sos_terminus_action SET status='pending', outcome_code=NULL, settled_at=NULL, attempts=0",
    );
    await admin.query(
      `UPDATE safety_sos_alert SET lifecycle_state='acknowledged', acknowledged_at=now(),
              acknowledged_by_membership_id=posted_by_membership_id WHERE id=$1`,
      [sosAlertId],
    );
    await runTerminusExecutorForOrg({ db: handle.db, terminus: bag, now: () => clock }, ORG_A);
    const rows = await actionsFor(sosAlertId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "superseded", outcome_code: "superseded_ack" });
    }
    expect(fakes.calls).toHaveLength(0);
    expect(fakes.pages).toHaveLength(0);
  });

  it("GAP-032: a consent revoked between entry and the dial is honoured (and 'unavailable' is never recorded as declined)", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag({ dialEnabled: false });
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: { ...bag, pager: undefined } });
    // enter with consent granted, dial_disabled settled it; re-pend and revoke
    await admin.query(
      "UPDATE safety_sos_terminus_action SET status='pending', outcome_code=NULL, settled_at=NULL, attempts=0 WHERE action_kind='dial_contact'",
    );
    await admin.query(
      "UPDATE safety_emergency_contact_consent SET status='revoked', revoked_at=now()",
    );
    const live = terminusBag().bag;
    await runTerminusExecutorForOrg({ db: handle.db, terminus: live, now: () => clock }, ORG_A);
    expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
      expect.objectContaining({ status: "skipped", outcome_code: "consent_expired_or_revoked" }),
    ]);
    expect(fakes.calls).toHaveLength(0);

    // A store that cannot answer retries (consent_unavailable) instead of recording a refusal.
    await admin.query(
      "UPDATE safety_sos_terminus_action SET status='pending', outcome_code=NULL, settled_at=NULL, attempts=0 WHERE action_kind='dial_contact'",
    );
    const flaky = terminusBag().bag;
    await runTerminusExecutorForOrg(
      {
        db: handle.db,
        terminus: {
          ...flaky,
          store: {
            ...flaky.store,
            emergencyContactConsent: async () => {
              throw new Error("db blip");
            },
          },
        },
        now: () => clock,
      },
      ORG_A,
    );
    expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
      expect.objectContaining({ status: "pending", outcome_code: "consent_unavailable" }),
    ]);
  });

  it("GAP-032: a crashed executor's dial row is NOT re-placed on lease recovery - it settles possible_duplicate", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const { bag, fakes } = terminusBag();
    await runSosSlaWatchdogCron({
      ...singleOrg(),
      terminus: { ...bag, caller: undefined, pager: undefined },
    });
    await admin.query(
      "UPDATE safety_sos_terminus_action SET status='attempting', lease_until=$1, outcome_code=NULL, settled_at=NULL WHERE action_kind='dial_contact'",
      [new Date(clock.getTime() - 120_000)],
    );
    await runTerminusExecutorForOrg({ db: handle.db, terminus: bag, now: () => clock }, ORG_A);
    expect(await kindRows(sosAlertId, "dial_contact")).toEqual([
      expect.objectContaining({ status: "failed", outcome_code: "possible_duplicate" }),
    ]);
    expect(fakes.calls).toHaveLength(0);
  });

  it("GAP-032: redial only after 10 minutes, as a new attempt, and a skipped/accepted dial is never repeated", async () => {
    await seedContactConsent("+14155552671");
    const sosAlertId = await seedTier3();
    const refusing = terminusBag({ caller: "refuse_terminal" });
    const d = { ...singleOrg(), terminus: refusing.bag };
    await runSosSlaWatchdogCron(d); // iteration 0: attempt 0 -> failed vendor_refused
    clock = new Date("2026-09-01T17:06:00.000Z"); // iteration 1, only ~6 min after attempt 0
    await runSosSlaWatchdogCron(d);
    expect(await kindRows(sosAlertId, "dial_contact")).toHaveLength(1);
    clock = new Date("2026-09-01T17:11:00.000Z"); // iteration 2, > 10 min after attempt 0 settled
    await runSosSlaWatchdogCron(d);
    expect((await kindRows(sosAlertId, "dial_contact")).map((r) => r.attempt_no)).toEqual([0, 1]);
  });

  it("GAP-032: a tenant cannot read another tenant's terminus ledger (RLS, as the real NOBYPASSRLS app role)", async () => {
    const sosAlertId = await seedTier3();
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: terminusBag().bag });
    const asA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) =>
      (tx as typeof handle.db).execute(
        sql`SELECT count(*)::int AS n FROM safety_sos_terminus_action`,
      ),
    );
    const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, async (tx) =>
      (tx as typeof handle.db).execute(
        sql`SELECT count(*)::int AS n FROM safety_sos_terminus_action`,
      ),
    );
    expect((asA.rows[0] as { n: number }).n).toBeGreaterThan(0);
    expect((asB.rows[0] as { n: number }).n).toBe(0);
    expect(sosAlertId).toBeTruthy();
  });

  it("GAP-032: end to end with the REAL M40 reader - the ledger resolves the tenant's PSAP and the /psap read returns its line, never the number in events", async () => {
    await admin.query(
      `INSERT INTO emergency_service_jurisdiction
         (organization_id, name, state, psap_name, psap_phone, is_org_default, verified_at)
       VALUES ($1,'Org default','OR','Cedar County PSAP','+15035550123',true,'2026-08-15T00:00:00Z')`,
      [ORG_A],
    );
    const sosAlertId = await seedTier3();
    const { bag } = terminusBag({ jurisdiction: "unbound" });
    const real = buildEmergencyServiceJurisdictionReader(handle.db, () => clock);
    await runSosSlaWatchdogCron({
      ...singleOrg(),
      terminus: { ...bag, jurisdictions: () => real },
    });
    expect(await kindRows(sosAlertId, "resolve_psap")).toEqual([
      expect.objectContaining({ status: "succeeded", outcome_code: "ok" }),
    ]);

    const routeDeps = {
      db: handle.db,
      jurisdictions: () => real,
      terminus: () => bag,
      now: () => clock,
    };
    const psap = await psapForAlert(routeDeps, ORG_A, sosAlertId);
    expect(psap.reason).toBe("resolved");
    expect(psap.emergencyLine).toMatch(/911/);
    expect(psap.psap).toMatchObject({
      psapName: "Cedar County PSAP",
      phone: "+15035550123",
      stale: false,
    });

    // The number never travels in the outbox / alert payloads - only the opaque jurisdiction id.
    const events = await outboxFor(sosAlertId);
    expect(JSON.stringify(events)).not.toContain("5550123");

    // Another tenant cannot read this alert's PSAP (the alert is invisible to it under RLS).
    await expect(psapForAlert(routeDeps, ORG_B, sosAlertId)).rejects.toThrow();

    const actions = await terminusActionsForAlert(routeDeps, ORG_A, sosAlertId);
    expect(actions.actions.map((a) => a.actionKind).sort()).toEqual([
      "dial_contact",
      "page_ops",
      "resolve_psap",
    ]);
    expect(JSON.stringify(actions)).not.toMatch(/\+1\d{10}/);
  });

  it("GAP-032: /psap is refused (409) for an alert that is not at the terminus, and 'none' is reported truthfully", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const early = await seedSos({
      org: ORG_A,
      lifecycleState: "escalation_tier_1",
      postedAt,
      policyVersionId,
    });
    const { bag } = terminusBag({ jurisdiction: "none" });
    const routeDeps = {
      db: handle.db,
      jurisdictions: () => {
        throw new Error("unbound");
      },
      terminus: () => bag,
      now: () => clock,
    };
    await expect(psapForAlert(routeDeps, ORG_A, early)).rejects.toThrow(
      /not at the emergency terminus/,
    );

    const atTerminus = await seedTier3();
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });
    const none = await psapForAlert(routeDeps, ORG_A, atTerminus);
    expect(none).toMatchObject({ psap: null, reason: "none" });
    expect(none.emergencyLine).toMatch(/911/);
  });

  it("GAP-032: readiness reports a missing pager as degraded and stuck terminus work", async () => {
    const sosAlertId = await seedTier3();
    await runSosSlaWatchdogCron(singleOrg()); // no pager bound
    const bare = await terminusReadiness(
      {
        db: handle.db,
        jurisdictions: () => {
          throw new Error("x");
        },
        terminus: () => undefined,
        now: () => new Date(clock.getTime() + 600_000),
      },
      ORG_A,
    );
    expect(bare).toMatchObject({ opsPagerBound: false, degraded: true });
    expect(bare.degradedReasons).toContain("ops_pager_unbound");

    const { bag } = terminusBag({ pagerFails: true });
    await admin.query("DELETE FROM safety_sos_terminus_action");
    await admin.query("DELETE FROM safety_sos_alert_state_history WHERE sos_alert_id=$1", [
      sosAlertId,
    ]);
    const downAlert = await seedTier3();
    await runSosSlaWatchdogCron({ ...singleOrg(), terminus: bag });
    const later = new Date(clock.getTime() + 600_000);
    const ready = await terminusReadiness(
      { db: handle.db, jurisdictions: () => ({}) as never, terminus: () => bag, now: () => later },
      ORG_A,
    );
    expect(ready.opsPagerBound).toBe(true);
    expect(ready.stuckActionCount).toBeGreaterThan(0);
    expect(ready.degradedReasons).toContain("unsettled_actions");
    expect(downAlert).toBeTruthy();
  });

  it("an alert already in emergency_terminus gets re-paged on its loop, one event per period", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const terminusEnteredAt = new Date("2026-09-01T16:50:00.000Z"); // 600s before the clock; loop = tier-3 SLA (300s)
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "emergency_terminus",
      postedAt,
      policyVersionId,
      history: { fromState: "escalation_tier_3", enteredAt: terminusEnteredAt },
    });
    await runSosSlaWatchdogCron(deps);
    await runSosSlaWatchdogCron(deps); // same period: nothing more

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "emergency_terminus",
      version: 1,
    });
    expect(await historyFor(sosAlertId)).toHaveLength(1);
    const outbox = await outboxFor(sosAlertId);
    expect(outbox.map((r) => r.event_type)).toEqual(["m20.safety.sos_terminus_reached"]);
    // 600s elapsed / 300s loop period = iteration 2.
    expect(outbox[0]?.payload).toMatchObject({
      loopIteration: 2,
      emergencyContactCallInitiated: false,
      psapJurisdictionId: null,
      wardenxOpsPaged: false,
    });
  });

  it("two concurrent ticks racing the same overdue alert escalate it exactly once", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId,
    });
    const singleOrgDeps = {
      ...deps,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
    };

    // Both ticks race the SAME row. Postgres holds the row lock across the first UPDATE until it commits,
    // so the second's `WHERE version = ?` re-evaluates against the already-advanced version and matches
    // zero rows — `processOneAlert` catches that as a lost race and returns, never throwing out of
    // `runSosSlaWatchdogCron` itself.
    await Promise.all([runSosSlaWatchdogCron(singleOrgDeps), runSosSlaWatchdogCron(singleOrgDeps)]);

    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "escalation_tier_1",
      version: 2, // NOT 3 — only one of the two ticks won.
    });
    expect(await historyFor(sosAlertId)).toHaveLength(1);
    expect(await outboxFor(sosAlertId)).toHaveLength(1);
  });

  it("a quiet acknowledged alert is left alone — the ladder's job is done", async () => {
    const postedAt = new Date("2026-09-01T16:00:00.000Z");
    const policyVersionId = await seedPolicyVersion(ORG_A, postedAt);
    const sosAlertId = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledged",
      postedAt,
      policyVersionId,
    });
    await runSosSlaWatchdogCron(deps);
    expect(await alertRow(sosAlertId)).toMatchObject({
      lifecycle_state: "acknowledged",
      version: 1,
    });
  });

  it("fans out over every active org and writes each org's alert under its own tenant scope", async () => {
    const postedAt = new Date("2026-09-01T16:58:00.000Z");
    const policyVersionIdA = await seedPolicyVersion(ORG_A, postedAt);
    const policyVersionIdB = await seedPolicyVersion(ORG_B, postedAt);
    const alertA = await seedSos({
      org: ORG_A,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId: policyVersionIdA,
    });
    const alertB = await seedSos({
      org: ORG_B,
      lifecycleState: "acknowledging",
      postedAt,
      policyVersionId: policyVersionIdB,
    });

    await runSosSlaWatchdogCron(deps); // deps' activeOrgs already lists both ORG_A and ORG_B.

    expect(await alertRow(alertA)).toMatchObject({ lifecycle_state: "escalation_tier_1" });
    expect(await alertRow(alertB)).toMatchObject({ lifecycle_state: "escalation_tier_1" });
  });
});
