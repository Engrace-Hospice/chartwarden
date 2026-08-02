// apps/backend/src/modules/31-portal/lifecycle/portal-access-gate.ts — M31-T03 (§4.4, §8.1, §8.2).
//
// THE FOUNDATION GATE. Every portal PHI route evaluates M39 consent before serving a byte (§8.2 Layer-3 /
// the plan's "M39 ConsentEvaluator gate on every route"). M31 `dependsOn` includes M39, but the established
// idiom for consuming `ConsentEvaluator` is a locally-declared structural port + `getSeam("ConsentEvaluator")`
// resolved OPAQUELY from the M1 registry — the M22/M15 precedent — so this stays off a `@wardenx/consent`
// import edge (`ConsentEvaluator` is `unknown` in the leaf SeamContracts). M39 owns the canonical rich
// interface; {@link PortalConsentEvaluatorPort} is the M31-side projection of the one arm M31 calls.
//
// The pure decision ({@link decidePortalAccess}) reads an already-resolved `allowed` fact; the impure
// resolver ({@link resolvePortalAccessConsent}) produces that fact via the real seam, FAIL-CLOSED on any
// error / missing seam / not-allowed (§8.2 — a consent read that throws must refuse, never disclose). The
// route binding (wrapping every handler) lands in M31-T07; T03 ships the reusable gate.
import type { PortalAccessGrantKind } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";
import { requirePortal } from "./errors";

/** The M31-side structural projection of M39's `ConsentEvaluator.evaluate` (the only arm the portal calls).
 *  The real (richer) contract lives in @wardenx/consent; M31 reads it opaquely from the M1 registry. */
export interface PortalConsentEvaluatorPort {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    asOf?: string;
    sessionContext: { sessionClass: string; portalDelegateCaregiverId?: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ allowed: boolean; denyReason?: string }>;
}

/**
 * §2.2.2 / §4.4 — the M39 consent type that backs each portal grant kind. The foundation gate evaluates
 * the grant's backing consent, so a `family_caregiver` session is gated on `family_caregiver_access`, a
 * DPOA session on `dpoa_healthcare`, a bereaved session on `bereavement_outreach_consent`, and a
 * patient-self session on the base `portal_access` type.
 */
const GRANT_KIND_CONSENT_TYPE: Record<PortalAccessGrantKind, string> = {
  patient_self: "portal_access",
  family_caregiver: "family_caregiver_access",
  dpoa_healthcare: "dpoa_healthcare",
  personal_representative: "personal_representative_authority_post_death",
  bereaved_family: "bereavement_outreach_consent",
};

/** The M39 consent type the foundation gate checks for a grant kind (§4.4). */
export function consentTypeForGrantKind(kind: PortalAccessGrantKind): string {
  return GRANT_KIND_CONSENT_TYPE[kind];
}

/** The session class M39 records for a portal-access evaluation (§8.1 — patient-self vs delegated). */
export function portalSessionClass(kind: PortalAccessGrantKind): "patient_portal" | "caregiver_portal" {
  return kind === "patient_self" ? "patient_portal" : "caregiver_portal";
}

/**
 * §8.2 — the PURE foundation-gate decision. Given an already-resolved `allowed` fact (from the seam),
 * refuse the route unless consent is affirmatively present. Fails CLOSED: `allowed !== true` → refusal.
 */
export function decidePortalAccess(consent: { allowed: boolean }): void {
  requirePortal(
    consent.allowed === true,
    "PORTAL_CONSENT_ABSENT",
    "no active portal-access consent is on file for this patient",
  );
}

/**
 * §4.4 / §8.2 — resolve whether portal access consent is present for `(patient, grantKind)` via M39's real
 * `ConsentEvaluator`, read OPAQUELY from the M1 registry. FAIL-CLOSED on any error / missing seam /
 * not-allowed so a consent-read outage refuses the disclosure rather than serving it.
 */
export async function resolvePortalAccessConsent(input: {
  organizationId: string;
  patientId: string;
  grantKind: PortalAccessGrantKind;
  asOf?: string;
  portalDelegateCaregiverId?: string;
  callerRoute?: string;
}): Promise<{ allowed: boolean; denyReason?: string }> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as PortalConsentEvaluatorPort;
    const res = await evaluator.evaluate({
      organizationId: input.organizationId,
      patientId: input.patientId,
      consentType: consentTypeForGrantKind(input.grantKind),
      asOf: input.asOf,
      sessionContext: {
        sessionClass: portalSessionClass(input.grantKind),
        portalDelegateCaregiverId: input.portalDelegateCaregiverId,
      },
      callerModule: "m31",
      callerRoute: input.callerRoute,
    });
    return { allowed: res.allowed === true, denyReason: res.denyReason };
  } catch {
    return { allowed: false, denyReason: "consent_read_failed" };
  }
}

/**
 * §4.4 / §8.1 — `evaluateForPortalAccess`: the one call a portal route makes to pass the foundation gate.
 * Resolves consent via M39 then applies the pure decision — throws `PORTAL_CONSENT_ABSENT` (403) unless an
 * active backing consent is on file. This is the gate the plan names "on every route".
 */
export async function evaluateForPortalAccess(input: {
  organizationId: string;
  patientId: string;
  grantKind: PortalAccessGrantKind;
  asOf?: string;
  portalDelegateCaregiverId?: string;
  callerRoute?: string;
}): Promise<void> {
  const consent = await resolvePortalAccessConsent(input);
  decidePortalAccess(consent);
}
