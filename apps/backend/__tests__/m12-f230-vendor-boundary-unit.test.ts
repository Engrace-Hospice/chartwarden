// apps/backend/__tests__/m12-f230-vendor-boundary-unit.test.ts — F-230 (#248), no database.
// The fail-closed posture and the pure pieces of OUR side of the DoseSpot boundary:
//   • the webhook route is DISABLED (503) without a configured secret, and every pre-persistence rejection
//     (bad/missing signature, tampered body, stale timestamp, malformed envelope, tenant with no secret)
//     returns BEFORE touching the DB (the `db` here throws if touched);
//   • the env secret resolver never invents a default;
//   • the DEK envelope round-trips and is AAD-bound to the org;
//   • `resolveMedicationHistory` (M14 packet port) drops inconsistent facts and is absent — never a fabricated
//     'none' — when the seam is unbound/throws;
//   • the packet builder passes the slot through and the Part 2 redactor zeroes the count;
//   • the packet read model never renders 'not pulled' / 'not captured' as 'no external history'.
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { type PacketBuildInput, applySudRedaction, buildPacketSnapshot } from "@chartwarden/idg";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createEnvWebhookSecretResolver,
  createUnboundWebhookSecretResolver,
  createWebhookBodyCipher,
  registerDoseSpotWebhookRoute,
} from "../src/modules/12-dosespot/index";
import { resolveMedicationHistory } from "../src/modules/14-idg/jobs/packet-build";
import { externalMedicationHistoryView } from "../src/modules/14-idg/routes/packet-content";
import { FakeDoseSpotWebhookSender } from "./_fake-dosespot-vendor";

const ORG = "11111111-1111-4111-8111-111111111111";
const SECRET = "unit-test-secret-0123456789abcdef";
const explodingDb = new Proxy({} as DbClient, {
  get() {
    throw new Error("DB TOUCHED — a rejected webhook must never reach persistence");
  },
});
const noopOutbox = { publish: vi.fn(async () => undefined) };
const cipher = createWebhookBodyCipher({
  dekForOrg: async (org) => ({ version: "v1", key: createHash("sha256").update(org).digest() }),
});
const body = (over: Record<string, unknown> = {}) => ({
  dosespot_event_id: "evt-1",
  organization_id: ORG,
  event_type: "script_status_update",
  occurred_at: "2026-09-29T00:00:00Z",
  payload: { dosespot_prescription_id: "rx-1", status: "Dispensed" },
  ...over,
});

async function app(secretsEnv: Record<string, string | undefined>) {
  const a = Fastify();
  registerDoseSpotWebhookRoute(a, {
    db: explodingDb,
    outbox: noopOutbox,
    secrets: createEnvWebhookSecretResolver(secretsEnv),
    cipher,
    log: () => undefined,
  });
  await a.ready();
  return a;
}
const post = (
  a: Awaited<ReturnType<typeof app>>,
  d: { rawBody: string; headers: Record<string, string> },
) =>
  a.inject({ method: "POST", url: "/webhooks/dosespot", payload: d.rawBody, headers: d.headers });

describe("secret resolver — never a default", () => {
  it("unset / empty / malformed / too-short secrets => unconfigured", () => {
    expect(createUnboundWebhookSecretResolver().isConfigured()).toBe(false);
    for (const v of [
      undefined,
      "",
      "  ",
      "{bad",
      "[]",
      '"str"',
      JSON.stringify({ [ORG]: "short" }),
    ]) {
      expect(createEnvWebhookSecretResolver({ DOSESPOT_WEBHOOK_SECRETS: v }).isConfigured()).toBe(
        false,
      );
    }
  });
  it("a configured map resolves only the named org (case-insensitive id), else null", async () => {
    const r = createEnvWebhookSecretResolver({
      DOSESPOT_WEBHOOK_SECRETS: JSON.stringify({ [ORG.toUpperCase()]: SECRET }),
    });
    expect(r.isConfigured()).toBe(true);
    expect(await r.resolve(ORG)).toBe(SECRET);
    expect(await r.resolve("22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});

describe("POST /webhooks/dosespot — fail-closed before persistence", () => {
  const sender = new FakeDoseSpotWebhookSender(SECRET);
  const env = { DOSESPOT_WEBHOOK_SECRETS: JSON.stringify({ [ORG]: SECRET }) };

  it("is DISABLED (503) when no secret is configured", async () => {
    const a = await app({});
    expect((await post(a, sender.delivery(body()))).statusCode).toBe(503);
    await a.close();
  });
  it("rejects bad/missing signature, tampered body, stale timestamp, malformed envelope, unknown tenant — DB never touched", async () => {
    const a = await app(env);
    expect((await post(a, sender.delivery(body(), { secret: "x".repeat(32) }))).statusCode).toBe(
      401,
    );
    expect((await post(a, sender.delivery(body(), { omitSignature: true }))).statusCode).toBe(401);
    const signed = sender.delivery(body());
    expect(
      (await post(a, { ...signed, rawBody: signed.rawBody.replace("Dispensed", "PickedUp") }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(a, sender.delivery(body(), { nowMs: Date.now() - 6 * 60 * 1000 }))).statusCode,
    ).toBe(400);
    expect((await post(a, sender.delivery({ nonsense: true }))).statusCode).toBe(400);
    const otherOrg = body({ organization_id: "22222222-2222-4222-8222-222222222222" });
    expect((await post(a, sender.delivery(otherOrg))).statusCode).toBe(401);
    expect(noopOutbox.publish).not.toHaveBeenCalled();
    await a.close();
  });
});

describe("DEK envelope (raw_body_cipher)", () => {
  it("round-trips, never contains the plaintext, and is AAD-bound to the org", async () => {
    const enc = await cipher.encrypt(ORG, '{"phi":"rx-secret"}');
    expect(enc.cipher).not.toContain("rx-secret");
    expect(await cipher.decrypt(ORG, enc.cipher, enc.dekRef)).toBe('{"phi":"rx-secret"}');
    await expect(
      cipher.decrypt("22222222-2222-4222-8222-222222222222", enc.cipher, enc.dekRef),
    ).rejects.toThrow();
  });
});

describe("resolveMedicationHistory (M14 port, F-230)", () => {
  const warn = vi.fn();
  it("keeps consistent facts; drops inconsistent ones (never coerced)", async () => {
    const out = await resolveMedicationHistory(
      {
        medicationHistoryForOrg: async () =>
          new Map([
            [
              "avail",
              { state: "available" as const, recordCount: 2, lastPulledAt: "2026-09-29T12:00:00Z" },
            ],
            [
              "none",
              {
                state: "none_available" as const,
                recordCount: 0,
                lastPulledAt: "2026-09-29T12:00:00Z",
              },
            ],
            ["never", { state: "not_pulled" as const, recordCount: 0, lastPulledAt: null }],
            [
              "bad1",
              { state: "available" as const, recordCount: 0, lastPulledAt: "2026-09-29T12:00:00Z" },
            ],
            [
              "bad2",
              {
                state: "none_available" as const,
                recordCount: 3,
                lastPulledAt: "2026-09-29T12:00:00Z",
              },
            ],
            [
              "bad3",
              {
                state: "not_pulled" as const,
                recordCount: 0,
                lastPulledAt: "2026-09-29T12:00:00Z",
              },
            ],
            ["bad4", { state: "available" as const, recordCount: 1, lastPulledAt: null }],
            [
              "bad5",
              {
                state: "available" as const,
                recordCount: -1,
                lastPulledAt: "2026-09-29T12:00:00Z",
              },
            ],
          ]),
      },
      "org",
      ["avail", "none", "never", "bad1", "bad2", "bad3", "bad4", "bad5"],
      warn,
    );
    expect([...out.keys()].sort()).toEqual(["avail", "never", "none"]);
    expect(out.get("avail")).toEqual({
      state: "available",
      recordCount: 2,
      lastPulledAt: "2026-09-29T12:00:00.000Z",
    });
  });
  it("an unbound port or a throwing seam is ABSENT (not captured) — never a fabricated 'none'", async () => {
    expect((await resolveMedicationHistory(undefined, "org", ["p"], warn)).size).toBe(0);
    const failed = await resolveMedicationHistory(
      {
        medicationHistoryForOrg: async () => {
          throw new Error("boom");
        },
      },
      "org",
      ["p"],
      warn,
    );
    expect(failed.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "m14.packet_build.medication_history_unavailable",
      expect.objectContaining({ organizationId: "org" }),
    );
  });
});

describe("packet slot: builder pass-through, Part 2 redaction, read model", () => {
  const base = (
    medicationHistory?: PacketBuildInput["medicationHistory"],
    sud = false,
  ): PacketBuildInput => ({
    context: {
      meetingId: "m" as never,
      patientId: "p" as never,
      admissionId: "a" as never,
      locationId: "l" as never,
      builtAt: "2026-06-16T09:00:00.000Z",
      builderJobId: "j",
      priorIdgAdjournedAt: "2026-06-01T00:00:00.000Z",
      admissionActivatedAt: "2026-05-01T00:00:00.000Z",
    },
    cover: {
      firstName: "J",
      lastInitial: "D",
      age: 70,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "x",
      levelOfCare: "routine",
      nextRecertDueAt: null,
      f2fWindowState: "not_due",
      activeDpoa: null,
      activeSudFlag: sud,
    },
    sinceLastIdg: {
      encounters: [],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [],
      medicationsChanged: [],
      flaggedEvents: [],
    },
    carePlanSummary: {
      activeProblemCount: 1,
      activeGoalCount: 1,
      activeInterventionCount: 1,
      lastSignedVersionId: "v",
      lastSignedAt: "2026-06-02T00:00:00.000Z",
      nextReviewDueAt: "2026-06-17T00:00:00.000Z",
      isReviewOverdue: false,
    },
    hopeContext: null,
    carryForwardActionItems: [],
    ...(medicationHistory !== undefined ? { medicationHistory } : {}),
  });
  const slot = {
    state: "available" as const,
    recordCount: 4,
    lastPulledAt: "2026-09-29T12:00:00.000Z",
  };

  it("passes the slot through; omits the key entirely when not supplied (pre-F-230 byte-identical)", () => {
    expect(buildPacketSnapshot(base(slot)).snapshot.medicationHistory).toEqual(slot);
    expect(buildPacketSnapshot(base(null)).snapshot.medicationHistory).toBeNull();
    expect("medicationHistory" in buildPacketSnapshot(base()).snapshot).toBe(false);
  });
  it("W-SUD-01: a caller without a Part 2 release gets the state but NOT the count", () => {
    const built = buildPacketSnapshot(base(slot, true));
    const out = applySudRedaction(built, {
      hasPart2Release: false,
      sudFlaggedSourceIds: new Set(),
    });
    expect(out.snapshot.medicationHistory).toEqual({ ...slot, recordCount: 0 });
    expect(
      applySudRedaction(built, { hasPart2Release: true, sudFlaggedSourceIds: new Set() }).snapshot
        .medicationHistory,
    ).toEqual(slot);
  });
  it("read model: only a real zero-entry pull says 'no external history'; not-pulled / not-captured never do", () => {
    const v = (mh: Parameters<typeof externalMedicationHistoryView>[0], redact = false) =>
      externalMedicationHistoryView(mh, redact);
    expect(
      v({ state: "none_available", recordCount: 0, lastPulledAt: "2026-09-29T12:00:00.000Z" })
        .message,
    ).toMatch(/No external medication history available/);
    const never = v({ state: "not_pulled", recordCount: 0, lastPulledAt: null });
    expect(never.message).not.toMatch(/No external medication history available/);
    expect(never.captured).toBe(true);
    const uncaptured = v(null);
    expect(uncaptured).toEqual({
      captured: false,
      state: null,
      recordCount: null,
      lastPulledAt: null,
      message: null,
    });
    expect(v(undefined as never).captured).toBe(false); // a pre-F-230 frozen snapshot
    expect(v(slot, true).recordCount).toBeNull(); // withheld under W-SUD-01
    expect(v(slot).recordCount).toBe(4);
  });
});
