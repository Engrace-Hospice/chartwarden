// M36 WP 3.2 - clinical links. A message links to ONE record owned by another module; M36 stores only
// (kind, source id) and reads the rest through the owning module's `linkSummary` seam at open time.
import type { IsoInstant } from "./care-plan";
import type { PatientId } from "./admission";

export const CLINICAL_LINK_KINDS = [
  "medication",
  "order",
  "care_plan",
  "assessment",
  "visit",
  "document",
  "idg_meeting",
] as const;
export type ClinicalLinkKind = (typeof CLINICAL_LINK_KINDS)[number];

/**
 * The minimum an owning module returns so M36 can authorise and label a link. IDs and status only: never a title,
 * drug name, score text, note or any free text (those can carry PHI the viewer may not be entitled to).
 * `patientId` is null only for a record that has no patient (an IDG meeting); M36 refuses a null patient for every
 * other kind. `null` result = not found in this org (indistinguishable from "not yours" by design).
 */
export interface ClinicalLinkSummary {
  readonly id: string;
  readonly patientId: PatientId | null;
  readonly status: string;
  readonly occurredAt: IsoInstant | null;
}

/** Added to each source seam. Org-explicit (opens its own tenant context, callable outside a request), fails closed. */
export interface ClinicalLinkSource {
  linkSummary(organizationId: string, id: string): Promise<ClinicalLinkSummary | null>;
}
