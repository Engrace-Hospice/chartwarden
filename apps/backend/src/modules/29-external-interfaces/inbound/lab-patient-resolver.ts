// apps/backend/src/modules/29-external-interfaces/inbound — ORU patient resolution cascade (M29-T05, D7/D8).
// The two-stage patient binding for an inbound lab, distinct from ADT's propose-then-review (D5): labs
// AUTO-ATTACH on a high-confidence match and fall to the unmatched queue otherwise (D7). PURE over the
// injected `LabOrderPort` (M11) + the T04 `matchPatient` cascade (`PatientReader`, M5) — no DB, no clock.
//
// STAGE 1 — OBR-2 placer resolution (D8, highest confidence): the OBR-2 placer order number IS the M11
// `order_record.id`; a hit binds the lab to that order's patient with `match_method='obr_placer_id'`. No PID
// cascade needed.
// STAGE 2 — PID cascade fallback (only when OBR-2 is empty/unknown): reuse the deterministic five-level
// cascade. Labs auto-attach ONLY on a CONFIDENT (L1-L3) outcome → `match_method='patient_loinc_date'`; a
// candidate (L4/L5), ambiguous, or no-match outcome stays UNMATCHED (`match_method='unmatched'`,
// patient_id null) for human review — the D5-vs-D7 asymmetry (reporting an observation against a
// known-with-MRN patient is low-risk; a loose demographic guess is not).
import type { Hl7InboundMatchLevel, LabMatchMethod } from "@chartwarden/types";
import { type CascadeDeps, type CascadePid, matchPatient } from "./match-cascade";

/** The narrow slice of M11's `OrderProvider` the placer resolver needs (§4.5 consumed seam, D8). */
export interface LabOrderPort {
  /**
   * Resolve an order by its OBR-2 placer order number (= the M11 `order_record.id`, D8) within the tenant.
   * Returns the order's patient binding, or null when the placer number is unknown.
   */
  getOrderByPlacerId(input: {
    organizationId: string;
    placerOrderNumber: string;
  }): Promise<{ readonly id: string; readonly patientId: string } | null>;
}

/** The resolved patient binding for an inbound lab (the shape the attach planner branches on). */
export type LabPatientResolution =
  /** OBR-2 hit — bound to the order's patient (D8, auto-attach). */
  | {
      readonly kind: "matched";
      readonly patientId: string;
      readonly orderId: string;
      readonly matchMethod: Extract<LabMatchMethod, "obr_placer_id">;
      readonly matchLevel: null;
      readonly matchConfidence: null;
    }
  /** PID cascade confident (L1-L3) — auto-attach (D7). */
  | {
      readonly kind: "matched";
      readonly patientId: string;
      readonly orderId: null;
      readonly matchMethod: Extract<LabMatchMethod, "patient_loinc_date">;
      readonly matchLevel: Hl7InboundMatchLevel;
      readonly matchConfidence: null;
    }
  /** Candidate / ambiguous / no-match — unmatched queue (D7). Candidate info carried for the reviewer. */
  | {
      readonly kind: "unmatched";
      readonly matchMethod: Extract<LabMatchMethod, "unmatched">;
      readonly candidatePatientId: string | null;
      readonly candidateMatchLevel: Hl7InboundMatchLevel;
      readonly matchConfidence: number | null;
    };

export interface LabResolveInput {
  readonly organizationId: string;
  /** OBR-2.1 placer order number; empty ⇒ skip stage 1. */
  readonly placerOrderNumber: string;
  /** The PID projected by {@link projectOru}, for the stage-2 fallback cascade. */
  readonly patientCandidate: CascadePid;
  /** `organization.settings.hl7_internal_mrn_authority` — passed through to the cascade (L1 gate). */
  readonly internalMrnAuthority?: string;
}

export interface LabResolveDeps extends CascadeDeps {
  readonly orderReader: LabOrderPort;
}

/** Resolve the patient for an inbound lab: OBR-2 placer first, PID cascade fallback (D7/D8). */
export async function resolveLabPatient(
  input: LabResolveInput,
  deps: LabResolveDeps,
): Promise<LabPatientResolution> {
  // ─── Stage 1: OBR-2 placer order number → M11 order → patient (D8) ───────
  const placer = input.placerOrderNumber.trim();
  if (placer !== "") {
    const order = await deps.orderReader.getOrderByPlacerId({
      organizationId: input.organizationId,
      placerOrderNumber: placer,
    });
    if (order?.patientId) {
      return {
        kind: "matched",
        patientId: order.patientId,
        orderId: order.id,
        matchMethod: "obr_placer_id",
        matchLevel: null,
        matchConfidence: null,
      };
    }
  }

  // ─── Stage 2: PID cascade fallback (D7 — auto-attach on CONFIDENT only) ──
  const outcome = await matchPatient(
    {
      organizationId: input.organizationId,
      ...(input.internalMrnAuthority ? { internalMrnAuthority: input.internalMrnAuthority } : {}),
      pid: input.patientCandidate,
    },
    deps,
  );

  switch (outcome.kind) {
    case "confident_match":
      return {
        kind: "matched",
        patientId: outcome.patientId,
        orderId: null,
        matchMethod: "patient_loinc_date",
        matchLevel: outcome.level,
        matchConfidence: null,
      };
    case "candidate_match":
      return {
        kind: "unmatched",
        matchMethod: "unmatched",
        candidatePatientId: outcome.patientId,
        candidateMatchLevel: outcome.level,
        matchConfidence: outcome.confidence,
      };
    case "ambiguous":
      return {
        kind: "unmatched",
        matchMethod: "unmatched",
        candidatePatientId: null,
        candidateMatchLevel: outcome.level,
        matchConfidence: null,
      };
    case "no_match":
      return {
        kind: "unmatched",
        matchMethod: "unmatched",
        candidatePatientId: null,
        candidateMatchLevel: "NO_MATCH",
        matchConfidence: null,
      };
  }
}
