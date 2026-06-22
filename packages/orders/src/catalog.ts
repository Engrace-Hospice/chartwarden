// @wardenx/orders — §2.1 Order-Kind catalog (M11-T01 domain layout).
//
// The single source of per-kind metadata the lifecycle + signer-eligibility + standing-order machines
// (land M11-T03/T04) read instead of re-deriving the rules inline: which disciplines may sign a kind,
// whether the kind admits a verbal order (§2.3 — `level_of_care_change` / `recertification` require a
// written order ab initio), whether the kind is standing-order-eligible (§2.4 — only lab / supply /
// ancillary_service), the §2.2 completion shape, and the downstream `m11.*` outbox events a sign emits.
//
// PURE DATA — no IO, `@wardenx/types`-only. The per-kind TypeBox `data` schemas + cross-field validators
// + terminology bindings land per-folder in `kinds/<kind>/` in later tasks (§3.1).

import type { OrderKind, M11EventName } from "@wardenx/types";

/**
 * The clinical disciplines the §2.1 signer matrix references. `lpn` appears as a drafter only (an
 * LPN-drafted order requires an RN cosignature, §2.5); the resolve-only `clinical_supervisor` may
 * redirect an `idg_requested` row but cannot sign it as the final order.
 */
export type OrderSignerDiscipline =
  | "rn_case_manager"
  | "medical_director"
  | "hospice_physician"
  | "np"
  | "pa"
  | "msw"
  | "clinical_supervisor";

/** The §2.2 completion shape: one-shot kinds auto-complete on the first downstream fulfillment/result;
 * ongoing kinds complete manually or on an explicit downstream signal (LCP transition, M21 receipt). */
export type OrderCompletionShape = "one_shot" | "ongoing";

/** Per-kind §2.1 metadata. */
export interface OrderKindMeta {
  readonly kind: OrderKind;
  /** Disciplines eligible to SIGN the kind (the §2.1 "Signer disciplines" column). */
  readonly signerDisciplines: readonly OrderSignerDiscipline[];
  /** §2.3 — may the kind enter `verbal_pending`? `false` for written-ab-initio kinds. */
  readonly allowsVerbal: boolean;
  /** §2.4 — may a standing-order template spawn this kind? */
  readonly standingEligible: boolean;
  /** §2.2 — one-shot vs ongoing completion semantics. */
  readonly completion: OrderCompletionShape;
  /** The kind-specific downstream `m11.*` events a sign emits on top of the always-emitted
   * `m11.order.signed` (the routing the §4.4 catalog pins). */
  readonly downstreamSignedEvents: readonly M11EventName[];
}

/** §2.1 — the authoritative per-kind catalog (one entry per {@link OrderKind}). */
export const KIND_CATALOG: { readonly [K in OrderKind]: OrderKindMeta } = {
  lab: {
    kind: "lab",
    signerDisciplines: ["rn_case_manager", "medical_director", "hospice_physician", "np", "pa"],
    allowsVerbal: true,
    standingEligible: true,
    completion: "one_shot",
    downstreamSignedEvents: ["m11.order.hl7_orm_requested"],
  },
  dme: {
    kind: "dme",
    signerDisciplines: ["rn_case_manager", "medical_director", "hospice_physician", "np", "pa"],
    allowsVerbal: true,
    standingEligible: false,
    completion: "ongoing",
    downstreamSignedEvents: ["m11.order.supply_fulfillment_requested"],
  },
  level_of_care_change: {
    kind: "level_of_care_change",
    signerDisciplines: ["medical_director", "hospice_physician", "np"],
    allowsVerbal: false,
    standingEligible: false,
    completion: "ongoing",
    downstreamSignedEvents: ["m11.order.level_of_care_change_signed"],
  },
  recertification: {
    kind: "recertification",
    signerDisciplines: ["medical_director", "hospice_physician"],
    allowsVerbal: false,
    standingEligible: false,
    completion: "one_shot",
    downstreamSignedEvents: ["m11.order.recertification_signed"],
  },
  comfort_kit: {
    kind: "comfort_kit",
    signerDisciplines: ["rn_case_manager", "medical_director", "hospice_physician", "np"],
    allowsVerbal: true,
    standingEligible: false,
    completion: "one_shot",
    downstreamSignedEvents: ["m11.order.supply_fulfillment_requested"],
  },
  supply: {
    kind: "supply",
    signerDisciplines: ["rn_case_manager", "medical_director", "hospice_physician", "np"],
    allowsVerbal: true,
    standingEligible: true,
    completion: "ongoing",
    downstreamSignedEvents: ["m11.order.supply_fulfillment_requested"],
  },
  ancillary_service: {
    kind: "ancillary_service",
    signerDisciplines: ["rn_case_manager", "medical_director", "hospice_physician", "np", "msw"],
    allowsVerbal: true,
    standingEligible: true,
    completion: "ongoing",
    downstreamSignedEvents: [],
  },
  idg_requested: {
    // §2.1 — the M14 → M11 intake landing row; `clinical_supervisor` resolves/redirects but cannot
    // sign it as the final order (it must be reissued as a specific kind, §2.1).
    kind: "idg_requested",
    signerDisciplines: ["rn_case_manager", "clinical_supervisor"],
    allowsVerbal: false,
    standingEligible: false,
    completion: "ongoing",
    downstreamSignedEvents: ["m11.order.idg_drafted"],
  },
} as const;

/** §2.4 — the kinds a standing-order template may spawn (derived from {@link KIND_CATALOG}). */
export const STANDING_ELIGIBLE_KINDS: readonly OrderKind[] = (
  Object.values(KIND_CATALOG) as OrderKindMeta[]
)
  .filter((m) => m.standingEligible)
  .map((m) => m.kind);
