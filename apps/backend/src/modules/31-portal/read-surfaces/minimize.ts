// apps/backend/src/modules/31-portal/read-surfaces/minimize.ts — M31-T04 (§8.4, D7, D17).
//
// The D17 PHI-minimization rules the portal read surfaces apply on top of the upstream digests. Two shapes:
//
//   • Document exposure is fail-CLOSED. M22's `PortalDocumentReader` already excludes non-patient-facing
//     kinds server-side (§8.4), but the portal is the most exposed surface in the system (§8), so M31 keeps
//     its OWN allowlist of patient-facing aggregate types as defence-in-depth: a kind absent from the
//     allowlist is dropped even if the upstream ever leaks it. Over-dropping is a display gap; over-showing
//     is a breach — so the allowlist, not a denylist, is the correct shape.
//   • SUD redaction (D7 / §7.8) is a DISPLAY substitution, not a drop. M12/M13 already null the drug name on
//     a redacted row and set `isRedacted`; M31 renders the placeholder so the row's existence stays honest
//     (the count is real) without disclosing the substance-use treatment it stands for.
import type { DocumentAggregateType } from "@chartwarden/types";

/**
 * §8.4 — the M22 document aggregate types a portal caregiver / patient may see. Anything NOT in this set is
 * dropped by {@link isPatientFacingDocumentKind}. Deliberately conservative: internal clinical artifacts
 * (encounters, order/administration records, IDG minutes, discipline plans, EVV, intake source) are absent,
 * so a future upstream mistake that surfaces one still cannot reach the portal.
 */
export const PORTAL_PATIENT_FACING_DOCUMENT_KINDS: ReadonlySet<DocumentAggregateType> =
  new Set<DocumentAggregateType>([
    "election_statement",
    "nor",
    "revocation",
    "nomnc",
    "abn",
    "hipaa_privacy_notice",
    "code_status_directive",
    "discharge_summary",
    "patient_medication_list",
    "comfort_kit_receipt",
    "idg_patient_packet",
    "bereavement_letter",
    "visit_confirmation",
    "patient_amendment_statement_of_disagreement",
    "consent_record",
  ]);

/** §8.4 defence-in-depth — true only for a document kind the portal is permitted to show. */
export function isPatientFacingDocumentKind(kind: DocumentAggregateType): boolean {
  return PORTAL_PATIENT_FACING_DOCUMENT_KINDS.has(kind);
}

/** §7.8 / D7 — the lay placeholder shown in place of a SUD-redacted medication / administration name. Never
 *  hints at the substance (no "controlled", no schedule); a caregiver sees only that a protected item
 *  exists and to ask the care team. */
export const SUD_REDACTED_PLACEHOLDER = "Protected medication — contact your care team";

/** §7.8 / D7 — the display name for a possibly-redacted row: the placeholder when redacted, else the given
 *  lay name (falling back to the placeholder if the upstream nulled the name without setting the flag —
 *  fail-CLOSED on an inconsistent redaction). */
export function redactedDisplayName(
  redacted: boolean,
  displayName: string | null | undefined,
): string {
  if (redacted || !displayName || displayName.length === 0) return SUD_REDACTED_PLACEHOLDER;
  return displayName;
}
