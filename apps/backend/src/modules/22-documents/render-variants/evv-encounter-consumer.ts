// apps/backend/src/modules/22-documents/render-variants/evv-encounter-consumer.ts — M22-T09 (§7.12 W12 / §7.13 W13).
//
// The EVV (`m18.evv.aggregator_accepted`) and encounter (`m8.encounter.signed` / `m8.encounter.addendum_signed`)
// render-variant adapters: they map the LIVE source event payload onto the pure `@wardenx/forms` variant builders
// (`buildEvvVerificationRenderPayload` / `buildEncounterPdfRenderPayload`). M8/M18 are in-wave, so these are NOT
// deny-stubbed — the §4.11 dispatcher already enqueues a render for these events; these resolvers supply the
// variant-shaped payload (W12 map-vs-exception narrative; W13 addendum-version + the M32 AI sidebar/footer).
//
// PURE: no IO. The forms builders own the layout/copy rules (map section vs alternate-method narrative; the AI
// attribution + capability disclosure footer), so they are unit-testable without a render engine.

import {
  buildEncounterPdfRenderPayload,
  buildEvvVerificationRenderPayload,
  type EncounterPdfRenderPayload,
  type EvvVerificationRenderPayload,
} from "@wardenx/forms";
import type { OrgScope } from "@wardenx/types";

function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The §7.12 W12 EVV-verification render plan, or a skip (wrong event / malformed payload). */
export type EvvVerificationResolution =
  | {
      readonly status: "render";
      readonly scope: OrgScope;
      readonly aggregateId: string;
      readonly patientId: string;
      readonly payload: EvvVerificationRenderPayload;
    }
  | { readonly status: "skip" };

/**
 * Resolve `m18.evv.aggregator_accepted` to its `evv_verification` render plan (§7.12 W12). The geo block is built
 * only when the event carries lat/lng AND a captured map snapshot; otherwise the exception narrative is populated
 * from `alternateMethodReason`. Pure.
 */
export function resolveEvvVerificationRender(eventName: string, payload: unknown): EvvVerificationResolution {
  if (eventName !== "m18.evv.aggregator_accepted") return { status: "skip" };
  const rec = (payload ?? {}) as Record<string, unknown>;
  const organizationId = str(rec, "organizationId");
  const patientId = str(rec, "patientId");
  const visitId = str(rec, "visitId");
  const evvRecordId = str(rec, "evvRecordId");
  const aggregatorRefId = str(rec, "aggregatorRefId");
  const acceptedAt = str(rec, "acceptedAt");
  const submissionId = str(rec, "submissionId");
  if (!organizationId || !patientId || !visitId || !evvRecordId || !aggregatorRefId || !acceptedAt) {
    return { status: "skip" };
  }

  const geo = (rec.geoVerification ?? null) as Record<string, unknown> | null;
  const lat = geo ? num(geo, "latitude") : null;
  const lng = geo ? num(geo, "longitude") : null;
  const snapshotPresent = geo ? geo.snapshotPresent === true : false;

  const out = buildEvvVerificationRenderPayload({
    visitId,
    evvRecordId,
    aggregatorRefId,
    acceptedAt,
    geoVerification: lat !== null && lng !== null ? { latitude: lat, longitude: lng, snapshotPresent } : null,
    alternateMethodReason: str(rec, "alternateMethodReason"),
  });
  // The §4.5 manifest keys the EVV render aggregate on the aggregator submission id (the back-ref target).
  return { status: "render", scope: { orgId: organizationId }, aggregateId: submissionId ?? evvRecordId, patientId, payload: out };
}

/** The §7.13 W13 encounter-PDF render plan, or a skip (wrong event / malformed payload). */
export type EncounterPdfResolution =
  | {
      readonly status: "render";
      readonly scope: OrgScope;
      readonly aggregateId: string;
      readonly patientId: string;
      readonly payload: EncounterPdfRenderPayload;
    }
  | { readonly status: "skip" };

/** The encounter render events (signed → v1; addendum_signed → a new version on the SAME document, W13). */
const ENCOUNTER_EVENTS = new Set(["m8.encounter.signed", "m8.encounter.addendum_signed"]);

/**
 * Resolve `m8.encounter.signed` / `m8.encounter.addendum_signed` to the `encounter_pdf` render plan (§7.13 W13).
 * An addendum renders as a NEW `document_version`; an M32 narrative enhancement (M8 Layer 2) populates the
 * AI-assisted sidebar + the capability disclosure footer. Pure.
 */
export function resolveEncounterPdfRender(eventName: string, payload: unknown): EncounterPdfResolution {
  if (!ENCOUNTER_EVENTS.has(eventName)) return { status: "skip" };
  const rec = (payload ?? {}) as Record<string, unknown>;
  const organizationId = str(rec, "organizationId");
  const patientId = str(rec, "patientId");
  const encounterId = str(rec, "encounterId");
  if (!organizationId || !patientId || !encounterId) return { status: "skip" };

  const enh = (rec.narrativeEnhancement ?? null) as Record<string, unknown> | null;
  const enhText = enh ? str(enh, "text") : null;
  const enhReviewedBy = enh ? str(enh, "reviewedBy") : null;
  const enhCapabilityId = enh ? str(enh, "capabilityId") : null;

  const out = buildEncounterPdfRenderPayload({
    encounterId,
    isAddendum: eventName === "m8.encounter.addendum_signed",
    narrativeEnhancement:
      enhText && enhReviewedBy && enhCapabilityId
        ? { text: enhText, reviewedBy: enhReviewedBy, capabilityId: enhCapabilityId }
        : null,
  });
  return { status: "render", scope: { orgId: organizationId }, aggregateId: encounterId, patientId, payload: out };
}
