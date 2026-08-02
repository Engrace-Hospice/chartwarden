// apps/backend/src/modules/31-portal/read-surfaces/views.ts — M31-T04 (§4.4, §5.1, §8.4, D17).
//
// The lay-language view shapes each portal read surface returns — the D17-minimized projection of an
// upstream digest, PHI-reduced by construction: ids + already-lay strings only, never a raw clinical code,
// never a coordinator-internal field, never a cost/flag column. These are the M31 read-layer's internal
// output types (the composition cores in `project.ts` produce them); the TypeBox WIRE schemas + the route
// handlers that emit them through `validatePortalDto` land in M31-T07. Every surface carries an explicit
// `category: PortalDataCategory` so the route layer can drive the §164.528 disclosure-accounting emit off
// one field and the §4.4 scope-set gate off the same taxonomy.
import type { IsoInstant, PatientId, PortalDataCategory } from "@wardenx/types";

/** §5.1 — the patient dashboard header (composed from M5 `PatientReader`). Name is shown (the caregiver is
 *  entitled to it via an active grant) but MRN / SSN / external ids never cross to the portal. */
export interface PortalDashboardView {
  readonly category: Extract<PortalDataCategory, "care_plan">;
  readonly patientId: PatientId;
  readonly displayName: string;
  readonly ageYears: number | null;
  readonly counts: {
    readonly upcomingVisits: number;
    readonly activeMedications: number;
    readonly unreadDocuments: number;
  };
}

/** §5.1 care-plan tab — one lay problem line (M7 problem, ICD-10/SNOMED resolved to a display via M38). */
export interface PortalCarePlanProblemView {
  readonly problemId: string;
  readonly label: string; // lay display (M38 layLabel over the code, falling back to the description)
  readonly goals: readonly string[]; // goal text, lay
  readonly focus: readonly string[]; // intervention scope text, lay
}

export interface PortalCarePlanView {
  readonly category: Extract<PortalDataCategory, "care_plan">;
  readonly patientId: PatientId;
  readonly problems: readonly PortalCarePlanProblemView[];
  readonly redacted: boolean;
}

/** §5.1 medications tab — one lay medication line (M12 `getPortalMedicationSummary`). A SUD-redacted row
 *  keeps its slot (so the count is honest) but shows a placeholder, never the drug (§7.8 / D7). */
export interface PortalMedicationView {
  readonly medicationOrderId: string;
  readonly displayName: string;
  readonly instructions: string;
  readonly statusLabel: string; // lay status
  readonly redacted: boolean;
}

export interface PortalMedicationListView {
  readonly category: Extract<PortalDataCategory, "medications">;
  readonly items: readonly PortalMedicationView[];
}

/** §5.1 — one lay administration line (M13 `getPortalAdministrationSummary`). */
export interface PortalAdministrationView {
  readonly administrationRecordId: string;
  readonly displayName: string;
  readonly administeredAt: IsoInstant;
  readonly modeLabel: string; // lay administration mode
  readonly redacted: boolean;
}

export interface PortalAdministrationListView {
  readonly category: Extract<PortalDataCategory, "administrations">;
  readonly items: readonly PortalAdministrationView[];
}

/** §5.1 visits tab — one lay upcoming-visit line (M17 `PortalVisitReader`). Clinician display name is kept
 *  (the family is meeting them); scheduling-availability / routing metadata is dropped (§8.4). */
export interface PortalVisitView {
  readonly visitId: string;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
  readonly purposeLabel: string; // lay
  readonly clinicianDisplayName: string;
  readonly settingLabel: string; // lay visit setting
}

export interface PortalVisitListView {
  readonly category: Extract<PortalDataCategory, "visits">;
  readonly items: readonly PortalVisitView[];
}

/** §5.1 documents tab — one patient-facing document line (M22 `PortalDocumentReader`). Only the
 *  patient-facing kinds survive the {@link import("./minimize")} allowlist; download URLs are minted
 *  per-request in M31-T07, never embedded here. */
export interface PortalDocumentView {
  readonly documentId: string;
  readonly title: string;
  readonly kindLabel: string; // lay aggregate type
  readonly createdAt: IsoInstant;
  readonly hasActiveVersion: boolean;
}

export interface PortalDocumentListView {
  readonly category: Extract<PortalDataCategory, "documents">;
  readonly items: readonly PortalDocumentView[];
}

/** §5.1 — one lay after-hours triage line (M19 `PortalTriageReader`). The disposition is M19's
 *  already-lay summary; no clinical assessment detail crosses. */
export interface PortalTriageView {
  readonly triageCallId: string;
  readonly occurredAt: IsoInstant;
  readonly callerLabel: string; // lay caller kind / relationship
  readonly disposition: string; // M19 lay disposition summary
  readonly visitDispatched: boolean;
}

export interface PortalTriageListView {
  readonly category: Extract<PortalDataCategory, "triage">;
  readonly items: readonly PortalTriageView[];
}

/** §5.1 bereaved surface — the bereaved-family scope M16 resolves for a portal account (D4/D9). Drives the
 *  §7.5 bereaved-mode flip's read side: what a bereaved caregiver may see + whether they may opt out. */
export interface PortalBereavementScopeView {
  readonly category: Extract<PortalDataCategory, "bereavement">;
  readonly items: readonly {
    readonly contactId: string;
    readonly planId: string;
    readonly inWindow: boolean;
    readonly mayOptOut: boolean;
    readonly mayRescindOptOut: boolean;
    readonly statusLabel: string; // lay contact status
  }[];
}
