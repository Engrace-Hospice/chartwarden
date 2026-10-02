// apps/backend/__tests__/_fake-dosespot-vendor.ts — *** TEST DOUBLE — NOT DOSESPOT *** (F-230, #248).
//
// `FakeDoseSpotVendor` stands in for the DoseSpot HTTP API at the `DoseSpotClient` port (@wardenx/dosespot
// `client/contract.ts`) and, for webhooks, for the vendor's delivery (`FakeDoseSpotWebhookSender`). It exists
// ONLY so live suites can drive OUR side of the vendor boundary (persistence, RLS, catalog-validating
// publisher, idempotency, the M14 slot) end to end. What it proves is OUR code's behaviour GIVEN a payload of
// the shape our contract declares. It proves NOTHING about real DoseSpot: the response/webhook field names
// below are OUR contract's (webhook script-status field names are explicitly PROVISIONAL, payloads.ts), the
// signature is computed with OUR `computeWebhookSignature`, and no real vendor sample was ever consulted —
// none exists in this repository. Never import this from `src/`; it must not be reachable from production.
import { computeWebhookSignature } from "@wardenx/dosespot";
import type {
  DoseSpotClient,
  DoseSpotEpcsSessionResponse,
  DoseSpotMedHistoryPayload,
  DoseSpotMedHistoryResponse,
  DoseSpotNewRxResponse,
  DoseSpotPatientPayload,
  DoseSpotPatientResponse,
  DoseSpotPrescriberResponse,
  DoseSpotRxBenefitResponse,
} from "@wardenx/dosespot";

export interface FakeDoseSpotVendorScript {
  /** The DoseSpot-side patient id `upsertPatient` answers with. */
  readonly dosespotPatientId?: string;
  /** The MedHx the fake "vendor" returns; default: zero entries. */
  readonly medHistory?: DoseSpotMedHistoryResponse;
}

export class FakeDoseSpotVendor implements DoseSpotClient {
  /** `${orgId}|${method}` call log — lets a test assert the vendor was (or was NOT) called. */
  readonly calls: Array<{ method: string; orgId: string; payload?: unknown }> = [];
  constructor(private readonly script: FakeDoseSpotVendorScript = {}) {}

  async upsertPatient(
    orgId: string,
    payload: DoseSpotPatientPayload,
  ): Promise<DoseSpotPatientResponse> {
    this.calls.push({ method: "upsertPatient", orgId, payload });
    return {
      dosespotPatientId:
        this.script.dosespotPatientId ?? `ds-${payload.wardenxPatientId.slice(0, 8)}`,
      upsertedAt: new Date().toISOString(),
    };
  }
  async pullMedicationHistory(
    orgId: string,
    payload: DoseSpotMedHistoryPayload,
  ): Promise<DoseSpotMedHistoryResponse> {
    this.calls.push({ method: "pullMedicationHistory", orgId, payload });
    return this.script.medHistory ?? { items: [], pulledAt: new Date().toISOString() };
  }
  async enrollPrescriber(): Promise<DoseSpotPrescriberResponse> {
    throw new Error("FakeDoseSpotVendor: enrollPrescriber not scripted");
  }
  async revokePrescriber(): Promise<void> {
    throw new Error("FakeDoseSpotVendor: revokePrescriber not scripted");
  }
  async transmitNewRx(): Promise<DoseSpotNewRxResponse> {
    throw new Error("FakeDoseSpotVendor: transmitNewRx not scripted");
  }
  async lookupRxBenefit(): Promise<DoseSpotRxBenefitResponse> {
    throw new Error("FakeDoseSpotVendor: lookupRxBenefit not scripted");
  }
  async respondToRefillRequest(): Promise<void> {
    throw new Error("FakeDoseSpotVendor: respondToRefillRequest not scripted");
  }
  async initiateEpcsSigningSession(): Promise<DoseSpotEpcsSessionResponse> {
    throw new Error("FakeDoseSpotVendor: initiateEpcsSigningSession not scripted");
  }
}

/** Builds a signed delivery the way OUR §7.4 scheme says DoseSpot does (HMAC-SHA256 hex of the raw body). */
export class FakeDoseSpotWebhookSender {
  constructor(private readonly secret: string) {}

  /** `body` is serialised ONCE; the signature covers exactly those bytes. */
  delivery(
    body: Record<string, unknown>,
    opts: { nowMs?: number; secret?: string; omitSignature?: boolean } = {},
  ): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-dosespot-timestamp": String(opts.nowMs ?? Date.now()),
    };
    if (!opts.omitSignature) {
      headers["x-dosespot-signature"] = computeWebhookSignature(
        rawBody,
        opts.secret ?? this.secret,
      );
    }
    return { rawBody, headers };
  }
}
