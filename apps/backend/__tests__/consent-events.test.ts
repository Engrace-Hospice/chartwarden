// apps/backend/__tests__/consent-events.test.ts — M39-T08 outbox/alerts/consumers (§4.5/§4.6/§4.10).
//
// Covers: (1) the M5 privacy-flag-snapshot recompute integration — M39's signed/revoked Part 2
// events drive M5's `applyConsentChanged` (the consumer M5 shipped inert in M5-T10), proving the
// cross-module SUD chain end-to-end; (2) the §4.10 alert payloads validate against M36's Foundation
// registry (collision-free, well-namespaced under m39.); (3) the D13 post-death expiry decision.
import { createAlertPayloadRegistry } from "@wardenx/messaging";
import { type StoredConsent, createConsentEvaluator, createInMemoryConsentStore } from "@wardenx/consent";
// M5's privacy-flag recompute consumer + the §7.6 SUD read gate (M5-T10; inert until M39 — wired here).
import { applyConsentChanged, isSudReadAllowed, recomputePrivacyFlags } from "../src/modules/05-patient/privacy/index";
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

describe("M39-T11 — the SUD-redaction chain end-to-end (M39 evaluator ↔ M5 §7.6 gate)", () => {
  const ORG2 = "org-sud";
  const PT = "pt-sud";

  function part2Consent(recipients: StoredConsent["recipients"]): StoredConsent {
    return {
      id: "c-part2", organizationId: ORG2, patientId: PT, typeKey: "42_cfr_part_2_release",
      status: "active", version: 0, effectiveAtMs: 0, expiresAtMs: null, survivesDeath: false,
      scopeDescriptor: {}, recipients,
    };
  }

  it("named recipient discloses SUD; unlisted is redacted; revoke re-restricts M5's §7.6 read gate", async () => {
    // 1. M39 evaluator: a Part 2 release naming `rx` discloses SUD to rx, redacts the vendor.
    const { store } = createInMemoryConsentStore({
      consents: [part2Consent([{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "rx" }])],
      deceasedPatientIds: new Set(),
    });
    const evaluator = createConsentEvaluator(store);
    const rx = await evaluator.evaluateForDisclosure({ organizationId: ORG2, patientId: PT, recipientResolvedId: "rx", callerModule: "m28" });
    expect(rx.redactSudContent).toBe(false);
    const vendor = await evaluator.evaluateForDisclosure({ organizationId: ORG2, patientId: PT, recipientResolvedId: "vendor", callerModule: "m28" });
    expect(vendor.redactSudContent).toBe(true);

    // 2. M5 §7.6 read gate: with an active SUD consent present, a SUD-flagged read is allowed.
    const signed = consentChangeToPrivacyPayload({ organizationId: ORG2, patientId: PT, typeKey: "42_cfr_part_2_release", action: "signed" });
    const signedFlags = recomputePrivacyFlags(signed!.signals);
    expect(isSudReadAllowed(signedFlags, /*sudConsentPresent*/ true)).toBe(true);

    // 3. Revoke → M5 recomputes the snapshot → the sud flag returns → the §7.6 gate closes without consent.
    const revoked = consentChangeToPrivacyPayload({ organizationId: ORG2, patientId: PT, typeKey: "42_cfr_part_2_release", action: "revoked" });
    const revokedFlags = recomputePrivacyFlags(revoked!.signals);
    expect(revokedFlags).toContain("sud");
    expect(isSudReadAllowed(revokedFlags, /*sudConsentPresent*/ false)).toBe(false);
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
