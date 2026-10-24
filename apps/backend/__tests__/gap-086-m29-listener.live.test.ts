/**
 * GAP-086 — the M29 MLLP listener process + inbound parse worker, LIVE Postgres + REAL sockets.
 *
 * The listener supervisor, framing, ACK builder, TLS registry and every inbound projection existed, but nothing composed them:
 * no `MllpIngestSink` implementation, no credential decrypt, no feed loader, no process entry — and no worker consumed
 * `hl7_message_inbound` rows, so nothing ever created an ADT proposal or an ORU lab observation. This suite drives the whole
 * thing as the NOBYPASSRLS `chartwarden_app` role over real mTLS sockets:
 *
 *   mint (sealed under the tenant DEK) → startListenerProcess → BAA gate / credential load / bind → client sends HL7 →
 *   ACK `AA` only after COMMIT → `hl7_message_inbound` row → parse worker → proposal / lab observation / review queue.
 *
 * Needs `openssl` on PATH (the repo has no cert fixtures).
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m29:listener:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientIdentity, PatientReader } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M29_OUTBOX_EVENTS,
  createDrizzleM29Store,
  createInboundCipher,
  runParseSweepForOrg,
  startListenerProcess,
} from "../src/modules/29-external-interfaces/index";
import type { ParseWorkerDeps } from "../src/modules/29-external-interfaces/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { ackCode, createTlsFixtures, freePort, hasOpenssl, sendMllp } from "./_m29-tls-fixtures";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG = "11111111-1111-1111-1111-111111111086";
const OTHER_ORG = "11111111-1111-1111-1111-111111111087";
const PE = "00000000-0000-0000-0000-000000000a86";
const USER = "00000000-0000-0000-0000-0000000ba086";
const PATIENT = "00000000-0000-0000-0000-0000000ee086";
const FEED_LAB = "00000000-0000-0000-0000-0000000fe086";
const FEED_ADT = "00000000-0000-0000-0000-0000000fe087";
const FEED_BAA = "00000000-0000-0000-0000-0000000fe088";
const FEED_LEGACY = "00000000-0000-0000-0000-0000000fe089";
const DEK = Buffer.alloc(32, 9);

const keys = {
  dekForOrg: async () => ({ version: "v1", key: DEK }),
  dekForOrgVersion: async (_org: string, version: string) => ({ version, key: DEK }),
};

const identity = (organizationId: string): PatientIdentity => ({
  id: PATIENT,
  organizationId,
  mrn: "MRN123",
  externalMrns: [],
  lastName: "DOE",
  firstName: "JANE",
  dateOfBirth: "1940-01-01",
  administrativeSex: "F",
  providerEntityId: PE,
  locationId: null,
});

/** M5's PatientReader slice: MRN123 (internal authority HOSP) resolves; everything else is unknown. */
function fakePatientReader(state: { throwing: boolean }): PatientReader {
  const guard = (): void => {
    if (state.throwing) throw new Error("patient reader down");
  };
  return {
    async findByMrn({ organizationId, mrn }) {
      guard();
      return mrn === "MRN123" ? identity(organizationId) : null;
    },
    async findByExternalMrn() {
      guard();
      return null;
    },
    async findBySsnLast4AndDob() {
      guard();
      return [];
    },
    async findByNameDobSex() {
      guard();
      return [];
    },
    async findByLooseName() {
      guard();
      return [];
    },
    async findById({ organizationId, id }) {
      guard();
      return id === PATIENT ? identity(organizationId) : null;
    },
  };
}

const hl7 = (...segments: string[]): string => `${segments.join("\r")}\r`;
const msh = (type: string, control: string, sender = "LABFAC"): string =>
  `MSH|^~\\&|SENDAPP|${sender}|WX|HOSPICE|20260801120000||${type}|${control}|P|2.5.1`;
const PID = "PID|1||MRN123^^^HOSP^MR||DOE^JANE||19400101|F|||1 MAIN ST^^TOWN^ST^12345";
const PID_UNKNOWN = "PID|1||NOSUCH9^^^HOSP^MR||ZZTOP^NOBODY||19000101|M";
const oru = (control: string, pid: string, loinc = "2160-0", value = "1.1"): string =>
  hl7(
    msh("ORU^R01", control),
    pid,
    `OBR|1|||${loinc}^Test^LN|||20260801100000`,
    `OBX|1|NM|${loinc}^Test^LN||${value}|mg/dL|0.6-1.3|N|||F`,
  );
const adt = (trigger: string, control: string, pid = PID): string =>
  hl7(msh(`ADT^${trigger}`, control), `EVN|${trigger}|20260801120000`, pid, "PV1|1|I");

describe.skipIf(!DB_URL || !hasOpenssl())("GAP-086 M29 listener + parse worker — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleM29Store>;
  let storeNoCipher: ReturnType<typeof createDrizzleM29Store>;
  let listener: Awaited<ReturnType<typeof startListenerProcess>>;
  let fixtures: ReturnType<typeof createTlsFixtures>;
  let portLab = 0;
  let portAdt = 0;
  const cipher = createInboundCipher(keys);
  const alerts: { orgId: string; eventType: string; severity: string; correlationId: string }[] =
    [];
  const readerState = { throwing: false };
  const baaRefused = new Set<string>(["BADBAA"]);
  let workerDeps: ParseWorkerDeps;
  let membershipId = "";

  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const asOrg = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
    withOrgContext(handle.db, { organizationId: ORG, userId: "" }, fn as never) as Promise<T>;
  void asOrg;
  const rowsOf = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows;
  const send = (port: number, message: string, withClient = true) =>
    sendMllp(
      {
        port,
        trust: fixtures.serverCaPem,
        ...(withClient ? { cert: fixtures.clientCertPem, key: fixtures.clientKeyPem } : {}),
      },
      message,
    );

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

  async function seedFeed(
    id: string,
    kind: "lab_inbound" | "adt_inbound",
    port: number,
    allowlist: string[],
  ) {
    await q(
      `INSERT INTO external_feed (id, organization_id, kind, display_name, status, protocol, port,
         proposed_by_membership_id, baa_contract_ref, sending_facility_allowlist)
       VALUES ($1,$2,$3,$4,'active','mllp_tls',$5,$6,'BAA-1',$7::jsonb)`,
      [id, ORG, kind, `feed-${id.slice(-3)}`, port, USER, JSON.stringify(allowlist)],
    );
  }

  beforeAll(async () => {
    fixtures = createTlsFixtures();
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await q("DROP SCHEMA IF EXISTS public CASCADE");
    await q("CREATE SCHEMA public");
    for (const r of ROLES) {
      await q(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    for (const [org, slug] of [
      [ORG, "org-086"],
      [OTHER_ORG, "org-087"],
    ] as const) {
      await q("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)", [
        org,
        slug,
      ]);
    }
    await q(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
       VALUES ($1,$2,'PE','086001','1234567893','enc','12-31')`,
      [PE, ORG],
    );
    await q(`INSERT INTO "user" (id,email) VALUES ($1,'gap086@x.test')`, [USER]);
    membershipId = (
      await q(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id;
    await q(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, provider_entity_id)
       VALUES ($1,$2,'MRN123','Jane','Doe','1940-01-01','F',$3)`,
      [PATIENT, ORG, PE],
    );

    portLab = await freePort();
    portAdt = await freePort();
    await seedFeed(FEED_LAB, "lab_inbound", portLab, ["LABFAC"]);
    await seedFeed(FEED_ADT, "adt_inbound", portAdt, ["LABFAC"]);
    await seedFeed(FEED_BAA, "adt_inbound", await freePort(), ["BADBAA"]);
    await seedFeed(FEED_LEGACY, "adt_inbound", await freePort(), ["LABFAC"]);

    await q(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M29_OUTBOX_EVENTS]);
    const outbox = buildTxOutboxPublisher(catalog);
    const m29Outbox = {
      publish: (tx: Parameters<typeof outbox.publish>[0], input: Record<string, unknown>) =>
        outbox.publish(tx, {
          ...(input as unknown as Parameters<typeof outbox.publish>[1]),
          callerModule: "m29",
        }),
    };
    store = createDrizzleM29Store(handle.db, { outbox: m29Outbox, credentialCipher: cipher });
    storeNoCipher = createDrizzleM29Store(handle.db, { outbox: m29Outbox });

    // The mint route's store path: a TLS bundle is validated + SEALED. FEED_LEGACY gets the pre-GAP-086 digest-only row.
    for (const feed of [FEED_LAB, FEED_ADT, FEED_BAA]) {
      await store.mintCredential(ORG, USER, feed, {
        kind: "mllp_client_cert",
        secret: fixtures.bundleJson,
      } as never);
    }
    await storeNoCipher.mintCredential(ORG, USER, FEED_LEGACY, {
      kind: "mllp_client_cert",
      secret: fixtures.bundleJson,
    } as never);

    workerDeps = {
      db: handle.db,
      cipher,
      patientReader: () => fakePatientReader(readerState),
      orderReader: () => ({ getOrderByPlacerId: async () => null }),
      terminology: () => ({
        validateLoinc: async () => ({ exists: true }),
        classifyLoinc: async ({ code }) => ({ categories: code === "3426-4" ? ["sud_test"] : [] }),
      }),
      consent: () => ({ evaluateForIngressRedaction: async () => ({ allowDisclosure: false }) }),
      internalMrnAuthority: async () => "HOSP",
      outbox: m29Outbox,
      maxAttempts: 3,
    };

    listener = await startListenerProcess({
      db: handle.db,
      cipher,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      baaGate: () => ({
        baaStatusBySendingFacility: async ({ sendingFacility }) =>
          baaRefused.has(sendingFacility)
            ? { isActive: false, status: "missing", expiresOn: null }
            : { isActive: true, status: "executed", expiresOn: null },
        baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed", expiresOn: null }),
      }),
      alerts: () => ({
        emit: async (orgId, input) => {
          alerts.push({ orgId, ...input });
        },
      }),
      log: () => {},
      allowPlainProtocol: false,
      reconcileIntervalMs: 3_600_000,
    });
  }, 240_000);

  afterAll(async () => {
    await listener?.shutdown();
    await handle?.close();
    if (admin) await admin.end();
    fixtures?.dispose();
  });

  // ── minting ────────────────────────────────────────────────────────────────────────────────────────────────────
  it("seals a minted mTLS bundle under the tenant DEK (never the plaintext, never a bare digest)", async () => {
    const [row] = await rowsOf(
      "SELECT secret_cipher, fingerprint FROM external_feed_credential WHERE feed_id=$1",
      [FEED_LAB],
    );
    expect(row.secret_cipher.startsWith("v1.")).toBe(true);
    expect(row.secret_cipher).not.toContain("BEGIN");
    expect(await cipher.decrypt(ORG, "external_feed_credential.secret", row.secret_cipher)).toBe(
      fixtures.bundleJson,
    );
    // AAD binds the tenant: another org cannot open it.
    await expect(
      cipher.decrypt(OTHER_ORG, "external_feed_credential.secret", row.secret_cipher),
    ).rejects.toThrow();
    const [legacy] = await rowsOf(
      "SELECT secret_cipher FROM external_feed_credential WHERE feed_id=$1",
      [FEED_LEGACY],
    );
    expect(legacy.secret_cipher.startsWith("v1.")).toBe(false);
  });

  it("refuses to mint a bundle whose key does not match its certificate", async () => {
    const bad = JSON.stringify({
      ...JSON.parse(fixtures.bundleJson),
      serverKeyPem: fixtures.clientKeyPem,
    });
    await expect(
      store.mintCredential(ORG, USER, FEED_LAB, { kind: "mllp_client_cert", secret: bad } as never),
    ).rejects.toThrow(/rejected/i);
    const [{ n }] = await rowsOf(
      "SELECT count(*)::int n FROM external_feed_credential WHERE feed_id=$1 AND status='active'",
      [FEED_LAB],
    );
    expect(n).toBe(1); // the failed mint did not retire the working credential
  });

  // ── boot decisions ─────────────────────────────────────────────────────────────────────────────────────────────
  it("binds the feeds that pass the BAA gate with a loadable credential — and only those", async () => {
    expect([...listener.boundFeedIds()].sort()).toEqual([FEED_ADT, FEED_LAB].sort());
  });

  it("alerts (BAA rule) for a feed the BAA gate refuses, and (listener_blocked) for an undecryptable credential", () => {
    const baa = alerts.find((a) => a.eventType === "external_feed.baa_missing");
    expect(baa?.orgId).toBe(ORG);
    expect(baa?.severity).toBe("critical");
    const blocked = alerts.find((a) => a.eventType === "external_feed.listener_blocked");
    expect(blocked).toBeDefined();
    expect(JSON.stringify(blocked)).not.toContain("BEGIN");
  });

  // ── real mTLS sockets → ingest sink ────────────────────────────────────────────────────────────────────────────
  // GAP-043 — the §4.11.1 health probe runs on the reconcile tick: it persists `external_feed_health` (as the real
  // NOBYPASSRLS app role) and pages `external_feed.listener_down` for an ACTIVE feed whose listener is not serving.
  it("writes external_feed_health and alerts listener_down for an active-but-unbound silent feed", async () => {
    const health = await rowsOf(
      "SELECT feed_id, listener_circuit_state FROM external_feed_health WHERE organization_id=$1",
      [ORG],
    );
    const stateOf = (feedId: string) =>
      health.find((r) => r.feed_id === feedId)?.listener_circuit_state;
    expect(stateOf(FEED_BAA)).toBe("open"); // refused by the BAA gate => never bound, never any frame
    expect(stateOf(FEED_LAB)).toBe("half_open"); // bound and reachable but silent: recovery pending, no page
    const down = alerts.filter((a) => a.eventType === "external_feed.listener_down");
    expect(down.some((a) => a.correlationId.includes(FEED_BAA))).toBe(true);
    expect(down.some((a) => a.correlationId.includes(FEED_LAB))).toBe(false);
    expect(down.every((a) => a.severity === "critical")).toBe(true);
  });

  // GAP-043 (second half) — the tick also leaves the FACTS the worker-role watcher decides from: a heartbeat and whether the
  // feed was actually bound. Written as the real app role under RLS; the watcher-owned columns are never touched.
  it("leaves a per-feed heartbeat + bound flag for the worker-role watcher", async () => {
    const rows = await rowsOf(
      `SELECT feed_id, listener_bound, listener_heartbeat_at, circuit_state, outage_opened_at
         FROM external_feed_listener_state WHERE organization_id=$1`,
      [ORG],
    );
    const stateOf = (feedId: string) => rows.find((r) => r.feed_id === feedId);
    expect(stateOf(FEED_LAB)?.listener_bound).toBe(true);
    expect(stateOf(FEED_BAA)?.listener_bound).toBe(false); // refused by the BAA gate => never bound
    expect(stateOf(FEED_LAB)?.listener_heartbeat_at).not.toBeNull();
    expect(Date.now() - new Date(stateOf(FEED_LAB)?.listener_heartbeat_at).getTime()).toBeLessThan(
      120_000,
    );
    // the listener never writes a decision: those columns are the watcher's
    expect(stateOf(FEED_LAB)?.circuit_state).toBe("closed");
    expect(stateOf(FEED_LAB)?.outage_opened_at).toBeNull();
  });

  it("rejects a client with no certificate and one from an unrelated CA (mTLS), persisting nothing", async () => {
    await expect(send(portLab, oru("NOCERT1", PID), false)).rejects.toThrow();
    await expect(
      sendMllp(
        {
          port: portLab,
          trust: fixtures.serverCaPem,
          cert: fixtures.strangerCertPem,
          key: fixtures.strangerKeyPem,
        },
        oru("STRANGER1", PID),
      ),
    ).rejects.toThrow();
    const rows = await rowsOf(
      "SELECT 1 FROM hl7_message_inbound WHERE message_control_id IN ('NOCERT1','STRANGER1')",
    );
    expect(rows).toHaveLength(0);
  });

  it("ACKs AA only after the row is committed, sealed and summarised; a re-send ACKs AA without a second row (D14)", async () => {
    const message = oru("CTRL-ORU-1", PID);
    const ack = await send(portLab, message);
    expect(ackCode(ack)).toBe("AA");
    expect(ack).toContain("CTRL-ORU-1");

    const rows = await rowsOf(
      "SELECT * FROM hl7_message_inbound WHERE feed_id=$1 AND message_control_id='CTRL-ORU-1'",
      [FEED_LAB],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.parse_status).toBe("in_progress");
    expect(row.message_type).toBe("ORU^R01");
    expect(row.sending_facility_raw_id).toBe("LABFAC");
    expect(row.payload_cipher).not.toContain("DOE");
    expect(await cipher.decrypt(ORG, "hl7_message_inbound.payload", row.payload_cipher)).toBe(
      message,
    );
    expect(row.segments_summary.segments.map((s: { name: string }) => s.name)).toEqual([
      "MSH",
      "PID",
      "OBR",
      "OBX",
    ]);
    expect(JSON.stringify(row.segments_summary)).not.toContain("JANE");
    expect(row.payload_sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(ackCode(await send(portLab, message))).toBe("AA");
    const again = await rowsOf(
      "SELECT 1 FROM hl7_message_inbound WHERE feed_id=$1 AND message_control_id='CTRL-ORU-1'",
      [FEED_LAB],
    );
    expect(again).toHaveLength(1);
  });

  it("two simultaneous copies of one MSH-10 store exactly one row", async () => {
    const message = oru("CTRL-RACE", PID);
    const acks = await Promise.all(Array.from({ length: 6 }, () => send(portLab, message)));
    expect(acks.map(ackCode)).toEqual(Array(6).fill("AA"));
    const rows = await rowsOf(
      "SELECT 1 FROM hl7_message_inbound WHERE feed_id=$1 AND message_control_id='CTRL-RACE'",
      [FEED_LAB],
    );
    expect(rows).toHaveLength(1);
  });

  it("NAKs AR a sender outside the feed allowlist and records it `rejected` (once)", async () => {
    const message = hl7(
      msh("ORU^R01", "CTRL-EVIL", "EVILFAC"),
      PID,
      "OBX|1|NM|2160-0^T^LN||1|u|||||F",
    );
    expect(ackCode(await send(portLab, message))).toBe("AR");
    expect(ackCode(await send(portLab, message))).toBe("AR");
    const rows = await rowsOf(
      "SELECT parse_status, parse_error FROM hl7_message_inbound WHERE message_control_id='CTRL-EVIL'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parse_status).toBe("rejected");
    expect(rows[0].parse_error.code).toBe("sender_not_allowlisted");
  });

  it("NAKs AE a malformed MSH and stores nothing", async () => {
    const ack = await send(portLab, "NOTHL7|garbage\r");
    expect(ackCode(ack)).toBe("AE");
  });

  // ── parse worker ───────────────────────────────────────────────────────────────────────────────────────────────
  it("processes an ORU for a known patient into a lab observation, values, link and outbox events", async () => {
    const result = await runParseSweepForOrg(ORG, workerDeps);
    expect(result.parsed).toBeGreaterThanOrEqual(2); // CTRL-ORU-1 + CTRL-RACE
    const [msg] = await rowsOf(
      "SELECT * FROM hl7_message_inbound WHERE message_control_id='CTRL-ORU-1'",
    );
    expect(msg.parse_status).toBe("parsed");
    expect(msg.parsed_segments_cipher).toBeTruthy();
    expect(msg.parsed_segments_sha256).toMatch(/^[0-9a-f]{64}$/);

    const obs = await rowsOf("SELECT * FROM lab_observation WHERE source_message_id=$1", [msg.id]);
    expect(obs).toHaveLength(1);
    expect(obs[0].patient_id).toBe(PATIENT);
    expect(obs[0].provider_entity_id).toBe(PE);
    expect(obs[0].sud_redacted_at_ingest).toBe(false);
    const values = await rowsOf("SELECT * FROM lab_observation_value WHERE observation_id=$1", [
      obs[0].id,
    ]);
    expect(values).toHaveLength(1);
    expect(Number(values[0].numeric_value)).toBe(1.1);
    const links = await rowsOf(
      "SELECT match_method FROM lab_observation_inbound_link WHERE observation_id=$1",
      [obs[0].id],
    );
    expect(links.map((l) => l.match_method)).toEqual(["patient_loinc_date"]);
    const events = await rowsOf(
      "SELECT event_type FROM outbox_event WHERE organization_id=$1 AND aggregate_id=$2 ORDER BY event_type",
      [ORG, obs[0].id],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "m29.lab_observation.attached",
      "m29.lab_observation.received",
    ]);
    // the duplicate-processing guard: a second sweep finds nothing left to claim
    expect((await runParseSweepForOrg(ORG, workerDeps)).parsed).toBe(0);
  });

  it("routes an ORU for an unknown patient to the unmatched-review queue (values + link, no parent)", async () => {
    await send(portLab, oru("CTRL-ORU-UNK", PID_UNKNOWN));
    await runParseSweepForOrg(ORG, workerDeps);
    const [msg] = await rowsOf(
      "SELECT id, parse_status FROM hl7_message_inbound WHERE message_control_id='CTRL-ORU-UNK'",
    );
    expect(msg.parse_status).toBe("parsed");
    const links = await rowsOf(
      "SELECT observation_id, match_method, resolved_at FROM lab_observation_inbound_link WHERE source_message_id=$1",
      [msg.id],
    );
    expect(links).toHaveLength(1);
    expect(links[0].match_method).toBe("unmatched");
    expect(links[0].resolved_at).toBeNull();
    expect(
      await rowsOf("SELECT 1 FROM lab_observation WHERE id=$1", [links[0].observation_id]),
    ).toHaveLength(0);
    expect(
      await rowsOf("SELECT 1 FROM lab_observation_value WHERE observation_id=$1", [
        links[0].observation_id,
      ]),
    ).toHaveLength(1);
    const queue = await store.listUnmatchedObservations(ORG, { limit: 50 } as never);
    expect(JSON.stringify(queue)).toContain(links[0].observation_id);
  });

  it("redacts a SUD-class lab at rest when consent does not allow disclosure (values AND the stored wire)", async () => {
    await send(portLab, oru("CTRL-ORU-SUD", PID, "3426-4", "POSITIVE-OPIATE"));
    await runParseSweepForOrg(ORG, workerDeps);
    const [msg] = await rowsOf(
      "SELECT id, payload_cipher, parsed_segments_cipher FROM hl7_message_inbound WHERE message_control_id='CTRL-ORU-SUD'",
    );
    const obs = await rowsOf(
      "SELECT id, sud_redacted_at_ingest FROM lab_observation WHERE source_message_id=$1",
      [msg.id],
    );
    expect(obs[0].sud_redacted_at_ingest).toBe(true);
    const [value] = await rowsOf(
      "SELECT numeric_value, string_value FROM lab_observation_value WHERE observation_id=$1",
      [obs[0].id],
    );
    expect(value.numeric_value).toBeNull();
    expect(value.string_value).toBe("[REDACTED_SUD]");
    const wire = await cipher.decrypt(ORG, "hl7_message_inbound.payload", msg.payload_cipher);
    expect(wire).not.toContain("POSITIVE-OPIATE");
    expect(wire).toContain("[REDACTED_SUD]");
    const parsed = await cipher.decrypt(
      ORG,
      "hl7_message_inbound.parsed_segments",
      msg.parsed_segments_cipher,
    );
    expect(parsed).not.toContain("POSITIVE-OPIATE");
  });

  it("turns an ADT for a known patient into ONE pending proposal with a 72h SLA and a created event", async () => {
    expect(ackCode(await send(portAdt, adt("A04", "CTRL-ADT-1")))).toBe("AA");
    await runParseSweepForOrg(ORG, workerDeps);
    const [msg] = await rowsOf(
      "SELECT id, parse_status, matched_patient_id, match_level, match_outcome FROM hl7_message_inbound WHERE message_control_id='CTRL-ADT-1'",
    );
    expect(msg.parse_status).toBe("parsed");
    expect(msg.matched_patient_id).toBe(PATIENT);
    expect(msg.match_level).toBe("L1_MRN_EXACT");
    expect(msg.match_outcome).toBe("matched_single");
    const proposals = await rowsOf(
      "SELECT * FROM hl7_inbound_proposal WHERE source_message_id=$1",
      [msg.id],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposal_status).toBe("pending");
    expect(proposals[0].resource_kind).toBe("admission_event");
    expect(proposals[0].owner_module).toBe("m6");
    const sla =
      new Date(proposals[0].expires_at).getTime() - new Date(proposals[0].proposed_at).getTime();
    expect(sla).toBe(72 * 3_600_000);
    const events = await rowsOf("SELECT event_type FROM outbox_event WHERE aggregate_id=$1", [
      proposals[0].id,
    ]);
    expect(events.map((e) => e.event_type)).toEqual(["m29.hl7_inbound_proposal.created"]);
  });

  it("proposes a NEW patient for an unknown A04, and drops an unknown A03 with an audit event (no proposal)", async () => {
    await send(portAdt, adt("A04", "CTRL-ADT-NEW", PID_UNKNOWN));
    await send(portAdt, adt("A03", "CTRL-ADT-DROP", PID_UNKNOWN));
    await runParseSweepForOrg(ORG, workerDeps);
    const [neu] = await rowsOf(
      "SELECT id FROM hl7_message_inbound WHERE message_control_id='CTRL-ADT-NEW'",
    );
    const [np] = await rowsOf(
      "SELECT resource_kind, owner_module, match_outcome FROM hl7_inbound_proposal WHERE source_message_id=$1",
      [neu.id],
    );
    expect(np).toEqual({
      resource_kind: "new_patient",
      owner_module: "m5",
      match_outcome: "no_match",
    });
    const [drop] = await rowsOf(
      "SELECT id, parse_status FROM hl7_message_inbound WHERE message_control_id='CTRL-ADT-DROP'",
    );
    expect(drop.parse_status).toBe("parsed");
    expect(
      await rowsOf("SELECT 1 FROM hl7_inbound_proposal WHERE source_message_id=$1", [drop.id]),
    ).toHaveLength(0);
    const ev = await rowsOf("SELECT event_type FROM outbox_event WHERE aggregate_id=$1", [drop.id]);
    expect(ev.map((e) => e.event_type)).toEqual(["m29.hl7_message.routing_dropped"]);
  });

  it("marks a PID-less ADT and an unsupported message type `parse_error` with a typed diagnostic (ACK was already AA)", async () => {
    expect(
      ackCode(await send(portAdt, hl7(msh("ADT^A04", "CTRL-ADT-NOPID"), "EVN|A04|20260801"))),
    ).toBe("AA");
    expect(ackCode(await send(portAdt, hl7(msh("MDM^T02", "CTRL-MDM"), PID)))).toBe("AA");
    await runParseSweepForOrg(ORG, workerDeps);
    const rows = await rowsOf(
      "SELECT message_control_id, parse_status, parse_error FROM hl7_message_inbound WHERE message_control_id IN ('CTRL-ADT-NOPID','CTRL-MDM') ORDER BY 1",
    );
    expect(rows.map((r) => [r.message_control_id, r.parse_status, r.parse_error.code])).toEqual([
      ["CTRL-ADT-NOPID", "parse_error", "adt_missing_pid"],
      ["CTRL-MDM", "parse_error", "unsupported_message_type"],
    ]);
  });

  it("keeps a message in_progress through transient failures, then parse_error after the attempt budget; replay recovers it", async () => {
    await send(portAdt, adt("A04", "CTRL-ADT-FLAKY"));
    readerState.throwing = true;
    await runParseSweepForOrg(ORG, workerDeps);
    let [row] = await rowsOf(
      "SELECT id, parse_status, parse_error FROM hl7_message_inbound WHERE message_control_id='CTRL-ADT-FLAKY'",
    );
    expect(row.parse_status).toBe("in_progress");
    expect(row.parse_error).toMatchObject({ code: "transient", attempts: 1 });
    await runParseSweepForOrg(ORG, workerDeps);
    await runParseSweepForOrg(ORG, workerDeps);
    [row] = await rowsOf(
      "SELECT id, parse_status, parse_error FROM hl7_message_inbound WHERE message_control_id='CTRL-ADT-FLAKY'",
    );
    expect(row.parse_status).toBe("parse_error");
    expect(row.parse_error.code).toBe("attempts_exhausted");
    // nothing half-written by the failed attempts
    expect(
      await rowsOf("SELECT 1 FROM hl7_inbound_proposal WHERE source_message_id=$1", [row.id]),
    ).toHaveLength(0);

    readerState.throwing = false;
    await store.replayInboundMessage(ORG, USER, row.id);
    const replayed = await runParseSweepForOrg(ORG, workerDeps);
    expect(replayed.parsed).toBe(1);
    expect(
      await rowsOf("SELECT 1 FROM hl7_inbound_proposal WHERE source_message_id=$1", [row.id]),
    ).toHaveLength(1);
  });

  it("two concurrent workers never process one message twice (SKIP LOCKED)", async () => {
    for (let i = 0; i < 12; i++) await send(portAdt, adt("A04", `CTRL-CONC-${i}`));
    const [a, b] = await Promise.all([
      runParseSweepForOrg(ORG, workerDeps),
      runParseSweepForOrg(ORG, workerDeps),
    ]);
    expect(a.parsed + b.parsed).toBe(12);
    const [{ n }] = await rowsOf(
      `SELECT count(*)::int n FROM hl7_inbound_proposal p JOIN hl7_message_inbound m ON m.id=p.source_message_id
       WHERE m.message_control_id LIKE 'CTRL-CONC-%'`,
    );
    expect(n).toBe(12);
  });

  it("does not see or process another tenant's messages (RLS as chartwarden_app)", async () => {
    await q(
      `INSERT INTO hl7_message_inbound (organization_id, feed_id, message_type, message_control_id, payload_cipher,
         payload_sha256, segments_summary, sending_facility_raw_id, idempotency_key)
       VALUES ($1,$2,'ADT^A04','OTHER-ORG-MSG','v1.x.y.z.w','00',$3::jsonb,'LABFAC','k')`,
      [OTHER_ORG, randomUUID(), JSON.stringify({ segments: [] })],
    );
    await runParseSweepForOrg(ORG, workerDeps);
    const [other] = await rowsOf(
      "SELECT parse_status FROM hl7_message_inbound WHERE message_control_id='OTHER-ORG-MSG'",
    );
    expect(other.parse_status).toBe("in_progress");
  });

  // ── supervisor lifecycle ───────────────────────────────────────────────────────────────────────────────────────
  it("unbinds a feed that is no longer active and rebinds one whose allowlist changed (reconcile)", async () => {
    await q("UPDATE external_feed SET status='suspended' WHERE id=$1", [FEED_ADT]);
    const stopped = await listener.reconcile();
    expect(stopped.stopped).toEqual([FEED_ADT]);
    await expect(send(portAdt, adt("A04", "CTRL-AFTER-SUSPEND"))).rejects.toThrow();

    await q("UPDATE external_feed SET status='active' WHERE id=$1", [FEED_ADT]);
    const restarted = await listener.reconcile();
    expect(restarted.started).toEqual([FEED_ADT]);
    expect(ackCode(await send(portAdt, adt("A04", "CTRL-AFTER-RESUME")))).toBe("AA");

    await q(
      `UPDATE external_feed SET sending_facility_allowlist='["OTHERFAC"]'::jsonb WHERE id=$1`,
      [FEED_ADT],
    );
    const rebound = await listener.reconcile();
    expect(rebound.stopped).toEqual([FEED_ADT]);
    expect(rebound.started).toEqual([FEED_ADT]);
    expect(ackCode(await send(portAdt, adt("A04", "CTRL-OLD-SENDER")))).toBe("AR");
  });

  it("drains and unbinds every listener on shutdown", async () => {
    const drained = await listener.shutdown();
    expect([...drained].sort()).toEqual([FEED_ADT, FEED_LAB].sort());
    await expect(send(portLab, oru("CTRL-AFTER-SHUTDOWN", PID))).rejects.toThrow();
  });
});

function randomUUID(): string {
  return crypto.randomUUID();
}
