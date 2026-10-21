// apps/backend/src/modules/31-portal/read-surfaces/terminology.ts — M31-T04 (§4.4, §8.4, D17).
//
// "M38 layLabel": the lay-language labelling utility every portal read surface runs its coded / enum
// values through before they reach a caregiver. A clinical corpus speaks in ICD-10 / SNOMED / RxNorm codes
// and internal snake_case enums; the portal must never render those raw (D17 — the surface is a
// non-clinician). Two label sources, both fail-OPEN to a safe human fallback (a missing label is a cosmetic
// gap, never a disclosure — the fail-CLOSED direction lives in the consent gate + the document allowlist):
//
//   • {@link layLabelForCode} — coded concepts (a care-plan problem's ICD-10, a drug's RxNorm) resolve via
//     M38's real `TerminologyProvider.lookup(...).display`, read OPAQUELY from the M1 registry (the
//     TerminologyProvider seam is `unknown` in the leaf SeamContracts — the M22/M15/T03-consent precedent).
//   • {@link layEnumLabel} — internal M31/upstream enums (visit setting, administration mode, document
//     kind) are NOT M38 code systems, so they resolve against a small curated override map over a generic
//     snake_case→Title-Case humanizer. PURE.
import { getSeam } from "../../../bootstrap/index";

/** The M31-side structural projection of M38's `TerminologyProvider` — the one arm the portal calls. The
 *  rich contract lives in @chartwarden/terminology; M31 reads it opaquely so it stays off a `@chartwarden/*` edge. */
export interface PortalTerminologyPort {
  lookup(system: string, code: string, asOf?: Date): Promise<{ readonly display?: string } | null>;
}

/**
 * Resolve M38's `TerminologyProvider` OPAQUELY from the M1 registry. Returns `null` (never throws) when the
 * seam is unregistered or the cast target is absent — the caller then falls back to the raw description, so
 * a terminology outage degrades the label, it does not fail the read.
 */
export function resolvePortalTerminology(): PortalTerminologyPort | null {
  try {
    return getSeam("TerminologyProvider") as PortalTerminologyPort;
  } catch {
    return null;
  }
}

/**
 * §8.4 / D17 — the lay display for a coded concept. Consults M38 for the concept's `display`; FAIL-OPEN to
 * `fallback` (typically the source row's own free-text description) on any miss / error, so the portal
 * always renders something human. `port` is injectable for tests; omit it to resolve the live seam.
 */
export async function layLabelForCode(
  system: string,
  code: string | null | undefined,
  fallback: string,
  port: PortalTerminologyPort | null = resolvePortalTerminology(),
): Promise<string> {
  if (!code || !port) return fallback;
  try {
    const concept = await port.lookup(system, code);
    const display = concept?.display;
    return display && display.length > 0 ? display : fallback;
  } catch {
    return fallback;
  }
}

/** §8.4 curated lay overrides for the non-obvious upstream enum codes the humanizer would mangle. Anything
 *  not listed falls through to {@link humanizeToken}; a new upstream enum value therefore still renders
 *  readably (Title Case) rather than leaking the raw token or throwing. */
const LAY_ENUM_OVERRIDES: Readonly<Record<string, string>> = {
  // §2.2.3 telehealth / M17 visit settings
  telephonic: "Phone visit",
  patient_home: "Home visit",
  patient_home_with_video: "Video visit at home",
  inpatient_unit: "Inpatient unit visit",
  facility: "Facility visit",
  // M13 administration modes
  single_dose: "Single dose",
  iv_continuous_start: "IV infusion started",
  iv_continuous_rate_change: "IV infusion rate changed",
  iv_continuous_pause: "IV infusion paused",
  iv_continuous_resume: "IV infusion resumed",
  iv_continuous_stop: "IV infusion stopped",
  // M22 document kinds a caregiver may see
  election_statement: "Hospice election form",
  cti: "Certification of terminal illness",
  f2f: "Face-to-face encounter",
  nomnc: "Notice of non-coverage",
  abn: "Advance beneficiary notice",
  hipaa_privacy_notice: "Privacy notice",
  code_status_directive: "Code status directive",
  idg_patient_packet: "Care team summary",
  patient_medication_list: "Medication list",
  comfort_kit_receipt: "Comfort kit receipt",
  bereavement_letter: "Bereavement letter",
  visit_confirmation: "Visit confirmation",
  patient_amendment_statement_of_disagreement: "Statement of disagreement",
  // M12 medication order statuses (lay)
  pending_signature: "Awaiting clinician signature",
  verbal_pending: "Verbal order pending",
  epcs_identity_pending: "Identity check pending",
  queued_for_transmission: "Sending to pharmacy",
  // M19 triage caller kinds
  external_clinician: "Outside clinician",
  portal_session: "Portal",
  system_inbound: "Automated",
  bereaved_family: "Family member",
};

/** Generic snake_case / kebab-case → Title Case. PURE. `"discharge_summary"` → `"Discharge Summary"`. */
export function humanizeToken(token: string): string {
  return token
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * §8.4 / D17 — the lay label for an internal enum value. PURE: a curated override wins, else the value is
 * humanized. Never throws and never returns the raw token verbatim for a non-empty input.
 */
export function layEnumLabel(value: string): string {
  if (value.length === 0) return "";
  return LAY_ENUM_OVERRIDES[value] ?? humanizeToken(value);
}
