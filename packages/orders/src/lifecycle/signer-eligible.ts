// @wardenx/orders — §2.2 / §4.7 `signer_eligible` + the named-practitioner / on-behalf guards (M11-T03).
// Pure, IO-free.
//
// The signing gate is stricter than the drafting gate (./discipline-can-order): a signer must be in the
// kind's signer matrix AND, for the two written-ab-initio kinds (`recertification`, `level_of_care_change`),
// must be a `medical_director` or `hospice_physician` — §2.2 narrows those beyond the catalog matrix
// (which lists `np` for LCC), so the §2.2 restriction wins. Beyond eligibility, the §2.2 sign guard also
// requires the signer to be the named ordering practitioner OR to hold `orders.sign_on_behalf` (reserved
// to a `medical_director`); the verbal flow admits no on-behalf shortcut (§2.2, per CMS). The named/on-
// behalf facts are resolved upstream (the named-practitioner match, the held-permission) and passed in.
import type { OrderKind } from "@wardenx/types";
import { KIND_CATALOG } from "../catalog";
import { require_ } from "./errors";

/** §2.2 — the kinds whose signer is narrowed to a physician (medical_director / hospice_physician). */
export const PHYSICIAN_ONLY_SIGN_KINDS = [
  "recertification",
  "level_of_care_change",
] as const satisfies readonly OrderKind[];

/** The two disciplines that satisfy the §2.2 physician-only narrowing. */
const PHYSICIAN_SIGN_DISCIPLINES = ["medical_director", "hospice_physician"] as const;

/** Normalize a free-text discipline to the lower-case key the matrix compares. */
function key(discipline: string): string {
  return discipline.trim().toLowerCase();
}

/**
 * §2.2 / §4.7 — whether `signerDiscipline` is eligible to SIGN `kind`. The discipline must be in the
 * kind's signer matrix; for {@link PHYSICIAN_ONLY_SIGN_KINDS} it must additionally be a physician
 * (medical_director / hospice_physician) — the §2.2 narrowing over the catalog matrix.
 */
export function signerEligible(signerDiscipline: string, kind: OrderKind): boolean {
  const d = key(signerDiscipline);
  if (!(KIND_CATALOG[kind].signerDisciplines as readonly string[]).includes(d)) return false;
  if ((PHYSICIAN_ONLY_SIGN_KINDS as readonly string[]).includes(kind)) {
    return (PHYSICIAN_SIGN_DISCIPLINES as readonly string[]).includes(d);
  }
  return true;
}

/** Guard the sign path on signer eligibility (raises `SIGNER_NOT_ELIGIBLE`). */
export function assertSignerEligible(signerDiscipline: string, kind: OrderKind): void {
  require_(
    signerEligible(signerDiscipline, kind),
    "SIGNER_NOT_ELIGIBLE",
    `Discipline '${signerDiscipline}' is not eligible to sign a '${kind}' order (§2.2 signer matrix).`,
  );
}

/** The §2.2 authority facts a sign is validated against (resolved upstream; injected as data). */
export interface SignAuthority {
  /** The signer is the named ordering practitioner on the order. */
  readonly isNamedPractitioner: boolean;
  /** The signer is signing on behalf of the named practitioner (`signature_context.onBehalfOf` set). */
  readonly onBehalf: boolean;
  /** The on-behalf signer is a `medical_director` (the only discipline holding `orders.sign_on_behalf`). */
  readonly onBehalfSignerIsMedicalDirector: boolean;
  /** The signature is being applied against a `verbal_pending` order (no on-behalf shortcut, §2.2). */
  readonly viaVerbal: boolean;
}

/**
 * §2.2 — assert the signer is authorized to sign this order: the named ordering practitioner, OR an
 * on-behalf medical_director. Sign-on-behalf is refused in the verbal flow (CMS requires the named
 * practitioner's own signature). Raises `SIGNER_NOT_NAMED_PRACTITIONER` / `ON_BEHALF_NOT_PERMITTED`.
 */
export function assertSignAuthority(auth: SignAuthority): void {
  if (auth.isNamedPractitioner) return;
  require_(
    auth.onBehalf,
    "SIGNER_NOT_NAMED_PRACTITIONER",
    "The signer is not the named ordering practitioner on this order (§2.2).",
  );
  require_(
    !auth.viaVerbal,
    "ON_BEHALF_NOT_PERMITTED",
    "Sign-on-behalf is not permitted for a verbal order — the named practitioner must sign (§2.2).",
  );
  require_(
    auth.onBehalfSignerIsMedicalDirector,
    "ON_BEHALF_NOT_PERMITTED",
    "Only a medical_director may sign on behalf of the ordering practitioner (`orders.sign_on_behalf`).",
  );
}
