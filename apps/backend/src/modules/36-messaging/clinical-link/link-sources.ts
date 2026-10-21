// apps/backend/src/modules/36-messaging/clinical-link/link-sources.ts - WP 3.2: which owning-module seam answers each
// link kind, and which permission + scope the caller must hold to link or open it.
//
// Each of the seven seams declares `linkSummary(organizationId, id)` by extending `ClinicalLinkSource`, which has no
// write member, so this module can read a source and nothing else.
import { type GuardHandler, composeGuards, requireAbac, requirePermission } from "@chartwarden/auth";
import type { AbacTarget } from "@chartwarden/auth";
import type { ClinicalLinkKind, ClinicalLinkSource } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import type { ClinicalLinkSourcePorts } from "./clinical-link-service";

export const CLINICAL_LINK_SEAM_KEYS = {
  medication: "MedicationOrderProvider",
  order: "OrderProvider",
  care_plan: "CarePlanReader",
  assessment: "LatestAssessmentProvider",
  visit: "VisitReader",
  document: "DocumentReader",
  idg_meeting: "IdgScheduleProvider",
} as const satisfies Record<ClinicalLinkKind, Parameters<typeof getSeam>[0]>;

const PATIENT_SCOPE = "caseload_or_scope";
const MEETING_SCOPE = "idg_meeting_scope";

/** Per kind: the owning module's READ permission and the ABAC predicate over its target. */
export const CLINICAL_LINK_GUARDS: Readonly<
  Record<ClinicalLinkKind, { readonly permission: string; readonly predicate: string }>
> = {
  medication: { permission: "prescribing.read", predicate: PATIENT_SCOPE },
  order: { permission: "orders.read", predicate: PATIENT_SCOPE },
  care_plan: { permission: "care_plan.read", predicate: PATIENT_SCOPE },
  assessment: { permission: "assessment.read", predicate: PATIENT_SCOPE },
  visit: { permission: "visit.read", predicate: PATIENT_SCOPE },
  // STRICTER than the document metadata route on purpose: that route has no ABAC, a link must not widen disclosure.
  document: { permission: "documents.read", predicate: PATIENT_SCOPE },
  idg_meeting: { permission: "idg.read", predicate: MEETING_SCOPE },
};

/**
 * The kind's guard over an explicit target (the summary's patient, or the meeting). Break-glass is NOT honoured: an
 * emergency grant opens the owning module's own screen (which audits it), never a chat side door.
 */
export function guardForLink(kind: ClinicalLinkKind, target: AbacTarget): GuardHandler {
  const { permission, predicate } = CLINICAL_LINK_GUARDS[kind];
  return composeGuards(
    requirePermission(permission),
    requireAbac(permission, predicate, { getTarget: () => target, breakGlassBypassable: false }),
  );
}

/**
 * The ABAC target for an IDG meeting. `idg_meeting_scope` resolves the meeting's location itself from `{ id }`, so the
 * default needs nothing beyond the id. A port (not a constant) so the wiring can supply more if that predicate changes.
 */
export type MeetingScopeTarget = (organizationId: string, meetingId: string) => Promise<AbacTarget>;
export const defaultMeetingScopeTarget: MeetingScopeTarget = async (_org, meetingId) => ({
  id: meetingId,
});

const sourceOf = (kind: ClinicalLinkKind): ClinicalLinkSource =>
  getSeam(CLINICAL_LINK_SEAM_KEYS[kind]);

/** Production source ports: the owning seam, resolved at call time (an unbound deny-stub throws => unavailable). */
export const seamClinicalLinkSources: ClinicalLinkSourcePorts = {
  summary: (kind, organizationId, sourceId) => sourceOf(kind).linkSummary(organizationId, sourceId),
};
