// M36 WP 3.2 - what the web knows about a clinical link: the kinds, their labels, the tenant flag, and the PORT that
// supplies candidate records to the composer's link picker. M36 owns no list route for candidate records (the owning
// modules do), so the picker never fetches by itself: it asks a `ClinicalLinkCandidateSource`.
import type { ClinicalLinkKind } from "@chartwarden/types";

export const CLINICAL_LINKS_FLAG_KEY = "messaging.clinical_links";

export const CLINICAL_LINK_KIND_LABEL: Readonly<Record<ClinicalLinkKind, string>> = {
  medication: "Medication",
  order: "Order",
  care_plan: "Care plan",
  assessment: "Assessment",
  visit: "Visit",
  document: "Document",
  idg_meeting: "IDG meeting",
};

/** A record the user may link. `label`/`detail` live in the picker and tray only; the message stores ids. */
export interface ClinicalLinkCandidate {
  readonly kind: ClinicalLinkKind;
  readonly entityId: string;
  readonly label: string;
  readonly detail?: string;
}

/**
 * Where the picker gets candidates. `kinds` is the set this source can list; the picker offers exactly those and
 * hides every other kind. `list` is READ-ONLY by contract (GET against the owning module's patient-scoped route).
 * The server re-validates every link on send and stays the authority.
 */
export interface ClinicalLinkCandidateSource {
  readonly kinds: readonly ClinicalLinkKind[];
  list(
    kind: ClinicalLinkKind,
    patientId: string,
    signal: AbortSignal,
  ): Promise<readonly ClinicalLinkCandidate[]>;
}

/** A link chosen for the draft (client-side tray entry). */
export type DraftClinicalLink = ClinicalLinkCandidate;
