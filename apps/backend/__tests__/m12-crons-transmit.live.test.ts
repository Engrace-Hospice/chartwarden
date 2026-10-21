/**
 * GAP-037 — M12 transmission crons over real Postgres as the real NOBYPASSRLS `chartwarden_app` role, with the REAL
 * catalog-validating publisher. Covers: the sign-time enqueue, `transmit_newrx` (success / retryable / exhausted /
 * permanent / breaker-open / unsynced patient / incomplete order / concurrent claim), the queued-on-recovery
 * reclaim, the status-poll + timeout sweep, and the breaker-edge events. Only the DoseSpot vendor is a test double
 * (`FakeDoseSpotVendor`); every UPDATE asserted here matches by id and checks its row count.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12:crons-transmit:live
 */
import { DegradedError } from "@chartwarden/dosespot";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueTransmissionIfBound } from "../src/modules/12-dosespot/index";
import { inOrg } from "../src/modules/12-dosespot/jobs/cron-common";
import {
  type M12CronDeps,
  createBreakerEdgeRecorder,
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
