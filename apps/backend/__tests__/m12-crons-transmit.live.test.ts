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
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  createLayeredTenantConfigResolver,
} from "@chartwarden/dosespot";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ClinicSecretCipher,
  createDrizzleTenantConfigSource,
  enqueueTransmissionIfBound,
} from "../src/modules/12-dosespot/index";
import { inOrg } from "../src/modules/12-dosespot/jobs/cron-common";
import { staleQueuedOrdersQuery } from "../src/modules/12-dosespot/jobs/degradation-reports";
import {
  type M12CronDeps,
  buildM12CronRunners,
  createBreakerEdgeRecorder,
  createEpisodeTracker,
  runRecoveryDrainForOrg,
  runTransmissionSweepForOrg,
  runTransmitNewRxForOrg,
} from "../src/modules/12-dosespot/jobs/index";
import { FakeDoseSpotVendor } from "./_fake-dosespot-vendor";
import { GOOD_DATA, type M12Live, ORG_A, ORG_B, setupM12Live } from "./_m12-live-harness";

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
    const fakeFetch: DoseSpotFetch = async (url) => {
      vendorRequests.push(url);
      if (url.endsWith("/connect/token"))
        return {
          status: 200,
          text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        };
      if (url.endsWith("/prescriptions/send"))
        return { status: 200, text: async () => JSON.stringify({ Items: [{ Id: 9001 }] }) };
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
        await runners.transmitNewRx();
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(1);
        await runners.transmitNewRx();
        expect(await eventsNamed("m12.dosespot_recovered", breaker)).toHaveLength(1);
        expect(await eventsNamed("m12.dosespot_degraded", breaker)).toHaveLength(1);
      });
    });

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
