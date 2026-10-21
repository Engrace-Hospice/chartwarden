// apps/backend/src/modules/21-supplies/lifecycle/caregiver-signature.ts — F-193 (#248). M21's OWN
// caregiver-signature CAPTURE.
//
// WHY THIS EXISTS. D7's spec line ("caregiver signature is optional via M22's signature flow, triggered
// when policy or tenant config requires it") named a capture mechanism M22 was never going to build —
// M22's own spec explicitly disclaims signature capture, and no capture route/seam/consumer exists
// anywhere in `22-documents/` (F-191 already dropped the misdeclared `m22` consumer off
// `m21.supply_request.delivered` for exactly this reason; see `events-by-m21.ts`'s comment on that event
// for the full citation trail). `supply_request.data`'s draft `caregiverSignatureRequestId` concept was
// dangling — no FK, nothing wired to it. This file is the real, minimal capture capability instead.
//
// NOT A STATE TRANSITION. Capturing a caregiver signature does not move `supply_request.status` — it is
// evidence ABOUT an already-`delivered` row, not a step in the §2.2 fulfillment machine. It therefore does
// NOT go through `transitionSupplyRequest` / `SUPPLY_REQUEST_EDGES`; `routes/write-service-drizzle.ts`'s
// `captureCaregiverSignature` runs its own (load → guard → UPDATE) shape instead. `require_` below throws
// the SAME `SupplyStateError` catalog (./errors) every other M21 guard uses, so a caller sees one error
// dialect regardless of which shape the write took.
//
// SHAPE MIRRORS THE PROVEN PRECEDENT for exactly this kind of record in this codebase:
// `packages/consent/src/routes/service.ts`'s `ConsentCaptureEvidence` / `validateCaptureEvidence` (M39) —
// a `captureMethod` enum plus a per-method evidence floor. NOT the literal M39 type: M21's manifest
// `dependsOn` is [1, 11, 40] with no edge to 39, so this module may not import `@chartwarden/consent`. The
// method set is narrowed to what is plausible for a courier-delivery caregiver signature — no portal
// session, no uploaded PDF, no notary.
//
// SCOPE, EXPLICITLY: this is the CAPTURE only. Nothing here — nor anywhere else this round touches — makes
// a caregiver signature REQUIRED before a delivery is considered complete. That "policy or tenant config
// requires it" gating mechanism D7 describes is a separate, larger product decision (what policy surface,
// what happens if required-but-missing) that this round does not build.
import type {
  SupplyCaregiverSignatureCaptureMethod,
  SupplyCaregiverSignatureEvidence,
} from "@chartwarden/types";
import { require_ } from "./errors";

/** The already-persisted capture facts, as `write-service-drizzle.ts` reads them off the row before
 *  deciding whether a new capture may proceed. */
export interface ExistingCaregiverSignatureCapture {
  readonly capturedAt: string | null;
}

/** The request-level facts the capture guard needs, already resolved from the loaded row. */
export interface CaregiverSignatureCaptureContext {
  /** `supply_request.delivered_at` — null means the row has not reached `delivered` yet. */
  readonly deliveredAt: string | null;
  readonly existing: ExistingCaregiverSignatureCapture;
}

/**
 * §2.2-adjacent guard (F-193) — may a caregiver-signature capture proceed against this row right now?
 * Throws `M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY` when the row has no delivery to attest to yet, and
 * `M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED` when one was already recorded — this module's append-only
 * posture for an evidentiary act (the DEA perpetual log, `order_transmission_attestation`) applied here:
 * a resubmission is REFUSED, not silently overwritten or appended as a second row.
 */
export function assertCaregiverSignatureCaptureAllowed(
  ctx: CaregiverSignatureCaptureContext,
): void {
  require_(
    ctx.deliveredAt !== null,
    "M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY",
    "a caregiver signature is captured against a delivery; this request has not reached 'delivered' yet",
  );
  require_(
    ctx.existing.capturedAt === null,
    "M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED",
    "a caregiver signature was already captured for this request; the capture is a one-time evidentiary act",
  );
}

/** The evidence a capture command carries — the flat, wire-level shape `CaptureCaregiverSignatureInput`
 *  (routes/write-service.ts) and the route's TypeBox body both use, so the SAME object reaches this
 *  pure predicate, the evidence-jsonb write and the outbox-free service call. */
export interface CaregiverSignatureEvidenceInput extends SupplyCaregiverSignatureEvidence {
  readonly evidenceDocumentId?: string;
}

/**
 * Pure evidence-floor check (mirrors M39's `validateCaptureEvidence`) — does the evidence given satisfy
 * the declared capture method's minimum shape?
 *
 *   • `typed_signature_in_app` — a typed name, at least 2 characters (the M39 floor).
 *   • `witnessed_verbal_documented` — a witness name (≥2 chars), an attestation (≥20 chars — long enough
 *     to be an actual account, not a placeholder) AND a reference to an already-rendered M22 document,
 *     exactly the way M39's `witnessSignatureEvidenceDocumentId` is required for its own witnessed path.
 *   • `declined` — no evidence required; `declinedReason` is optional free text.
 */
export function caregiverSignatureEvidenceSatisfiesMethod(
  method: SupplyCaregiverSignatureCaptureMethod,
  evidence: CaregiverSignatureEvidenceInput,
): boolean {
  if (method === "typed_signature_in_app") {
    return (evidence.typedSignatureName ?? "").trim().length >= 2;
  }
  if (method === "witnessed_verbal_documented") {
    return (
      (evidence.witnessName ?? "").trim().length >= 2 &&
      (evidence.witnessAttestationText ?? "").trim().length >= 20 &&
      typeof evidence.evidenceDocumentId === "string" &&
      evidence.evidenceDocumentId.length > 0
    );
  }
  // "declined" — capturing a refusal is still evidence; nothing further is required to record it.
  return true;
}

/** Throws `M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED` when the evidence does not satisfy the method. */
export function requireCaregiverSignatureEvidence(
  method: SupplyCaregiverSignatureCaptureMethod,
  evidence: CaregiverSignatureEvidenceInput,
): void {
  require_(
    caregiverSignatureEvidenceSatisfiesMethod(method, evidence),
    "M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED",
    `'${method}' does not have the evidence its capture method requires`,
  );
}

/** Project a capture-command's evidence fields into exactly what `caregiver_signature_evidence_jsonb`
 *  should store — only the free-text fields the method actually names, never a stray field from a
 *  mismatched method (a `witnessName` typed on a `typed_signature_in_app` capture must not ride along). */
export function caregiverSignatureEvidenceJsonbOf(
  method: SupplyCaregiverSignatureCaptureMethod,
  evidence: CaregiverSignatureEvidenceInput,
): SupplyCaregiverSignatureEvidence | null {
  if (method === "typed_signature_in_app") {
    return { typedSignatureName: evidence.typedSignatureName };
  }
  if (method === "witnessed_verbal_documented") {
    return {
      witnessName: evidence.witnessName,
      witnessAttestationText: evidence.witnessAttestationText,
    };
  }
  return evidence.declinedReason !== undefined ? { declinedReason: evidence.declinedReason } : null;
}
