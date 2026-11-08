import { randomUUID } from "node:crypto";
/**
 * GAP-037 — M12 transmission crons over real Postgres as the real NOBYPASSRLS `chartwarden_app` role, with the REAL
 * catalog-validating publisher. Covers: the sign-time enqueue, `transmit_newrx` (success / retryable / exhausted /
 * permanent / breaker-open / unsynced patient / incomplete order / concurrent claim), the queued-on-recovery
 * reclaim, the status-poll + timeout sweep, and the breaker-edge events. Only the DoseSpot vendor is a test double
 * (`FakeDoseSpotVendor`); every UPDATE asserted here matches by id and checks its row count.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12:crons-transmit:live
 */
import {
  DegradedError,
  type DoseSpotFetch,
  NotEnabledError,
  UnconfirmedOutcomeError,
  computeNewRxIdempotencyKey,
  computeRxBusinessKey,
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  createLayeredTenantConfigResolver,
  sigDirections,
} from "@chartwarden/dosespot";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { buildClinicAuditPort } from "../src/m12-dosespot-clinic-audit";
import { createDbDoseSpotBackend } from "../src/modules/12-dosespot/dosespot-route-service-db";
import {
  type ClinicSecretCipher,
  M12_OUTBOX_EVENTS,
  createDrizzleTenantConfigSource,
  enqueueTransmissionIfBound,
} from "../src/modules/12-dosespot/index";
import { inOrg } from "../src/modules/12-dosespot/jobs/cron-common";
import { staleQueuedOrdersQuery } from "../src/modules/12-dosespot/jobs/degradation-reports";
import {
  EPISODE_CLAIM_MS,
  type EpisodeStoreClient,
  createInMemoryEpisodeStore,
  createValkeyEpisodeTracker,
} from "../src/modules/12-dosespot/jobs/episode-store";
import {
  type M12CronDeps,
  buildM12CronRunners,
  createBreakerEdgeRecorder,
  createEpisodeTracker,
  runHeldAgeAlertForOrg,
  runQueuedAgeAlertForOrg,
  runRecoveryDrainForOrg,
  runTransmissionSweepForOrg,
  runTransmitNewRxForOrg,
} from "../src/modules/12-dosespot/jobs/index";
import { TRANSMIT_BATCH_SIZE } from "../src/modules/12-dosespot/jobs/transmit-newrx";
import { alertAfterCommit } from "../src/modules/12-dosespot/tenant-config/effects";
import { createTransmissionResolveService } from "../src/modules/12-dosespot/tenant-config/transmission-resolve";
import { createDrizzleAlertEmitter, wireAlertRuleSeed } from "../src/modules/36-messaging/index";
import { buildM36DosespotAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/dosespot-alerts";
import { FakeDoseSpotVendor } from "./_fake-dosespot-vendor";
import { GOOD_DATA, type M12Live, ORG_A, ORG_B, USER, setupM12Live } from "./_m12-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const T0 = new Date();
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const retryable = () =>
  new DegradedError(
    "dosespot",
    "transmitNewRx",
    true,
    "E-prescribe temporarily unavailable.",
    "c1",
  );
const permanent = () =>
  new DegradedError(
    "dosespot",
    "transmitNewRx",
    false,
    "DoseSpot rejected the request (HTTP 422).",
    "c2",
  );
const circuitOpen = () =>
  new DegradedError(
    "dosespot",
    "transmitNewRx",
    true,
    "E-prescribe service is temporarily unavailable (circuit open); the request will retry automatically.",
    "c3",
  );

describe.skipIf(!DB_URL)("GAP-037 M12 transmission crons — LIVE Postgres, real publisher", () => {
  let h: M12Live;
  beforeAll(async () => {
    h = await setupM12Live(DB_URL as string);
    await h.seedPrescriber(ORG_A);
    await h.seedPrescriber(ORG_B);
  }, 240_000);
  afterAll(async () => {
    await h?.close();
  });
  // Every test starts from an empty order book (the cron passes are tenant-wide, so leftovers would leak across).
  beforeEach(async () => {
    await h.admin.query("DELETE FROM medication_order_transmission");
    await h.admin.query("DELETE FROM dosespot_sync_queue");
    await h.admin.query("DELETE FROM medication_order");
  });

  const deps = (vendor: FakeDoseSpotVendor, now: Date = T0): M12CronDeps => ({
    db: h.handle.db,
    outbox: h.outbox,
    client: vendor,
    now: () => now,
  });
  const orderRow = async (id: string) =>
    (
      await h.q(
        "SELECT status, dosespot_send_state s, dosespot_prescription_id rx, version FROM medication_order WHERE id=$1",
        [id],
      )
    )[0];
  const txRow = async (id: string) =>
    (await h.q("SELECT * FROM medication_order_transmission WHERE id=$1", [id]))[0];
  const queued = async (org = ORG_A, over: Record<string, unknown> = {}) => {
    const patientId = await h.seedPatient(org, { synced: "501" });
    return {
      patientId,
      ...(await h.seedOrder({
        org,
        patientId,
        status: "queued_for_transmission",
        sendState: "queued",
        ...over,
      })),
    };
  };

  it("sign-time enqueue: a signed, transmittable order is queued with the D8 key; a double-sign reuses the row", async () => {
    const patientId = await h.seedPatient(ORG_A, { synced: "501" });
    const { orderId } = await h.seedOrder({
      org: ORG_A,
      patientId,
      status: "signed",
      sendState: "not_required",
      transmission: false,
    });
    const load = async () =>
      inOrg(h.handle.db, ORG_A, async (tx) => {
        const { schema } = await import("@chartwarden/db");
        const { eq } = await import("drizzle-orm");
        const [row] = await tx
          .select()
          .from(schema.medicationOrders)
          .where(eq(schema.medicationOrders.id, orderId));
        return row as NonNullable<typeof row>;
      });
    const queuedNow = await inOrg(h.handle.db, ORG_A, async (tx) =>
      enqueueTransmissionIfBound(tx, h.outbox, ORG_A, await load(), new Date()),
    );
    expect(queuedNow).toBe(true);
    expect((await orderRow(orderId)).status).toBe("queued_for_transmission");
    expect((await orderRow(orderId)).s).toBe("queued");
    expect(
      (
        await h.q(
          "SELECT count(*)::int n FROM medication_order_transmission WHERE medication_order_id=$1",
          [orderId],
        )
      )[0].n,
    ).toBe(1);
    expect(
      (await h.eventsOf("m12.medication_order.queued_for_transmission", ORG_A)).length,
    ).toBeGreaterThanOrEqual(1);
    // already queued -> not transmittable again, nothing else written
    const again = await inOrg(h.handle.db, ORG_A, async (tx) =>
      enqueueTransmissionIfBound(tx, h.outbox, ORG_A, await load(), new Date()),
    );
    expect(again).toBe(false);
  });

  it("sign-time enqueue refuses an order with no RxCUI (it stays on the local-activation path)", async () => {
    const patientId = await h.seedPatient(ORG_A, { synced: "501" });
    const { orderId } = await h.seedOrder({
      org: ORG_A,
      patientId,
      status: "signed",
      sendState: "not_required",
      rxnormRxcui: null,
      transmission: false,
    });
    const result = await inOrg(h.handle.db, ORG_A, async (tx) => {
      const { schema } = await import("@chartwarden/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await tx
        .select()
        .from(schema.medicationOrders)
        .where(eq(schema.medicationOrders.id, orderId));
      return enqueueTransmissionIfBound(
        tx,
        h.outbox,
        ORG_A,
        row as NonNullable<typeof row>,
        new Date(),
      );
    });
    expect(result).toBe(false);
    expect((await orderRow(orderId)).status).toBe("signed");
  });

  it("transmit success: order -> transmitted, prescription id recorded, event published, vendor got real facts", async () => {
    const { orderId, transmissionId, idempotencyKey } = await queued();
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => ({
        dosespotPrescriptionId: "rx-9001",
        transmittedAt: T0.toISOString(),
      }),
    });
    const res = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(res).toMatchObject({ claimed: 1, transmitted: 1 });
    const o = await orderRow(orderId);
    expect(o).toMatchObject({ status: "transmitted", s: "transmitted", rx: "rx-9001" });
    const t = await txRow(transmissionId as string);
    expect(t.transmission_succeeded_at).not.toBeNull();
    expect(t.dosespot_prescription_id).toBe("rx-9001");
    expect(t.dosespot_response_digest).toHaveLength(64);
    const ev = await h.eventsOf("m12.medication_order.transmitted", ORG_A);
    expect(ev.some((e) => (e.payload as any).orderId === orderId)).toBe(true);
    const call = vendor.calls.find((c) => c.method === "transmitNewRx");
    expect(call?.payload).toMatchObject({
      dosespotPatientId: "501",
      dosespotPrescriberId: "700",
      rxnormRxcui: "197361",
      quantity: GOOD_DATA.dispenseQuantity.value,
      daysSupply: GOOD_DATA.daysSupply,
    });
    expect(idempotencyKey).toBeTruthy();
    // a second tick finds nothing left to do (idempotent)
    expect((await runTransmitNewRxForOrg(deps(vendor), ORG_A)).claimed).toBe(0);
  });

  it("retryable failure re-queues with backoff, then exhausts after the 5th failure into transmission_failed", async () => {
    const { orderId, transmissionId } = await queued();
    let n = 0;
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => {
        n += 1;
        throw retryable();
      },
    });
    let clock = 0;
    const times = [0, 1, 3, 7, 15]; // minutes: each beyond the 1,2,4,8 backoff after the previous failure
    for (let i = 0; i < 5; i += 1) {
      clock = times[i] as number;
      const r = await runTransmitNewRxForOrg(deps(vendor, minutes(clock)), ORG_A);
      expect(r.claimed).toBe(1);
      if (i < 4) {
        expect(r.requeued).toBe(1);
        expect((await orderRow(orderId)).s).toBe("queued");
        // inside the backoff window the order is NOT re-claimed
        expect((await runTransmitNewRxForOrg(deps(vendor, minutes(clock)), ORG_A)).claimed).toBe(0);
      } else {
        expect(r.failed).toBe(1);
      }
    }
    expect(n).toBe(5);
    expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed", s: "failed" });
    const t = await txRow(transmissionId as string);
    expect(t.retry_count).toBe(5);
    expect(t.last_error_class).toBe("degraded_retryable");
    expect(t.transmission_failed_at).not.toBeNull();
    const ev = await h.eventsOf("m12.medication_order.transmission_failed", ORG_A);
    expect(
      ev.some((e) => (e.payload as any).orderId === orderId && (e.payload as any).retryCount === 5),
    ).toBe(true);
  });

  it("a permanent vendor rejection exhausts immediately", async () => {
    const { orderId } = await queued();
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => {
        throw permanent();
      },
    });
    const r = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(r.failed).toBe(1);
    expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed", s: "failed" });
  });

  it("a registration that stops being live mid-batch defers WITHOUT burning the retry budget (queued orders wait, ADR-0110 D6)", async () => {
    const { orderId, transmissionId } = await queued();
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => {
        throw new NotEnabledError(
          "dosespot",
          "transmitNewRx",
          "E-prescribe is not enabled for this organization; DoseSpot credentials are not configured.",
          "c4",
        );
      },
    });
    const r = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(r).toMatchObject({ claimed: 1, deferredByOutage: 1, failed: 0, requeued: 0 });
    expect(await orderRow(orderId)).toMatchObject({
      status: "queued_for_transmission",
      s: "queued",
    });
    const t = await txRow(transmissionId as string);
    expect(t.retry_count).toBe(0);
    expect(t.transmission_failed_at).toBeNull();
  });

  // ── the SAME deferral, produced by the real resolver and the real HTTP client (no hand-made error in a fake vendor) ────────────
  describe("a registration that is not live defers through the real layered resolver (ADR-0110 D6)", () => {
    const CLINIC_KEY = "clinic-key-plaintext-CRON-4d1b";
    const platformEnv: Record<string, string | undefined> = {
      DOSESPOT_SANDBOX_ENABLED: "true",
      DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "platform-sandbox-sub-key",
    };
    let cipherOpens: "ok" | "corrupt" = "ok";
    // The sealing itself is proved on the real key ring in m12-tenant-dosespot.live; here the cipher is a stub that either opens the
    // bundle or refuses like a bad GCM tag (the row's text is opaque to the source).
    const stubCipher: ClinicSecretCipher = {
      encrypt: async () => ({ cipher: "sealed", dekRef: "dek-1" }),
      decrypt: async () => {
        if (cipherOpens === "corrupt")
          throw new Error("Unsupported state or unable to authenticate data");
        return { clinicKey: CLINIC_KEY };
      },
    };
    let vendorRequests: string[] = [];
    /** What the SEND answers: the echo of our id (the default), or an ambiguous answer (a 2xx that does not echo it, or no answer). */
    let sendAnswer: "echo" | "empty_list" | "empty_body" | "timeout" = "echo";
    const fakeFetch: DoseSpotFetch = async (url) => {
      vendorRequests.push(url);
      if (url.endsWith("/connect/token"))
        return {
          status: 200,
          text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        };
      if (url.endsWith("/prescriptions/send")) {
        if (sendAnswer === "timeout")
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const body =
          sendAnswer === "echo"
            ? JSON.stringify({ Items: [{ Id: 9001 }] })
            : sendAnswer === "empty_list"
              ? "[]"
              : "";
        return { status: 200, text: async () => body };
      }
      return { status: 200, text: async () => JSON.stringify({ Id: 9001 }) };
    };
    /** A fresh resolver: the source caches an unsealed credential per row version, which would hide a later corrupt envelope. */
    const realResolver = () =>
      createLayeredTenantConfigResolver({
        source: createDrizzleTenantConfigSource({
          db: h.handle.db,
          cipher: stubCipher,
          platformEnv,
        }),
        fallback: createEnvTenantConfigResolver({}),
      });
    const realClient = (resolver = realResolver()) =>
      createHttpDoseSpotClient({ resolver, fetch: fakeFetch, sleep: async () => undefined });
    const realDeps = (): M12CronDeps => ({
      db: h.handle.db,
      outbox: h.outbox,
      client: realClient(),
      now: () => T0,
    });
    const registration = async (
      status: "registered" | "verified" | "active",
      environment = "sandbox",
    ) => {
      const m = h.memberOf[ORG_A];
      await h.admin.query("DELETE FROM dosespot_clinic_registration WHERE organization_id=$1", [
        ORG_A,
      ]);
      await h.admin.query(
        `INSERT INTO dosespot_clinic_registration (organization_id, environment, status, clinic_id, service_clinician_id,
           secret_cipher, secret_dek_ref, registered_at, registered_by_membership_id, verified_at, verified_by_membership_id,
           activated_at, activated_by_membership_id, set_by_membership_id)
         VALUES ($1,$2,$3,'clinic-cron','900','sealed','dek-1', now(), $4,
           CASE WHEN $3 IN ('verified','active') THEN now() END, CASE WHEN $3 IN ('verified','active') THEN $4::uuid END,
           CASE WHEN $3 = 'active' THEN now() END, CASE WHEN $3 = 'active' THEN $4::uuid END, $4)`,
        [ORG_A, environment, status, m],
      );
    };
    beforeEach(() => {
      cipherOpens = "ok";
      sendAnswer = "echo";
      vendorRequests = [];
      platformEnv.DOSESPOT_SANDBOX_ENABLED = "true";
    });
    afterAll(async () => {
      await h.admin.query("DELETE FROM dosespot_clinic_registration WHERE organization_id=$1", [
        ORG_A,
      ]);
    });

    const deferralCases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      [
        "a `registered` row (a rotation landed, not yet re-tested)",
        () => registration("registered"),
      ],
      ["a `verified` row (deactivated)", () => registration("verified")],
      [
        "an `active` sandbox row while the platform's sandbox flag is off",
        async () => {
          await registration("active");
          platformEnv.DOSESPOT_SANDBOX_ENABLED = "false";
        },
      ],
      [
        "an `active` row whose sealed key cannot be opened, met MID-BATCH with no preflight (the typed 503)",
        async () => {
          await registration("active");
          cipherOpens = "corrupt";
        },
      ],
    ];
    it.each(deferralCases)(
      "%s: the order returns to queued, retry_count stays 0, and nothing is sent to the vendor",
      async (_name, arrange) => {
        const { orderId, transmissionId } = await queued();
        await arrange();
        const r = await runTransmitNewRxForOrg(realDeps(), ORG_A);
        expect(r).toMatchObject({ claimed: 1, deferredByOutage: 1, failed: 0, requeued: 0 });
        expect(await orderRow(orderId)).toMatchObject({
          status: "queued_for_transmission",
          s: "queued",
        });
        const t = await txRow(transmissionId as string);
        expect(t.retry_count).toBe(0);
        expect(t.transmission_failed_at).toBeNull();
        expect(vendorRequests).toEqual([]);
      },
    );

    // ── a credential / resolver fault skips the pass: no claim, no UPDATE, no audit row, one alert per episode ───────────────────
    describe("a credential or resolver fault skips the org's pass instead of churning its orders", () => {
      let warnings: { fields: Record<string, string | number>; message: string }[] = [];
      /** The cron's deps WITH the preflight: the resolver the client reads, an episode tracker and a captured log. */
      const preflightDeps = () => {
        const resolver = realResolver();
        warnings = [];
        return {
          db: h.handle.db,
          outbox: h.outbox,
          client: realClient(resolver),
          config: resolver,
          episodes: createEpisodeTracker(),
          warn: (fields: Record<string, string | number>, message: string) =>
            warnings.push({ fields, message }),
          now: () => T0,
        } satisfies M12CronDeps;
      };
      const eventsNamed = async (type: string, breakerName: string) =>
        (await h.eventsOf(type, ORG_A)).filter((e) => e.payload.breakerName === breakerName);
      const auditCount = async () =>
        (
          await h.q("SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1", [ORG_A])
        )[0]?.n as number;
      const rowFacts = async (orderId: string) =>
        (
          await h.q(
            "SELECT version, dosespot_send_state, updated_at FROM medication_order WHERE id=$1",
            [orderId],
          )
        )[0];

      it("a corrupt sealed key: nothing is claimed, updated or audited; ONE alert across two ticks; the order stays queued; it clears once the key opens", async () => {
        const { orderId, transmissionId } = await queued();
        await registration("active");
        cipherOpens = "corrupt";
        const world = preflightDeps();
        const before = await rowFacts(orderId);
        const auditBefore = await auditCount();

        const first = await runTransmitNewRxForOrg(world, ORG_A);
        const second = await runTransmitNewRxForOrg(world, ORG_A);

        for (const pass of [first, second]) {
          expect(pass).toEqual({
            claimed: 0,
            transmitted: 0,
            requeued: 0,
            failed: 0,
            held: 0,
            skipped: 0,
            deferredByOutage: 0,
            skippedConfigFault: 1,
          });
        }
        // nothing was written for the order: same row, same version, same timestamp, no new audit row, transmission untouched
        expect(await rowFacts(orderId)).toEqual(before);
        expect(await auditCount()).toBe(auditBefore);
        expect(await orderRow(orderId)).toMatchObject({
          status: "queued_for_transmission",
          s: "queued",
        });
        const t = await txRow(transmissionId as string);
        expect(t.retry_count).toBe(0);
        expect(t.transmission_started_at).toBeNull();
        expect(t.call_token).toBeNull();
        expect(vendorRequests).toEqual([]);
        // ONE alert for the episode, through the real catalog-validating publisher, naming the class
        const breaker = `dosespot-config_unavailable:${ORG_A}`;
        const opened = await eventsNamed("m12.dosespot_degraded", breaker);
        expect(opened).toHaveLength(1);
        expect(opened[0]?.payload.lastErrorClass).toBe("config_unavailable");
        // each tick logged the org id and the error class and code, never the key or the cipher's message
        expect(warnings).toHaveLength(2);
        expect(warnings[0]?.fields).toMatchObject({
          organizationId: ORG_A,
          cause: "ChartWardenError",
          code: "DOSESPOT_CREDENTIAL_UNREADABLE",
        });
        const logged = JSON.stringify(warnings);
        expect(logged).not.toContain(CLINIC_KEY);
        expect(logged).not.toContain("Unsupported state");
        // the key opens again: the order goes out, and the episode ends with exactly one recovery event
        cipherOpens = "ok";
        expect(await runTransmitNewRxForOrg(world, ORG_A)).toMatchObject({
          claimed: 1,
          transmitted: 1,
          skippedConfigFault: 0,
        });
        expect(await runTransmitNewRxForOrg(world, ORG_A)).toMatchObject({ claimed: 0 });
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(1);
        expect(await eventsNamed("m12.dosespot_degraded", breaker)).toHaveLength(1);
      });

      it("the cron tick reports what it held back: an org skipped for a fault, and orders deferred mid-batch", async () => {
        const activeOrgs = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
        await registration("active");
        // (a) a corrupt key: the org is skipped whole, and the tick says so
        {
          await queued();
          cipherOpens = "corrupt";
          const world = preflightDeps();
          const runners = buildM12CronRunners({
            ...world,
            connection: {} as never,
            activeOrgs,
            config: world.config as never,
          });
          await runners.transmitNewRx();
          expect(warnings.map((w) => w.fields)).toContainEqual({
            cron: "M12_TRANSMIT_NEWRX",
            deferredByOutage: 0,
            skipped: 0,
            orgsSkippedByConfigFault: 1,
          });
        }
        // (b) an order the vendor boundary sends back to queued mid-batch is no longer discarded silently
        {
          await h.admin.query("DELETE FROM medication_order_transmission");
          await h.admin.query("DELETE FROM medication_order");
          await queued();
          cipherOpens = "ok";
          const world = preflightDeps();
          const vendor = new FakeDoseSpotVendor({
            transmit: async () => {
              throw new NotEnabledError("dosespot", "transmitNewRx", "not enabled", "c9");
            },
          });
          const runners = buildM12CronRunners({
            ...world,
            client: vendor,
            connection: {} as never,
            activeOrgs,
            config: world.config as never,
          });
          await runners.transmitNewRx();
          expect(warnings.map((w) => w.fields)).toContainEqual({
            cron: "M12_TRANSMIT_NEWRX",
            deferredByOutage: 1,
            skipped: 0,
            orgsSkippedByConfigFault: 0,
          });
        }
      });

      it("an order that waits in `queued` past the threshold raises ONE age alert (even for an org the cron skips as not live), and clears when it moves", async () => {
        const { orderId } = await queued();
        await registration("registered"); // not live: the transmit cron skips this org, so the age alert is all that speaks
        await h.admin.query(
          "UPDATE medication_order_transmission SET queued_at = now() - interval '2 hours' WHERE medication_order_id=$1",
          [orderId],
        );
        const world = preflightDeps();
        const runners = buildM12CronRunners({
          ...world,
          connection: {} as never,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
          config: world.config as never,
        });
        const before = await rowFacts(orderId);
        await runners.transmitNewRx();
        await runners.transmitNewRx();
        const breaker = `dosespot-queued_orders_stale:${ORG_A}`;
        const opened = await eventsNamed("m12.dosespot_degraded", breaker);
        expect(opened).toHaveLength(1);
        expect(opened[0]?.payload.lastErrorClass).toBe("queued_orders_stale");
        expect(await rowFacts(orderId)).toEqual(before); // the skipped org's order was not touched
        await h.admin.query(
          "UPDATE medication_order_transmission SET queued_at = now() WHERE medication_order_id=$1",
          [orderId],
        );
        await runners.transmitNewRx(); // clean tick 1: a recovery needs two in a row
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(0);
        await runners.transmitNewRx(); // clean tick 2
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(1);
        await runners.transmitNewRx();
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(1);
        expect(await eventsNamed("m12.dosespot_degraded", breaker)).toHaveLength(1);
      });
    });

    // Review of slice 4 (send-step ambiguity): a SEND DoseSpot accepted without echoing our id, or whose answer was lost, may have reached the
    // pharmacy. Through the REAL adapter it is HELD for a person (never re-sent), not re-queued for a retry that could dispense twice.
    for (const answer of ["empty_list", "empty_body", "timeout"] as const) {
      it(`an ambiguous SEND (${answer}) through the real adapter HOLDS the order: one send, no retry spent, never sent again`, async () => {
        await h.admin.query(
          "DELETE FROM outbox_event WHERE event_type IN ('m12.medication_order.transmission_unconfirmed','m12.medication_order.transmission_failed')",
        );
        const { orderId, transmissionId } = await queued();
        await registration("active");
        sendAnswer = answer;
        const sends = () => vendorRequests.filter((u) => u.endsWith("/prescriptions/send")).length;
        const r = await runTransmitNewRxForOrg(realDeps(), ORG_A);
        expect(r).toMatchObject({ claimed: 1, held: 1, requeued: 0, failed: 0, transmitted: 0 });
        expect(sends()).toBe(1);
        expect(await orderRow(orderId)).toMatchObject({
          status: "queued_for_transmission",
          s: "in_flight",
        });
        const t = await txRow(transmissionId as string);
        expect(t).toMatchObject({
          last_error_class: "unconfirmed_outcome",
          retry_count: 0,
          transmission_failed_at: null,
          dosespot_prescription_id: "9001", // the created id is kept: a person resolves against it
        });
        expect(await h.eventsOf("m12.medication_order.transmission_unconfirmed", ORG_A)).toHaveLength(1);
        expect(await h.eventsOf("m12.medication_order.transmission_failed", ORG_A)).toEqual([]);
        // neither the next tick nor the recovery drain long after the stale window sends it again
        sendAnswer = "echo";
        await runTransmitNewRxForOrg(realDeps(), ORG_A);
        await runRecoveryDrainForOrg({ ...realDeps(), now: () => minutes(60) }, ORG_A);
        expect(sends()).toBe(1);
        expect((await orderRow(orderId)).s).toBe("in_flight");
      });
    }

    it("control: the same order goes out once the registration is active and its key opens (so the deferrals above are the registration's doing)", async () => {
      const { orderId } = await queued();
      await registration("active");
      const r = await runTransmitNewRxForOrg(realDeps(), ORG_A);
      expect(r).toMatchObject({ claimed: 1, transmitted: 1, deferredByOutage: 0 });
      expect((await orderRow(orderId)).rx).toBe("9001");
      expect(vendorRequests.some((u) => u.includes("/prescriptions/send"))).toBe(true);
    });
  });

  it("an open circuit defers WITHOUT burning the retry budget (the outage must not exhaust orders)", async () => {
    const { orderId, transmissionId } = await queued();
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => {
        throw circuitOpen();
      },
    });
    const r = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(r).toMatchObject({ claimed: 1, deferredByOutage: 1, failed: 0, requeued: 0 });
    expect(await orderRow(orderId)).toMatchObject({
      status: "queued_for_transmission",
      s: "queued",
    });
    const t = await txRow(transmissionId as string);
    expect(t.retry_count).toBe(0);
    expect(t.transmission_failed_at).toBeNull();
    expect(t.transmission_started_at).toBeNull(); // the stamp the call left was cleared: the vendor never saw this attempt
    expect(t.call_token).toBeNull(); // and so was its ownership token
    // once the vendor is back the SAME order goes out on the next tick
    const ok = new FakeDoseSpotVendor({
      transmit: async () => ({
        dosespotPrescriptionId: "rx-after-outage",
        transmittedAt: T0.toISOString(),
      }),
    });
    expect((await runTransmitNewRxForOrg(deps(ok), ORG_A)).transmitted).toBe(1);
    expect((await orderRow(orderId)).rx).toBe("rx-after-outage");
  });

  it("a patient with no recorded DoseSpot id re-queues and requests a patient sync (vendor never called)", async () => {
    const patientId = await h.seedPatient(ORG_A); // NOT synced
    const { orderId } = await h.seedOrder({
      org: ORG_A,
      patientId,
      status: "queued_for_transmission",
      sendState: "queued",
    });
    const vendor = new FakeDoseSpotVendor();
    const r = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(r.requeued).toBe(1);
    expect(vendor.calls).toHaveLength(0);
    expect((await orderRow(orderId)).s).toBe("queued");
    expect(
      (
        await h.q("SELECT kind FROM dosespot_sync_queue WHERE patient_id=$1 AND status='pending'", [
          patientId,
        ])
      ).map((x) => x.kind),
    ).toEqual(["patient_sync"]);
  });

  it("an order that cannot be sent as written (no structured sig) fails permanently without calling the vendor", async () => {
    const { orderId } = await queued(ORG_A, { data: {} });
    const vendor = new FakeDoseSpotVendor();
    const r = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect(r.failed).toBe(1);
    expect(vendor.calls).toHaveLength(0);
    expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed" });
  });

  it("two concurrent ticks never claim the same order (FOR UPDATE SKIP LOCKED)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await queued()).orderId);
    const seen: string[] = [];
    const vendor = new FakeDoseSpotVendor({
      transmit: async (_o, p) => {
        seen.push(p.medicationOrderId);
        await new Promise((r) => setTimeout(r, 25));
        return {
          dosespotPrescriptionId: `rx-${p.medicationOrderId.slice(0, 8)}`,
          transmittedAt: T0.toISOString(),
        };
      },
    });
    const [a, b] = await Promise.all([
      runTransmitNewRxForOrg(deps(vendor), ORG_A),
      runTransmitNewRxForOrg(deps(vendor), ORG_A),
    ]);
    expect(a.transmitted + b.transmitted).toBe(6);
    expect(new Set(seen).size).toBe(seen.length); // no order sent twice
    for (const id of ids) expect((await orderRow(id)).status).toBe("transmitted");
  });

  it("tenant isolation: org A's pass never touches org B's orders", async () => {
    const b = await queued(ORG_B);
    const vendor = new FakeDoseSpotVendor({
      transmit: async () => ({
        dosespotPrescriptionId: "rx-a-only",
        transmittedAt: T0.toISOString(),
      }),
    });
    await runTransmitNewRxForOrg(deps(vendor), ORG_A);
    expect((await orderRow(b.orderId)).status).toBe("queued_for_transmission");
    expect(vendor.calls.every((c) => c.orgId === ORG_A)).toBe(true);
    await runTransmitNewRxForOrg(deps(vendor), ORG_B);
    expect((await orderRow(b.orderId)).status).toBe("transmitted");
  });

  it("recovery drain releases a crashed worker's stale in-flight claim and sends it", async () => {
    const { orderId } = await queued(ORG_A, {
      sendState: "in_flight",
      updatedAt: new Date(T0.getTime() - 3_600_000),
    });
    const fresh = await queued(ORG_A, { sendState: "in_flight" }); // claimed just now: NOT stale
    const vendor = new FakeDoseSpotVendor({
      transmit: async (_o, p) => ({
        dosespotPrescriptionId: `rx-${p.medicationOrderId.slice(0, 6)}`,
        transmittedAt: T0.toISOString(),
      }),
    });
    const r = await runRecoveryDrainForOrg(deps(vendor), ORG_A);
    expect(r.released).toBe(1);
    expect((await orderRow(orderId)).status).toBe("transmitted");
    expect((await orderRow(fresh.orderId)).s).toBe("in_flight");
  });

  describe("transmission_timeout_sweep (status poll + 24h timeout)", () => {
    const transmitted = async (hoursAgo: number, prescriptionId: string) => {
      const patientId = await h.seedPatient(ORG_A, { synced: "501" });
      return h.seedOrder({
        org: ORG_A,
        patientId,
        status: "transmitted",
        sendState: "transmitted",
        dosespotPrescriptionId: prescriptionId,
        transmittedAt: new Date(T0.getTime() - hoursAgo * 3_600_000),
      });
    };
    const statusOf = (map: Record<string, "sent" | "pending" | "failed" | "needs_pharmacy">) =>
      new FakeDoseSpotVendor({
        prescriptionStatus: async (_o, _p, rxId) => ({
          dosespotPrescriptionId: rxId,
          phase: map[rxId] ?? "pending",
          rawStatus: `raw-${map[rxId] ?? "pending"}`,
          observedAt: T0.toISOString(),
        }),
      });

    it("sent -> ack_received -> active (both events); failed -> nack_received; pending waits; stale pending times out", async () => {
      const ack = await transmitted(1, "rx-ack");
      const nack = await transmitted(1, "rx-nack");
      const wait = await transmitted(2, "rx-wait");
      const old = await transmitted(25, "rx-old");
      const res = await runTransmissionSweepForOrg(
        deps(
          statusOf({
            "rx-ack": "sent",
            "rx-nack": "failed",
            "rx-wait": "pending",
            "rx-old": "pending",
          }),
        ),
        ORG_A,
      );
      expect(res).toMatchObject({ acknowledged: 1, nacked: 1, timedOut: 1 });
      expect(await orderRow(ack.orderId)).toMatchObject({ status: "active", s: "acked" });
      expect(await orderRow(nack.orderId)).toMatchObject({ status: "nack_received", s: "nacked" });
      expect((await orderRow(wait.orderId)).status).toBe("transmitted");
      expect(await orderRow(old.orderId)).toMatchObject({
        status: "transmission_failed",
        s: "failed",
      });
      const ackEv = await h.eventsOf("m12.medication_order.ack_received", ORG_A);
      expect(ackEv.some((e) => (e.payload as any).orderId === ack.orderId)).toBe(true);
      const activeEv = await h.eventsOf("m12.medication_order.active", ORG_A);
      expect(activeEv.some((e) => (e.payload as any).orderId === ack.orderId)).toBe(true);
      const nackEv = await h.eventsOf("m12.medication_order.nack_received", ORG_A);
      expect(
        nackEv.some(
          (e) =>
            (e.payload as any).orderId === nack.orderId &&
            (e.payload as any).rejectionReason === "raw-failed",
        ),
      ).toBe(true);
      // re-running emits nothing new for the settled orders
      const before = (await h.eventsOf("m12.medication_order.ack_received", ORG_A)).length;
      await runTransmissionSweepForOrg(deps(statusOf({ "rx-wait": "pending" })), ORG_A);
      expect((await h.eventsOf("m12.medication_order.ack_received", ORG_A)).length).toBe(before);
    });

    it("a poll failure settles nothing, but the 24h deadline still applies", async () => {
      const young = await transmitted(1, "rx-young-fail");
      const stale = await transmitted(30, "rx-stale-fail");
      const vendor = new FakeDoseSpotVendor({
        prescriptionStatus: async () => {
          throw new DegradedError("dosespot", "getPrescriptionStatus", true, "down", "c9");
        },
      });
      const res = await runTransmissionSweepForOrg(deps(vendor), ORG_A);
      expect(res.pollFailures).toBeGreaterThanOrEqual(2);
      expect((await orderRow(young.orderId)).status).toBe("transmitted");
      expect((await orderRow(stale.orderId)).status).toBe("transmission_failed");
    });

    it("a sweep that loses the race to the webhook path is a no-op (no double event)", async () => {
      const o = await transmitted(1, "rx-race");
      // the webhook path settles it first
      await h.admin.query(
        "UPDATE medication_order SET status='active', dosespot_send_state='acked' WHERE id=$1",
        [o.orderId],
      );
      const before = (await h.eventsOf("m12.medication_order.ack_received", ORG_A)).length;
      await runTransmissionSweepForOrg(deps(statusOf({ "rx-race": "sent" })), ORG_A);
      expect((await h.eventsOf("m12.medication_order.ack_received", ORG_A)).length).toBe(before);
    });
  });

  // Review of slice 4, M4: the per-tick age alert must be index-served, and reshaping it must not change what it finds.
  describe("the queued-age probe is index-served (migration 1385)", () => {
    const cutoff = () => new Date(Date.now() - 60 * 60_000);
    const probe = (org: string) =>
      inOrg(h.handle.db, org, (tx) => staleQueuedOrdersQuery(tx, org, cutoff()));
    const age = (orderId: string, interval: string) =>
      h.admin.query(
        `UPDATE medication_order_transmission SET queued_at = now() - interval '${interval}' WHERE medication_order_id=$1`,
        [orderId],
      );
    const seeded = async (org: string, over: Record<string, unknown> = {}) => {
      const patientId = await h.seedPatient(org, { synced: "501" });
      return h.seedOrder({
        org,
        patientId,
        status: "queued_for_transmission",
        sendState: "queued",
        ...over,
      });
    };

    it("finds a queued order whose transmission row is older than the cutoff, and only that", async () => {
      const old = await seeded(ORG_A);
      await age(old.orderId, "2 hours");
      expect((await probe(ORG_A)).map((r) => r.id)).toEqual([old.orderId]);
    });

    it("ignores a queued order whose transmission row is fresh, a sent order with an old row, and another org's old queued order", async () => {
      const fresh = await seeded(ORG_A);
      await age(fresh.orderId, "5 minutes");
      const sent = await seeded(ORG_A, { status: "transmitted", sendState: "transmitted" });
      await age(sent.orderId, "3 hours");
      const other = await seeded(ORG_B);
      await age(other.orderId, "3 hours");
      expect(await probe(ORG_A)).toEqual([]);
      expect((await probe(ORG_B)).map((r) => r.id)).toEqual([other.orderId]);
    });

    it("both indexes exist, and the order index exists on every partition of the partitioned table", async () => {
      const names = (
        await h.q(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('mot_order_idx','medication_order_queued_idx') ORDER BY 1",
        )
      ).map((r) => r.indexname);
      expect(names).toEqual(["medication_order_queued_idx", "mot_order_idx"]);
      const [parts] = await h.q(
        `SELECT count(*)::int AS partitions,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM pg_index i JOIN pg_inherits ih ON ih.inhrelid = i.indexrelid
                   WHERE i.indrelid = c.oid AND ih.inhparent = 'medication_order_queued_idx'::regclass))::int AS indexed
           FROM pg_inherits p JOIN pg_class c ON c.oid = p.inhrelid
          WHERE p.inhparent = 'medication_order'::regclass`,
      );
      expect(parts.partitions).toBeGreaterThan(0);
      expect(parts.indexed).toBe(parts.partitions);
    });

    it("the real probe's plan reaches both tables through an index, with sequential scans disabled", async () => {
      const { sql: text, params } = staleQueuedOrdersQuery(h.handle.db, ORG_A, cutoff()).toSQL();
      await h.admin.query("BEGIN");
      try {
        await h.admin.query("SET LOCAL enable_seqscan = off");
        const plan = (await h.admin.query(`EXPLAIN ${text}`, params as unknown[])).rows
          .map((r) => r["QUERY PLAN"] as string)
          .join("\n");
        expect(plan).toMatch(/using mot_order_idx on medication_order_transmission/);
        expect(plan).not.toMatch(/Seq Scan/);
      } finally {
        await h.admin.query("ROLLBACK");
      }
    });
  });

  // Review of 18d8778fe..HEAD (LOW): a queued order with NO transmission row (an orphan, left by the enqueue bug fixed in acdec7b42) is invisible to the
  // worker, and used to be invisible to the age alert too. Worse, the claim chose its batch BEFORE looking for rows, so a batch of orphans older than a
  // real order filled the whole batch and the real order was never reached.
  describe("a queued order with no transmission row (an orphan)", () => {
    const TWO_HOURS = 2 * 60 * 60_000;
    const orphan = async (patientId: string, over: Record<string, unknown> = {}) =>
      h.seedOrder({
        org: ORG_A,
        patientId,
        status: "queued_for_transmission",
        sendState: "queued",
        transmission: false,
        ...over,
      });
    const noCall = new FakeDoseSpotVendor({
      transmit: async () => {
        throw new Error("no call is expected");
      },
    });

    it("never starves the claim: more orphans than one batch, all older than a real order, and the real order is still claimed and sent", async () => {
      const patientId = await h.seedPatient(ORG_A, { synced: "501" });
      const orphans: string[] = [];
      for (let i = 0; i < TRANSMIT_BATCH_SIZE + 1; i += 1) {
        orphans.push(
          (await orphan(patientId, { updatedAt: new Date(Date.now() - TWO_HOURS) })).orderId,
        );
      }
      const real = await h.seedOrder({
        org: ORG_A,
        patientId,
        status: "queued_for_transmission",
        sendState: "queued",
      }); // the newest order, WITH its row
      const sends: string[] = [];
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sends.push(payload.medicationOrderId);
          return { dosespotPrescriptionId: "rx-real", transmittedAt: T0.toISOString() };
        },
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(pass).toMatchObject({ claimed: 1, transmitted: 1 });
      expect(sends).toEqual([real.orderId]);
      expect((await orderRow(real.orderId)).status).toBe("transmitted");
      const untouched = await h.q(
        "SELECT count(*)::int AS n FROM medication_order WHERE id = ANY($1::uuid[]) AND status='queued_for_transmission' AND dosespot_send_state='queued'",
        [orphans],
      );
      expect(untouched[0]?.n).toBe(orphans.length); // the orphans are left exactly as they were
    });

    it("is surfaced by the age alert once it has waited past the threshold, and not before", async () => {
      const probe = (org: string) =>
        inOrg(h.handle.db, org, (tx) =>
          staleQueuedOrdersQuery(tx, org, new Date(Date.now() - 60 * 60_000)),
        );
      const patientId = await h.seedPatient(ORG_A, { synced: "501" });
      await orphan(patientId); // fresh: updated just now
      expect(await probe(ORG_A)).toEqual([]);
      const old = await orphan(patientId, { updatedAt: new Date(Date.now() - TWO_HOURS) });
      expect((await probe(ORG_A)).map((r) => r.id)).toEqual([old.orderId]);
      // ... and the alert itself is raised, once, through the degradation machinery
      await h.admin.query("DELETE FROM outbox_event WHERE event_type='m12.dosespot_degraded'");
      const world = { ...deps(noCall), episodes: createEpisodeTracker() };
      expect(await runQueuedAgeAlertForOrg(world, ORG_A)).toBe(true);
      expect(await runQueuedAgeAlertForOrg(world, ORG_A)).toBe(true);
      const raised = (await h.eventsOf("m12.dosespot_degraded", ORG_A)).filter(
        (e) => e.payload.breakerName === `dosespot-queued_orders_stale:${ORG_A}`,
      );
      expect(raised).toHaveLength(1);
    });
  });

  // Review of slice 4, L-e: DoseSpot ACCEPTED the call (2xx) but its answer was unreadable or carried no id, so the prescription may already
  // exist there. That is neither a failure (the order did not fail) nor a retry (a second send could dispense twice): it is held, in its
  // own state, and an administrator is told once.
  describe("an unconfirmed outcome is held, never failed and never re-sent", () => {
    const unconfirmed = () =>
      new UnconfirmedOutcomeError(
        "dosespot",
        "transmitNewRx",
        "DoseSpot returned an unreadable response.",
        "c-unconfirmed",
      );
    const sendsOf = (vendor: FakeDoseSpotVendor) =>
      vendor.calls.filter((c) => c.method === "transmitNewRx").length;
    const never = new FakeDoseSpotVendor({
      transmit: async () => {
        throw new Error("this worker must not call the vendor");
      },
    });
    const eventsFor = async (type: string, orderId: string) =>
      (await h.eventsOf(type, ORG_A)).filter(
        (e) => (e.payload as { orderId?: string }).orderId === orderId,
      );
    const heldOrder = async () => {
      await h.admin.query(
        "DELETE FROM outbox_event WHERE event_type='m12.medication_order.transmission_unconfirmed'",
      );
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          throw unconfirmed();
        },
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      return { orderId, transmissionId: transmissionId as string, vendor, pass };
    };

    it("the order stays in flight with its transmission row naming why: not failed, no retry spent, one event", async () => {
      const { orderId, transmissionId, vendor, pass } = await heldOrder();
      expect(pass).toMatchObject({ claimed: 1, held: 1, failed: 0, requeued: 0, transmitted: 0 });
      expect(await orderRow(orderId)).toMatchObject({
        status: "queued_for_transmission",
        s: "in_flight",
      });
      const t = await txRow(transmissionId);
      expect(t).toMatchObject({
        last_error_class: "unconfirmed_outcome",
        retry_count: 0,
        transmission_failed_at: null,
        transmission_succeeded_at: null,
      });
      expect(String(t.last_error_detail)).toMatch(/may already exist/);
      expect(sendsOf(vendor)).toBe(1);
      const events = await h.eventsOf("m12.medication_order.transmission_unconfirmed", ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ orderId, lastErrorClass: "unconfirmed_outcome" });
      const failed = await h.eventsOf("m12.medication_order.transmission_failed", ORG_A);
      expect(failed.filter((e) => (e.payload as { orderId?: string }).orderId === orderId)).toEqual(
        [],
      );
    });

    it("neither the next tick nor the recovery drain (even long after the stale-claim window) sends it again", async () => {
      const { orderId, vendor } = await heldOrder();
      expect((await runTransmitNewRxForOrg(deps(vendor, minutes(120)), ORG_A)).claimed).toBe(0);
      await h.admin.query(
        "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
        [orderId],
      );
      const drain = await runRecoveryDrainForOrg(deps(vendor, minutes(240)), ORG_A);
      expect(drain.released).toBe(0);
      expect(drain.pass.claimed).toBe(0);
      expect(sendsOf(vendor)).toBe(1);
      expect(await orderRow(orderId)).toMatchObject({ s: "in_flight" });
    });

    it("a crashed worker's stale claim (no unconfirmed marker) is still released and re-sent: the hold is for the ambiguous outcome only", async () => {
      const { orderId } = await queued();
      await h.admin.query(
        "UPDATE medication_order SET dosespot_send_state='in_flight', updated_at = now() - interval '3 hours' WHERE id=$1",
        [orderId],
      );
      const vendor = new FakeDoseSpotVendor({});
      const drain = await runRecoveryDrainForOrg(deps(vendor), ORG_A);
      expect(drain.released).toBe(1);
      expect(sendsOf(vendor)).toBe(1);
    });

    // Residual of the review: a worker that dies (or whose settle hits a database error) AFTER the vendor's 2xx but BEFORE the hold commits
    // leaves a stale claim with no marker. The claim now records when the vendor call BEGAN, so such a claim is held for a person, while a
    // claim that never reached the vendor is still released and re-sent.
    it("the transmission row records that the vendor call began BEFORE the call is made, and no earlier than that", async () => {
      const { orderId, transmissionId } = await queued();
      let seenAtCall: Record<string, unknown> | undefined;
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          seenAtCall = await txRow(transmissionId as string);
          return { dosespotPrescriptionId: "rx-1", transmittedAt: new Date().toISOString() };
        },
      });
      await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(seenAtCall?.transmission_started_at).not.toBeNull(); // written and committed before the vendor was asked
      expect(seenAtCall?.call_token).not.toBeNull(); // with the nonce the worker owns the call by
      expect((await orderRow(orderId)).status).toBe("transmitted");
    });

    it("a claim whose vendor call began and whose worker then died is HELD by the drain (not re-sent), with the event; one that never reached the vendor is released", async () => {
      await h.admin.query(
        "DELETE FROM outbox_event WHERE event_type='m12.medication_order.transmission_unconfirmed'",
      );
      const afterCall = await queued();
      const beforeCall = await queued();
      await h.admin.query(
        "UPDATE medication_order SET dosespot_send_state='in_flight', updated_at = now() - interval '3 hours' WHERE id = ANY($1::uuid[])",
        [[afterCall.orderId, beforeCall.orderId]],
      );
      await h.admin.query(
        "UPDATE medication_order_transmission SET transmission_started_at = now() - interval '3 hours' WHERE id=$1",
        [afterCall.transmissionId],
      ); // the call began; no settle ever ran
      const sent: string[] = [];
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sent.push(payload.medicationOrderId);
          return { dosespotPrescriptionId: "rx-2", transmittedAt: new Date().toISOString() };
        },
      });
      const drain = await runRecoveryDrainForOrg(deps(vendor), ORG_A);
      expect(drain.released).toBe(1);
      expect(sent).toEqual([beforeCall.orderId]); // only the claim that never reached the vendor was sent
      expect((await orderRow(afterCall.orderId)).s).toBe("in_flight");
      const t = await txRow(afterCall.transmissionId as string);
      expect(t.last_error_class).toBe("unconfirmed_outcome");
      expect(String(t.last_error_detail)).toMatch(/stopped after the call to DoseSpot was made/);
      const events = await h.eventsOf("m12.medication_order.transmission_unconfirmed", ORG_A);
      expect(events.map((e) => (e.payload as { orderId: string }).orderId)).toEqual([
        afterCall.orderId,
      ]);
      // and it stays held: a second drain neither re-sends it nor announces it again
      const again = await runRecoveryDrainForOrg(deps(vendor, minutes(300)), ORG_A);
      expect(again.released).toBe(0);
      expect(sent).toEqual([beforeCall.orderId]);
      expect(await h.eventsOf("m12.medication_order.transmission_unconfirmed", ORG_A)).toHaveLength(
        1,
      );
    });

    // M1: the drain's release was conditioned on the hold marker only, so a stamped claim BEYOND the 100-row hold batch was re-queued and re-sent.
    it("more stale claims than one hold batch: a stamped claim beyond the batch is never re-queued or sent, and the next drain holds it", async () => {
      const patientId = await h.seedPatient(ORG_A, { synced: "501" });
      const stamped: string[] = [];
      for (let i = 0; i < 104; i += 1) {
        const o = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "queued_for_transmission",
          sendState: "in_flight",
        });
        stamped.push(o.orderId);
      }
      const unstamped = await h.seedOrder({
        org: ORG_A,
        patientId,
        status: "queued_for_transmission",
        sendState: "in_flight",
      });
      await h.admin.query(
        "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE organization_id=$1 AND dosespot_send_state='in_flight'",
        [ORG_A],
      );
      await h.admin.query(
        "UPDATE medication_order_transmission SET transmission_started_at = now() - interval '3 hours' WHERE medication_order_id = ANY($1::uuid[])",
        [stamped],
      );
      const sent: string[] = [];
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sent.push(payload.medicationOrderId);
          return {
            dosespotPrescriptionId: `rx-${sent.length}`,
            transmittedAt: new Date().toISOString(),
          };
        },
      });
      const inFlightStamped = async () =>
        Number(
          (
            await h.q(
              "SELECT count(*)::int AS n FROM medication_order WHERE id = ANY($1::uuid[]) AND dosespot_send_state='in_flight'",
              [stamped],
            )
          )[0]?.n,
        );
      const marked = async () =>
        Number(
          (
            await h.q(
              "SELECT count(*)::int AS n FROM medication_order_transmission WHERE medication_order_id = ANY($1::uuid[]) AND last_error_class='unconfirmed_outcome'",
              [stamped],
            )
          )[0]?.n,
        );
      const first = await runRecoveryDrainForOrg(deps(vendor, minutes(300)), ORG_A);
      expect(first.released).toBe(1); // only the claim that never reached the vendor
      expect(sent).toEqual([unstamped.orderId]);
      expect(await marked()).toBe(100); // one hold batch ...
      expect(await inFlightStamped()).toBe(104); // ... and none of the 104 stamped claims was re-queued, held or not
      const second = await runRecoveryDrainForOrg(deps(vendor, minutes(301)), ORG_A);
      expect(second.released).toBe(0);
      expect(await marked()).toBe(104); // the next drain holds the rest
      expect(sent).toEqual([unstamped.orderId]); // nothing was ever sent twice
    }, 120_000);

    // The created-but-unsent DoseSpot prescription id lived in the adapter's process memory, so a retry on another replica re-ran the create. The
    // worker now persists it on the transmission row when it is created and hands it back, so a retry only re-runs the send.
    it("the created prescription id is persisted before the send, and a retry is handed it so only the send is re-run", async () => {
      const { orderId, transmissionId } = await queued();
      const seen: (string | undefined)[] = [];
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, _payload, _key, resume) => {
          seen.push(resume?.createdPrescriptionId);
          if (resume?.createdPrescriptionId === undefined) {
            await resume?.onCreated?.("rx-created-1"); // the create answered; the send then fails (another replica retries it)
            throw retryable();
          }
          return {
            dosespotPrescriptionId: resume.createdPrescriptionId,
            transmittedAt: T0.toISOString(),
          };
        },
      });
      expect((await runTransmitNewRxForOrg(deps(vendor, minutes(0)), ORG_A)).requeued).toBe(1);
      const t = await txRow(transmissionId as string);
      expect(t.dosespot_prescription_id).toBe("rx-created-1"); // persisted, though nothing was sent
      expect((await orderRow(orderId)).rx).toBeNull(); // the ORDER carries an id only once it is really sent
      expect((await runTransmitNewRxForOrg(deps(vendor, minutes(5)), ORG_A)).transmitted).toBe(1);
      expect(seen).toEqual([undefined, "rx-created-1"]); // the retry was handed the persisted id
      expect((await orderRow(orderId)).rx).toBe("rx-created-1");
    });

    it("a retryable failure puts the order back with no 'call began' mark, so a later stale claim of it that never called is released", async () => {
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          throw retryable();
        },
      });
      expect((await runTransmitNewRxForOrg(deps(vendor), ORG_A)).requeued).toBe(1);
      expect((await orderRow(orderId)).s).toBe("queued");
      expect((await txRow(transmissionId as string)).transmission_started_at).toBeNull();
      expect((await txRow(transmissionId as string)).call_token).toBeNull();
    });

    // H3: the stale window measures from the CLAIM and a stamp was not a fence. A slow sequential batch could be drained and re-claimed by another
    // worker while the first worker, still in the batch, then stamped and sent the SAME order with the SAME key: a double send. The stamp is now the
    // fence (a conditional update of the order's claim that also restarts the stale clock at the call): a worker that no longer owns the claim makes no call.
    it("FENCE, interleaving forced: a batch worker whose claim was drained and taken over while it was busy with an earlier order makes NO call for it", async () => {
      const first = await queued();
      const second = await queued();
      const sendsB: string[] = [];
      const vendorB = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sendsB.push(payload.medicationOrderId);
          return { dosespotPrescriptionId: "rx-by-b", transmittedAt: new Date().toISOString() };
        },
      });
      const sendsA: string[] = [];
      const vendorA = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sendsA.push(payload.medicationOrderId);
          if (payload.medicationOrderId === first.orderId) {
            // while A is on its first order, its claim on the second goes stale and ANOTHER worker's drain takes it over and sends it
            await h.admin.query(
              "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
              [second.orderId],
            );
            await runRecoveryDrainForOrg(deps(vendorB, minutes(30)), ORG_A);
          }
          return { dosespotPrescriptionId: "rx-by-a", transmittedAt: new Date().toISOString() };
        },
      });
      await runTransmitNewRxForOrg(deps(vendorA), ORG_A);
      expect(sendsB).toEqual([second.orderId]); // the takeover sent it
      expect(sendsA).toEqual([first.orderId]); // the original worker never called for it
      expect((await orderRow(second.orderId)).rx).toBe("rx-by-b");
      expect((await orderRow(first.orderId)).rx).toBe("rx-by-a");
    });

    it("FENCE, takeover still IN FLIGHT: the new owner's claim is a different claim, so the original worker is fenced out by the claim itself, not only by the state", async () => {
      const first = await queued();
      const second = await queued();
      let bEntered!: () => void;
      const bIsCalling = new Promise<void>((resolve) => {
        bEntered = resolve;
      });
      let releaseB!: () => void;
      const bMayFinish = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const sendsB: string[] = [];
      const vendorB = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sendsB.push(payload.medicationOrderId);
          bEntered();
          await bMayFinish; // B's call is still running while A reaches the order
          return { dosespotPrescriptionId: "rx-by-b", transmittedAt: new Date().toISOString() };
        },
      });
      let takeover: Promise<unknown> | undefined;
      const sendsA: string[] = [];
      const vendorA = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          sendsA.push(payload.medicationOrderId);
          if (payload.medicationOrderId === first.orderId) {
            await h.admin.query(
              "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
              [second.orderId],
            );
            takeover = runRecoveryDrainForOrg(deps(vendorB, minutes(30)), ORG_A); // NOT awaited: B is mid-call
            await bIsCalling;
          }
          return { dosespotPrescriptionId: "rx-by-a", transmittedAt: new Date().toISOString() };
        },
      });
      await runTransmitNewRxForOrg(deps(vendorA), ORG_A);
      expect(sendsA).toEqual([first.orderId]); // the order is in flight again (B's claim) but A is fenced out
      expect(sendsB).toEqual([second.orderId]);
      releaseB();
      await takeover;
      expect((await orderRow(second.orderId)).rx).toBe("rx-by-b");
    });

    it("the stamp restarts the stale clock AT THE CALL: an order that waited in a slow batch is not drained as stale while its own call is running", async () => {
      const first = await queued();
      const second = await queued();
      const clock = { minute: 0 };
      const at = (minute: number) => new Date(T0.getTime() + minute * 60_000);
      let secondWasFreshDuringItsCall = false;
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          if (payload.medicationOrderId === first.orderId) {
            clock.minute = 15; // the first call is slow: the second order has now waited 15 minutes since its CLAIM
            return { dosespotPrescriptionId: "rx-1", transmittedAt: at(15).toISOString() };
          }
          // the second order's call begins at minute 15; a drain at minute 16 must find its claim 1 minute old, not 16
          const drain = await runRecoveryDrainForOrg({ ...deps(never), now: () => at(16) }, ORG_A);
          secondWasFreshDuringItsCall =
            drain.released === 0 &&
            (await orderRow(second.orderId)).s === "in_flight" &&
            (await txRow(second.transmissionId as string)).last_error_class === null;
          return { dosespotPrescriptionId: "rx-2", transmittedAt: at(16).toISOString() };
        },
      });
      await runTransmitNewRxForOrg({ ...deps(vendor), now: () => at(clock.minute) }, ORG_A);
      expect(secondWasFreshDuringItsCall).toBe(true);
      expect((await orderRow(second.orderId)).rx).toBe("rx-2");
    });

    // The drain's CLOCK is moved (not the order's updated_at): the drain only reads the claim, so a worker that is merely slow keeps owning it.
    it("a hold set by the drain while the original call was still running is cleared by that call's late success (no stale marker, read says transmitted)", async () => {
      const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          // the call is slower than the stale window: the drain (another worker, a later clock) holds the stamped claim meanwhile
          await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
          expect((await txRow(transmissionId as string)).last_error_class).toBe(
            "unconfirmed_outcome",
          );
          return { dosespotPrescriptionId: "rx-slow", transmittedAt: new Date().toISOString() };
        },
      });
      expect((await runTransmitNewRxForOrg(deps(vendor), ORG_A)).transmitted).toBe(1);
      expect(await orderRow(orderId)).toMatchObject({ status: "transmitted", rx: "rx-slow" });
      const t = await txRow(transmissionId as string);
      expect(t.last_error_class).toBeNull(); // the stale marker is gone
      expect((await backend.getTransmission(ORG_A, orderId)).status).toBe("transmitted");
    });

    it("a late UNCONFIRMED outcome after the drain already held the order does not announce it a second time", async () => {
      const { orderId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
          throw new UnconfirmedOutcomeError("dosespot", "transmitNewRx", "unreadable", "c-late");
        },
      });
      await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(
        await eventsFor("m12.medication_order.transmission_unconfirmed", orderId),
      ).toHaveLength(1);
      expect((await orderRow(orderId)).s).toBe("in_flight");
    });

    it("a late OUTAGE after the drain already held the order requeues it AND clears the stale hold marker (no 'held' order that is queued)", async () => {
      const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
          expect((await txRow(transmissionId as string)).last_error_class).toBe(
            "unconfirmed_outcome",
          );
          throw circuitOpen(); // nothing reached the vendor after all
        },
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(pass).toMatchObject({ deferredByOutage: 1, skipped: 0 });
      expect(await orderRow(orderId)).toMatchObject({
        status: "queued_for_transmission",
        s: "queued",
      });
      const t = await txRow(transmissionId as string);
      expect(t.last_error_class).toBeNull();
      expect(t.transmission_started_at).toBeNull();
      expect(t.call_token).toBeNull();
      expect((await backend.getTransmission(ORG_A, orderId)).status).toBe("queued");
    });

    // LOW (review of 436fd3c1c..): when the drain had already held the order, the worker's own hold matched no row, so the detail the administrator
    // reads stayed the drain's generic "a worker stopped ..." even when the worker then found a duplicate id or an unreadable answer.
    it("a hold the drain already set takes the worker's real cause as its detail (a duplicate id, an unreadable answer), and is still announced once", async () => {
      await h.seedOrder({
        org: ORG_A,
        patientId: await h.seedPatient(ORG_A, { synced: "501" }),
        status: "active",
        sendState: "acked",
        dosespotPrescriptionId: "rx-clash-2",
        transmittedAt: T0,
      });
      for (const cause of ["duplicate id", "unreadable answer"] as const) {
        await h.admin.query(
          "DELETE FROM medication_order_transmission WHERE medication_order_id IN (SELECT id FROM medication_order WHERE dosespot_prescription_id IS NULL)",
        );
        await h.admin.query("DELETE FROM medication_order WHERE dosespot_prescription_id IS NULL");
        const { orderId, transmissionId } = await queued();
        const vendor = new FakeDoseSpotVendor({
          transmit: async () => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
            expect(
              String((await txRow(transmissionId as string)).last_error_detail),
              cause,
            ).toMatch(/A worker stopped/);
            if (cause === "unreadable answer") throw unconfirmed();
            return { dosespotPrescriptionId: "rx-clash-2", transmittedAt: T0.toISOString() };
          },
        });
        const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
        expect(pass, cause).toMatchObject({ held: 1, transmitted: 0 });
        const t = await txRow(transmissionId as string);
        expect(t.last_error_class, cause).toBe("unconfirmed_outcome");
        expect(String(t.last_error_detail), cause).toMatch(
          cause === "duplicate id" ? /already recorded on another order/ : /unreadable response/,
        );
        expect(String(t.last_error_detail), cause).not.toMatch(/A worker stopped/);
        expect(
          await eventsFor("m12.medication_order.transmission_unconfirmed", orderId),
          cause,
        ).toHaveLength(1);
      }
    });

    // What a late DEFINITIVE failure does after the drain held the order, pinned (the CW-AC-23 text states it): the call's own answer settles what the
    // hold was waiting to learn, through the ordinary failure path. A retryable one puts the order back on the queue (a retry spent, the persisted
    // created id re-sent, the hold marker replaced by the failure's class); a permanent one fails the order. Neither keeps it held.
    for (const kind of ["retryable", "permanent"] as const) {
      it(`a late ${kind.toUpperCase()} failure after the drain held the order is settled as an ordinary failure: ${kind === "retryable" ? "requeued, one retry spent, the marker replaced" : "the order fails and the administrators are told"}`, async () => {
        const { orderId, transmissionId } = await queued();
        const keys: string[] = [];
        const resumedWith: (string | undefined)[] = [];
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, _payload, key, resume) => {
            keys.push(key);
            resumedWith.push(resume?.createdPrescriptionId);
            if (resume?.createdPrescriptionId !== undefined) {
              // the SECOND attempt: handed the persisted id, it only re-runs the send
              await resume.beforeSend?.();
              return {
                dosespotPrescriptionId: resume.createdPrescriptionId,
                transmittedAt: minutes(5).toISOString(),
              };
            }
            await resume?.onCreated?.("rx-created-late"); // the create answered and was persisted, then the send is slow ...
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
            expect((await txRow(transmissionId as string)).last_error_class).toBe(
              "unconfirmed_outcome",
            );
            throw kind === "retryable" ? retryable() : permanent();
          },
        });
        const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
        const t = await txRow(transmissionId as string);
        expect(t.last_error_class).not.toBe("unconfirmed_outcome");
        if (kind === "retryable") {
          expect(pass).toMatchObject({ requeued: 1, failed: 0, held: 0 });
          expect(await orderRow(orderId)).toMatchObject({
            status: "queued_for_transmission",
            s: "queued",
          });
          expect(t.retry_count).toBe(1);
          expect(t.dosespot_prescription_id).toBe("rx-created-late"); // the persisted created id survives the requeue
          // ... and the next attempt re-sends THAT prescription under the SAME Idempotency-Key (the second attempt's backoff has elapsed)
          const second = await runTransmitNewRxForOrg(deps(vendor, minutes(5)), ORG_A);
          expect(second).toMatchObject({ claimed: 1, transmitted: 1 });
          expect(resumedWith).toEqual([undefined, "rx-created-late"]);
          expect(keys).toHaveLength(2);
          expect(keys[1]).toBe(keys[0]);
          expect(await orderRow(orderId)).toMatchObject({
            status: "transmitted",
            rx: "rx-created-late",
          });
        } else {
          expect(pass).toMatchObject({ failed: 1, requeued: 0, held: 0 });
          expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed" });
          expect(
            (await eventsFor("m12.medication_order.transmission_failed", orderId)).length,
          ).toBe(1);
        }
      });
    }

    // MEDIUM-1 of the next review: the fence covered only the vendor call. A worker that lost its claim BEFORE the fence (its payload build then
    // failed) still wrote its failure over the NEW owner's claim: it requeued or exhausted it and cleared its stamp, and the owner's success then
    // matched nothing, so a prescription that WAS sent was never recorded and went out again on the next tick. Every write a worker makes after its
    // claim is now conditional on the claim still being its own.
    for (const flip of ["sync", "prescriber"] as const) {
      it(`OWNERSHIP (${flip}): a worker whose claim was taken over, and whose payload build then fails, neither requeues nor exhausts the new owner's claim; the owner's success is recorded and nothing is sent again`, async () => {
        const first = await queued();
        const second = await queued();
        const secondPatient = (
          await h.q("SELECT patient_id FROM medication_order WHERE id=$1", [second.orderId])
        )[0]?.patient_id as string;
        let bEntered!: () => void;
        const bIsCalling = new Promise<void>((resolve) => {
          bEntered = resolve;
        });
        let releaseB!: () => void;
        const bMayFinish = new Promise<void>((resolve) => {
          releaseB = resolve;
        });
        const sendsB: string[] = [];
        const vendorB = new FakeDoseSpotVendor({
          transmit: async (_org, payload) => {
            sendsB.push(payload.medicationOrderId);
            bEntered();
            await bMayFinish;
            return { dosespotPrescriptionId: "rx-by-b", transmittedAt: new Date().toISOString() };
          },
        });
        let takeover: Promise<unknown> | undefined;
        const sendsA: string[] = [];
        const vendorA = new FakeDoseSpotVendor({
          transmit: async (_org, payload) => {
            sendsA.push(payload.medicationOrderId);
            if (payload.medicationOrderId === first.orderId) {
              await h.admin.query(
                "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
                [second.orderId],
              );
              takeover = runRecoveryDrainForOrg(deps(vendorB, minutes(30)), ORG_A); // B takes the second order over and is mid-call
              await bIsCalling;
              // B has built its payload; now the facts A is about to read change under it
              if (flip === "sync")
                await h.admin.query(
                  "UPDATE dosespot_patient_sync SET last_sync_outcome='failed' WHERE patient_id=$1",
                  [secondPatient],
                );
              else
                await h.admin.query(
                  "UPDATE dosespot_prescriber SET revoked_at = now() WHERE organization_id=$1",
                  [ORG_A],
                );
            }
            return { dosespotPrescriptionId: "rx-by-a", transmittedAt: new Date().toISOString() };
          },
        });
        try {
          const pass = await runTransmitNewRxForOrg(deps(vendorA), ORG_A);
          expect(sendsA).toEqual([first.orderId]); // A never called for the second order
          expect(pass).toMatchObject({
            claimed: 2,
            transmitted: 1,
            skipped: 1,
            requeued: 0,
            failed: 0,
          });
          expect(pass.deferredByOutage).toBe(0); // a lost claim is not an outage
          // B's claim is intact while B is still calling: not requeued, not exhausted, its stamp not cleared, no patient sync queued by A
          expect(await orderRow(second.orderId)).toMatchObject({
            status: "queued_for_transmission",
            s: "in_flight",
          });
          expect(
            (await txRow(second.transmissionId as string)).transmission_started_at,
          ).not.toBeNull();
          expect(
            (
              await h.q("SELECT count(*)::int AS n FROM dosespot_sync_queue WHERE patient_id=$1", [
                secondPatient,
              ])
            )[0]?.n,
          ).toBe(0);
          releaseB();
          await takeover; // B's success must be recorded (it used to throw: its order had been put back on the queue)
          expect(await orderRow(second.orderId)).toMatchObject({
            status: "transmitted",
            rx: "rx-by-b",
          });
          expect(sendsB).toEqual([second.orderId]);
          expect((await runTransmitNewRxForOrg(deps(never), ORG_A)).claimed).toBe(0); // nothing goes out again
        } finally {
          releaseB();
          await takeover?.catch(() => undefined);
          await h.admin.query(
            "UPDATE dosespot_prescriber SET revoked_at = NULL WHERE organization_id=$1",
            [ORG_A],
          );
        }
      });
    }

    // MEDIUM-1 of the review of 436fd3c1c..: `updated_at` is shared with writes that have nothing to do with the claim (a coverage determination,
    // a correction's version bump). Once the call began the worker's claim is the stamp it wrote on the transmission row, so a benign write during
    // the call must not turn a legitimate owner into a skipped one (which orphaned the accepted prescription: held by the drain, resolved by hand).
    it("OWNERSHIP after the fence is the call's own stamp: a coverage save and a correction's version bump during the call do not orphan the accepted prescription", async () => {
      const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
      const { orderId, transmissionId } = await queued();
      const membership = (
        await h.q("SELECT id FROM membership WHERE organization_id=$1 LIMIT 1", [ORG_A])
      )[0]?.id as string;
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          await backend.setCoverageDetermination(ORG_A, membership, orderId, {
            hospiceCoverage: "not_covered_unrelated",
            reason: "Unrelated to the terminal diagnosis, per the attending.",
          });
          // what `correctOrder` writes to the ORIGINAL order (it has no status guard)
          await h.admin.query(
            "UPDATE medication_order SET version = version + 1, updated_at = now() + interval '1 second' WHERE id=$1",
            [orderId],
          );
          return { dosespotPrescriptionId: "rx-benign", transmittedAt: new Date().toISOString() };
        },
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(pass).toMatchObject({ claimed: 1, transmitted: 1, skipped: 0, held: 0 });
      expect(await orderRow(orderId)).toMatchObject({ status: "transmitted", rx: "rx-benign" });
      expect((await txRow(transmissionId as string)).transmission_succeeded_at).not.toBeNull();
      // nothing is left over from the benign writes: no hold marker, no "unconfirmed" announcement, and the read says transmitted
      expect((await txRow(transmissionId as string)).last_error_class).toBeNull();
      expect(await eventsFor("m12.medication_order.transmission_unconfirmed", orderId)).toEqual([]);
      expect((await backend.getTransmission(ORG_A, orderId)).status).toBe("transmitted");
    });

    // LOW (review of d333d1d9d..HEAD): the token after the fence is a per-call NONCE (a uuid the fence writes), not the app-clock stamp, so two cycles
    // that stamp the same instant are still told apart. The "identical clocks" runs fail with the stamp as the token: A would write over B's claim.
    it("OWNERSHIP after the fence: a worker whose call was overtaken (the order released and a NEW claim fenced and calling) writes nothing over the new owner, whatever it found and even on an identical clock", async () => {
      for (const [clocks, found] of [
        ["different clocks", "failure"],
        ["different clocks", "outage"],
        ["different clocks", "unconfirmed"],
        ["identical clocks", "failure"],
        ["identical clocks", "outage"],
        ["identical clocks", "unconfirmed"],
      ] as const) {
        const label = `${clocks}, ${found}`;
        await h.admin.query("DELETE FROM medication_order_transmission");
        await h.admin.query("DELETE FROM medication_order");
        const { orderId, transmissionId } = await queued();
        let bEntered!: () => void;
        const bIsCalling = new Promise<void>((resolve) => {
          bEntered = resolve;
        });
        let releaseB!: () => void;
        const bMayFinish = new Promise<void>((resolve) => {
          releaseB = resolve;
        });
        const sendsB: string[] = [];
        const vendorB = new FakeDoseSpotVendor({
          transmit: async (_org, payload) => {
            sendsB.push(payload.medicationOrderId);
            bEntered();
            await bMayFinish;
            return { dosespotPrescriptionId: "rx-by-b", transmittedAt: new Date().toISOString() };
          },
        });
        let takeover: Promise<unknown> | undefined;
        const vendorA = new FakeDoseSpotVendor({
          transmit: async () => {
            // the claim is released while A is still in its call (an operator's fix-up, say), and ANOTHER worker claims, fences and calls
            await h.admin.query(
              "UPDATE medication_order SET dosespot_send_state='queued' WHERE id=$1",
              [orderId],
            );
            await h.admin.query(
              "UPDATE medication_order_transmission SET transmission_started_at = NULL, call_token = NULL WHERE id=$1",
              [transmissionId],
            );
            takeover = runTransmitNewRxForOrg(
              deps(vendorB, clocks === "identical clocks" ? T0 : minutes(30)),
              ORG_A,
            ); // NOT awaited: B is mid-call
            await bIsCalling;
            if (found === "failure") throw retryable();
            if (found === "outage") throw circuitOpen();
            throw new UnconfirmedOutcomeError("dosespot", "transmitNewRx", "unreadable", "c-a");
          },
        });
        try {
          const pass = await runTransmitNewRxForOrg(deps(vendorA), ORG_A);
          expect(pass, label).toMatchObject({ claimed: 1, skipped: 1, requeued: 0, held: 0 });
          expect(pass.deferredByOutage, label).toBe(0);
          // B's claim is intact: still in flight, its stamp not cleared, no marker and no failure written over it
          expect(await orderRow(orderId), label).toMatchObject({ s: "in_flight" });
          const t = await txRow(transmissionId as string);
          expect(t.transmission_started_at, label).not.toBeNull();
          expect(t.last_error_class, label).toBeNull();
          expect(t.retry_count, label).toBe(0);
          releaseB();
          await takeover;
          expect(await orderRow(orderId), label).toMatchObject({
            status: "transmitted",
            rx: "rx-by-b",
          });
          expect(sendsB, label).toEqual([orderId]);
        } finally {
          releaseB();
          await takeover?.catch(() => undefined);
        }
      }
    });

    /** An organization administrator resolves the held order NOT SENT (the service, as the route calls it). */
    const resolveNotSent = async (orderId: string) => {
      const membershipId = (
        await h.q("SELECT id FROM membership WHERE organization_id=$1 LIMIT 1", [ORG_A])
      )[0]?.id as string;
      await createTransmissionResolveService({
        db: h.handle.db,
        outbox: h.outbox,
        audit: buildClinicAuditPort(),
      }).resolve({ organizationId: ORG_A, userId: USER, membershipId }, orderId, {
        outcome: "not_sent",
        reason: "Checked the prescriber's DoseSpot account: nothing there.",
      });
    };
    const outboxCount = async () =>
      (await h.q("SELECT count(*)::int AS n FROM outbox_event"))[0]?.n as number;

    // LOW (review of 436fd3c1c..): a worker that lost its claim after the call began (an administrator resolved the held order while the slow call
    // was still running) wrote nothing, and said so only for a success. Every result it discards is now said, with ids only, and counted.
    describe("a call that answers after an administrator resolved the held order", () => {
      type Warning = { fields: Record<string, unknown>; message: string };
      const LATE_ID = "rx-late-9a8b7c";
      /** A slow call: the drain holds it, the administrator resolves it NOT SENT, and only then does the call answer. */
      const scenario = async (
        answer: () => Promise<never | { dosespotPrescriptionId: string; transmittedAt: string }>,
      ) => {
        const warnings: Warning[] = [];
        const { orderId, transmissionId } = await queued();
        const atAnswer: { events?: number; tx?: Record<string, unknown> } = {};
        const vendor = new FakeDoseSpotVendor({
          transmit: async () => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
            await resolveNotSent(orderId);
            atAnswer.events = await outboxCount();
            atAnswer.tx = await txRow(transmissionId as string);
            return answer();
          },
        });
        const world = {
          ...deps(vendor),
          warn: (fields: Record<string, string | number>, message: string) =>
            warnings.push({ fields, message }),
        };
        return { orderId, transmissionId: transmissionId as string, world, warnings, atAnswer };
      };

      it("SUCCESS: nothing is recorded over the administrator's decision, and the log names ids only", async () => {
        const run = await scenario(async () => ({
          dosespotPrescriptionId: LATE_ID,
          transmittedAt: new Date().toISOString(),
        }));
        const pass = await runTransmitNewRxForOrg(run.world, ORG_A);
        expect(pass).toMatchObject({ claimed: 1, transmitted: 0, skipped: 1, held: 0 });
        expect(await orderRow(run.orderId)).toMatchObject({
          status: "transmission_failed",
          rx: null,
        });
        expect(await outboxCount()).toBe(run.atAnswer.events); // no transmitted event
        const log = run.warnings.filter((w) => /no longer owns/.test(w.message));
        expect(log).toHaveLength(1);
        expect(Object.keys(log[0]?.fields ?? {}).sort()).toEqual([
          "found",
          "orderId",
          "organizationId",
        ]);
        expect(log[0]?.fields).toMatchObject({
          organizationId: ORG_A,
          orderId: run.orderId,
          found: "success",
        });
        expect(JSON.stringify(run.warnings)).not.toContain(LATE_ID); // the id of a prescription is not logged
      });

      for (const found of ["failure", "outage", "unconfirmed"] as const) {
        it(`${found.toUpperCase()}: nothing is written, nothing is announced, and the log says it was discarded`, async () => {
          const run = await scenario(async () => {
            if (found === "failure") throw retryable();
            if (found === "outage") throw circuitOpen();
            throw new UnconfirmedOutcomeError("dosespot", "transmitNewRx", "unreadable", "c-late");
          });
          const pass = await runTransmitNewRxForOrg(run.world, ORG_A);
          expect(pass).toMatchObject({ claimed: 1, skipped: 1, requeued: 0, held: 0, failed: 0 });
          expect(pass.deferredByOutage).toBe(0);
          expect((await orderRow(run.orderId)).status).toBe("transmission_failed"); // the administrator's decision stands
          expect(await outboxCount()).toBe(run.atAnswer.events);
          expect(await txRow(run.transmissionId)).toEqual(run.atAnswer.tx); // retry count, marker and stamp untouched
          const log = run.warnings.filter((w) => /no longer owns/.test(w.message));
          expect(log).toHaveLength(1);
          expect(Object.keys(log[0]?.fields ?? {}).sort()).toEqual([
            "found",
            "orderId",
            "organizationId",
          ]);
          expect(log[0]?.fields.found).toBe(found);
        });
      }

      // MEDIUM-2 (code side): the adapter creates a prescription, hands its id to `onCreated`, and only then SENDS it. `onCreated` used to update the
      // transmission row by id alone, so a worker that had lost the order (an administrator resolved it NOT SENT) still went on to send. It now
      // answers only while the worker still owns the call, and the adapter's contract stops the send when it throws.
      it("CREATE: a call that creates the prescription after the administrator resolved the order is stopped before the SEND, and the created id is not recorded", async () => {
        const warnings: Warning[] = [];
        const sends: string[] = [];
        const { orderId, transmissionId } = await queued();
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, payload, _key, resume) => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
            await resolveNotSent(orderId);
            await resume?.onCreated?.("rx-draft-5e6f"); // the create answered AFTER the resolution; the adapter sends only if this returns
            sends.push(payload.medicationOrderId);
            return { dosespotPrescriptionId: "rx-draft-5e6f", transmittedAt: T0.toISOString() };
          },
        });
        const pass = await runTransmitNewRxForOrg(
          {
            ...deps(vendor),
            warn: (fields, message) => warnings.push({ fields, message }),
          },
          ORG_A,
        );
        expect(sends).toEqual([]); // the send was never reached
        expect(pass).toMatchObject({
          claimed: 1,
          transmitted: 0,
          skipped: 1,
          requeued: 0,
          held: 0,
        });
        expect((await txRow(transmissionId as string)).dosespot_prescription_id).toBeNull();
        expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed", rx: null });
        expect(warnings.filter((w) => /no longer owns/.test(w.message))).toHaveLength(1);
        expect(JSON.stringify(warnings)).not.toContain("rx-draft-5e6f");
      });

      it("CREATE (control): after only the drain's hold, the worker still owns the call, so the created id is recorded and the send goes ahead", async () => {
        const sends: string[] = [];
        const { orderId, transmissionId } = await queued();
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, payload, _key, resume) => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A); // held, not resolved
            await resume?.onCreated?.("rx-draft-7a8b");
            expect((await txRow(transmissionId as string)).dosespot_prescription_id).toBe(
              "rx-draft-7a8b",
            );
            sends.push(payload.medicationOrderId);
            return { dosespotPrescriptionId: "rx-draft-7a8b", transmittedAt: T0.toISOString() };
          },
        });
        expect((await runTransmitNewRxForOrg(deps(vendor), ORG_A)).transmitted).toBe(1);
        expect(sends).toEqual([orderId]);
        expect(await orderRow(orderId)).toMatchObject({
          status: "transmitted",
          rx: "rx-draft-7a8b",
        });
      });

      // The resumed path (item 1a of the next round): a retry handed a PERSISTED created id skips the create, so `onCreated` never runs and its ownership
      // check never happened. The adapter's `beforeSend` runs on both paths; the worker re-checks there. The fake vendor stands in for the adapter and
      // calls the hooks as the real one does (the adapter's own order is pinned in packages/dosespot http-client.test.ts).
      it("RESUME: a retry handed a persisted created id is stopped before the SEND when the administrator resolved the order meanwhile", async () => {
        const warnings: Warning[] = [];
        const sends: string[] = [];
        const { orderId, transmissionId } = await queued();
        await h.admin.query(
          "UPDATE medication_order_transmission SET dosespot_prescription_id='rx-persisted-3c4d' WHERE id=$1",
          [transmissionId],
        );
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, payload, _key, resume) => {
            expect(resume?.createdPrescriptionId).toBe("rx-persisted-3c4d"); // the create is skipped: only the send is left
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A);
            await resolveNotSent(orderId);
            await resume?.beforeSend?.(); // the adapter calls it just before the send, on this path too
            sends.push(payload.medicationOrderId);
            return { dosespotPrescriptionId: "rx-persisted-3c4d", transmittedAt: T0.toISOString() };
          },
        });
        const pass = await runTransmitNewRxForOrg(
          { ...deps(vendor), warn: (fields, message) => warnings.push({ fields, message }) },
          ORG_A,
        );
        expect(sends).toEqual([]); // the send was never reached
        expect(pass).toMatchObject({ claimed: 1, transmitted: 0, skipped: 1 });
        expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed", rx: null });
        expect(warnings.filter((w) => /no longer owns/.test(w.message))).toHaveLength(1);
        expect(JSON.stringify(warnings)).not.toContain("rx-persisted-3c4d");
      });

      it("RESUME (control): while the worker still owns the call, a persisted created id is sent as before", async () => {
        const sends: string[] = [];
        const { orderId, transmissionId } = await queued();
        await h.admin.query(
          "UPDATE medication_order_transmission SET dosespot_prescription_id='rx-persisted-5e6f' WHERE id=$1",
          [transmissionId],
        );
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, payload, _key, resume) => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A); // held by the drain, not resolved
            await resume?.beforeSend?.();
            sends.push(payload.medicationOrderId);
            return { dosespotPrescriptionId: "rx-persisted-5e6f", transmittedAt: T0.toISOString() };
          },
        });
        expect((await runTransmitNewRxForOrg(deps(vendor), ORG_A)).transmitted).toBe(1);
        expect(sends).toEqual([orderId]);
      });

      it("the cron tick reports the skipped order", async () => {
        const run = await scenario(async () => {
          throw retryable();
        });
        const runners = buildM12CronRunners({
          ...run.world,
          connection: {} as never,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
          config: { isConfiguredFor: async () => true, configFor: async () => ({}) } as never,
        });
        await runners.transmitNewRx();
        expect(run.warnings.map((w) => w.fields)).toContainEqual({
          cron: "M12_TRANSMIT_NEWRX",
          deferredByOutage: 0,
          skipped: 1,
          orgsSkippedByConfigFault: 0,
        });
      });
    });

    // LOW (lock order): the worker's settle takes the ORDER row before the transmission row, the order the administrator's resolution takes, so a late
    // answer racing a resolution cannot deadlock (40P01). The interleaving is FORCED, not left to timing: an administrator's connection holds the order
    // row's lock, the first of the two is started and seen blocked (pg_stat_activity), the second is started and seen blocked, and only then is the lock
    // released. With the old order (the settle writing the transmission row, then the order) the resolution wins the order row while the settle holds the
    // transmission row, and Postgres kills one of them with a deadlock.
    for (const first of ["resolution", "late failure"] as const) {
      it(`LOCK ORDER, forced: a late failure and an administrator's resolution both waiting on the order row, the ${first} first, never deadlock and leave a coherent order`, async () => {
        const { orderId } = await queued();
        // pg_locks, not pg_stat_activity: the latter is a per-transaction snapshot, and the admin connection polling here is inside one
        const blocked = async () =>
          Number(
            (
              await h.q(
                "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()",
              )
            )[0]?.n,
          );
        const untilBlocked = async (n: number) => {
          for (let i = 0; i < 200; i += 1) {
            if ((await blocked()) >= n) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const who = await h.q(
            "SELECT pid, locktype, granted FROM pg_locks WHERE locktype IN ('transactionid', 'tuple')",
          );
          throw new Error(`fewer than ${n} backends ever waited on a lock: ${JSON.stringify(who)}`);
        };
        const resolution: { current?: Promise<PromiseSettledResult<unknown>[]> } = {};
        const startResolution = () => {
          resolution.current = Promise.allSettled([resolveNotSent(orderId)]);
        };
        const vendor = new FakeDoseSpotVendor({
          transmit: async () => {
            await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A); // the drain holds the slow claim
            await h.admin.query("BEGIN");
            await h.admin.query("SELECT 1 FROM medication_order WHERE id=$1 FOR UPDATE", [orderId]);
            if (first === "resolution") {
              startResolution();
              await untilBlocked(1);
            }
            throw retryable(); // the call's own late, retryable failure
          },
        });
        let released = false;
        try {
          const pass = runTransmitNewRxForOrg(deps(vendor), ORG_A);
          if (first === "late failure") {
            await untilBlocked(1);
            startResolution();
          }
          await untilBlocked(2);
          released = true;
          await h.admin.query("COMMIT");
          const result = await pass; // a deadlock would reject here (or fail the resolution below)
          const [settled] = (await resolution.current) as PromiseSettledResult<unknown>[];
          if (first === "resolution") {
            expect(settled?.status).toBe("fulfilled");
            expect((await orderRow(orderId)).status).toBe("transmission_failed");
            expect(result).toMatchObject({ skipped: 1, requeued: 0 }); // the late failure found the order resolved
          } else {
            expect((settled as PromiseRejectedResult).reason).toMatchObject({
              code: "DOSESPOT_TRANSMISSION_NOT_HELD", // the failure replaced the marker first: the resolution is refused, cleanly
            });
            expect(await orderRow(orderId)).toMatchObject({
              status: "queued_for_transmission",
              s: "queued",
            });
            expect(result).toMatchObject({ requeued: 1, skipped: 0 });
          }
        } finally {
          if (!released) await h.admin.query("ROLLBACK").catch(() => undefined);
        }
      });
    }

    // LOW: the drain's hold re-applied a marker a worker had already set but not yet committed, and published the event twice.
    it("the drain's hold does not re-apply or re-announce a marker a worker is setting at the same moment", async () => {
      const { orderId, transmissionId } = await queued();
      await h.admin.query(
        "UPDATE medication_order SET dosespot_send_state='in_flight', updated_at = now() - interval '3 hours' WHERE id=$1",
        [orderId],
      );
      await h.admin.query(
        "UPDATE medication_order_transmission SET transmission_started_at = now() - interval '3 hours' WHERE id=$1",
        [transmissionId],
      );
      // another worker's hold, set but not yet committed (its own event, if any, belongs to that transaction)
      await h.admin.query("BEGIN");
      await h.admin.query(
        "UPDATE medication_order_transmission SET last_error_class='unconfirmed_outcome', last_error_detail='worker hold' WHERE id=$1",
        [transmissionId],
      );
      const drain = runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A); // reads the old row, then waits on the lock
      await new Promise((resolve) => setTimeout(resolve, 400));
      await h.admin.query("COMMIT");
      await drain;
      expect(await eventsFor("m12.medication_order.transmission_unconfirmed", orderId)).toEqual([]);
      expect((await txRow(transmissionId as string)).last_error_detail).toBe("worker hold");
    });

    // ITEM 0 of the next round: `idempotency_key` is sha256(prescriber, patient, drug, strength, sig) and unique per organization, and the sign-time
    // enqueue REUSED an existing row on a conflict without asking whose it was. A retransmit by the authoring prescriber (the standing rule allows it)
    // mints a replacement with exactly the same content, so it found the FAILED order's row and was queued with none of its own; the worker finds
    // transmissions by order id, so the replacement sat queued forever, never sent. The same holds for any second order with the same content (a refill).
    describe("a replacement order with the same content is sent under its OWN transmission row (retransmit, refill)", () => {
      const enqueueSigned = async (orderId: string) =>
        inOrg(h.handle.db, ORG_A, async (tx) => {
          const { schema } = await import("@chartwarden/db");
          const { eq } = await import("drizzle-orm");
          const [row] = await tx
            .select()
            .from(schema.medicationOrders)
            .where(eq(schema.medicationOrders.id, orderId));
          return enqueueTransmissionIfBound(
            tx,
            h.outbox,
            ORG_A,
            row as NonNullable<typeof row>,
            new Date(),
          );
        });
      /** A signed order enqueued through the real sign-time path (so it carries the D8 key, not a seeded one). */
      const signedAndEnqueued = async (patientId: string) => {
        const { orderId } = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "signed",
          sendState: "not_required",
          transmission: false,
        });
        expect(await enqueueSigned(orderId)).toBe(true);
        return orderId;
      };
      const ownRows = async (orderId: string) =>
        (await h.q(
          "SELECT id, idempotency_key FROM medication_order_transmission WHERE medication_order_id=$1",
          [orderId],
        )) as { id: string; idempotency_key: string }[];
      const sendsOf = (calls: { orderId: string; key: string }[], orderId: string) =>
        calls.filter((c) => c.orderId === orderId);

      for (const how of ["exhausted its retries", "was resolved NOT SENT"] as const) {
        it(`a retransmit by the authoring prescriber of an order that ${how} gets its own row and a different Idempotency-Key, and is sent`, async () => {
          const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
          const patientId = await h.seedPatient(ORG_A, { synced: "501" });
          const original = await signedAndEnqueued(patientId);
          const calls: { orderId: string; key: string }[] = [];
          const failing = new FakeDoseSpotVendor({
            transmit: async (_org, payload, key) => {
              calls.push({ orderId: payload.medicationOrderId, key });
              throw how === "exhausted its retries" ? permanent() : unconfirmed();
            },
          });
          await runTransmitNewRxForOrg(deps(failing), ORG_A);
          if (how === "was resolved NOT SENT") await resolveNotSent(original);
          expect((await orderRow(original)).status).toBe("transmission_failed");

          // the replacement a retransmit mints (same patient, drug, strength and sig; the SAME prescriber), signed
          const { newOrderId } = await backend.retransmit(ORG_A, h.memberOf[ORG_A], original, {
            signerDisciplines: ["hospice_physician"],
          });
          await h.admin.query("UPDATE medication_order SET status='signed' WHERE id=$1", [
            newOrderId,
          ]);
          expect(await enqueueSigned(newOrderId)).toBe(true);
          expect(await ownRows(newOrderId)).toHaveLength(1); // its own row, not the failed order's

          const ok = new FakeDoseSpotVendor({
            transmit: async (_org, payload, key) => {
              calls.push({ orderId: payload.medicationOrderId, key });
              return { dosespotPrescriptionId: "rx-replacement", transmittedAt: T0.toISOString() };
            },
          });
          const pass = await runTransmitNewRxForOrg(deps(ok, minutes(1)), ORG_A);
          expect(pass).toMatchObject({ claimed: 1, transmitted: 1 });
          expect(await orderRow(newOrderId)).toMatchObject({
            status: "transmitted",
            rx: "rx-replacement",
          });
          // a retransmit after a definite failure must not be deduped into the failed one at DoseSpot
          const failedKey = sendsOf(calls, original)[0]?.key;
          const replacementKey = sendsOf(calls, newOrderId)[0]?.key;
          expect(replacementKey).toBeDefined();
          expect(replacementKey).not.toBe(failedKey);
        });
      }

      it("a second order with the same content as one already transmitted (a refill mint, say) is sent under its own row", async () => {
        const patientId = await h.seedPatient(ORG_A, { synced: "501" });
        const first = await signedAndEnqueued(patientId);
        const calls: { orderId: string; key: string }[] = [];
        const ok = new FakeDoseSpotVendor({
          transmit: async (_org, payload, key) => {
            calls.push({ orderId: payload.medicationOrderId, key });
            return {
              dosespotPrescriptionId: `rx-${calls.length}`,
              transmittedAt: T0.toISOString(),
            };
          },
        });
        expect((await runTransmitNewRxForOrg(deps(ok), ORG_A)).transmitted).toBe(1);
        const second = await signedAndEnqueued(patientId);
        expect(await ownRows(second)).toHaveLength(1);
        expect((await runTransmitNewRxForOrg(deps(ok, minutes(1)), ORG_A)).transmitted).toBe(1);
        expect(await orderRow(second)).toMatchObject({ status: "transmitted", rx: "rx-2" });
        expect(sendsOf(calls, second)[0]?.key).not.toBe(sendsOf(calls, first)[0]?.key);
      });

      it("the sign-time enqueue refuses, loudly, when its key is held by another order's row: it never queues an order no worker can pick up", async () => {
        const patientId = await h.seedPatient(ORG_A, { synced: "501" });
        const { orderId } = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "signed",
          sendState: "not_required",
          transmission: false,
        });
        const other = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "transmission_failed",
          sendState: "failed",
          transmission: false,
        });
        const [row] = await h.q(
          "SELECT rxnorm_rxcui, strength, data, prescriber_membership_id FROM medication_order WHERE id=$1",
          [orderId],
        );
        const rxBusinessKey = computeRxBusinessKey({
          rxnormRxcui: row?.rxnorm_rxcui,
          strength: row?.strength,
          sigFreeText: sigDirections(row?.data.sigStructured),
        });
        await h.admin.query(
          "INSERT INTO medication_order_transmission (organization_id, medication_order_id, idempotency_key, rx_business_key, correlation_id) VALUES ($1,$2,$3,$4,'c-foreign')",
          [
            ORG_A,
            other.orderId,
            computeNewRxIdempotencyKey({
              prescriberMembershipId: row?.prescriber_membership_id,
              patientId,
              rxBusinessKey,
              medicationOrderId: orderId,
            }),
            rxBusinessKey,
          ],
        );
        await expect(enqueueSigned(orderId)).rejects.toThrow(/belongs to another order/);
        expect((await orderRow(orderId)).status).toBe("signed"); // not queued
      });

      it("the sign-time enqueue of the SAME order twice still shares one row (the double-sign the key exists for)", async () => {
        const patientId = await h.seedPatient(ORG_A, { synced: "501" });
        const orderId = await signedAndEnqueued(patientId);
        // a racing second sign of the same order: it saw `not_required` before the first committed, so it reaches the insert
        await h.admin.query(
          "UPDATE medication_order SET status='signed', dosespot_send_state='not_required' WHERE id=$1",
          [orderId],
        );
        expect(await enqueueSigned(orderId)).toBe(true);
        expect(await ownRows(orderId)).toHaveLength(1);
      });
    });

    it("an ambiguous outcome among clean ones holds only its own order", async () => {
      const first = await queued();
      const second = await queued();
      let calls = 0;
      const vendor = new FakeDoseSpotVendor({
        transmit: async (_org, payload) => {
          calls += 1;
          if (payload.medicationOrderId === first.orderId) throw unconfirmed();
          return { dosespotPrescriptionId: "rx-ok", transmittedAt: new Date().toISOString() };
        },
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(calls).toBe(2);
      expect(pass).toMatchObject({ claimed: 2, held: 1, transmitted: 1 });
      expect((await orderRow(first.orderId)).s).toBe("in_flight");
      expect((await orderRow(second.orderId)).status).toBe("transmitted");
    });
  });

  // Review of slice 4, MEDIUM-1: the hold had no way out. An organization administrator who checked the prescriber's DoseSpot account resolves
  // it: SENT (with the prescription id) or NOT SENT. Both are accepted only while the hold marker is on the transmission row, under a row lock.
  describe("an administrator resolves a held order", () => {
    const REASON = "Checked the prescriber's DoseSpot account on 11/6 with the clinic lead.";
    const resolver = () =>
      createTransmissionResolveService({
        db: h.handle.db,
        outbox: h.outbox,
        audit: buildClinicAuditPort(),
      });
    const actorFor = async (org = ORG_A) => ({
      organizationId: org,
      userId: USER,
      membershipId: (
        await h.q("SELECT id FROM membership WHERE organization_id=$1 LIMIT 1", [org])
      )[0]?.id as string,
    });
    const hold = async () => {
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => {
          throw new UnconfirmedOutcomeError(
            "dosespot",
            "transmitNewRx",
            "DoseSpot returned an unreadable response.",
            "c-held",
          );
        },
      });
      await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      return { orderId, transmissionId: transmissionId as string };
    };
    const eventsFor = async (type: string, orderId: string) =>
      (await h.eventsOf(type, ORG_A)).filter(
        (e) => (e.payload as { orderId?: string }).orderId === orderId,
      );
    const never = new FakeDoseSpotVendor({
      transmit: async () => {
        throw new Error("nothing may be sent for a resolved order");
      },
    });
    const errorCodeOf = async (promise: Promise<unknown>) =>
      promise.then(
        () => "",
        (e: unknown) => (e as { code?: string }).code ?? "",
      );

    it("SENT: the order becomes transmitted with the vendor id recorded, the transmitted event goes out as for a worker success, the status poll follows it, and nothing is sent", async () => {
      const { orderId, transmissionId } = await hold();
      const before = await orderRow(orderId);
      const res = await resolver().resolve(await actorFor(), orderId, {
        outcome: "sent",
        reason: REASON,
        dosespotPrescriptionId: "rx-777",
      });
      expect(res).toEqual({ orderId, outcome: "sent", status: "transmitted" });
      const after = await orderRow(orderId);
      expect(after).toMatchObject({ status: "transmitted", s: "transmitted", rx: "rx-777" });
      expect(Number(after.version)).toBe(Number(before.version) + 1);
      const t = await txRow(transmissionId);
      expect(t).toMatchObject({
        dosespot_prescription_id: "rx-777",
        last_error_class: "resolved_sent",
        last_error_detail: REASON,
      });
      expect(t.transmission_succeeded_at).not.toBeNull();
      const transmitted = await eventsFor("m12.medication_order.transmitted", orderId);
      expect(transmitted).toHaveLength(1);
      expect(transmitted[0]?.payload).toMatchObject({ dosespotPrescriptionId: "rx-777" });
      expect(await eventsFor("m12.medication_order.transmission_failed", orderId)).toEqual([]);
      // the audit entry is ids and the outcome only; the reason is on the (denylisted) transmission column, in no audit image
      const audits = await h.q(
        "SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m12.dosespot_order.transmission_resolved' AND resource_id=$2",
        [ORG_A, orderId],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.context).toMatchObject({ outcome: "sent", transmissionId });
      expect(JSON.stringify(audits[0]?.context)).not.toContain("DoseSpot account");
      const leaks = await h.q(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND (before::text LIKE '%DoseSpot account on 11/6%' OR after::text LIKE '%DoseSpot account on 11/6%' OR context::text LIKE '%DoseSpot account on 11/6%')",
        [ORG_A],
      );
      expect(leaks[0]?.n).toBe(0);
      // the poll follows it like any transmitted order, and neither a tick nor the drain sends it
      const poll = new FakeDoseSpotVendor({
        prescriptionStatus: async (_o, _p, rxId) => ({
          dosespotPrescriptionId: rxId,
          phase: "sent",
          rawStatus: "raw-sent",
          observedAt: T0.toISOString(),
        }),
      });
      await runTransmissionSweepForOrg(deps(poll), ORG_A);
      expect(await orderRow(orderId)).toMatchObject({ status: "active", s: "acked" });
      expect((await runTransmitNewRxForOrg(deps(never), ORG_A)).claimed).toBe(0);
    });

    it("NOT SENT: the order becomes transmission_failed (the retransmit path), the failed event goes out, and it is never put back on the queue or sent", async () => {
      const { orderId, transmissionId } = await hold();
      const res = await resolver().resolve(await actorFor(), orderId, {
        outcome: "not_sent",
        reason: REASON,
      });
      expect(res).toEqual({ orderId, outcome: "not_sent", status: "transmission_failed" });
      expect(await orderRow(orderId)).toMatchObject({ status: "transmission_failed", s: "failed" });
      const t = await txRow(transmissionId);
      expect(t).toMatchObject({ last_error_class: "resolved_not_sent", last_error_detail: REASON });
      expect(t.transmission_failed_at).not.toBeNull();
      expect(t.transmission_succeeded_at).toBeNull();
      const failed = await eventsFor("m12.medication_order.transmission_failed", orderId);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        lastErrorClass: "resolved_not_sent",
        retryCount: 0,
      });
      expect(await eventsFor("m12.medication_order.transmitted", orderId)).toEqual([]);
      await h.admin.query(
        "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
        [orderId],
      );
      expect((await runTransmitNewRxForOrg(deps(never), ORG_A)).claimed).toBe(0);
      expect((await runRecoveryDrainForOrg(deps(never, minutes(300)), ORG_A)).released).toBe(0);
      expect((await orderRow(orderId)).status).toBe("transmission_failed");
    });

    it("is refused unless the order is still HELD: an ordinary queued order, a transmitted one, an already-resolved one and an unknown one", async () => {
      const resolved = await hold(); // (its pass claims every queued order of the org, so the plain queued order is made AFTER it)
      const queuedOnly = await queued();
      const sent = await h.seedOrder({
        org: ORG_A,
        patientId: await h.seedPatient(ORG_A, { synced: "501" }),
        status: "transmitted",
        sendState: "transmitted",
        dosespotPrescriptionId: "rx-9",
        transmittedAt: T0,
      });
      await resolver().resolve(await actorFor(), resolved.orderId, {
        outcome: "not_sent",
        reason: REASON,
      });
      const input = { outcome: "not_sent", reason: REASON } as const;
      for (const id of [queuedOnly.orderId, sent.orderId, resolved.orderId]) {
        expect(await errorCodeOf(resolver().resolve(await actorFor(), id, input)), id).toBe(
          "DOSESPOT_TRANSMISSION_NOT_HELD",
        );
      }
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(), "99999999-9999-4999-8999-999999999999", input),
        ),
      ).toBe("NOT_FOUND");
      expect((await orderRow(queuedOnly.orderId)).s).toBe("queued"); // nothing was touched
    });

    it("another organization's administrator cannot resolve it (404 under RLS) and it stays held", async () => {
      const { orderId } = await hold();
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(ORG_B), orderId, {
            outcome: "not_sent",
            reason: REASON,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect((await orderRow(orderId)).s).toBe("in_flight");
    });

    it("a reason that says nothing is refused (422 DOSESPOT_REASON_REQUIRED) however it is padded, and the stored reason is trimmed", async () => {
      const { orderId, transmissionId } = await hold();
      for (const reason of ["          ", "   short   ", "\n\t \n\t \n\t \n\t "]) {
        expect(
          await errorCodeOf(
            resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason }),
          ),
          JSON.stringify(reason),
        ).toBe("DOSESPOT_REASON_REQUIRED");
      }
      expect((await orderRow(orderId)).s).toBe("in_flight");
      await resolver().resolve(await actorFor(), orderId, {
        outcome: "not_sent",
        reason: `   ${REASON}   `,
      });
      expect((await txRow(transmissionId)).last_error_detail).toBe(REASON);
    });

    it("sent needs the prescription id and not sent refuses one (422), before the order is touched", async () => {
      const { orderId } = await hold();
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(), orderId, { outcome: "sent", reason: REASON }),
        ),
      ).toBe("DOSESPOT_PRESCRIPTION_ID_REQUIRED");
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(), orderId, {
            outcome: "not_sent",
            reason: REASON,
            dosespotPrescriptionId: "rx-1",
          }),
        ),
      ).toBe("DOSESPOT_PRESCRIPTION_ID_UNEXPECTED");
      expect((await orderRow(orderId)).s).toBe("in_flight");
    });

    it("RACE: two resolutions of one held order, in parallel, cannot both win (one succeeds, the other is 409), and exactly one outcome event exists", async () => {
      const pairs = await Promise.all([hold(), hold(), hold(), hold()]);
      for (const { orderId } of pairs) {
        const settled = await Promise.allSettled([
          resolver().resolve(await actorFor(), orderId, {
            outcome: "sent",
            reason: REASON,
            dosespotPrescriptionId: `rx-race-${orderId.slice(0, 8)}`,
          }),
          resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason: REASON }),
        ]);
        const won = settled.filter((r) => r.status === "fulfilled");
        const lost = settled.filter((r) => r.status === "rejected");
        expect(won, orderId).toHaveLength(1);
        expect(lost, orderId).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
          code: "DOSESPOT_TRANSMISSION_NOT_HELD",
        });
        const outcome = (won[0] as PromiseFulfilledResult<{ status: string }>).value.status;
        expect((await orderRow(orderId)).status).toBe(outcome);
        const sentEvents = await eventsFor("m12.medication_order.transmitted", orderId);
        const failedEvents = await eventsFor("m12.medication_order.transmission_failed", orderId);
        expect(sentEvents.length + failedEvents.length).toBe(1);
      }
    });

    it("RACE with the interleaving forced: both resolutions are held at the order's row lock until it is released, and still only one wins", async () => {
      // A free-running pair usually finishes one after the other. Holding the order's row lock from another connection makes both
      // resolutions reach their first statement before either may write, which is the interleaving the lock and the conditional UPDATE exist for.
      const { orderId } = await hold();
      await h.admin.query("BEGIN");
      await h.admin.query("SELECT id FROM medication_order WHERE id=$1 FOR UPDATE", [orderId]);
      const both = Promise.allSettled([
        resolver().resolve(await actorFor(), orderId, {
          outcome: "sent",
          reason: REASON,
          dosespotPrescriptionId: "rx-forced",
        }),
        resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason: REASON }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await h.admin.query("COMMIT");
      const settled = await both;
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "DOSESPOT_TRANSMISSION_NOT_HELD" });
      const sentEvents = await eventsFor("m12.medication_order.transmitted", orderId);
      const failedEvents = await eventsFor("m12.medication_order.transmission_failed", orderId);
      expect(sentEvents.length + failedEvents.length).toBe(1);
    });

    it("an order that is in flight but NOT held (an ordinary claim a worker is processing) cannot be resolved", async () => {
      const { orderId } = await queued();
      await h.admin.query(
        "UPDATE medication_order SET dosespot_send_state='in_flight' WHERE id=$1",
        [orderId],
      );
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason: REASON }),
        ),
      ).toBe("DOSESPOT_TRANSMISSION_NOT_HELD");
      expect((await orderRow(orderId)).s).toBe("in_flight");
    });

    it("RACE: a resolution racing the recovery drain wins cleanly: the drain never re-queues or sends the order, whichever outcome", async () => {
      for (const outcome of ["sent", "not_sent"] as const) {
        const { orderId } = await hold();
        await h.admin.query(
          "UPDATE medication_order SET updated_at = now() - interval '3 hours' WHERE id=$1",
          [orderId],
        );
        const sentOrders: string[] = [];
        const vendor = new FakeDoseSpotVendor({
          transmit: async (_org, payload) => {
            sentOrders.push(payload.medicationOrderId);
            return { dosespotPrescriptionId: "rx-leak", transmittedAt: new Date().toISOString() };
          },
        });
        const [resolution] = await Promise.allSettled([
          resolver().resolve(await actorFor(), orderId, {
            outcome,
            reason: REASON,
            ...(outcome === "sent" ? { dosespotPrescriptionId: "rx-after-race" } : {}),
          }),
          runRecoveryDrainForOrg(deps(vendor, minutes(300)), ORG_A),
        ]);
        expect(resolution.status, outcome).toBe("fulfilled");
        expect(sentOrders, outcome).not.toContain(orderId);
        expect((await orderRow(orderId)).status).toBe(
          outcome === "sent" ? "transmitted" : "transmission_failed",
        );
      }
    });

    // H1: a retryable failure sets transmission_failed_at (the backoff needs it) and nothing cleared it, so a hold that followed an earlier retry was
    // judged "failed" by the read and refused by the resolve. The marker, not the failure timestamp, says the order is held.
    const failOnceThenHold = async () => {
      const { orderId, transmissionId } = await queued();
      const failing = new FakeDoseSpotVendor({
        transmit: async () => {
          throw retryable();
        },
      });
      expect((await runTransmitNewRxForOrg(deps(failing, minutes(0)), ORG_A)).requeued).toBe(1);
      expect((await txRow(transmissionId as string)).transmission_failed_at).not.toBeNull();
      const unconfirmed = new FakeDoseSpotVendor({
        transmit: async () => {
          throw new UnconfirmedOutcomeError(
            "dosespot",
            "transmitNewRx",
            "DoseSpot returned an unreadable response.",
            "c-after-retry",
          );
        },
      });
      expect((await runTransmitNewRxForOrg(deps(unconfirmed, minutes(5)), ORG_A)).held).toBe(1);
      return { orderId, transmissionId: transmissionId as string };
    };

    it("a hold that FOLLOWS an earlier retry is shown as held and resolves both ways", async () => {
      const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
      const asSent = await failOnceThenHold();
      expect((await backend.getTransmission(ORG_A, asSent.orderId)).status).toBe(
        "unconfirmed_outcome",
      );
      await resolver().resolve(await actorFor(), asSent.orderId, {
        outcome: "sent",
        reason: REASON,
        dosespotPrescriptionId: "rx-after-retry",
      });
      expect(await orderRow(asSent.orderId)).toMatchObject({
        status: "transmitted",
        rx: "rx-after-retry",
      });
      expect((await backend.getTransmission(ORG_A, asSent.orderId)).status).toBe("transmitted");

      const asNotSent = await failOnceThenHold();
      expect((await backend.getTransmission(ORG_A, asNotSent.orderId)).status).toBe(
        "unconfirmed_outcome",
      );
      await resolver().resolve(await actorFor(), asNotSent.orderId, {
        outcome: "not_sent",
        reason: REASON,
      });
      expect((await orderRow(asNotSent.orderId)).status).toBe("transmission_failed");
      expect((await backend.getTransmission(ORG_A, asNotSent.orderId)).status).toBe(
        "transmission_failed",
      );
    });

    // H2: webhooks bind an order by dosespot_prescription_id and take the first match, so an id recorded on two orders could land a dispense or a
    // refill on the wrong patient. The "sent" resolution and the worker's own success refuse to record an id another order of the org carries.
    it("SENT with a prescription id another order already carries is refused (409 DOSESPOT_PRESCRIPTION_ID_IN_USE) and the order stays held", async () => {
      const { orderId, transmissionId } = await hold();
      const other = await h.seedOrder({
        org: ORG_A,
        patientId: await h.seedPatient(ORG_A, { synced: "501" }),
        status: "active",
        sendState: "acked",
        dosespotPrescriptionId: "rx-taken",
        transmittedAt: T0,
      });
      expect(
        await errorCodeOf(
          resolver().resolve(await actorFor(), orderId, {
            outcome: "sent",
            reason: REASON,
            dosespotPrescriptionId: "rx-taken",
          }),
        ),
      ).toBe("DOSESPOT_PRESCRIPTION_ID_IN_USE");
      expect(await orderRow(orderId)).toMatchObject({
        status: "queued_for_transmission",
        s: "in_flight",
      });
      expect((await txRow(transmissionId)).last_error_class).toBe("unconfirmed_outcome");
      expect((await orderRow(other.orderId)).rx).toBe("rx-taken"); // the other order is untouched
      // an id nobody carries still works
      await resolver().resolve(await actorFor(), orderId, {
        outcome: "sent",
        reason: REASON,
        dosespotPrescriptionId: "rx-free",
      });
      expect((await orderRow(orderId)).rx).toBe("rx-free");
    });

    it("RACE: two held orders resolved as SENT with the SAME new id, in parallel, cannot both record it (the advisory lock makes check-then-write atomic)", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const a = await hold();
        const b = await hold();
        // hold both orders' row locks so both resolutions are in flight before either may write
        await h.admin.query("BEGIN");
        await h.admin.query(
          "SELECT id FROM medication_order WHERE id = ANY($1::uuid[]) FOR UPDATE",
          [[a.orderId, b.orderId]],
        );
        const id = `rx-dup-${attempt}`;
        const both = Promise.allSettled(
          [a, b].map(async (o) =>
            resolver().resolve(await actorFor(), o.orderId, {
              outcome: "sent",
              reason: REASON,
              dosespotPrescriptionId: id,
            }),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await h.admin.query("COMMIT");
        const settled = await both;
        expect(
          settled.filter((r) => r.status === "fulfilled"),
          `attempt ${attempt}`,
        ).toHaveLength(1);
        const lost = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(lost.reason).toMatchObject({ code: "DOSESPOT_PRESCRIPTION_ID_IN_USE" });
        const carrying = await h.q(
          "SELECT count(*)::int AS n FROM medication_order WHERE organization_id=$1 AND dosespot_prescription_id=$2",
          [ORG_A, id],
        );
        expect(carrying[0]?.n, `attempt ${attempt}`).toBe(1);
      }
    });

    it("the worker's own success refuses to record an id another order carries: the order is HELD (not transmitted), with the event", async () => {
      await h.seedOrder({
        org: ORG_A,
        patientId: await h.seedPatient(ORG_A, { synced: "501" }),
        status: "active",
        sendState: "acked",
        dosespotPrescriptionId: "rx-clash",
        transmittedAt: T0,
      });
      const { orderId, transmissionId } = await queued();
      const vendor = new FakeDoseSpotVendor({
        transmit: async () => ({
          dosespotPrescriptionId: "rx-clash",
          transmittedAt: T0.toISOString(),
        }),
      });
      const pass = await runTransmitNewRxForOrg(deps(vendor), ORG_A);
      expect(pass).toMatchObject({ claimed: 1, held: 1, transmitted: 0 });
      expect(await orderRow(orderId)).toMatchObject({
        status: "queued_for_transmission",
        s: "in_flight",
      });
      const t = await txRow(transmissionId as string);
      expect(t.last_error_class).toBe("unconfirmed_outcome");
      expect(String(t.last_error_detail)).toMatch(/already recorded on another order/);
      expect(
        await eventsFor("m12.medication_order.transmission_unconfirmed", orderId),
      ).toHaveLength(1);
      const carrying = await h.q(
        "SELECT count(*)::int AS n FROM medication_order WHERE organization_id=$1 AND dosespot_prescription_id='rx-clash'",
        [ORG_A],
      );
      expect(carrying[0]?.n).toBe(1);
    });

    it("the transmission read says unconfirmed_outcome while held and the resolved state after", async () => {
      const backend = createDbDoseSpotBackend(h.handle.db, h.outbox);
      const { orderId } = await hold();
      expect((await backend.getTransmission(ORG_A, orderId)).status).toBe("unconfirmed_outcome");
      await resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason: REASON });
      expect((await backend.getTransmission(ORG_A, orderId)).status).toBe("transmission_failed");
    });

    it("a hold that has waited over 24 hours raises ONE reminder (the degradation machinery), and resolving it clears it", async () => {
      await h.admin.query(
        "DELETE FROM outbox_event WHERE event_type IN ('m12.dosespot_degraded','m12.dosespot_recovered')",
      );
      const { orderId, transmissionId } = await hold();
      const clock = { t: Date.now() };
      const store = createInMemoryEpisodeStore(() => clock.t);
      const world: M12CronDeps = {
        ...deps(never),
        episodes: createValkeyEpisodeTracker(store),
        warn: () => undefined,
      };
      const reminders = async (type: string) =>
        (await h.eventsOf(type, ORG_A)).filter(
          (e) => e.payload.breakerName === `dosespot-held_orders_aged:${ORG_A}`,
        );
      expect(await runHeldAgeAlertForOrg(world, ORG_A)).toBe(false); // held for a moment: no reminder yet
      await h.admin.query(
        "UPDATE medication_order_transmission SET transmission_started_at = now() - interval '25 hours' WHERE id=$1",
        [transmissionId],
      );
      expect(await runHeldAgeAlertForOrg(world, ORG_A)).toBe(true);
      expect(await runHeldAgeAlertForOrg(world, ORG_A)).toBe(true);
      const opened = await reminders("m12.dosespot_degraded");
      expect(opened).toHaveLength(1);
      expect(opened[0]?.payload.lastErrorClass).toBe("held_orders_aged");
      await resolver().resolve(await actorFor(), orderId, { outcome: "not_sent", reason: REASON });
      expect(await runHeldAgeAlertForOrg(world, ORG_A)).toBe(false);
      expect(await runHeldAgeAlertForOrg(world, ORG_A)).toBe(false); // the second clean tick announces the recovery
      expect(await reminders("m12.dosespot_recovered")).toHaveLength(1);
      expect(await reminders("m12.dosespot_degraded")).toHaveLength(1);
    });
  });

  // Review of slice 4, M3: the episode memory is shared (Valkey), a recovery is announced by whichever process sees it, and a fault
  // in the store or the publish delays an alert but never drops one or fails a tick. The shared store here is a faithful in-memory
  // stand-in for the SET NX PX / PEXPIRE / DEL subset; the real Valkey is exercised by m12-episode-store.live.test.ts.
  describe("degradation alerts across processes (shared episode store)", () => {
    const sharedStore = () => {
      const clock = { t: Date.now() }; // a test moves time instead of sleeping
      const inner = createInMemoryEpisodeStore(() => clock.t);
      const faults = { down: false };
      const reach = () => {
        if (faults.down) throw new Error("ECONNREFUSED");
      };
      const client: EpisodeStoreClient = {
        set: (async (...args: Parameters<EpisodeStoreClient["set"]>) => {
          reach();
          return (inner.set as (...a: unknown[]) => Promise<"OK" | null>)(...args);
        }) as EpisodeStoreClient["set"],
        pexpire: async (key, ms) => {
          reach();
          return inner.pexpire(key, ms);
        },
        del: async (...keys) => {
          reach();
          return inner.del(...keys);
        },
        exists: async (key) => {
          reach();
          return inner.exists(key);
        },
        incr: async (key) => {
          reach();
          return inner.incr(key);
        },
      };
      return { client, faults, clock };
    };
    const BREAKER = `dosespot-queued_orders_stale:${ORG_A}`;
    const events = async (type: string) =>
      (await h.eventsOf(type, ORG_A)).filter((e) => e.payload.breakerName === BREAKER);
    const staleOrder = async () => {
      const patientId = await h.seedPatient(ORG_A, { synced: "501" });
      const { orderId } = await h.seedOrder({
        org: ORG_A,
        patientId,
        status: "queued_for_transmission",
        sendState: "queued",
      });
      const setAge = (interval: string) =>
        h.admin.query(
          `UPDATE medication_order_transmission SET queued_at = now() - interval '${interval}' WHERE medication_order_id=$1`,
          [orderId],
        );
      await setAge("2 hours");
      return { orderId, setAge };
    };
    const makeReplica = (
      store: EpisodeStoreClient,
      over: Partial<M12CronDeps> = {},
      warnings: { fields: Record<string, string | number>; message: string }[] = [],
    ): M12CronDeps => ({
      ...deps(new FakeDoseSpotVendor({})),
      episodes: createValkeyEpisodeTracker(store),
      warn: (fields, message) => warnings.push({ fields, message }),
      ...over,
    });
    const clearEvents = async () => {
      await h.admin.query(
        "DELETE FROM outbox_event WHERE event_type IN ('m12.dosespot_degraded','m12.dosespot_recovered')",
      );
    };

    it("two replicas raise ONE alert, and the replica that sees the recovery announces it even though the other raised the alert", async () => {
      await clearEvents();
      const { setAge } = await staleOrder();
      const { client, clock } = sharedStore();
      const replicaA = makeReplica(client);
      const replicaB = makeReplica(client);
      expect(await runQueuedAgeAlertForOrg(replicaA, ORG_A)).toBe(true);
      expect(await runQueuedAgeAlertForOrg(replicaB, ORG_A)).toBe(true); // B sees the same fault: no second alert
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
      await setAge("1 minute");
      expect(await runQueuedAgeAlertForOrg(replicaB, ORG_A)).toBe(false); // clean tick 1: not announced yet (no flapping)
      expect(await events("m12.dosespot_recovered")).toHaveLength(0);
      expect(await runQueuedAgeAlertForOrg(replicaB, ORG_A)).toBe(false); // clean tick 2: B, not A, announces the recovery
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
      expect(await runQueuedAgeAlertForOrg(replicaA, ORG_A)).toBe(false);
      expect(await runQueuedAgeAlertForOrg(replicaA, ORG_A)).toBe(false);
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
      // the episode is CLOSED, not merely claimed: long after the claim window nobody announces the recovery a second time
      clock.t += EPISODE_CLAIM_MS + 1_000;
      await runQueuedAgeAlertForOrg(replicaA, ORG_A);
      await runQueuedAgeAlertForOrg(replicaA, ORG_A);
      await runQueuedAgeAlertForOrg(replicaB, ORG_A);
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });

    it("replicas that disagree do not flap: a replica that still sees the fault restarts the clean count, so no recovery is announced", async () => {
      await clearEvents();
      const { setAge } = await staleOrder();
      const { client } = sharedStore();
      const sees = makeReplica(client);
      const doesNotSee = makeReplica(client);
      await runQueuedAgeAlertForOrg(sees, ORG_A);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
      for (let i = 0; i < 4; i += 1) {
        // the fault is visible to one replica and not the other (e.g. each sees its own view of a flaky dependency), alternating ticks
        await setAge("2 hours");
        await runQueuedAgeAlertForOrg(sees, ORG_A);
        await setAge("1 minute");
        await runQueuedAgeAlertForOrg(doesNotSee, ORG_A);
      }
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
      expect(await events("m12.dosespot_recovered")).toHaveLength(0);
    });

    it("a restart does not alert again: a fresh process over the same store joins the open episode", async () => {
      await clearEvents();
      await staleOrder();
      const { client } = sharedStore();
      await runQueuedAgeAlertForOrg(makeReplica(client), ORG_A);
      await runQueuedAgeAlertForOrg(makeReplica(client), ORG_A); // the "restarted" process: a new tracker, same store
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });

    it("a recovery that could not be published is retried on the next tick instead of being lost with the episode", async () => {
      await clearEvents();
      const { setAge } = await staleOrder();
      const { client } = sharedStore();
      const warnings: { fields: Record<string, string | number>; message: string }[] = [];
      let failRecovery = true;
      const publishing = makeReplica(client, {}, warnings);
      const flaky: M12CronDeps = {
        ...publishing,
        outbox: {
          publish: (tx, e) => {
            if (failRecovery && e.eventName === "m12.dosespot_recovered")
              return Promise.reject(new Error("outbox unavailable"));
            return publishing.outbox.publish(tx, e);
          },
        },
      };
      await runQueuedAgeAlertForOrg(flaky, ORG_A);
      await setAge("1 minute");
      await runQueuedAgeAlertForOrg(flaky, ORG_A); // clean tick 1
      await expect(runQueuedAgeAlertForOrg(flaky, ORG_A)).resolves.toBe(false); // clean tick 2 claims it; the publish fails; a tick never fails on it
      expect(await events("m12.dosespot_recovered")).toHaveLength(0);
      expect(warnings.map((w) => w.message)).toContain("M12 recovery event could not be published");
      failRecovery = false;
      await runQueuedAgeAlertForOrg(flaky, ORG_A); // the claim was released and the clean count kept: announced on the very next tick
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
      await runQueuedAgeAlertForOrg(flaky, ORG_A);
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
    });

    // MEDIUM-2: the two windows the previous design left open. A "crash" is modelled as the publish failing AND the release failing (the
    // claim is then all that is left); time then moves past the claim window.
    const withBrokenRelease = (replica: M12CronDeps): M12CronDeps => ({
      ...replica,
      episodes: {
        ...(replica.episodes as NonNullable<M12CronDeps["episodes"]>),
        abortRaise: () => Promise.reject(new Error("release failed")),
        abortClear: () => Promise.reject(new Error("release failed")),
      },
    });
    const failing = (replica: M12CronDeps, eventName: string): M12CronDeps => ({
      ...replica,
      outbox: {
        publish: (tx, e) =>
          e.eventName === eventName
            ? Promise.reject(new Error("outbox unavailable"))
            : replica.outbox.publish(tx, e),
      },
    });

    it("opening window: a claimant whose publish AND release both failed does not block the alert; another replica's ticks do not extend the claim; it is published once the claim lapses", async () => {
      await clearEvents();
      await staleOrder();
      const { client, clock } = sharedStore();
      const crashed = withBrokenRelease(failing(makeReplica(client), "m12.dosespot_degraded"));
      const healthy = makeReplica(client);
      await runQueuedAgeAlertForOrg(crashed, ORG_A); // claim taken, publish failed, release failed
      await runQueuedAgeAlertForOrg(healthy, ORG_A); // sees a claim in progress: nothing, and it must not extend it
      expect(await events("m12.dosespot_degraded")).toHaveLength(0);
      clock.t += EPISODE_CLAIM_MS - 1_000;
      await runQueuedAgeAlertForOrg(healthy, ORG_A); // still inside the window
      expect(await events("m12.dosespot_degraded")).toHaveLength(0);
      clock.t += 2_000; // past the ORIGINAL claim: only true if no tick refreshed it
      await runQueuedAgeAlertForOrg(healthy, ORG_A);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });

    it("closing window: a claimant whose recovery publish AND release both failed leaves the episode open; the recovery is published once the claim lapses", async () => {
      await clearEvents();
      const { setAge } = await staleOrder();
      const { client, clock } = sharedStore();
      const healthy = makeReplica(client);
      await runQueuedAgeAlertForOrg(healthy, ORG_A);
      await setAge("1 minute");
      const crashed = withBrokenRelease(failing(makeReplica(client), "m12.dosespot_recovered"));
      await runQueuedAgeAlertForOrg(crashed, ORG_A);
      await runQueuedAgeAlertForOrg(crashed, ORG_A); // claim taken, publish failed, release failed
      await runQueuedAgeAlertForOrg(healthy, ORG_A); // sees the recovery claimed: nothing
      expect(await events("m12.dosespot_recovered")).toHaveLength(0);
      clock.t += EPISODE_CLAIM_MS + 1_000;
      await runQueuedAgeAlertForOrg(healthy, ORG_A);
      expect(await events("m12.dosespot_recovered")).toHaveLength(1);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });

    it("an alert that could not be published is retried on the next tick (the episode is released)", async () => {
      await clearEvents();
      await staleOrder();
      const { client } = sharedStore();
      let failOpen = true;
      const publishing = makeReplica(client);
      const flaky: M12CronDeps = {
        ...publishing,
        outbox: {
          publish: (tx, e) =>
            failOpen && e.eventName === "m12.dosespot_degraded"
              ? Promise.reject(new Error("outbox unavailable"))
              : publishing.outbox.publish(tx, e),
        },
      };
      await runQueuedAgeAlertForOrg(flaky, ORG_A);
      expect(await events("m12.dosespot_degraded")).toHaveLength(0);
      failOpen = false;
      await runQueuedAgeAlertForOrg(flaky, ORG_A);
      await runQueuedAgeAlertForOrg(flaky, ORG_A);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });

    it("an unreachable episode store never fails the tick and never drops the alert: it is raised once the store is back", async () => {
      await clearEvents();
      await staleOrder();
      const { client, faults } = sharedStore();
      const warnings: { fields: Record<string, string | number>; message: string }[] = [];
      const replica = makeReplica(client, {}, warnings);
      faults.down = true;
      await expect(runQueuedAgeAlertForOrg(replica, ORG_A)).resolves.toBe(true);
      expect(await events("m12.dosespot_degraded")).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields).toMatchObject({
        organizationId: ORG_A,
        kind: "queued_orders_stale",
      });
      faults.down = false;
      await runQueuedAgeAlertForOrg(replica, ORG_A);
      await runQueuedAgeAlertForOrg(replica, ORG_A);
      expect(await events("m12.dosespot_degraded")).toHaveLength(1);
    });
    // The point of the whole path: the alert must REACH someone. Real catalog-validating publisher, real dispatcher, real AlertEmitter and the
    // seeded platform rules, against an organization that has an administrator and one that has none.
    describe("the alerts reach the tenant's administrators (publisher -> dispatcher -> M36 consumer -> seeded rule)", () => {
      let dispatcher: ReturnType<typeof createOutboxDispatcher>;
      let emitter: ReturnType<typeof createDrizzleAlertEmitter>;
      let adminUserId: string;
      beforeAll(async () => {
        // earlier tests of this suite published events nothing consumed; the dispatcher polls a bounded batch oldest first, so start clean
        await h.admin.query("DELETE FROM outbox_event");
        const member = (
          await h.q("SELECT id, user_id FROM membership WHERE organization_id=$1", [ORG_A])
        )[0];
        adminUserId = member.user_id as string;
        const roleId = (
          await h.q(
            "INSERT INTO role (organization_id, key, name, category) VALUES ($1,'org_admin','org_admin','admin_executive') RETURNING id",
            [ORG_A],
          )
        )[0].id as string;
        await h.q(
          "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
          [ORG_A, member.id, roleId],
        );
        emitter = createDrizzleAlertEmitter(h.handle.db);
        await wireAlertRuleSeed(h.handle.db);
        dispatcher = createOutboxDispatcher({
          db: h.handle.db,
          orgs: {
            listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
          },
          consumers: [buildM36DosespotAlertConsumer(emitter)],
          eventCatalog: buildBootOutboxCatalog([M12_OUTBOX_EVENTS]),
          options: { log: () => {} },
        });
      });
      const alertsNamed = (eventType: string) =>
        h.q(
          "SELECT id, severity::text AS severity FROM alert WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
          [ORG_A, eventType],
        );
      const recipientsOf = async (alertId: string) =>
        (
          await h.q(
            "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
            [alertId],
          )
        ).map((r) => r.recipient_user_id as string);

      it("an opened episode pages the administrator once (critical) however often the relay runs, and its recovery sends the paired notice (info)", async () => {
        await clearEvents();
        const { setAge } = await staleOrder();
        const { client } = sharedStore();
        const replica = makeReplica(client);
        await runQueuedAgeAlertForOrg(replica, ORG_A);
        await dispatcher.tick();
        await dispatcher.tick();
        const degraded = await alertsNamed("m12.dosespot_degraded");
        expect(degraded).toHaveLength(1);
        expect(degraded[0]?.severity).toBe("critical");
        expect(await recipientsOf(degraded[0]?.id as string)).toEqual([adminUserId]);
        await setAge("1 minute");
        await runQueuedAgeAlertForOrg(replica, ORG_A);
        await runQueuedAgeAlertForOrg(replica, ORG_A); // the second clean tick announces the recovery
        await dispatcher.tick();
        const recovered = await alertsNamed("m12.dosespot_recovered");
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.severity).toBe("info");
        expect(await recipientsOf(recovered[0]?.id as string)).toEqual([adminUserId]);
      });

      it("a held (unconfirmed) transmission pages the administrator once, critical, naming the order and nothing clinical", async () => {
        await h.admin.query(
          "DELETE FROM outbox_event WHERE event_type='m12.medication_order.transmission_unconfirmed'",
        );
        const patientId = await h.seedPatient(ORG_A, { synced: "501" });
        const { orderId } = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "queued_for_transmission",
          sendState: "queued",
        });
        const vendor = new FakeDoseSpotVendor({
          transmit: async () => {
            throw new UnconfirmedOutcomeError("dosespot", "transmitNewRx", "no id", "c-held");
          },
        });
        await runTransmitNewRxForOrg(deps(vendor), ORG_A);
        await dispatcher.tick();
        await dispatcher.tick();
        // earlier tests of this suite held orders of their own: this order's alert is the one named by its id
        const held = await h.q(
          "SELECT id, severity::text AS severity FROM alert WHERE organization_id=$1 AND event_type=$2 AND payload->>'orderId'=$3",
          [ORG_A, "m12.medication_order.transmission_unconfirmed", orderId],
        );
        expect(held).toHaveLength(1);
        expect(held[0]?.severity).toBe("critical");
        expect(await recipientsOf(held[0]?.id as string)).toEqual([adminUserId]);
        const payload = (await h.q("SELECT payload FROM alert WHERE id=$1", [held[0]?.id]))[0]
          ?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({ orderId, lastErrorClass: "unconfirmed_outcome" });
        expect(JSON.stringify(payload)).not.toMatch(/Morphine|patient/i);
      });

      it("an order that exhausted its retries pages the administrator once (critical): the event used to be described as an M36 alert and had no consumer", async () => {
        const patientId = await h.seedPatient(ORG_A, { synced: "501" });
        const { orderId } = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "queued_for_transmission",
          sendState: "queued",
        });
        const vendor = new FakeDoseSpotVendor({
          transmit: async () => {
            throw new DegradedError(
              "dosespot",
              "transmitNewRx",
              false,
              "rejected (HTTP 422).",
              "c-x",
            );
          },
        });
        await runTransmitNewRxForOrg(deps(vendor), ORG_A); // a permanent rejection exhausts the budget at once
        expect((await orderRow(orderId)).status).toBe("transmission_failed");
        await dispatcher.tick();
        await dispatcher.tick();
        const failed = await h.q(
          "SELECT id, severity::text AS severity, payload FROM alert WHERE organization_id=$1 AND event_type=$2 AND payload->>'orderId'=$3",
          [ORG_A, "m12.medication_order.transmission_failed", orderId],
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]?.severity).toBe("critical");
        expect(await recipientsOf(failed[0]?.id as string)).toEqual([adminUserId]);
        expect(failed[0]?.payload).toMatchObject({
          orderId,
          lastErrorClass: "degraded_non_retryable",
        });
        expect(JSON.stringify(failed[0]?.payload)).not.toMatch(/Morphine|patient/i);
      });

      it("the registration's deactivation alert (raised directly by the clinic service) now has a recipient too", async () => {
        await alertAfterCommit(
          {
            dispatch: async ({ alertCode, severity, organizationId, payload }) => {
              await emitter.emit(organizationId, {
                eventType: alertCode,
                payload,
                severity,
                correlationId: `m12-clinic:${alertCode}:${randomUUID()}`,
              });
            },
          },
          ORG_A,
          { id: randomUUID(), environment: "production", version: 3 },
          { kind: "deactivated", cause: "deactivated" },
        );
        const sent = await alertsNamed("m12.dosespot_config.deactivated");
        expect(sent).toHaveLength(1);
        expect(await recipientsOf(sent[0]?.id as string)).toEqual([adminUserId]);
      });
    });
  });

  it("breaker edges are published as m12.dosespot_degraded / m12.dosespot_recovered", async () => {
    const rec = createBreakerEdgeRecorder();
    rec.record({ organizationId: ORG_A, edge: "opened", lastErrorClass: "5xx_503" });
    rec.record({ organizationId: ORG_A, edge: "closed", lastErrorClass: "" });
    expect(await rec.flush(h.handle.db, h.outbox, () => T0)).toBe(2);
    expect((await h.eventsOf("m12.dosespot_degraded", ORG_A)).length).toBeGreaterThanOrEqual(1);
    expect((await h.eventsOf("m12.dosespot_recovered", ORG_A)).length).toBeGreaterThanOrEqual(1);
    expect(await rec.flush(h.handle.db, h.outbox, () => T0)).toBe(0);
  });
});
