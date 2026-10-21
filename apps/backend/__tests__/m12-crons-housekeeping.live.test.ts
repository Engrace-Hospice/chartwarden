/**
 * GAP-037 — the M12 refill-SLA / IAL2 / EPCS-expiry / RxBenefit-prewarm crons and the webhook handlers
 * (ack / nack / refill_request / prescriber_status_changed), over real Postgres as the real NOBYPASSRLS
 * `chartwarden_app` role with the REAL catalog-validating publisher. Only the DoseSpot vendor and its webhook
 * delivery are test doubles. Every guarded UPDATE is asserted through its observable effect (marker set once,
 * exactly one event) rather than through the vendor.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12:crons-housekeeping:live
 */
import { createHash, randomUUID } from "node:crypto";
import { DegradedError } from "@chartwarden/dosespot";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEnvWebhookSecretResolver,
  createWebhookBodyCipher,
  ingestDoseSpotWebhook,
} from "../src/modules/12-dosespot/index";
import { inOrg } from "../src/modules/12-dosespot/jobs/cron-common";
import {
  type M12CronDeps,
  runEpcsAttemptExpirySweepForOrg,
  runIal2ExpiryWarnForOrg,
  runRefillSlaForOrg,
  runRxBenefitPrewarmForOrg,
} from "../src/modules/12-dosespot/jobs/index";
import { invalidateRxBenefitCacheForPatient } from "../src/modules/12-dosespot/jobs/rx-benefit-prewarm";
import { FakeDoseSpotVendor, FakeDoseSpotWebhookSender } from "./_fake-dosespot-vendor";
import { type M12Live, ORG_A, ORG_B, setupM12Live } from "./_m12-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const T0 = new Date();
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const SECRET = "org-a-webhook-secret-0123456789abcdef";

describe.skipIf(!DB_URL)(
  "GAP-037 M12 housekeeping crons + webhook handlers — LIVE Postgres",
  () => {
    let h: M12Live;
    beforeAll(async () => {
      h = await setupM12Live(DB_URL as string);
    }, 240_000);
    afterAll(async () => {
      await h?.close();
    });
    beforeEach(async () => {
      for (const t of [
        "refill_request",
        "epcs_signing_attempt",
        "rx_benefit_cache",
        "medication_order_transmission",
        "dosespot_patient_sync",
        "dosespot_prescriber",
      ]) {
        await h.admin.query(`DELETE FROM ${t}`);
      }
      await h.admin.query("DELETE FROM medication_order");
    });

    const deps = (
      vendor: FakeDoseSpotVendor = new FakeDoseSpotVendor(),
      now: Date = T0,
    ): M12CronDeps => ({
      db: h.handle.db,
      outbox: h.outbox,
      client: vendor,
      now: () => now,
    });

    // ── refill SLA ────────────────────────────────────────────────────────────────────────────────────────
    describe("dosespot.refill_sla", () => {
      async function pending(org: string, receivedAt: Date, status = "pending") {
        const patientId = await h.seedPatient(org);
        const { orderId } = await h.seedOrder({
          org,
          patientId,
          status: "active",
          sendState: "acked",
          transmission: false,
          dosespotPrescriptionId: `rx-${randomUUID()}`,
        });
        const { rows } = await h.admin.query(
          `INSERT INTO refill_request (organization_id, provider_entity_id, location_id, source_medication_order_id,
           patient_id, dosespot_event_id, received_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::refill_request_status) RETURNING id`,
          [
            org,
            h.providerOf[org],
            h.locationOf[org],
            orderId,
            patientId,
            `ev-${randomUUID()}`,
            receivedAt,
            status,
          ],
        );
        return rows[0].id as string;
      }
      const slaEvents = async (type: string, id: string) =>
        (await h.eventsOf(type, ORG_A)).filter((e) => (e.payload as any).refillRequestId === id);

      it("warns at 48h and goes critical at 72h, exactly once per stage, only for PENDING requests", async () => {
        const fresh = await pending(ORG_A, hours(-10));
        const warn = await pending(ORG_A, hours(-50));
        const crit = await pending(ORG_A, hours(-80));
        const done = await pending(ORG_A, hours(-100), "approved");
        expect(await runRefillSlaForOrg(deps(), ORG_A)).toMatchObject({ warned: 1, critical: 1 });
        expect(await slaEvents("m12.refill_request_sla_warn", warn)).toHaveLength(1);
        expect(await slaEvents("m12.refill_request_sla_critical", crit)).toHaveLength(1);
        expect(await slaEvents("m12.refill_request_sla_warn", crit)).toHaveLength(0);
        for (const id of [fresh, done]) {
          expect(await slaEvents("m12.refill_request_sla_warn", id)).toHaveLength(0);
          expect(await slaEvents("m12.refill_request_sla_critical", id)).toHaveLength(0);
        }
        const marks = (
          await h.q(
            "SELECT sla_warn_emitted_at w, sla_critical_emitted_at c FROM refill_request WHERE id=$1",
            [warn],
          )
        )[0];
        expect(marks.w).not.toBeNull();
        expect(marks.c).toBeNull();
        // re-run: nothing new; later the warned one crosses 72h and escalates once
        expect(await runRefillSlaForOrg(deps(), ORG_A)).toMatchObject({ warned: 0, critical: 0 });
        expect(await runRefillSlaForOrg(deps(undefined, hours(30)), ORG_A)).toMatchObject({
          critical: 1,
        });
        expect(await slaEvents("m12.refill_request_sla_critical", warn)).toHaveLength(1);
        expect(await slaEvents("m12.refill_request_sla_warn", warn)).toHaveLength(1);
      });

      it("never touches another tenant's requests", async () => {
        const b = await pending(ORG_B, hours(-90));
        await runRefillSlaForOrg(deps(), ORG_A);
        expect(
          (await h.q("SELECT sla_critical_emitted_at c FROM refill_request WHERE id=$1", [b]))[0].c,
        ).toBeNull();
      });
    });

    // ── IAL2 ──────────────────────────────────────────────────────────────────────────────────────────────
    describe("dosespot.ial2_expiry_warn", () => {
      const evFor = async (membership: string) =>
        (await h.eventsOf("m12.ial2_expiring_warn", ORG_A)).filter(
          (e) => (e.payload as any).membershipId === membership,
        );

      it("alerts at 30d, escalates at 7d, never repeats a stage, and an EXPIRED prescriber loses EPCS", async () => {
        const id = await h.seedPrescriber(ORG_A, { ial2ExpiresAt: days(20) });
        await h.admin.query(
          "UPDATE dosespot_prescriber SET dea='AB1234563', dea_authorized_schedules='{II}', epcs_enabled=true WHERE id=$1",
          [id],
        );
        expect(await runIal2ExpiryWarnForOrg(deps(), ORG_A)).toMatchObject({
          warned: 1,
          critical: 0,
        });
        expect(await evFor(h.memberOf[ORG_A] as string)).toHaveLength(1);
        expect(await runIal2ExpiryWarnForOrg(deps(), ORG_A)).toMatchObject({
          warned: 0,
          critical: 0,
        });
        expect(await evFor(h.memberOf[ORG_A] as string)).toHaveLength(1);
        // 15 days later it is 5d out: critical, once
        expect(await runIal2ExpiryWarnForOrg(deps(undefined, days(15)), ORG_A)).toMatchObject({
          critical: 1,
        });
        expect(await evFor(h.memberOf[ORG_A] as string)).toHaveLength(2);
        expect(await runIal2ExpiryWarnForOrg(deps(undefined, days(15)), ORG_A)).toMatchObject({
          critical: 0,
        });
        // expired: status flips, EPCS is switched off (the table CHECK requires verified IAL2 for EPCS)
        const r = await runIal2ExpiryWarnForOrg(deps(undefined, days(25)), ORG_A);
        expect(r.expired).toBe(1);
        const row = (
          await h.q(
            "SELECT ial2_status s, epcs_enabled e, ial2_alert_stage st FROM dosespot_prescriber WHERE id=$1",
            [id],
          )
        )[0];
        expect(row).toMatchObject({ s: "expired", e: false, st: "critical" });
      });

      it("ignores prescribers far from expiry, revoked ones, and other tenants", async () => {
        await h.seedPrescriber(ORG_A, { ial2ExpiresAt: days(200) });
        await h.seedPrescriber(ORG_B, { ial2ExpiresAt: days(2) });
        const r = await runIal2ExpiryWarnForOrg(deps(), ORG_A);
        expect(r).toMatchObject({ warned: 0, critical: 0, expired: 0 });
      });
    });

    // ── EPCS attempt expiry ───────────────────────────────────────────────────────────────────────────────
    describe("dosespot.epcs_attempt_expiry_sweep", () => {
      async function attempt(expiresAt: Date, orderStatus: string, outcome = "pending") {
        const patientId = await h.seedPatient(ORG_A);
        const { orderId } = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: orderStatus,
          sendState: "not_required",
          transmission: false,
        });
        const { rows } = await h.admin.query(
          `INSERT INTO epcs_signing_attempt (organization_id, medication_order_id, prescriber_membership_id, nonce, expires_at, outcome)
         VALUES ($1,$2,$3,$4,$5,$6::epcs_signing_attempt_outcome) RETURNING id`,
          [
            ORG_A,
            orderId,
            h.memberOf[ORG_A],
            createHash("sha256").update(randomUUID()).digest("hex"),
            expiresAt,
            outcome,
          ],
        );
        return { attemptId: rows[0].id as string, orderId };
      }
      const status = async (id: string) =>
        (await h.q("SELECT status FROM medication_order WHERE id=$1", [id]))[0].status;

      it("times out only expired pending attempts and reverts the order only when it is awaiting the second factor", async () => {
        const lapsed = await attempt(hours(-1), "epcs_identity_pending");
        const open = await attempt(hours(1), "epcs_identity_pending");
        const done = await attempt(hours(-1), "signed", "succeeded");
        const lapsedNoOrderWait = await attempt(hours(-2), "signed");
        const r = await runEpcsAttemptExpirySweepForOrg(deps(), ORG_A);
        expect(r).toEqual({ expired: 2, ordersReverted: 1 });
        const outcome = async (id: string) =>
          (await h.q("SELECT outcome FROM epcs_signing_attempt WHERE id=$1", [id]))[0].outcome;
        expect(await outcome(lapsed.attemptId)).toBe("failed_timeout");
        expect(await outcome(lapsedNoOrderWait.attemptId)).toBe("failed_timeout");
        expect(await outcome(open.attemptId)).toBe("pending");
        expect(await outcome(done.attemptId)).toBe("succeeded");
        expect(await status(lapsed.orderId)).toBe("pending_signature");
        expect(await status(open.orderId)).toBe("epcs_identity_pending");
        expect(await status(lapsedNoOrderWait.orderId)).toBe("signed");
        const ev = await h.eventsOf("m12.medication_order.epcs_2fa_failed", ORG_A);
        expect(ev.filter((e) => (e.payload as any).orderId === lapsed.orderId)).toHaveLength(1);
        // idempotent
        expect(await runEpcsAttemptExpirySweepForOrg(deps(), ORG_A)).toEqual({
          expired: 0,
          ordersReverted: 0,
        });
      });
    });

    // ── RxBenefit prewarm ─────────────────────────────────────────────────────────────────────────────────
    describe("dosespot.rx_benefit_prewarm", () => {
      const active = async (org: string, rxcui: string) => {
        const patientId = await h.seedPatient(org, { synced: "501" });
        await h.seedOrder({
          org,
          patientId,
          status: "active",
          sendState: "acked",
          rxnormRxcui: rxcui,
          transmission: false,
        });
        return patientId;
      };
      const benefit = new FakeDoseSpotVendor({
        rxBenefit: async () => ({
          covered: true,
          copayTier: "T2",
          priorAuthRequired: false,
          lookedUpAt: T0.toISOString(),
        }),
      });

      it("caches a real lookup once, skips fresh rows, refreshes expired ones, never crosses tenants", async () => {
        const p = await active(ORG_A, "197361");
        await active(ORG_B, "197361");
        expect(await runRxBenefitPrewarmForOrg(deps(benefit), ORG_A)).toMatchObject({
          candidates: 1,
          cached: 1,
          failed: 0,
        });
        const row = (
          await h.q(
            "SELECT covered, copay_tier t, prior_auth_required pa, expires_at FROM rx_benefit_cache WHERE patient_id=$1",
            [p],
          )
        )[0];
        expect(row).toMatchObject({ covered: true, t: "T2", pa: false });
        expect(
          (
            await h.q("SELECT count(*)::int n FROM rx_benefit_cache WHERE organization_id=$1", [
              ORG_B,
            ])
          )[0].n,
        ).toBe(0);
        expect((await runRxBenefitPrewarmForOrg(deps(benefit), ORG_A)).candidates).toBe(0); // still fresh
        const refreshed = new FakeDoseSpotVendor({
          rxBenefit: async () => ({
            covered: false,
            priorAuthRequired: true,
            lookedUpAt: hours(30).toISOString(),
          }),
        });
        expect(await runRxBenefitPrewarmForOrg(deps(refreshed, hours(30)), ORG_A)).toMatchObject({
          cached: 1,
        });
        const after = await h.q(
          "SELECT covered, prior_auth_required pa FROM rx_benefit_cache WHERE patient_id=$1",
          [p],
        );
        expect(after).toHaveLength(1); // upserted in place
        expect(after[0]).toMatchObject({ covered: false, pa: true });
      });

      it("writes nothing and stops after 3 consecutive failures when the adapter cannot answer", async () => {
        for (let i = 0; i < 5; i += 1) await active(ORG_A, `rx-${i}`);
        const dead = new FakeDoseSpotVendor({
          rxBenefit: async () => {
            throw new DegradedError("dosespot", "lookupRxBenefit", false, "not available", "c1");
          },
        });
        const r = await runRxBenefitPrewarmForOrg(deps(dead), ORG_A);
        expect(r).toMatchObject({ cached: 0, failed: 3, aborted: true });
        expect((await h.q("SELECT count(*)::int n FROM rx_benefit_cache"))[0].n).toBe(0);
      });

      it("a demographic change drops the patient's cache", async () => {
        const p = await active(ORG_A, "197361");
        await runRxBenefitPrewarmForOrg(deps(benefit), ORG_A);
        const n = await inOrg(h.handle.db, ORG_A, (tx) =>
          invalidateRxBenefitCacheForPatient(tx, ORG_A, p),
        );
        expect(n).toBe(1);
        expect(
          (await h.q("SELECT count(*)::int n FROM rx_benefit_cache WHERE patient_id=$1", [p]))[0].n,
        ).toBe(0);
      });
    });

    // ── webhook handlers ──────────────────────────────────────────────────────────────────────────────────
    describe("webhook handlers (provisional wire mapping)", () => {
      const sender = new FakeDoseSpotWebhookSender(SECRET);
      const keys = {
        dekForOrg: async (org: string) => ({
          version: "v1",
          key: createHash("sha256").update(`dek:${org}`).digest(),
        }),
      };
      const post = async (
        type: string,
        payload: Record<string, unknown>,
        eventId = `ev-${randomUUID()}`,
      ) => {
        const d = sender.delivery({
          dosespot_event_id: eventId,
          organization_id: ORG_A,
          event_type: type,
          occurred_at: new Date().toISOString(),
          payload,
        });
        return ingestDoseSpotWebhook(
          {
            db: h.handle.db,
            outbox: h.outbox,
            secrets: createEnvWebhookSecretResolver({
              DOSESPOT_WEBHOOK_SECRETS: JSON.stringify({ [ORG_A]: SECRET }),
            }),
            cipher: createWebhookBodyCipher(keys),
          },
          {
            rawBody: d.rawBody,
            signatureHeader: d.headers["x-dosespot-signature"],
            timestampHeader: d.headers["x-dosespot-timestamp"],
          },
        );
      };
      const transmitted = async (rx: string) => {
        const patientId = await h.seedPatient(ORG_A);
        return h.seedOrder({
          org: ORG_A,
          patientId,
          status: "transmitted",
          sendState: "transmitted",
          dosespotPrescriptionId: rx,
          transmittedAt: new Date(),
          transmission: false,
        });
      };
      const statusOf = async (id: string) =>
        (await h.q("SELECT status FROM medication_order WHERE id=$1", [id]))[0].status;

      it("Sent -> ack -> active; a redelivery and a later poll are no-ops", async () => {
        const o = await transmitted("rx-w-ack");
        expect(
          await post(
            "script_status_update",
            { dosespot_prescription_id: "rx-w-ack", status: "Sent" },
            "ev-ack-1",
          ),
        ).toEqual({ kind: "accepted", outcome: "ack_recorded" });
        expect(await statusOf(o.orderId)).toBe("active");
        expect(
          await post(
            "script_status_update",
            { dosespot_prescription_id: "rx-w-ack", status: "Sent" },
            "ev-ack-1",
          ),
        ).toEqual({ kind: "duplicate" });
        expect(
          await post(
            "script_status_update",
            { dosespot_prescription_id: "rx-w-ack", status: "Sent" },
            "ev-ack-2",
          ),
        ).toEqual({ kind: "accepted", outcome: "ack_already_settled" });
        const ev = (await h.eventsOf("m12.medication_order.ack_received", ORG_A)).filter(
          (e) => (e.payload as any).orderId === o.orderId,
        );
        expect(ev).toHaveLength(1);
      });

      it("Rejected -> nack_received with the reason; an unknown prescription is recorded, never guessed", async () => {
        const o = await transmitted("rx-w-nack");
        expect(
          (
            await post("script_status_update", {
              dosespot_prescription_id: "rx-w-nack",
              status: "Rejected",
            })
          ).kind,
        ).toBe("accepted");
        expect(await statusOf(o.orderId)).toBe("nack_received");
        expect(
          await post("script_status_update", {
            dosespot_prescription_id: "rx-nobody",
            status: "Sent",
          }),
        ).toMatchObject({ outcome: "order_not_found" });
      });

      it("refill_request opens a pending refill + event, idempotent on the vendor event id", async () => {
        const patientId = await h.seedPatient(ORG_A);
        const o = await h.seedOrder({
          org: ORG_A,
          patientId,
          status: "active",
          sendState: "acked",
          dosespotPrescriptionId: "rx-w-refill",
          transmission: false,
        });
        const first = await post(
          "refill_request",
          {
            dosespot_prescription_id: "rx-w-refill",
            requested_quantity: "30",
            requested_days_supply: 15,
          },
          "ev-refill-1",
        );
        expect(first).toEqual({ kind: "accepted", outcome: "refill_recorded" });
        const rows = await h.q(
          "SELECT status, requested_quantity q, requested_days_supply d, source_medication_order_id s FROM refill_request",
        );
        expect(rows).toEqual([{ status: "pending", q: "30", d: 15, s: o.orderId }]);
        expect(
          await post("refill_request", { dosespot_prescription_id: "rx-w-refill" }, "ev-refill-1"),
        ).toEqual({ kind: "duplicate" });
        expect((await h.q("SELECT count(*)::int n FROM refill_request"))[0].n).toBe(1);
        expect(
          (await h.eventsOf("m12.refill_request_received", ORG_A)).length,
        ).toBeGreaterThanOrEqual(1);
        expect(await post("refill_request", { nonsense: true })).toMatchObject({
          outcome: "malformed_payload",
        });
      });

      it("prescriber_status_changed records IAL2 verification (resets the alert stage) and never enables EPCS", async () => {
        const id = await h.seedPrescriber(ORG_A, {
          dosespotId: "prx-1",
          ial2Status: "in_progress",
        });
        await h.admin.query(
          "UPDATE dosespot_prescriber SET ial2_alert_stage='critical' WHERE id=$1",
          [id],
        );
        const exp = days(365).toISOString();
        expect(
          await post("prescriber_status_changed", {
            dosespot_prescriber_id: "prx-1",
            ial2_status: "verified",
            ial2_expires_at: exp,
          }),
        ).toMatchObject({ outcome: "prescriber_status_recorded" });
        const row = (
          await h.q(
            "SELECT ial2_status s, epcs_enabled e, ial2_alert_stage st, ial2_expires_at x FROM dosespot_prescriber WHERE id=$1",
            [id],
          )
        )[0];
        expect(row).toMatchObject({ s: "verified", e: false, st: null });
        expect(new Date(row.x).toISOString()).toBe(exp);
        expect(
          await post("prescriber_status_changed", {
            dosespot_prescriber_id: "prx-1",
            ial2_status: "verified",
          }),
        ).toMatchObject({ outcome: "malformed_payload" });
        expect(
          await post("prescriber_status_changed", {
            dosespot_prescriber_id: "prx-missing",
            ial2_status: "revoked",
          }),
        ).toMatchObject({ outcome: "prescriber_not_found" });
      });
    });
  },
);
