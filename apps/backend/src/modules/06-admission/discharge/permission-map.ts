// apps/backend/src/modules/06-admission/discharge/permission-map.ts — M6-T09 the §6.3 discharge
// reason-specific permission mapping. The single route `POST /admissions/:id/discharge` (route 39) is
// authorized by a permission key DERIVED from `reason` server-side, so a client cannot bypass the
// per-reason policy by changing the path. This module is the single source of truth for that
// derivation (the route's preHandler) AND the per-reason narrative gates the service enforces — the
// §6.3 table, as PURE data + functions (no I/O, no throw; the slice maps a verdict to a thrown
// AdmissionStateError so the §2.4 code catalog stays the one place codes→status are bound).

/** The §4.2.7 discharge reasons (canonical list; the TypeBox schema's union is built from this). */
export const DISCHARGE_REASONS = [
  "death",
  "moved_out_of_service_area",
  "no_longer_terminal",
  "for_cause",
  "other",
] as const;
export type DischargeReason = (typeof DISCHARGE_REASONS)[number];

/** The §6.3 policy for one discharge reason: derived permission key + the additional capture gates. */
export interface DischargePolicy {
  /** The permission key route 39 derives + gates on for this reason (server-side; never the path). */
  readonly permissionKey: string;
  /** Minimum narrative length (chars) — D11 tightens `no_longer_terminal` (≥20) and `other` (≥40). */
  readonly minNarrativeChars: number;
  /** `for_cause` requires a `forCauseReason` (≥20 chars) in the body (§6.3 / §4.2.7). */
  readonly requiresForCauseReason: boolean;
  /** `for_cause` requires a subsequent medical-director cosign via route 40 before discharge (D11). */
  readonly requiresMedicalDirectorCosign: boolean;
  /** R-DC-01 — `death` requires an identified certifier (`death_certifier_id`); no other reason does. */
  readonly requiresDeathCertifier: boolean;
}

/** §6.3 reason → policy. The keys are the derivation targets registered in M6_CONTRIBUTED_PERMISSIONS. */
export const DISCHARGE_POLICY: Record<DischargeReason, DischargePolicy> = {
  death: {
    permissionKey: "discharge.death",
    minNarrativeChars: 10,
    requiresForCauseReason: false,
    requiresMedicalDirectorCosign: false,
    requiresDeathCertifier: true,
  },
  moved_out_of_service_area: {
    permissionKey: "discharge.moved",
    minNarrativeChars: 10,
    requiresForCauseReason: false,
    requiresMedicalDirectorCosign: false,
    requiresDeathCertifier: false,
  },
  no_longer_terminal: {
    permissionKey: "discharge.no_longer_terminal",
    minNarrativeChars: 20, // D11
    requiresForCauseReason: false,
    requiresMedicalDirectorCosign: false,
    requiresDeathCertifier: false,
  },
  for_cause: {
    permissionKey: "discharge.for_cause",
    minNarrativeChars: 10,
    requiresForCauseReason: true,
    requiresMedicalDirectorCosign: true, // D11 — admission stays active until route 40 cosign
    requiresDeathCertifier: false,
  },
  other: {
    permissionKey: "discharge.other",
    minNarrativeChars: 40,
    requiresForCauseReason: false,
    requiresMedicalDirectorCosign: false,
    requiresDeathCertifier: false,
  },
};

/** The umbrella capability key gating route 39 when `reason` is absent / unrecognised (§4.5). */
export const DISCHARGE_FALLBACK_PERMISSION = "discharge.create";

/** True when `value` is one of the five §4.2.7 discharge reasons. */
export function isDischargeReason(value: unknown): value is DischargeReason {
  return typeof value === "string" && (DISCHARGE_REASONS as readonly string[]).includes(value);
}

/**
 * §6.3 — derive route 39's required permission key from the request `reason`, evaluated server-side.
 * An absent / unrecognised reason falls back to the broadest `discharge.create` gate so the route is
 * never left ungated (the TypeBox schema rejects the bad reason in the handler afterwards).
 */
export function deriveDischargePermissionKey(reason: unknown): string {
  return isDischargeReason(reason)
    ? DISCHARGE_POLICY[reason].permissionKey
    : DISCHARGE_FALLBACK_PERMISSION;
}

/** True when this reason's discharge must wait on a medical-director cosign (D11 — only `for_cause`). */
export function dischargeRequiresCosign(reason: DischargeReason): boolean {
  return DISCHARGE_POLICY[reason].requiresMedicalDirectorCosign;
}

/** A §6.3 narrative-gate violation (the service throws the matching §2.4 code). */
export interface DischargeNarrativeIssue {
  readonly code:
    | "NARRATIVE_REQUIRED_FOR_CAUSE"
    | "DISCHARGE_NARRATIVE_TOO_SHORT"
    | "DEATH_CERTIFIER_INVALID"
    | "PLACE_OF_DEATH_REQUIRED"
    | "PLACE_OF_DEATH_NOT_ALLOWED";
  readonly message: string;
}

/** Where the patient died (`discharge_event.place_of_death`) — drives claim patient status 40/41/42. */
export const PLACES_OF_DEATH = ["home", "facility", "unknown"] as const;
export type PlaceOfDeath = (typeof PLACES_OF_DEATH)[number];

/**
 * A death discharge must say where the patient died: the Medicare claim's patient discharge status is
 * 40 (home), 41 (medical facility) or 42 (place unknown) — CMS Pub. 100-04 Ch. 11 §30.3. `unknown` is a
 * valid answer (42); silence is not. Any other reason must NOT carry a place of death.
 */
export function checkPlaceOfDeath(
  reason: DischargeReason,
  placeOfDeath: string | undefined,
): DischargeNarrativeIssue | null {
  if (reason === "death") {
    if (
      placeOfDeath === undefined ||
      !(PLACES_OF_DEATH as readonly string[]).includes(placeOfDeath)
    ) {
      return {
        code: "PLACE_OF_DEATH_REQUIRED",
        message: "death discharge requires placeOfDeath (home, facility or unknown)",
      };
    }
    return null;
  }
  if (placeOfDeath !== undefined) {
    return {
      code: "PLACE_OF_DEATH_NOT_ALLOWED",
      message: "placeOfDeath is only recorded on a death discharge",
    };
  }
  return null;
}

/**
 * The place of death a discharge records. An external (HL7, W-M6-31) death that does not carry it records
 * `unknown` (status 42) rather than blocking the intake; every other path keeps what the caller sent so
 * `checkPlaceOfDeath` can refuse a missing value.
 */
export function resolvePlaceOfDeath(
  reason: DischargeReason,
  placeOfDeath: PlaceOfDeath | undefined,
  isExternalSource: boolean,
): PlaceOfDeath | undefined {
  if (reason === "death" && isExternalSource) return placeOfDeath ?? "unknown";
  return placeOfDeath;
}

/**
 * §6.3 — validate the discharge capture body against the per-reason gates. Returns the first issue or
 * `null`. The `for_cause` reason requires a `forCauseReason` of ≥20 chars (412); `death` requires an
 * identified `deathCertifierId` (R-DC-01, reuses the same `DEATH_CERTIFIER_INVALID` code
 * `checkDeathCertifier` uses for the date-order half of the same rule — one coherent guard, two
 * places it can fail); every reason requires a narrative of at least the reason's minimum (D11
 * tightens `no_longer_terminal`/`other`) (422).
 */
export function checkDischargeNarrative(
  reason: DischargeReason,
  narrative: string,
  forCauseReason?: string,
  deathCertifierId?: string,
): DischargeNarrativeIssue | null {
  const policy = DISCHARGE_POLICY[reason];
  if (policy.requiresForCauseReason && (forCauseReason ?? "").trim().length < 20) {
    return {
      code: "NARRATIVE_REQUIRED_FOR_CAUSE",
      message: "for-cause discharge requires a forCauseReason of at least 20 characters",
    };
  }
  if (policy.requiresDeathCertifier && !deathCertifierId) {
    return {
      code: "DEATH_CERTIFIER_INVALID",
      message: "death discharge requires an identified death certifier (deathCertifierId)",
    };
  }
  if (narrative.trim().length < policy.minNarrativeChars) {
    return {
      code: "DISCHARGE_NARRATIVE_TOO_SHORT",
      message: `${reason} discharge requires a narrative of at least ${policy.minNarrativeChars} characters`,
    };
  }
  return null;
}
