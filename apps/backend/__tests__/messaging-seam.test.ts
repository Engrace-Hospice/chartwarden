// apps/backend/__tests__/messaging-seam.test.ts — M36-T06 published-seam registration (§4.6).
//
// Proves M36's boot-validated cross-module surface — `AlertEmitter`, the alert routing seam every
// clinical/billing module emits through — registers over the M1 deny-stub and passes
// validateSeams(); the real emitter resolves rules + recipients + the in-app fan-out floor (§2.1).
// Also asserts `MessagingProvider` is declared fail-closed (its DB-backed impl lands T07/T08) and
// that the composition-root `wireModuleSeams` hook wires M36's seam during a real buildServer() boot.
import { createInMemoryAlertEmitter } from "@wardenx/messaging";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  getAlertEmitter,
  getMessagingProvider,
  registerMessagingSeams,
} from "../src/modules/36-messaging/index";

describe("M36-T06 — AlertEmitter registers over the M1 deny-stub (§4.6)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares AlertEmitter + MessagingProvider in REQUIRED_SEAMS owned by M36 with deny-stubs", () => {
    const emitter = REQUIRED_SEAMS.find((r) => r.key === "AlertEmitter");
    expect(emitter?.ownerModule).toBe(36);
    expect(emitter?.phi).toBe(false); // routing surface, not a PHI read
    expect(emitter?.denyStub).toBeDefined();

    const provider = REQUIRED_SEAMS.find((r) => r.key === "MessagingProvider");
    expect(provider?.ownerModule).toBe(36);
    expect(provider?.phi).toBe(true); // decrypts message bodies for entitled readers
    expect(provider?.denyStub).toBeDefined();
  });

  it("registers the real emitter so validateSeams() passes and the typed getter resolves it", () => {
    registerMessagingSeams();
    expect(() => validateSeams()).not.toThrow();
    expect(getAlertEmitter()).toBeDefined();
  });

  it("the real emitter resolves rules + recipients + the in-app floor (not the deny-stub)", async () => {
    // Inject a role_set source so `visit.late` (platform-default, role_set resolver) fans out.
    const { emitter, recorded } = createInMemoryAlertEmitter({
      recipients: { roleSetMembers: async () => ["u1", "u2"] },
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    registerMessagingSeams({ emitter });
    validateSeams();

    const result = await getAlertEmitter().emit("org-1", {
      eventType: "visit.late",
      payload: { patientId: "p-secret" },
      severity: "warn",
      correlationId: "corr-1",
    });

    expect(result.resolvedRecipientCount).toBe(2);
    expect(recorded).toHaveLength(1);
    // §2.1.1 in-app floor: one in_app delivery per resolved recipient.
    const floor = recorded[0]!.deliveries.filter((d) => d.channel === "in_app");
    expect(floor.map((d) => d.recipientUserId).sort()).toEqual(["u1", "u2"]);
  });

  it("an event with no firing rule routes to nobody (count 0), still a no-op alert", async () => {
    const { emitter } = createInMemoryAlertEmitter();
    registerMessagingSeams({ emitter });
    validateSeams();
    const result = await getAlertEmitter().emit("org-1", {
      eventType: "nonexistent.event",
      payload: {},
      severity: "info",
      correlationId: "corr-2",
    });
    expect(result.resolvedRecipientCount).toBe(0);
  });

  it("without registration both seams boot FAIL-CLOSED (generic deny-stub throws on any call)", () => {
    validateSeams(); // no module registered → deny-stub defaults applied
    expect(() =>
      getAlertEmitter().emit("org-1", {
        eventType: "x",
        payload: {},
        severity: "info",
        correlationId: "c",
      }),
    ).toThrow(NotImplementedError);
    // MessagingProvider stays a deny-stub even after a real boot (its impl lands T07/T08).
    expect(() =>
      getMessagingProvider().openChannel("org-1", { kind: "dm", creatorUserId: "u1" }),
    ).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers M36's seam during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    // Boot completed (validateSeams() did not throw) AND AlertEmitter is the real impl: an emit
    // for an event with no recipients resolves to count 0 rather than throwing the deny-stub.
    const result = await getAlertEmitter().emit("org-1", {
      eventType: "visit.late",
      payload: {},
      severity: "warn",
      correlationId: "corr-3",
    });
    expect(result.resolvedRecipientCount).toBe(0);
    await app.close();
  });
});
