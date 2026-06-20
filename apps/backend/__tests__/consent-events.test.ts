// apps/backend/__tests__/consent-events.test.ts — M39-T08 outbox/alerts/consumers (§4.5/§4.6/§4.10).
//
// Covers: (1) the M5 privacy-flag-snapshot recompute integration — M39's signed/revoked Part 2
// events drive M5's `applyConsentChanged` (the consumer M5 shipped inert in M5-T10), proving the
// cross-module SUD chain end-to-end; (2) the §4.10 alert payloads validate against M36's Foundation
// registry (collision-free, well-namespaced under m39.); (3) the D13 post-death expiry decision.
import { createAlertPayloadRegistry } from "@wardenx/messaging";
// M5's privacy-flag recompute consumer (shipped in M5-T10, inert until M39 emits — now wired by the test).
import { applyConsentChanged, recomputePrivacyFlags } from "../src/modules/05-patient/privacy/index";
import { describe, expect, it } from "vitest";
import {
  M39_ALERT_PAYLOADS,
  consentChangeToPrivacyPayload,
  decideDeceasedConsentExpiry,
} from "../src/modules/39-consent/index";

const ORG = "org-1";
const PAT = "pat-1";

describe("M39-T08 — m39.consent.* → M5 privacy_flag_snapshot recompute (§4.6 / M5 D10)", () => {
  function inMemoryPorts() {
    const writes: { patientId: string; flags: readonly string[] }[] = [];
    return {
      ports: {
        async writeSnapshot(_org: string, patientId: string, flags: readonly string[]) {
          writes.push({ patientId, flags: [...flags] });
        },
        async emitPrivacyFlagChanged() {
          /* m5.patient.privacy_flag_changed — asserted via the write above */
        },
      },
      writes,
    };
  }

  it("a signed 42_cfr_part_2_release lifts the SUD restriction (no sud flag in the snapshot)", async () => {
    const payload = consentChangeToPrivacyPayload({
      organizationId: ORG,
      patientId: PAT,
      typeKey: "42_cfr_part_2_release",
      action: "signed",
    });
    expect(payload).not.toBeNull();
    const { ports, writes } = inMemoryPorts();
    const flags = await applyConsentChanged(payload!, ports);
    expect(flags).not.toContain("sud"); // active consent → unrestricted
    expect(writes[0]!.flags).not.toContain("sud");
  });

  it("a revoked 42_cfr_part_2_release re-restricts SUD (sud flag present)", async () => {
    const payload = consentChangeToPrivacyPayload({
      organizationId: ORG,
      patientId: PAT,
      typeKey: "42_cfr_part_2_release",
      action: "revoked",
    });
    const { ports } = inMemoryPorts();
    const flags = await applyConsentChanged(payload!, ports);
    expect(flags).toContain("sud"); // inactive consent → restricted
  });

  it("non-SUD consent types drive no M5 privacy signal (HIV/MH/genetic are M5-delegated)", () => {
    expect(
      consentChangeToPrivacyPayload({ organizationId: ORG, patientId: PAT, typeKey: "hipaa_release", action: "signed" }),
    ).toBeNull();
  });

  it("the bridge's signal shape recomputes consistently in M5's pure engine", () => {
    expect(recomputePrivacyFlags([{ flag: "sud", active: false }])).toEqual(["sud"]);
    expect(recomputePrivacyFlags([{ flag: "sud", active: true }])).toEqual([]);
  });
});

describe("M39-T08 — §4.10 alert payloads register cleanly with M36's Foundation registry", () => {
  it("validates collision-free + correctly namespaced under m39.", () => {
    const registry = createAlertPayloadRegistry();
    registry.register(M39_ALERT_PAYLOADS);
    expect(() => registry.assertValid()).not.toThrow();
    expect(M39_ALERT_PAYLOADS).toHaveLength(5);
    for (const e of M39_ALERT_PAYLOADS) {
      expect(e.payloadType.startsWith("m39.")).toBe(true);
      expect(e.moduleOwner).toBe("m39");
    }
  });
});

describe("M39-T08 — D13 post-death consent expiry decision (§4.6 m5.patient.deceased)", () => {
  it("terminates non-surviving consents, keeps survives_death + bereavement", () => {
    const ids = decideDeceasedConsentExpiry([
      { id: "a", typeKey: "hipaa_release", status: "active", survivesDeath: false },
      { id: "b", typeKey: "family_caregiver_access", status: "active", survivesDeath: true },
      { id: "c", typeKey: "bereavement_outreach_consent", status: "active", survivesDeath: false },
      { id: "d", typeKey: "media_release", status: "superseded", survivesDeath: false },
    ]);
    expect(ids).toEqual(["a"]); // b survives (flag), c survives (post-mortem), d not active
  });
});
