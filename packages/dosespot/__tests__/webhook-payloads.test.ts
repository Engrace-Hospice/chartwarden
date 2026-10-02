// packages/dosespot/__tests__/webhook-payloads.test.ts — F-230. The inbound webhook BODY contract: the §4.2
// envelope (spec-defined) and the PROVISIONAL script_status_update payload. Pure parsing only; nothing here
// is checked against real DoseSpot documentation (none exists in the repo) — see payloads.ts.
import { describe, expect, it } from "vitest";
import {
  DOSESPOT_WIRE_MAPPING_VERIFIED,
  isDispenseStatus,
  parseScriptStatusUpdate,
  parseWebhookEnvelope,
} from "../src";

const ORG = "11111111-1111-4111-8111-111111111111";
const env = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    dosespot_event_id: "evt-1",
    organization_id: ORG,
    event_type: "script_status_update",
    occurred_at: "2026-09-29T00:00:00Z",
    payload: { dosespot_prescription_id: "rx-1", status: "Dispensed" },
    ...over,
  });

describe("parseWebhookEnvelope (§4.2)", () => {
  it("accepts a well-formed envelope", () => {
    const r = parseWebhookEnvelope(env());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.organization_id).toBe(ORG);
  });
  it("rejects non-JSON, a missing field, an unknown event_type and a non-uuid org", () => {
    expect(parseWebhookEnvelope("nope")).toEqual({ ok: false, reason: "MALFORMED_JSON" });
    expect(parseWebhookEnvelope(env({ dosespot_event_id: undefined })).ok).toBe(false);
    expect(parseWebhookEnvelope(env({ event_type: "made_up" })).ok).toBe(false);
    expect(parseWebhookEnvelope(env({ organization_id: "org_a" })).ok).toBe(false);
    expect(parseWebhookEnvelope(env({ dosespot_event_id: "" })).ok).toBe(false);
  });
});

describe("script_status_update payload (PROVISIONAL field names)", () => {
  it("parses the provisional shape and classifies dispense statuses", () => {
    expect(
      parseScriptStatusUpdate({
        dosespot_prescription_id: "rx",
        status: "PickedUp",
        fill_number: 1,
      }).ok,
    ).toBe(true);
    expect(parseScriptStatusUpdate({ status: "Dispensed" }).ok).toBe(false);
    expect(
      parseScriptStatusUpdate({
        dosespot_prescription_id: "rx",
        status: "Dispensed",
        fill_number: -1,
      }).ok,
    ).toBe(false);
    expect(isDispenseStatus("Dispensed")).toBe(true);
    expect(isDispenseStatus("PickedUp")).toBe(true);
    expect(isDispenseStatus("Sent")).toBe(false);
    expect(isDispenseStatus("dispensed")).toBe(false); // exact vendor literal, never loosely matched
  });
  it("the wire mapping is flagged UNVERIFIED until checked against real vendor docs", () => {
    expect(DOSESPOT_WIRE_MAPPING_VERIFIED).toBe(false);
  });
});
