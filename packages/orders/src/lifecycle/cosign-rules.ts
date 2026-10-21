// @chartwarden/orders — §2.5 cosignature rules (M11-T03). Pure, IO-free.
//
// Three concurrent cosign axes drive whether `pending_signature → active` is blocked behind a cosignature:
//   1. LPN-cosign-by-RN  (state-law-driven)  — an LPN-drafted clinical kind in the tenant's
//      `lpn_cosign_required_kinds` requires an RN (case manager / clinical supervisor) cosignature.
//   2. NP-cosign-by-MD   (state-board-driven)— an NP-signed kind in the tenant's `np_cosign_required_kinds`
//      requires a supervising medical_director cosignature (default: none; the jurisdiction adapter is P2).
//   3. For-cause cosign  (escalation jump)    — an LCC order to `gip` from `rhc` skipping `chc`/`irc` needs
//      a medical_director cosignature alongside a hospice_physician/np signer (MD-signed self-satisfies).
// Every axis resolves to the same polymorphic `order_signature` row with `signature_kind='cosignature'`;
// this module decides WHEN a cosignature is required and WHO may attest it. The cosign-attached gate on
// the `sign` event lives in ./order-machine; the attest-validation plan is `planCosignAttest` below.
import type { OrderKind } from "@chartwarden/types";
import { require_ } from "./errors";

/** The §2.5 per-tenant cosign policy (a projection of `order_verbal_policy`; default-filled by the service). */
export interface OrderCosignPolicy {
  /** Axis 1 — kinds for which an LPN-drafted order requires RN cosign. Default: all clinical kinds. */
  readonly lpnCosignRequiredKinds: readonly OrderKind[];
  /** Axis 2 — kinds for which an NP-signed order requires MD cosign. Default: empty. */
  readonly npCosignRequiredKinds: readonly OrderKind[];
}

/** §2.5 — the default tenant policy: LPN drafts of every clinical kind require RN cosign; no NP cosign. */
export const DEFAULT_COSIGN_POLICY: OrderCosignPolicy = {
  lpnCosignRequiredKinds: ["lab", "dme", "comfort_kit", "supply", "ancillary_service"],
  npCosignRequiredKinds: [],
} as const;

/** The §2.1 hospice level-of-care tiers, ordered from least to most acute (escalation-jump math, axis 3). */
const LOC_RANK = { rhc: 0, irc: 1, chc: 2, gip: 3 } as const;
export type LevelOfCare = keyof typeof LOC_RANK;

/** The disciplines an RN cosignature (axis 1) accepts. */
const RN_COSIGN_ROLES = ["rn_case_manager", "clinical_supervisor"] as const;

function key(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * §2.5 axis 1 — whether an LPN-drafted `kind` requires an RN cosignature under `policy`. Only an `lpn`
 * drafter triggers it; every other drafting discipline self-satisfies (no cosignature row needed).
 */
export function lpnCosignRequired(
  drafterDiscipline: string,
  kind: OrderKind,
  policy: OrderCosignPolicy = DEFAULT_COSIGN_POLICY,
): boolean {
  return key(drafterDiscipline) === "lpn" && policy.lpnCosignRequiredKinds.includes(kind);
}

/**
 * §2.5 axis 2 — whether an NP-signed `kind` requires a medical_director cosignature under `policy`
 * (default: never; the per-jurisdiction state-board adapter is Phase 2, mirroring the M40 D6 deferral).
 */
export function npCosignRequired(
  signerDiscipline: string,
  kind: OrderKind,
  policy: OrderCosignPolicy = DEFAULT_COSIGN_POLICY,
): boolean {
  return key(signerDiscipline) === "np" && policy.npCosignRequiredKinds.includes(kind);
}

/**
 * §2.5 axis 3 — whether a `level_of_care_change` is an "escalation jump" that requires a medical_director
 * cosignature: a transition to `gip` from `rhc` that skips `chc`/`irc`, when the signer is a
 * hospice_physician or np. A medical_director signer self-satisfies (no separate cosignature).
 */
export function escalationJumpCosignRequired(
  fromLevel: LevelOfCare,
  toLevel: LevelOfCare,
  signerDiscipline: string,
): boolean {
  const isJump = fromLevel === "rhc" && toLevel === "gip";
  if (!isJump) return false;
  const d = key(signerDiscipline);
  return d === "hospice_physician" || d === "np";
}

/**
 * §2.5 — the single cosign decision the request-signature path consumes: does this order, given its
 * drafter / signer / (for LCC) level transition, require a cosignature before it may be signed, and which
 * role must attest it. Axis precedence: LPN-cosign (RN) → escalation-jump (MD) → NP-cosign (MD). Returns
 * `null` when no cosignature is required (the order signs directly).
 */
export interface CosignRequirement {
  readonly axis: "lpn_cosign" | "escalation_jump" | "np_cosign";
  readonly cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director";
}

export function resolveCosignRequirement(input: {
  readonly kind: OrderKind;
  readonly drafterDiscipline: string;
  readonly signerDiscipline: string;
  readonly levelChange?: { readonly fromLevel: LevelOfCare; readonly toLevel: LevelOfCare };
  readonly policy?: OrderCosignPolicy;
}): CosignRequirement | null {
  const policy = input.policy ?? DEFAULT_COSIGN_POLICY;
  if (lpnCosignRequired(input.drafterDiscipline, input.kind, policy)) {
    // Either RN role may attest; the route surfaces the case-manager queue first (§4.9).
    return { axis: "lpn_cosign", cosignerRoleNeeded: "rn_case_manager" };
  }
  if (
    input.kind === "level_of_care_change" &&
    input.levelChange &&
    escalationJumpCosignRequired(
      input.levelChange.fromLevel,
      input.levelChange.toLevel,
      input.signerDiscipline,
    )
  ) {
    return { axis: "escalation_jump", cosignerRoleNeeded: "medical_director" };
  }
  if (npCosignRequired(input.signerDiscipline, input.kind, policy)) {
    return { axis: "np_cosign", cosignerRoleNeeded: "medical_director" };
  }
  return null;
}

/** The facts a cosignature attest is validated against (the order's cosign state + the attester). */
export interface CosignAttest {
  readonly orderId: string;
  /** Whether the order actually requires a cosignature (the resolved {@link CosignRequirement} ≠ null). */
  readonly cosignRequired: boolean;
  /** Whether a cosignature row already exists for this order (idempotency / double-sign guard). */
  readonly alreadyCosigned: boolean;
  /** The role the attesting caller holds (must satisfy `cosignerRoleNeeded`). */
  readonly cosignerRole: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  /** The role the resolved requirement demands. */
  readonly cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  /** ABAC self-cosign guard: the attester must not be the order's drafter/signer (§7.3). */
  readonly cosignerIsAuthor: boolean;
}

/** The decision a validated attest produces: write the `cosignature` row + emit `m11.order.cosigned`. */
export interface CosignPlan {
  readonly orderId: string;
  readonly emitsCosigned: true;
}

/** Whether a caller's role satisfies the demanded cosign role (an RN role satisfies either RN demand). */
function roleSatisfies(
  has: CosignAttest["cosignerRole"],
  needed: CosignAttest["cosignerRoleNeeded"],
): boolean {
  if (needed === "medical_director") return has === "medical_director";
  // RN demand: either RN role attests (§2.5 axis 1).
  return (RN_COSIGN_ROLES as readonly string[]).includes(has);
}

/**
 * §2.5 / §7.3 — validate a cosignature attest and produce the write/emit plan. Guards:
 *   - the order must require a cosignature      → 422 `COSIGN_NOT_REQUIRED`
 *   - not already cosigned                      → 409 `ALREADY_COSIGNED`
 *   - the attester's role satisfies the demand
 *     and is not the order's author             → 403 `COSIGNER_NOT_ELIGIBLE`
 * Pure: the service writes the `order_signature` cosignature row and emits `m11.order.cosigned`.
 */
export function planCosignAttest(attest: CosignAttest): CosignPlan {
  require_(
    attest.cosignRequired,
    "COSIGN_NOT_REQUIRED",
    `Order ${attest.orderId} does not require a cosignature.`,
  );
  require_(
    !attest.alreadyCosigned,
    "ALREADY_COSIGNED",
    `Order ${attest.orderId} is already cosigned.`,
  );
  require_(
    roleSatisfies(attest.cosignerRole, attest.cosignerRoleNeeded) && !attest.cosignerIsAuthor,
    "COSIGNER_NOT_ELIGIBLE",
    `A '${attest.cosignerRoleNeeded}' cosignature (other than the order's author) is required.`,
  );
  return { orderId: attest.orderId, emitsCosigned: true };
}
