// apps/web/src/cop27-preview.tsx — fixture-backed preview modes for the FY2027 CoP screens, mounted by
// clinical-preview.tsx (visual QA only; no real patient data, nothing here ships in the app bundle).
//
//   ?addendum=none|draft|furnished|signed|refused|overdue|legacy|upload|uploaded — Election & Certification
//       with the election statement addendum section (click a version row to open its drawer). `upload` is a
//       draft furnished on paper outside WardenX (its drawer opens on "Upload signed paper copy"); `uploaded` is
//       a version signed on a scanned paper copy (drawer: "Signed — scanned paper copy" + Open scan / Open PDF);
//       `upload-incomplete` is an incomplete draft (the form says the scan stands as the content); `paper` is a
//       version whose content is on the signed paper copy.
//   ?admit=upload-nor|upload-election|upload-election-sign|upload-cti — the admission intake workspace with
//       that evidence upload drawer open (the shared scanned-upload kit).
//   ?coverage=med|supply|dashboard — hospice coverage section/badges on M12 medication detail, M21
//       supply-request detail and the M21 supply dashboard.
//   ?admit=intake|active|discharged — admission detail: 418.25(a) recommendation section (+ capture drawer
//       via "Record recommendation") and the 418.26(b) discharge order section.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  AdmissionDetail,
  type InitialEvidenceUpload,
} from "./modules/06-admission/admission-detail";
import { PatientElectionCert } from "./modules/06-admission/patient-election-cert";
import { MedicationDetail } from "./modules/12-dosespot/medication-detail";
import { SupplyTeamDashboard } from "./modules/21-supplies/supply-dashboard";
import { SupplyRequestDetailScreen } from "./modules/21-supplies/supply-request-detail";
import { SessionProvider } from "./shell/session";

const query = new URLSearchParams(location.search);
const addendumMode = query.get("addendum");
const coverageMode = query.get("coverage");
const admitMode = query.get("admit");
/** `?admit=intake` and the `upload-*` modes all show the pending intake workspace (uploads open from it). */
const intakeMode = admitMode === "intake" || (admitMode?.startsWith("upload-") ?? false);

export const isCop27Preview = addendumMode !== null || coverageMode !== null || admitMode !== null;

const DAY_MS = 864e5;
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const isoAt = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString();

const PATIENT = {
  id: "p1",
  mrn: "MRN-20417",
  firstName: "Henry",
  lastName: "Nakamura",
  dob: "1936-02-11",
  status: "active",
};

// ── Election statement addendum ─────────────────────────────────────────────────────────────────────

const ELECTION_START = isoDay(-4);

function addendumVersion(status: string, overrides: Record<string, unknown> = {}) {
  const furnished = status !== "draft";
  return {
    id: "add-v1",
    admissionId: "adm1",
    patientId: PATIENT.id,
    versionNumber: 1,
    trigger: "initial",
    triggerCause: null,
    triggeredAt: isoAt(-4),
    status,
    hospiceName: "Lantern Hospice of the Valley",
    patientName: "Henry Nakamura",
    medicalRecordNumber: PATIENT.mrn,
    terminalDiagnosis: [{ icd10Code: "C25.9", description: "Malignant neoplasm of pancreas" }],
    relatedDiagnoses: [{ icd10Code: "R63.4", description: "Abnormal weight loss" }],
    items: [
      {
        category: "drug",
        description: "Atorvastatin 40 mg tablet",
        reasonNotCovered:
          "Prescribed for high cholesterol, which is not related to the terminal illness.",
        source: "medication",
        sourceId: "m5",
      },
      {
        category: "item",
        description: "Continuous glucose monitor supplies",
        reasonNotCovered: "Diabetes is managed by the primary care physician, unrelated.",
        source: "supply",
        sourceId: "sr2",
      },
    ],
    noNonCoveredItems: false,
    clinicalExplanation:
      "These treat long-standing conditions that do not affect the pancreatic cancer prognosis.",
    guidelineReferences: null,
    dueAt: isoDay(1),
    furnishedAt: furnished ? isoAt(-2) : null,
    furnishMethod: furnished ? "paper" : null,
    signedAt: null,
    signerKind: null,
    representativeName: null,
    representativeRelationship: null,
    acknowledgementSource: status === "signed" || status === "refused" ? "structured" : null,
    acknowledgementDocumentId: null,
    acknowledgementDocumentVersionId: null,
    contentSource: "structured",
    refusedAt: null,
    refusalReason: null,
    signatureNotRequiredReason: null,
    signatureNotRequiredNote: null,
    documentId: furnished ? "doc-add-1" : null,
    supersededById: null,
    version: 3,
    ...overrides,
  };
}

function addendumOverview() {
  const base = {
    admissionId: "adm1",
    required: true,
    electionEffectiveDate: ELECTION_START,
    inCare: true,
    current: null as unknown,
    history: [] as unknown[],
    openWindows: [] as unknown[],
  };
  const initialWindow = (dueOffset: number) => ({
    id: "cw-add",
    kind: "election_addendum_initial",
    status: "open",
    dueAt: isoDay(dueOffset),
  });
  switch (addendumMode) {
    case "legacy":
      return { ...base, required: false, electionEffectiveDate: "2026-07-08" };
    case "none":
      return { ...base, openWindows: [initialWindow(1)] };
    case "overdue": {
      const v = addendumVersion("draft", { dueAt: isoDay(-2) });
      return { ...base, current: v, history: [v], openWindows: [initialWindow(-2)] };
    }
    case "furnished": {
      const v = addendumVersion("furnished");
      return { ...base, current: v, history: [v] };
    }
    case "signed": {
      const prior = addendumVersion("signed", {
        signedAt: isoAt(-2),
        signerKind: "beneficiary",
        supersededById: "add-v2",
      });
      const v = addendumVersion("signed", {
        id: "add-v2",
        versionNumber: 2,
        trigger: "poc_change",
        triggerCause: "medication_added",
        triggeredAt: isoAt(-1),
        furnishedAt: isoAt(-1),
        signedAt: isoAt(-1),
        signerKind: "representative",
        representativeName: "Jordan Rivera",
        representativeRelationship: "Daughter",
      });
      return { ...base, current: v, history: [v, prior] };
    }
    case "upload-incomplete": {
      const v = addendumVersion("draft", {
        items: [],
        clinicalExplanation: null,
        terminalDiagnosis: [],
      });
      return { ...base, current: v, history: [v], openWindows: [initialWindow(1)] };
    }
    case "paper": {
      const v = addendumVersion("signed", {
        items: [],
        clinicalExplanation: null,
        furnishedAt: isoAt(-3),
        signedAt: isoAt(-3),
        signerKind: "beneficiary",
        acknowledgementSource: "uploaded",
        acknowledgementDocumentId: "doc-scan-2",
        acknowledgementDocumentVersionId: "ver-scan-2",
        contentSource: "scanned_paper",
      });
      return { ...base, current: v, history: [v] };
    }
    case "uploaded": {
      const v = addendumVersion("signed", {
        furnishedAt: isoAt(-3),
        signedAt: isoAt(-3),
        signerKind: "representative",
        representativeName: "Jordan Rivera",
        representativeRelationship: "Daughter",
        acknowledgementSource: "uploaded",
        acknowledgementDocumentId: "doc-scan-1",
        acknowledgementDocumentVersionId: "ver-scan-1",
      });
      return { ...base, current: v, history: [v] };
    }
    case "refused": {
      const v = addendumVersion("refused", {
        refusedAt: isoAt(-1),
        refusalReason: "Patient declined to sign; copy left at bedside and explained to spouse.",
      });
      return { ...base, current: v, history: [v] };
    }
    default: {
      const v = addendumVersion("draft");
      return { ...base, current: v, history: [v], openWindows: [initialWindow(1)] };
    }
  }
}

function electionCertification() {
  const windows =
    addendumMode === "legacy"
      ? []
      : [
          {
            id: "cw-add",
            windowKind: "election_addendum_initial",
            severity: "regulatory",
            status: addendumMode === "overdue" ? "breached" : "open",
            mustCompleteBy: isoDay(addendumMode === "overdue" ? -2 : 1),
            closedAt: null,
          },
          {
            id: "cw-upd",
            windowKind: "election_addendum_update",
            severity: "regulatory",
            status: "open",
            mustCompleteBy: isoDay(3),
            closedAt: null,
          },
          {
            id: "cw-f2f",
            windowKind: "f2f_before_third_period",
            severity: "regulatory",
            status: "open",
            mustCompleteBy: isoDay(160),
            closedAt: null,
          },
        ];
  return {
    admission: {
      id: "adm1",
      state: "active",
      admissionAt: `${ELECTION_START}T10:00:00Z`,
      activatedAt: `${ELECTION_START}T12:00:00Z`,
      dischargedAt: null,
      version: 3,
    },
    periods: [
      {
        id: "ep1",
        sequenceNumber: 1,
        periodKind: "ninety_day",
        effectiveAt: ELECTION_START,
        scheduledEndAt: isoDay(86),
        actualEndAt: null,
        status: "active",
        electionStatement: {
          id: "es1",
          status: "signed",
          signerKind: "beneficiary",
          signedAt: `${ELECTION_START}T09:30:00Z`,
          sourceType: "structured",
        },
        cti: null,
        faceToFace: null,
      },
    ],
    complianceWindows: windows,
  };
}

// ── Hospice coverage (M12 / M21) ────────────────────────────────────────────────────────────────────

const notCovered = coverageMode !== "covered";
const COVERAGE = {
  hospiceCoverage: notCovered ? "not_covered_unrelated" : "covered_related",
  coverageReason: notCovered
    ? "Prescribed for high cholesterol, which is not related to the terminal illness."
    : null,
  coverageDeterminedAt: isoAt(-1),
  coverageDeterminedBy: "u-md-0b41",
};

const MED_ORDER = {
  id: "m5",
  patientId: "p1",
  admissionId: "adm1",
  medClass: "non_controlled",
  status: "active",
  drugName: "Atorvastatin",
  strength: "40 mg",
  doseForm: "tablet",
  route: "po",
  rxnormRxcui: "617312",
  ndc: null,
  prescriberDiscipline: "physician",
  prescribingPhysicianMdmId: "mdm-ph-1",
  dispensingPharmacyMdmId: null,
  isControlledSubstance: false,
  deaSchedule: null,
  cosignRequired: false,
  cosignStatus: null,
  refillsRemaining: 2,
  derivedFromRefillId: null,
  replacesMedicationOrderId: null,
  signedAt: isoAt(-3),
  signedBy: "u-md-0b41",
  transmittedAt: null,
  discontinuedAt: null,
  discontinuationReason: null,
  createdAt: isoAt(-3),
  ...COVERAGE,
};

const supplyRow = (id: string, kind: string, status: string, coverage: string) => ({
  supplyRequestId: id,
  id,
  kind,
  status,
  patientId: "p1-7c21a4",
  admissionId: "adm1-9e02",
  locationId: "loc-north-11",
  providerEntityId: "pe-0001",
  assignedVendorId: status === "requested" ? null : "vendor-4410",
  trackingNumber: status === "in_transit" ? "1Z999AA10123456784" : null,
  carrier: status === "in_transit" ? "UPS" : null,
  sourceOrderId: "ord-31f0",
  sourceReplenishmentEventId: null,
  deliveryInstructions: null,
  cancellationReason: null,
  createdAt: isoAt(-2),
  updatedAt: isoAt(-1),
  hospiceCoverage: coverage,
  coverageReason:
    coverage === "covered_related"
      ? null
      : "Diabetes is managed by the primary care physician, unrelated to the terminal illness.",
  coverageDeterminedAt: isoAt(-1),
  coverageDeterminedBy: "u-rn-11c9",
});

const SUPPLY_ROWS = [
  supplyRow("sr1", "dme", "vendor_assigned", "covered_related"),
  supplyRow("sr2", "supply", "requested", "not_covered_unrelated"),
  supplyRow("sr3", "dme", "in_transit", "not_covered_other"),
];

// ── Admission recommendation / discharge order ──────────────────────────────────────────────────────

const SIGNERS = {
  items: [
    { userId: "u-md-0b41", name: "Dr. Avery Lin", capacities: ["medical_director"] },
    {
      userId: "u-md-77a2",
      name: "Dr. Priya Raman",
      capacities: ["physician_designee", "idg_physician_member"],
    },
  ],
};

function admissionDetail() {
  const state = intakeMode ? "pending" : admitMode === "discharged" ? "discharged" : "active";
  const recorded = !intakeMode;
  return {
    id: "adm1",
    state,
    version: 4,
    patientId: "p1",
    referralId: null,
    admissionAt: `${ELECTION_START}T10:00:00Z`,
    activatedAt: state === "pending" ? null : `${ELECTION_START}T12:00:00Z`,
    providerEntityId: "pe-0001",
    locationId: "loc-north-11",
    hospicePhysicianId: "u-md-0b41",
    hospicePhysician: { id: "u-md-0b41", displayName: "Dr. Avery Lin", npi: "1234567893" },
    primaryDiagnosisIcd10: "C25.9",
    attendingPhysicianId: "mdm-att-9",
    admissionRecommendation: recorded
      ? {
          recommendedByUserId: "u-md-0b41",
          capacity: "medical_director",
          recommendedAt: `${ELECTION_START}T08:15:00Z`,
          attendingConsulted: true,
          attendingConsultNote:
            "Discussed by phone with the attending; agrees hospice is appropriate.",
        }
      : null,
    activationGate: { ready: false, missing: [] },
  };
}

function readiness() {
  const req = (code: string, label: string, status: string, action?: string) => ({
    code,
    label,
    status,
    blocking: false,
    ...(action ? { action } : {}),
  });
  return {
    admissionId: "adm1",
    status: "action_required",
    canActivate: false,
    completed: 2,
    blockingRemaining: 0,
    requirements: [
      req("notice_of_rights", "Notice of rights", "complete"),
      req("election_statement", "Election statement", "complete"),
      req(
        "admission_recommendation",
        "Physician admission recommendation",
        "action_required",
        "RECORD_ADMISSION_RECOMMENDATION",
      ),
      req(
        "election_addendum",
        "Election statement addendum",
        "pending",
        "COMPLETE_ELECTION_ADDENDUM",
      ),
    ],
  };
}

const DISCHARGE = {
  discharge: {
    dischargeEventId: "dc1",
    reason: "no_longer_terminal",
    status: "filed",
    dischargeDate: isoDay(-1),
    orderRequired: true,
    order: {
      signedByUserId: "u-md-77a2",
      signedByName: "Dr. Priya Raman",
      capacity: "physician_designee",
      signedAt: isoAt(-2),
      orderText:
        "Discharge from hospice: no longer terminally ill. Prognosis exceeds six months per IDG review.",
      orderReference: "Fax 2026-1006-114",
    },
    cosigner: null,
  },
};

// ── Routing ─────────────────────────────────────────────────────────────────────────────────────────

function cop27Get(path: string): unknown {
  switch (path) {
    case "/api/v1/patients/{patientId}/election-certification":
      return electionCertification();
    case "/api/v1/admissions/{id}/election-addendum":
      return addendumOverview();
    case "/api/v1/documents/{id}/versions":
      return {
        items: [{ id: "ver-render-1", versionNumber: 1 }],
        nextCursor: null,
        hasMore: false,
      };
    case "/api/v1/documents/{id}/versions/{versionId}/content":
      return { url: "about:blank" };
    case "/api/v1/patients/{id}":
      return PATIENT;
    case "/api/v1/medication-orders/{id}":
      return MED_ORDER;
    case "/api/v1/supplies/supply-requests/{supplyRequestId}":
      return SUPPLY_ROWS[1];
    case "/api/v1/supplies/supply-requests":
      return { data: SUPPLY_ROWS, has_more: false, next_cursor: null };
    case "/api/v1/supplies/comfort-kit-returns":
    case "/api/v1/supplies/par-stock":
    case "/api/v1/supplies/comfort-kit-dispatches":
      return { data: [], has_more: false, next_cursor: null };
    case "/api/v1/admissions/{id}":
      return admissionDetail();
    case "/api/v1/admissions/{id}/readiness":
      return intakeMode ? readiness() : null;
    case "/api/v1/admissions/{id}/physician-signers":
      return SIGNERS;
    case "/api/v1/admissions/{id}/discharge-order":
      return admitMode === "discharged" ? DISCHARGE : { discharge: null };
    case "/api/v1/admissions/{id}/election-periods":
    case "/api/v1/admissions/{id}/compliance-windows":
      return { items: [] };
    case "/api/v1/patients/{id}/addresses":
      return { addresses: [] };
    default:
      return undefined;
  }
}

const respond = (data: unknown) =>
  Promise.resolve({ data, error: undefined, response: new Response() });

const client = {
  GET: (path: string) => respond(cop27Get(path)),
  POST: () => respond({}),
  PATCH: () => respond({}),
  PUT: () => respond({}),
  DELETE: () => respond({}),
} as unknown as ApiClient;

const PERMISSIONS = [
  "election.read",
  "election_addendum.write",
  "election_addendum.acknowledge",
  "admission.read",
  "admission.update",
  "medication.read",
  "supplies.request.read",
];

function entryAndRoutes(): { entry: string; routes: JSX.Element } {
  if (addendumMode !== null)
    return {
      entry: "/patients/p1/election-certification",
      routes: (
        <Route
          path="/patients/:patientId/election-certification"
          element={<PatientElectionCert />}
        />
      ),
    };
  if (coverageMode === "supply")
    return {
      entry: "/supplies/requests/sr2",
      routes: (
        <Route path="/supplies/requests/:supplyRequestId" element={<SupplyRequestDetailScreen />} />
      ),
    };
  if (coverageMode === "dashboard")
    return {
      entry: "/supplies",
      routes: <Route path="/supplies" element={<SupplyTeamDashboard />} />,
    };
  if (coverageMode !== null)
    return {
      entry: "/medication-orders/m5",
      routes: <Route path="/medication-orders/:id" element={<MedicationDetail />} />,
    };
  return {
    entry: "/admissions/adm1",
    routes: (
      <Route
        path="/admissions/:id"
        element={
          <AdmissionDetail
            {...(admitMode?.startsWith("upload-")
              ? {
                  initialUpload:
                    `${admitMode.slice("upload-".length)}-upload` as InitialEvidenceUpload,
                }
              : {})}
          />
        }
      />
    ),
  };
}

export function renderCop27Preview(): void {
  const { entry, routes } = entryAndRoutes();
  createRoot(document.getElementById("root")!).render(
    <SessionProvider
      session={
        {
          userId: "u-np",
          organizationId: "o",
          displayName: "Nora Patel, NP",
          permissions: PERMISSIONS,
          roles: ["administrator"],
          isAdmin: true,
        } as never
      }
    >
      <MemoryRouter initialEntries={[entry]}>
        <ApiClientProvider client={client}>
          <ToastProvider>
            <Routes>{routes}</Routes>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}
