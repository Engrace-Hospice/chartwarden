// apps/backend/src/modules/31-portal/read-surfaces/resolve.ts — M31-T04 (§4.4, §8.2, §8.4, D17).
//
// The impure side of the portal read layer: resolve an upstream reader seam OPAQUELY from the M1 registry
// (`getSeam`), then hand its digest to the matching PURE projector in `project.ts`. Every resolver is
// FAIL-CLOSED for disclosure: any missing seam / throw yields the EMPTY view, never a partial leak and
// never a raw error to the caregiver (§8.2 — a read-path outage discloses nothing). The M39 consent gate
// (T03 `evaluateForPortalAccess`) and the per-route `portal_grant_active_for_patient` ABAC still run FIRST
// at the route (M31-T07); these resolvers assume the gate already passed and only compose the payload.
//
// The consumed seam arms are the DEDICATED portal-summary methods the upstream modules published for exactly
// this surface — M12 `getPortalMedicationSummary`, M13 `getPortalAdministrationSummary`, M17
// `PortalVisitReader`, M19 `PortalTriageReader`, M22 `PortalDocumentReader`, M16 `BereavedPortalScopeProvider`
// — plus M5 `PatientReader` for the dashboard header and M38 for lay coded-concept labels. (M7's care-plan
// read has no dedicated portal seam arm yet — only the encounter-scoped `relevantElementsForEncounter` — so
// its LIVE resolver is deferred to when M7 publishes a portal reader; the pure `projectCarePlan` core ships
// here now and is exercised in the T04 unit suite.)
import type { PatientId, PatientIdentity } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";
import {
  projectAdministrationList,
  projectBereavementScope,
  projectDashboard,
  projectDocumentList,
  projectMedicationList,
  projectTriageList,
  projectVisitList,
} from "./project";
import { layLabelForCode } from "./terminology";
import type {
  PortalAdministrationListView,
  PortalBereavementScopeView,
  PortalDashboardView,
  PortalDocumentListView,
  PortalMedicationListView,
  PortalTriageListView,
  PortalVisitListView,
} from "./views";

/** The live M38-backed code→lay-label function the care-plan projector consumes (re-exported so M31-T07 can
 *  inject it once M7's portal care-plan reader lands). Resolves the terminology seam per call, fail-open. */
export const liveLayLabelForCode = (
  system: string,
  code: string | null | undefined,
  fallback: string,
) => layLabelForCode(system, code, fallback);

/** §5.1 medications — M12 `getPortalMedicationSummary`, fail-closed to an empty list. */
export async function resolveMedicationList(
  orgId: string,
  patientId: PatientId,
): Promise<PortalMedicationListView> {
  try {
    const provider = getSeam("MedicationOrderProvider");
    const { summary } = await provider.getPortalMedicationSummary(orgId, patientId);
    return projectMedicationList(summary);
  } catch {
    return { category: "medications", items: [] };
  }
}

/** §5.1 administrations — M13 `getPortalAdministrationSummary`, fail-closed to an empty list. */
export async function resolveAdministrationList(
  orgId: string,
  patientId: PatientId,
  asOfIso: string,
): Promise<PortalAdministrationListView> {
  try {
    const provider = getSeam("MedicationAdministrationProvider");
    const { summary } = await provider.getPortalAdministrationSummary(orgId, patientId, asOfIso);
    return projectAdministrationList(summary);
  } catch {
    return { category: "administrations", items: [] };
  }
}

/** §5.1 visits — M17 `PortalVisitReader.upcomingForPatient`, fail-closed to an empty list. */
export async function resolveVisitList(
  orgId: string,
  patientId: PatientId,
  withinHours: number,
): Promise<PortalVisitListView> {
  try {
    const reader = getSeam("PortalVisitReader");
    const summaries = await reader.upcomingForPatient(orgId, patientId, withinHours);
    return projectVisitList(summaries);
  } catch {
    return { category: "visits", items: [] };
  }
}

/** §5.1 triage — M19 `PortalTriageReader.summaryForPatient`, fail-closed to an empty list. */
export async function resolveTriageList(
  orgId: string,
  patientId: PatientId,
  withinHours: number,
): Promise<PortalTriageListView> {
  try {
    const reader = getSeam("PortalTriageReader");
    const summaries = await reader.summaryForPatient(orgId, patientId, withinHours);
    return projectTriageList(summaries);
  } catch {
    return { category: "triage", items: [] };
  }
}

/** §5.1 / §8.4 documents — M22 `PortalDocumentReader.documentsForPatient`, fail-closed to an empty list;
 *  the projector then drops any non-patient-facing kind (defence-in-depth over M22's own filter). */
export async function resolveDocumentList(
  orgId: string,
  patientId: PatientId,
): Promise<PortalDocumentListView> {
  try {
    const reader = getSeam("PortalDocumentReader");
    const digests = await reader.documentsForPatient({ patientId, organizationId: orgId });
    return projectDocumentList(digests);
  } catch {
    return { category: "documents", items: [] };
  }
}

/** §5.1 / §7.5 bereaved surface — M16 `BereavedPortalScopeProvider`, fail-closed to an empty scope. */
export async function resolveBereavementScope(
  orgId: string,
  portalAccountId: string,
): Promise<PortalBereavementScopeView> {
  try {
    const provider = getSeam("BereavedPortalScopeProvider");
    const scopes = await provider.scopeForPortalAccount(orgId, portalAccountId);
    return projectBereavementScope(scopes);
  } catch {
    return { category: "bereavement", items: [] };
  }
}

/**
 * §5.1 dashboard — the M5 patient header + the upstream counts composed from the visit / medication /
 * document surfaces. Fail-CLOSED per component: an unreadable `PatientReader` yields `null` (the route then
 * 404s rather than rendering a nameless dashboard); each count degrades to 0 independently. `withinHours` is
 * the visit look-ahead window (§5.1 default 168h / 7 days).
 */
export async function resolveDashboard(
  orgId: string,
  patientId: PatientId,
  asOfMs: number,
  withinHours = 168,
): Promise<PortalDashboardView | null> {
  let identity: PatientIdentity | null = null;
  try {
    identity = await getSeam("PatientReader").findById({ organizationId: orgId, id: patientId });
  } catch {
    identity = null;
  }
  if (identity === null) return null;

  const [visits, meds, docs] = await Promise.all([
    resolveVisitList(orgId, patientId, withinHours),
    resolveMedicationList(orgId, patientId),
    resolveDocumentList(orgId, patientId),
  ]);
  return projectDashboard(
    identity,
    {
      upcomingVisits: visits.items.length,
      activeMedications: meds.items.filter((m) => !m.redacted).length,
      unreadDocuments: docs.items.length,
    },
    asOfMs,
  );
}
