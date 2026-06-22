// apps/backend/src/modules/06-admission/discharge/for-cause.ts — M6-T09 the for-cause discharge cosign
// cascade (§7.6 W-DC-02 / D11). PURE: a for-cause discharge is the highest-risk patient-rights event in
// hospice, so it is two-step. Filing it creates a discharge row with `cosign_required=true` and a
// `pending_for_cause_discharge` flag on the admission — the admission stays `active` (NOT `discharged`)
// until a medical director resolves it via route 40. These functions describe the two transitions; the
// slice/service applies them in one transaction.

/** The state a freshly-filed for-cause discharge enters — it waits for the medical-director cosign. */
export interface ForCauseFiling {
  /** The discharge row state on creation (awaiting the route-40 cosign). */
  readonly dischargeState: "awaiting_cosign";
  /** The admission stays here — for-cause does NOT discharge on filing (D11). */
  readonly admissionState: "active";
  /** Marks the admission so the UI/queue surfaces the pending governance step (§2.2). */
  readonly pendingForCauseDischarge: true;
  /** Filing emits the discharge-created event but NOT `m6.admission.discharged` yet. */
  readonly events: readonly ["m6.discharge.created"];
}

/** The terminal resolution of a for-cause discharge: the medical director cosigns it or rejects it. */
export type ForCauseResolution = "cosign" | "reject";

/** The verdict after a medical director resolves the pending for-cause discharge (route 40 / W-DC-02). */
export interface ForCauseOutcome {
  /** `completed` when cosigned; `voided` when rejected (audit captured either way). */
  readonly dischargeState: "completed" | "voided";
  /** Cosign discharges the admission; a rejection returns it to `active`. */
  readonly admissionState: "discharged" | "active";
  /** The pending flag is always cleared once the discharge is resolved. */
  readonly pendingForCauseDischarge: false;
  /** A cosign fans out `m6.discharge.cosigned` + `m6.admission.discharged`; a rejection emits nothing. */
  readonly events: readonly string[];
}

/** W-DC-02 — the cascade when a for-cause discharge is first filed (admission stays active). */
export function fileForCauseDischarge(): ForCauseFiling {
  return {
    dischargeState: "awaiting_cosign",
    admissionState: "active",
    pendingForCauseDischarge: true,
    events: ["m6.discharge.created"],
  };
}

/**
 * W-DC-02 / D11 — resolve a pending for-cause discharge. A `cosign` completes the discharge and moves
 * the admission to `discharged` (emitting `m6.discharge.cosigned` + `m6.admission.discharged`); a
 * `reject` voids the discharge row and returns the admission to `active` (no outbox fan-out).
 */
export function resolveForCauseDischarge(resolution: ForCauseResolution): ForCauseOutcome {
  if (resolution === "cosign") {
    return {
      dischargeState: "completed",
      admissionState: "discharged",
      pendingForCauseDischarge: false,
      events: ["m6.discharge.cosigned", "m6.admission.discharged"],
    };
  }
  return {
    dischargeState: "voided",
    admissionState: "active",
    pendingForCauseDischarge: false,
    events: [],
  };
}
