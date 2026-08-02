// apps/backend/src/modules/31-portal/read-surfaces/project.ts — M31-T04 (§4.4, §5.1, §8.4, D17).
//
// The PURE projection cores of the portal read layer: an upstream digest (+ injected lay-label functions)
// in, a D17-minimized lay view out. No DB, no live seam, no ambient clock — every dependency is a parameter,
// mirroring the T03 lifecycle cores. The impure side (resolving the seam, wiring the live M38 labeller) is
// `resolve.ts`; the routes that gate + emit these are M31-T07. Keeping the projection pure is what lets the
// §8.4 minimization + §7.8 redaction rules be unit-tested exhaustively without a running system.
import type {
  BereavedPortalScope,
  DocumentAggregateType,
  PatientId,
  PatientIdentity,
  PortalAdministrationSummary,
  PortalDocumentDigest,
  PortalMedicationSummary,
  PortalTriageSummary,
  PortalVisitSummary,
} from "@wardenx/types";
import { isPatientFacingDocumentKind, redactedDisplayName } from "./minimize";
import { layEnumLabel } from "./terminology";
import type {
  PortalAdministrationListView,
  PortalBereavementScopeView,
  PortalCarePlanProblemView,
  PortalCarePlanView,
  PortalDashboardView,
  PortalDocumentListView,
  PortalMedicationListView,
  PortalTriageListView,
  PortalVisitListView,
} from "./views";

/** Whole years between an ISO `yyyy-mm-dd` date of birth and `asOf` (ms epoch). `null` on an unparseable /
 *  future dob — the dashboard renders "age unknown" rather than a wrong or negative number. */
export function ageYearsFromDob(dobIso: string, asOfMs: number): number | null {
  const dobMs = Date.parse(dobIso);
  if (Number.isNaN(dobMs) || dobMs > asOfMs) return null;
  const asOf = new Date(asOfMs);
  const dob = new Date(dobMs);
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age < 0 ? null : age;
}

/** §5.1 dashboard — M5 identity + upstream counts → the lay header. MRN / SSN / external ids are dropped by
 *  construction (never copied out of `PatientIdentity`). */
export function projectDashboard(
  identity: PatientIdentity,
  counts: { upcomingVisits: number; activeMedications: number; unreadDocuments: number },
  asOfMs: number,
): PortalDashboardView {
  return {
    category: "care_plan",
    patientId: identity.id as PatientId,
    displayName: `${identity.firstName} ${identity.lastName}`.trim(),
    ageYears: ageYearsFromDob(identity.dateOfBirth, asOfMs),
    counts: {
      upcomingVisits: counts.upcomingVisits,
      activeMedications: counts.activeMedications,
      unreadDocuments: counts.unreadDocuments,
    },
  };
}

/** The care-plan projector's injected code→lay-label function (M38-backed; see `resolve.ts`). */
export type LayLabelForCode = (
  system: string,
  code: string | null | undefined,
  fallback: string,
) => Promise<string>;

/**
 * §5.1 care-plan tab — M7 relevant-elements digest → lay problems with their goals + intervention focus.
 * Each problem's label is M38-resolved from its ICD-10 (preferred) or SNOMED code, FAIL-OPEN to the row's
 * own `description`. A `redacted` digest yields an empty problem list (D17 — an SUD-flagged plan discloses
 * nothing through the portal). Goals / interventions are matched to their parent problem by `problemId`.
 */
export async function projectCarePlan(
  elements: {
    patientId: PatientId;
    redacted: boolean;
    problems: readonly {
      problemId: string;
      icd10Code: string | null;
      snomedCode: string | null;
      description: string;
    }[];
    goals: readonly { problemId: string; text: string }[];
    interventions: readonly { problemId: string; scopeText: string }[];
  },
  layLabelForCode: LayLabelForCode,
): Promise<PortalCarePlanView> {
  if (elements.redacted) {
    return { category: "care_plan", patientId: elements.patientId, problems: [], redacted: true };
  }
  const problems: PortalCarePlanProblemView[] = [];
  for (const p of elements.problems) {
    const system = p.icd10Code ? "icd10" : "snomed";
    const code = p.icd10Code ?? p.snomedCode;
    const label = await layLabelForCode(system, code, p.description);
    problems.push({
      problemId: p.problemId,
      label,
      goals: elements.goals.filter((g) => g.problemId === p.problemId).map((g) => g.text),
      focus: elements.interventions
        .filter((i) => i.problemId === p.problemId)
        .map((i) => i.scopeText),
    });
  }
  return { category: "care_plan", patientId: elements.patientId, problems, redacted: false };
}

/** §5.1 medications — M12 lay summaries → the medications tab; SUD redaction applied per row (§7.8/D7). */
export function projectMedicationList(
  summaries: readonly PortalMedicationSummary[],
): PortalMedicationListView {
  return {
    category: "medications",
    items: summaries.map((m) => ({
      medicationOrderId: m.medicationOrderId,
      displayName: redactedDisplayName(m.isRedacted, m.displayName),
      instructions: m.isRedacted ? "" : m.instructions,
      statusLabel: layEnumLabel(m.status),
      redacted: m.isRedacted,
    })),
  };
}

/** §5.1 administrations — M13 lay summaries → the administrations list; SUD redaction applied per row. */
export function projectAdministrationList(
  summaries: readonly PortalAdministrationSummary[],
): PortalAdministrationListView {
  return {
    category: "administrations",
    items: summaries.map((a) => ({
      administrationRecordId: a.administrationRecordId,
      displayName: redactedDisplayName(a.isRedacted, a.displayName),
      administeredAt: a.administeredAt,
      modeLabel: layEnumLabel(a.mode),
      redacted: a.isRedacted,
    })),
  };
}

/** §5.1 visits — M17 portal visit summaries → the upcoming-visits tab. Scheduling-availability / routing
 *  metadata never enters `PortalVisitSummary`, so minimization here is the lay setting label only (§8.4). */
export function projectVisitList(summaries: readonly PortalVisitSummary[]): PortalVisitListView {
  return {
    category: "visits",
    items: summaries.map((v) => ({
      visitId: v.visitId,
      scheduledStartedAt: v.scheduledStartedAt,
      scheduledEndedAt: v.scheduledEndedAt,
      purposeLabel: v.visitPurposeLabel,
      clinicianDisplayName: v.clinicianDisplayName,
      settingLabel: layEnumLabel(v.visitSetting),
    })),
  };
}

/** §5.1 / §8.4 documents — M22 digests → the documents tab, FAIL-CLOSED through the M31 patient-facing
 *  allowlist (defence-in-depth over M22's own filter). A non-allowlisted kind is dropped entirely. */
export function projectDocumentList(
  digests: readonly PortalDocumentDigest[],
): PortalDocumentListView {
  return {
    category: "documents",
    items: digests
      .filter((d) => isPatientFacingDocumentKind(d.aggregateType as DocumentAggregateType))
      .map((d) => ({
        documentId: d.documentId,
        title: d.title,
        kindLabel: layEnumLabel(d.aggregateType),
        createdAt: d.createdAt,
        hasActiveVersion: d.activeVersionId !== null,
      })),
  };
}

/** §5.1 triage — M19 portal triage summaries → the after-hours-calls list. Caller label prefers M19's
 *  resolved relationship, else the lay caller kind; no clinical assessment detail crosses. */
export function projectTriageList(summaries: readonly PortalTriageSummary[]): PortalTriageListView {
  return {
    category: "triage",
    items: summaries.map((t) => ({
      triageCallId: t.triageCallId,
      occurredAt: t.occurredAt,
      callerLabel: t.callerRelationshipLabel ?? layEnumLabel(t.callerKind),
      disposition: t.dispositionSummaryLay,
      visitDispatched: t.visitDispatched,
    })),
  };
}

/** §5.1 / §7.5 bereaved surface — M16 bereaved-portal scope rows → the bereaved read view (D4/D9). */
export function projectBereavementScope(
  scopes: readonly BereavedPortalScope[],
): PortalBereavementScopeView {
  return {
    category: "bereavement",
    items: scopes.map((s) => ({
      contactId: s.contactId,
      planId: s.planId,
      inWindow: s.inBereavementWindow,
      mayOptOut: s.mayOptOut,
      mayRescindOptOut: s.mayRescindOptOut,
      statusLabel: layEnumLabel(s.status),
    })),
  };
}
