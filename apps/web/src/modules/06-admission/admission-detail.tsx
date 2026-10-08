import {
  type ApiClient,
  CeremonyModal,
  CodeSearchInput,
  DetailPageLayout,
  EmptyState,
  type GateItem,
  GateStepper,
  GuardChip,
  InlineAlert,
  LoadingSpinner,
  Modal,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Detail (M6 §5.2.4 + §5.2.5 activation gate, Track B).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Detail Page."
// Reads the admission aggregate from GET /api/v1/admissions/:id (which carries the R-AC-01 activation
// gate — the SAME server-truth gate route 14 enforces, so the §5.2.5 checklist can never diverge),
// plus the election-periods and compliance-windows sub-lists. Reconciled to Lantern (R1): the §5.2.5
// activation gate renders as a Guardrail GateStepper (blockers-first, alert glyphs) under a GuardChip
// summary; states are §6.6 status pills. Reads + the Acknowledge-NOR and Activate ceremonies (TASK-031).
//
// State-graph fix: `transitionAdmission`'s legal-transition graph (state-machines/admission.ts) only
// accepts `activate` FROM `notice_of_rights_acknowledged`, not from `pending` — a fresh admission
// (`acceptReferral`/`createAdmission`) always starts `pending`. Gating Activate on `state === "pending"`
// (an earlier draft of this file did) made the button permanently unreachable: the one route that
// advances `pending → notice_of_rights_acknowledged` (`POST /admissions/:id/nor`) had no UI anywhere in
// M6, so no admission could ever legally reach the state Activate requires. Both gaps are fixed here:
// Activate is gated on the real prerequisite state, and the Acknowledge-NOR ceremony (`state ===
// "pending"`) is what gets an admission there. Activate itself is only ever enabled when the SAME
// `activationGate.ready` the server enforces is true (route 14 now calls the identical
// `computeActivationGate` before transitioning — see admission-route-service-db.ts), so the button can
// never promise something the server would then refuse.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  type DocumentTypeValue,
  type UploadStage,
  verifiedUpload,
} from "../../shell/document-workflows";
import { MdmEntityLookupField, ProviderEntityLookupField } from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { EvidenceUploadDrawer, type EvidenceUploadKind } from "./admission-evidence-upload";
import { AdmissionHoldAction } from "./admission-hold-action";
import {
  AdmissionRecommendationDrawer,
  AdmissionRecommendationSection,
  type AdmissionRecommendationView,
} from "./admission-recommendation-ui";
import {
  ADMISSION_TONE,
  DISCHARGEABLE_STATES,
  DISCHARGE_WORKFLOW_PERMISSIONS,
  WINDOW_TONE,
  stateLabel,
} from "./admission-status";
import { MissingDischargeDetailsAlert } from "./discharge-details-alert";
import { DischargeOrderSection } from "./discharge-order-ui";
import { PatientIntakeDetails } from "./patient-intake-details";
import { TransferNoticeStatus } from "./transfer-notice-status";
import { authFailureRedirect } from "./write-workflow";

const NOR_METHODS = [
  { value: "electronic_witnessed", label: "Electronic (witnessed)" },
  { value: "wet_ink_scanned", label: "Wet ink (scanned)" },
  { value: "verbal_with_witness", label: "Verbal (with witness)" },
] as const;
type NorMethod = (typeof NOR_METHODS)[number]["value"];

interface SummaryRow {
  id: string;
  state: string;
  version: number;
}
interface AdmissionDetailView extends SummaryRow {
  patientId?: string;
  referralId?: string | null;
  admissionAt?: string | null;
  activatedAt?: string | null;
  providerEntityId?: string | null;
  locationId?: string | null;
  patientResidenceAddressId?: string | null;
  serviceAddressSnapshot?: AddressView | null;
  hospicePhysicianId?: string | null;
  hospicePhysician?: PhysicianSummary | null;
  primaryDiagnosisIcd10?: string | null;
  referringDxText?: string | null;
  admissionRecommendation?: AdmissionRecommendationView | null;
  attendingPhysicianId?: string | null;
  activationGate: { ready: boolean; missing: string[] };
  readiness?: AdmissionReadiness;
}
interface PhysicianSummary {
  id: string;
  displayName: string;
  npi?: string | null;
}
interface AddressView {
  id?: string;
  kind?: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
  isPrimary?: boolean;
  current?: boolean;
}
interface PatientSummary {
  id: string;
  mrn?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  dob?: string | null;
  status?: string | null;
}
interface ReadinessRequirement {
  code: string;
  label: string;
  status:
    | "complete"
    | "action_required"
    | "awaiting_signature"
    | "pending"
    | "blocked"
    | "overdue"
    | "not_applicable";
  blocking: boolean;
  message?: string;
  action?: string;
  satisfiedBy?: "normal" | "override";
  /** `patient_privacy` only: why it is blocked (category-free; picks the privacy dialog's next step). */
  reasonCode?: string;
  evidence?: {
    sourceType: "structured" | "uploaded";
    documentId?: string;
    documentVersionId?: string;
    completedAt?: string;
  };
}
interface AdmissionReadiness {
  admissionId: string;
  status: "blocked" | "action_required" | "ready";
  canActivate: boolean;
  completed: number;
  blockingRemaining: number;
  requirements: ReadinessRequirement[];
}
interface HopeSummary {
  admissionAssessment: {
    status: string;
    attention?: { state: string; severity: string };
  };
  huv1: { status: string; attention?: { state: string; severity: string } };
  huv2: { status: string; attention?: { state: string; severity: string } };
  dischargeAssessment: {
    status: string;
    attention?: { state: string; severity: string };
  };
  sfvs: Array<{
    status: string;
    attention?: { state: string; severity: string };
  }>;
  summary: {
    actionableCount: number;
    overdueCount?: number;
    dueSoonCount?: number;
    workflowIssueCount?: number;
    highestSeverity?: string;
    nextDeadline: string | null;
  };
}
interface ElectionStatementView extends SummaryRow {
  signedAt: string | null;
  signerKind: string;
}
interface CtiView extends SummaryRow {
  hospiceMdSigned: boolean;
  attendingMdSigned: boolean;
  signedLate: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}
interface ElectionPeriodView extends SummaryRow {
  sequenceNumber: number;
  periodKind: string;
  effectiveAt: string | null;
  scheduledEndAt: string | null;
  actualEndAt: string | null;
  electionStatement: ElectionStatementView | null;
  cti: CtiView | null;
}
interface ElectionCertificationView {
  admission: {
    id: string;
    state: string;
    admissionAt: string | null;
    activatedAt: string | null;
    dischargedAt: string | null;
    version: number;
  } | null;
  periods: ElectionPeriodView[];
}

// §5.2.5 — the four activation preconditions, in checklist order; the server's `missing[]` codes drive
// which rows pulse red. Kept verbatim from computeActivationGate so the UI renders server truth.
const GATE_ROWS: { code: string; label: string }[] = [
  { code: "election_signed", label: "Election statement signed (period 1)" },
  { code: "nor_acknowledged", label: "Notice of Rights acknowledged" },
  { code: "cti_signed", label: "CTI signed by hospice medical director" },
];

/** The evidence upload drawer to open on mount (visual-QA harness seam; production passes nothing). */
export type InitialEvidenceUpload =
  | "nor-upload"
  | "election-upload"
  | "election-sign-upload"
  | "cti-upload";

export function AdmissionDetail({
  initialUpload,
}: { initialUpload?: InitialEvidenceUpload } = {}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  // One-shot confirmation handed back by the discharge workflow after a successful submit.
  const flashNotice = (location.state as { notice?: string } | null)?.notice ?? null;
  const hasPermission = (key: string): boolean => session?.permissions?.includes(key) ?? false;
  const [admission, setAdmission] = useState<AdmissionDetailView | null>(null);
  const [readiness, setReadiness] = useState<AdmissionReadiness | null>(null);
  const [periods, setPeriods] = useState<SummaryRow[]>([]);
  const [windows, setWindows] = useState<SummaryRow[]>([]);
  const [hope, setHope] = useState<HopeSummary | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [patientAddresses, setPatientAddresses] = useState<AddressView[] | null>(null);
  const [electionCert, setElectionCert] = useState<ElectionCertificationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<
    | "activate"
    | "nor"
    | "nor-record"
    | "nor-upload"
    | "admission-details"
    | "election"
    | "election-create"
    | "election-upload"
    | "sign-election"
    | "election-sign-record"
    | "election-sign-upload"
    | "cti"
    | "cti-create"
    | "cti-upload"
    | "sign-cti-hospice-md"
    | "privacy"
    | null
  >(initialUpload ?? null);
  const [busy, setBusy] = useState(false);
  // 42 CFR 418.25(a) — the recommendation capture drawer replaces the readiness rail while open.
  const [recommending, setRecommending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedSignedState, setUploadedSignedState] = useState<"unsigned" | "signed">("unsigned");
  const [uploadedSignerName, setUploadedSignerName] = useState("");
  const [uploadedSignerRole, setUploadedSignerRole] = useState<
    "patient" | "legal_representative" | "caregiver"
  >("patient");
  const [uploadedSignatureDate, setUploadedSignatureDate] = useState("");
  // The NOR / Election / CTI "Upload document" ceremonies open in the right-hand drawer (scanned-upload.tsx).
  const uploadKind: EvidenceUploadKind | null =
    ceremony === "nor-upload"
      ? "nor"
      : ceremony === "election-upload"
        ? "election"
        : ceremony === "election-sign-upload"
          ? "election-signed"
          : ceremony === "cti-upload"
            ? "cti"
            : null;

  const [deliveryMethod, setDeliveryMethod] = useState<NorMethod>("electronic_witnessed");
  const [acknowledgedByName, setAcknowledgedByName] = useState("");
  const [acknowledgedByRole, setAcknowledgedByRole] = useState<"patient" | "legal_representative">(
    "patient",
  );
  const [admissionDate, setAdmissionDate] = useState("");
  const [providerEntityId, setProviderEntityId] = useState("");
  const [hospicePhysicianId, setHospicePhysicianId] = useState("");
  const [electionEffectiveDate, setElectionEffectiveDate] = useState("");
  const [primaryDiagnosisIcd10, setPrimaryDiagnosisIcd10] = useState("");
  const [electedProviderEntityId, setElectedProviderEntityId] = useState("");
  const [electedAttendingPhysicianId, setElectedAttendingPhysicianId] = useState("");
  const [waiverAcknowledged, setWaiverAcknowledged] = useState(false);
  const [stateAddendum, setStateAddendum] = useState("");
  const [electionSignerName, setElectionSignerName] = useState("");
  const [electionSignerRole, setElectionSignerRole] = useState<
    "patient" | "legal_representative" | "caregiver"
  >("patient");
  const [ctiDiagnosisIcd10, setCtiDiagnosisIcd10] = useState("");
  const [ctiSecondaryDiagnoses, setCtiSecondaryDiagnoses] = useState("");
  const [ctiPrognosis, setCtiPrognosis] = useState(
    "Life expectancy is six months or less if the illness runs its normal course.",
  );
  const [ctiNarrative, setCtiNarrative] = useState("");

  const [referralNumbers, setReferralNumbers] = useState<
    { medicare: string | null; medicaid: string | null } | undefined
  >(undefined);
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admissions/{id}", {
      params: { path: { id } },
    });
    if (err || !data) {
      setError("Admission not found or not visible to you.");
      setLoading(false);
      return;
    }
    const detail = data as AdmissionDetailView;
    setAdmission(detail);
    // Numbers captured on the originating referral pre-fill the Coverage / Payers form (best-effort).
    if (detail.referralId) {
      void client
        .GET("/api/v1/referrals/{id}", { params: { path: { id: detail.referralId } } })
        .then(({ data: ref }) => {
          const r = ref as
            | { medicareNumberAtReceipt?: string | null; medicaidNumberAtReceipt?: string | null }
            | undefined;
          setReferralNumbers(
            r
              ? {
                  medicare: r.medicareNumberAtReceipt ?? null,
                  medicaid: r.medicaidNumberAtReceipt ?? null,
                }
              : undefined,
          );
        });
    }
    setAdmissionDate(toDateInput(detail.admissionAt));
    setProviderEntityId(detail.providerEntityId ?? "");
    setHospicePhysicianId(detail.hospicePhysicianId ?? "");
    setPrimaryDiagnosisIcd10(detail.primaryDiagnosisIcd10 ?? "");
    setCtiDiagnosisIcd10(detail.primaryDiagnosisIcd10 ?? "");
    const [p, w, r, h, ec, patientResult, addressResult] = await Promise.all([
      client.GET("/api/v1/admissions/{id}/election-periods", {
        params: { path: { id } },
      }),
      client.GET("/api/v1/admissions/{id}/compliance-windows", {
        params: { path: { id } },
      }),
      client.GET("/api/v1/admissions/{id}/readiness", {
        params: { path: { id } },
      }),
      detail.state === "active"
        ? client.GET("/api/v1/admissions/{admissionId}/hope", {
            params: { path: { admissionId: id } },
          })
        : Promise.resolve({ data: null }),
      detail.patientId
        ? client.GET("/api/v1/patients/{patientId}/election-certification", {
            params: { path: { patientId: detail.patientId } },
          })
        : Promise.resolve({ data: null }),
      detail.patientId
        ? client.GET("/api/v1/patients/{id}", {
            params: { path: { id: detail.patientId } },
          })
        : Promise.resolve({ data: null }),
      detail.patientId
        ? client.GET("/api/v1/patients/{id}/addresses", {
            params: { path: { id: detail.patientId } },
          })
        : Promise.resolve({ data: null }),
    ]);
    setPeriods(p.data?.items ?? []);
    setWindows(w.data?.items ?? []);
    setReadiness(r.data ?? (data as AdmissionDetailView).readiness ?? null);
    setHope(h.data ? (h.data as HopeSummary) : null);
    setElectionCert(ec.data ? (ec.data as unknown as ElectionCertificationView) : null);
    setPatient(patientResult.data ? (patientResult.data as PatientSummary) : null);
    setPatientAddresses(
      (addressResult.data as { addresses?: AddressView[] } | null | undefined)?.addresses ?? null,
    );
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setActionError(null);
    setAcknowledgedByName("");
    setUploadedFile(null);
    setUploadedSignedState("unsigned");
    setUploadedSignerName("");
    setUploadedSignatureDate("");
    setUploadStage("idle");
  }, []);

  const branchError = useCallback(
    (status: number | undefined, code: string | undefined, fallback: string) => {
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      setBusy(false);
      if (status === 412) {
        setActionError("Admission requirements changed. Review the blockers and try again.");
        void load();
      } else if (status === 403) setActionError("You do not have permission for this action.");
      else if (status === 422 && code === "M6_LOCATION_REQUIRED")
        setActionError("Choose the service location this admission is served from.");
      else if (status === 422 && code === "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY")
        setActionError("That location does not belong to this admission's hospice.");
      else if (status === 422 && code === "CTI_NARRATIVE_REQUIRED")
        setActionError(
          "The CTI needs a physician narrative of at least 200 characters before it can be signed.",
        );
      else if (status === 422) setActionError("Validation failed — check the values you entered.");
      else if (status === 409 && code === "ELECTION_STATEMENT_CONFLICT") {
        setActionError("This benefit period already has an election statement.");
        void load();
      } else setActionError(fallback);
      return false;
    },
    [load, navigate],
  );

  const activate = useCallback(async () => {
    if (!id || !admission) return;
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/activate", {
      params: { path: { id } },
      body: { ifVersion: admission.version },
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Activation failed.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [id, admission, client, branchError, closeCeremony, load]);

  const acknowledgeNor = useCallback(async () => {
    if (!id) return;
    if (acknowledgedByName.trim().length === 0) {
      setActionError("Provide the acknowledging person's name.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/nor", {
      params: { path: { id } },
      body: {
        deliveryMethod,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedByName: acknowledgedByName.trim(),
        acknowledgedByRole,
      } as never,
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not record the acknowledgment.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    id,
    deliveryMethod,
    acknowledgedByName,
    acknowledgedByRole,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  const completeAdmissionDetails = useCallback(async () => {
    if (!id || !admission) return;
    const residence = currentResidenceAddress(patientAddresses);
    if (!admissionDate || !providerEntityId || !hospicePhysicianId || !residence) {
      setActionError(
        !residence
          ? "A patient residence address is required before completing admission details."
          : "Choose the admission/SOC date, hospice provider, and Hospice Physician before saving.",
      );
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.PATCH("/api/v1/admissions/{id}", {
      params: { path: { id } },
      body: {
        ifVersion: admission.version,
        admissionAt: dateInputToIso(admissionDate),
        providerEntityId,
        hospicePhysicianId,
      } as never,
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not save admission details.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    id,
    admission,
    admissionDate,
    providerEntityId,
    hospicePhysicianId,
    patientAddresses,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  const createElectionStatement = useCallback(async () => {
    if (!id || !currentPeriod(electionCert, periods)) return;
    const period = currentPeriod(electionCert, periods);
    if (!period) return;
    if (
      !electionEffectiveDate ||
      primaryDiagnosisIcd10.trim().length === 0 ||
      electedProviderEntityId.trim().length === 0
    ) {
      setActionError("Provide the effective date, diagnosis, provider, and waiver acknowledgment.");
      return;
    }
    if (!waiverAcknowledged) {
      setActionError("Confirm the election/waiver acknowledgment before creating the statement.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST(
      "/api/v1/admissions/{id}/election-statements",
      {
        params: { path: { id } },
        body: {
          electionPeriodId: period.id,
          effectiveDate: electionEffectiveDate,
          primaryDiagnosisIcd10: primaryDiagnosisIcd10.trim().toUpperCase(),
          electedProviderEntityId,
          electedAttendingPhysicianId: electedAttendingPhysicianId || undefined,
          waiverAcknowledged,
          stateAddendum: stateAddendum.trim() || undefined,
        } as never,
      },
    );
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not create the Election Statement.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    id,
    electionCert,
    periods,
    electionEffectiveDate,
    primaryDiagnosisIcd10,
    electedProviderEntityId,
    electedAttendingPhysicianId,
    waiverAcknowledged,
    stateAddendum,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  const attachUploadedEvidence = useCallback(
    async (
      documentType: DocumentTypeValue,
      title: string,
      attach: (ids: {
        documentId: string;
        documentVersionId: string;
      }) => Promise<{
        error?: unknown;
        response?: Response;
      }>,
    ) => {
      if (!admission?.patientId) return;
      if (!uploadedFile) {
        setActionError("Choose a document to upload.");
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        const uploaded = await verifiedUpload(client, {
          context: {
            kind: "patient",
            patientId: admission.patientId,
            admissionId: admission.id,
          } as never,
          mode: "new_document",
          file: uploadedFile,
          title,
          documentType,
          patientFacing: false,
          sourceMetadata: {
            documentType,
            sourceChannel: "scanned_physical",
            receivedAt: new Date().toISOString(),
            originalFilename: uploadedFile.name,
          },
          onStage: setUploadStage,
        });
        const attached = await attach({
          documentId: uploaded.documentId,
          documentVersionId: uploaded.documentVersionId,
        });
        if (attached.error) {
          branchError(
            attached.response?.status,
            (attached.error as { error?: { code?: string } })?.error?.code,
            "The document uploaded, but the admission evidence could not be attached.",
          );
          return;
        }
        setBusy(false);
        closeCeremony();
        void load();
      } catch (err) {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : "Upload failed.");
      }
    },
    [admission, uploadedFile, client, branchError, closeCeremony, load],
  );

  const uploadNor = useCallback(async () => {
    await attachUploadedEvidence(
      "notice_of_rights",
      "Notice of Rights",
      ({ documentId, documentVersionId }) =>
        postUntyped(client, `/api/v1/admissions/${id}/nor/uploaded-evidence`, {
          documentId,
          documentVersionId,
          acknowledgedAt: new Date().toISOString(),
          acknowledgedByName: acknowledgedByName.trim() || undefined,
          acknowledgedByRole,
        }),
    );
  }, [attachUploadedEvidence, client, id, acknowledgedByName, acknowledgedByRole]);

  const uploadElection = useCallback(async () => {
    const period = currentPeriod(electionCert, periods);
    if (!period) return;
    const state = ceremony === "election-sign-upload" ? "signed" : uploadedSignedState;
    if (state === "signed" && (!uploadedSignerName.trim() || !uploadedSignatureDate)) {
      setActionError(
        "Signer name, signer role, and signature date are required for a signed Election Statement.",
      );
      return;
    }
    await attachUploadedEvidence(
      "election_statement",
      "Election Statement",
      ({ documentId, documentVersionId }) =>
        postUntyped(
          client,
          ceremony === "election-sign-upload" && period.electionStatement?.id
            ? `/api/v1/election-statements/${period.electionStatement.id}/sign/uploaded-evidence`
            : `/api/v1/election-periods/${period.id}/election-statement/uploaded-evidence`,
          {
            documentId,
            documentVersionId,
            documentState: state,
            signerName: state === "signed" ? uploadedSignerName.trim() : undefined,
            signerRole: state === "signed" ? uploadedSignerRole : undefined,
            signedAt: state === "signed" ? dateInputToIso(uploadedSignatureDate) : undefined,
          },
        ),
    );
  }, [
    attachUploadedEvidence,
    client,
    ceremony,
    electionCert,
    periods,
    uploadedSignedState,
    uploadedSignerName,
    uploadedSignatureDate,
    uploadedSignerRole,
  ]);

  const uploadCti = useCallback(async () => {
    const period = currentPeriod(electionCert, periods);
    if (!period) return;
    if (!admission?.hospicePhysicianId) {
      setActionError("Select a Hospice Physician before creating the CTI.");
      return;
    }
    if (uploadedSignedState === "signed" && !uploadedSignatureDate) {
      setActionError("Signature date is required for a signed CTI.");
      return;
    }
    await attachUploadedEvidence(
      "cti",
      "Certification of Terminal Illness",
      ({ documentId, documentVersionId }) =>
        postUntyped(client, `/api/v1/election-periods/${period.id}/cti/uploaded-evidence`, {
          documentId,
          documentVersionId,
          documentState: uploadedSignedState,
          signedAt:
            uploadedSignedState === "signed" ? dateInputToIso(uploadedSignatureDate) : undefined,
        }),
    );
  }, [
    admission,
    attachUploadedEvidence,
    client,
    electionCert,
    periods,
    uploadedSignedState,
    uploadedSignatureDate,
  ]);

  const viewDocument = useCallback(
    async (evidence: ReadinessRequirement["evidence"]) => {
      if (!evidence?.documentId || !evidence.documentVersionId) return;
      const getContent = client.GET as unknown as (
        path: string,
        init: { params: { path: { id: string; versionId: string } } },
      ) => Promise<{
        data?: { url?: string };
        error?: unknown;
        response?: Response;
      }>;
      const res = await getContent("/api/v1/documents/{id}/versions/{versionId}/content", {
        params: {
          path: {
            id: evidence.documentId,
            versionId: evidence.documentVersionId,
          },
        },
      });
      if (res.error || !res.data?.url) {
        setActionError("The document version is no longer available.");
        return;
      }
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    },
    [client],
  );

  const signElectionStatement = useCallback(async () => {
    const election = currentPeriod(electionCert, periods)?.electionStatement;

    if (!election) return;

    if (electionSignerName.trim().length === 0) {
      setActionError("Provide the signer name.");
      return;
    }

    setBusy(true);
    setActionError(null);

    // election-certification currently does not expose the Election
    // Statement version. Fetch the statement itself to obtain the
    // current optimistic-lock version before signing.
    const {
      data: currentElection,
      error: readError,
      response: readResponse,
    } = await client.GET("/api/v1/election-statements/{id}", {
      params: {
        path: {
          id: election.id,
        },
      },
    });

    if (readError || !currentElection) {
      branchError(
        readResponse?.status,
        readError?.error?.code,
        "Could not load the current Election Statement.",
      );
      return;
    }

    const { error: err, response } = await client.POST("/api/v1/election-statements/{id}/sign", {
      params: {
        path: {
          id: election.id,
        },
      },
      body: {
        signingPatientName: electionSignerName.trim(),
        signingRole: electionSignerRole,
        ifVersion: currentElection.version,
      } as never,
    });

    if (err) {
      branchError(response?.status, err?.error?.code, "Could not sign the Election Statement.");
      return;
    }

    setBusy(false);
    closeCeremony();
    void load();
  }, [
    electionCert,
    periods,
    electionSignerName,
    electionSignerRole,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  const createCti = useCallback(async () => {
    const period = currentPeriod(electionCert, periods);
    if (!period) return;
    const selectedPhysicianId = admission?.hospicePhysicianId ?? hospicePhysicianId;
    if (!selectedPhysicianId) {
      setActionError("Select a Hospice Physician before creating the CTI.");
      return;
    }
    if (ctiDiagnosisIcd10.trim().length === 0 || ctiNarrative.trim().length === 0) {
      setActionError("Provide the diagnosis and CTI narrative.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/election-periods/{id}/cti", {
      params: { path: { id: period.id } },
      body: {
        hospiceMedicalDirectorId: selectedPhysicianId,
        terminalDiagnosisIcd10: ctiDiagnosisIcd10.trim().toUpperCase(),
        secondaryDiagnoses: normalizeSecondaryDiagnoses(ctiSecondaryDiagnoses),
        prognosisStatement: ctiPrognosis.trim(),
        narrative: ctiNarrative.trim(),
        clinicalFindings: {},
        isRecert: false,
      } as never,
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not create the CTI.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    electionCert,
    periods,
    admission,
    hospicePhysicianId,
    ctiDiagnosisIcd10,
    ctiSecondaryDiagnoses,
    ctiPrognosis,
    ctiNarrative,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  const signCti = useCallback(async () => {
    const cti = currentPeriod(electionCert, periods)?.cti;

    if (!cti) return;
    if (!admission?.hospicePhysicianId) {
      setActionError("Select a Hospice Physician before signing the CTI.");
      return;
    }

    setBusy(true);
    setActionError(null);

    const {
      data: currentCti,
      error: readError,
      response: readResponse,
    } = await client.GET("/api/v1/cti/{id}", {
      params: {
        path: {
          id: cti.id,
        },
      },
    });

    if (readError || !currentCti) {
      branchError(readResponse?.status, readError?.error?.code, "Could not load the current CTI.");
      return;
    }

    const { error: err, response } = await client.POST("/api/v1/cti/{id}/sign-hospice-md", {
      params: {
        path: {
          id: cti.id,
        },
      },
      body: {
        ifVersion: currentCti.version,
      } as never,
    });

    if (err) {
      branchError(response?.status, err?.error?.code, "Could not sign the CTI.");
      return;
    }

    setBusy(false);
    closeCeremony();
    void load();
  }, [electionCert, periods, admission, client, branchError, closeCeremony, load]);

  if (loading) return <LoadingSpinner />;
  if (error || !admission)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const pendingWorkspace =
    admission.state === "pending" || admission.state === "notice_of_rights_acknowledged";
  const canAcknowledgeNor =
    pendingWorkspace &&
    !readiness?.requirements.some((r) => r.code === "notice_of_rights" && r.status === "complete");
  const canActivate =
    pendingWorkspace && (readiness?.canActivate ?? admission.activationGate.ready);
  // Discharge / revocation / transfer-out entry (discharge-workflow.tsx): only from a state the
  // admission state machine discharges from, and only for an actor holding one of the workflow's keys
  // (display gating — the server derives and enforces the real per-reason key on submit).
  const canEndService =
    DISCHARGEABLE_STATES.has(admission.state) &&
    (!session?.permissions ||
      DISCHARGE_WORKFLOW_PERMISSIONS.some((k) => session.permissions?.includes(k)));
  const period = currentPeriod(electionCert, periods);
  const electionStatement = period?.electionStatement ?? null;
  const cti = period?.cti ?? null;
  const nextRequirement = readiness?.requirements.find(
    (r) => r.blocking && r.status !== "complete" && r.status !== "not_applicable",
  );
  // F-238 — non-blocking items still owing an action (today: an unreviewed intake detection).
  const advisories = (readiness?.requirements ?? []).filter(isAdvisory);
  const triggerAction = (action: string | undefined): void => {
    if (!action) return;
    if (action === "ACKNOWLEDGE_NOR" || action === "COMPLETE_NOTICE_OF_RIGHTS") setCeremony("nor");
    else if (action === "COMPLETE_ADMISSION_DETAILS") setCeremony("admission-details");
    else if (action === "COMPLETE_ELECTION" || action === "COMPLETE_ELECTION_STATEMENT")
      setCeremony(electionStatement ? "sign-election" : "election");
    else if (action === "COMPLETE_ELECTION_SIGNATURE") setCeremony("sign-election");
    else if (action === "REVIEW_CTI") {
      if (!cti) {
        setCeremony("cti");
        return;
      }

      if (!cti.hospiceMdSigned) {
        setCeremony("sign-cti-hospice-md");
        return;
      }
    } else if (action === "COMPLETE_CTI") setCeremony("cti");
    else if (action === "COMPLETE_CTI_SIGNATURE") setCeremony("sign-cti-hospice-md");
    else if (action === "REVIEW_PRIVACY") setCeremony("privacy");
    else if (action === "RECORD_ADMISSION_RECOMMENDATION") setRecommending(true);
    // FY2027 — the informational 42 CFR 418.24(c) addendum item: worked on the patient's Election tab.
    else if (action === "COMPLETE_ELECTION_ADDENDUM" && admission.patientId)
      navigate(`/patients/${admission.patientId}/election-certification`);
  };
  const actionContext = { electionStatement, cti };

  if (pendingWorkspace) {
    return (
      <DetailPageLayout
        header={
          <PageHeader
            title="Admission Intake"
            breadcrumb="Admissions / Intake"
            actions={
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.625rem",
                  flexWrap: "wrap",
                }}
              >
                <StatusPill
                  label={stateLabel(admission.state)}
                  tone={ADMISSION_TONE[admission.state] ?? "neutral"}
                />
                {hasPermission("transfer.in") ? (
                  <Link to={`/admissions/${admission.id}/transfer-in`} className="wx-btn-secondary">
                    Record transfer-in
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => setCeremony("activate")}
                  style={canActivate ? primaryBtn : disabledBtn}
                  disabled={!canActivate}
                >
                  Activate Admission
                </button>
              </div>
            }
          >
            <div
              style={{
                color: "var(--color-on-surface-variant)",
                fontSize: "0.875rem",
              }}
            >
              Patient{" "}
              <AdmissionPatientLink patientId={admission.patientId} patient={patient} compact />
              {admission.referralId ? (
                <>
                  {" "}
                  · Referral <span className="wx-data-md">{admission.referralId}</span>
                </>
              ) : null}
            </div>
          </PageHeader>
        }
        aside={
          uploadKind ? (
            <EvidenceUploadDrawer
              kind={uploadKind}
              state={{
                file: uploadedFile,
                signedState: uploadedSignedState,
                signerName: uploadedSignerName,
                signerRole: uploadedSignerRole,
                signatureDate: uploadedSignatureDate,
              }}
              on={{
                onFile: setUploadedFile,
                onSignedState: setUploadedSignedState,
                onSignerName: setUploadedSignerName,
                onSignerRole: setUploadedSignerRole,
                onSignatureDate: setUploadedSignatureDate,
              }}
              {...(uploadKind === "cti"
                ? {
                    signedByLabel: physicianLabel(
                      admission.hospicePhysician,
                      admission.hospicePhysicianId,
                    ),
                  }
                : {})}
              stage={uploadStage}
              busy={busy}
              error={actionError}
              onSubmit={() =>
                void (uploadKind === "nor"
                  ? uploadNor()
                  : uploadKind === "cti"
                    ? uploadCti()
                    : uploadElection())
              }
              onClose={closeCeremony}
            />
          ) : recommending ? (
            <AdmissionRecommendationDrawer
              admissionId={admission.id}
              version={admission.version}
              hasAttending={!!admission.attendingPhysicianId}
              onClose={() => setRecommending(false)}
              onSaved={() => {
                setRecommending(false);
                void load();
              }}
            />
          ) : (
            <RightDetailPanel title="Admission readiness">
              {readiness ? (
                <ReadinessChecklist readiness={readiness} />
              ) : (
                <ActivationChecklist gate={admission.activationGate} />
              )}
            </RightDetailPanel>
          )
        }
      >
        <div style={contentShellStyle}>
          <TransferNoticeStatus admissionId={admission.id} />
          <section style={summaryCardStyle}>
            <div style={summaryHeaderStyle}>
              <div>
                <h2 style={sectionTitleStyle}>Admission readiness</h2>
                <div style={summaryMetaStyle}>
                  {readiness
                    ? `${readiness.completed} of ${readiness.requirements.length} items complete`
                    : "Readiness is loading from the server."}
                </div>
              </div>
              <StatusPill
                label={readiness?.canActivate ? "Ready" : "Action required"}
                tone={readiness?.canActivate ? "success" : "warning"}
              />
            </div>
            {readiness && !readiness.canActivate ? (
              <div style={blockerBoxStyle}>
                <strong>Admission cannot be activated</strong>
                <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                  {readiness.requirements
                    .filter((r) => r.blocking && r.status !== "complete")
                    .map((r) => (
                      <li key={r.code}>{r.message ?? `${r.label} is incomplete.`}</li>
                    ))}
                </ul>
              </div>
            ) : readiness?.canActivate ? (
              <div style={readyBoxStyle}>
                <strong>Ready for Admission</strong>
                <span>All blocking admission requirements are complete.</span>
              </div>
            ) : null}
            {advisories.map((r) => (
              <div key={r.code} style={nextStepStyle} data-testid={`advisory-${r.code}`}>
                <div>
                  <strong>{r.label}: review advised</strong>
                  <p style={requirementMessageStyle}>{r.message}</p>
                </div>
                {r.action ? (
                  <RequirementActionButton
                    action={r.action}
                    context={actionContext}
                    onAction={triggerAction}
                    style={ghostBtn}
                  />
                ) : null}
              </div>
            ))}
            {nextRequirement ? (
              <div style={nextStepStyle}>
                <div>
                  <strong>Next step: {nextRequirement.label}</strong>
                  <p style={requirementMessageStyle}>
                    {nextRequirement.message ?? "Complete this item to move the admission forward."}
                  </p>
                </div>
                {nextRequirement.action ? (
                  <RequirementActionButton
                    action={nextRequirement.action}
                    context={actionContext}
                    onAction={triggerAction}
                    style={primaryBtn}
                  />
                ) : null}
              </div>
            ) : null}
          </section>

          <nav aria-label="Intake sections" style={tabsStyle}>
            {[
              "Overview",
              "Admission Details",
              "Notice of Rights",
              "Election",
              "CTI",
              "Face-to-Face",
              "Documents",
              "Activity",
            ].map((tab) => (
              <a key={tab} href={`#${tab.toLowerCase().replaceAll(" ", "-")}`} style={tabStyle}>
                {tab}
              </a>
            ))}
          </nav>

          <Section title="Overview">
            <RequirementCards
              requirements={readiness?.requirements ?? []}
              electionStatement={electionStatement}
              cti={cti}
              onAction={triggerAction}
            />
          </Section>
          <Section title="Admission Details">
            <div id="admission-details" style={sectionStackStyle}>
              <div style={fieldGridStyle}>
                <Field label="Admission ID" value={admission.id} mono />

                <Field
                  label="Patient"
                  value={<AdmissionPatientLink patientId={admission.patientId} patient={patient} />}
                />

                <Field label="Referral" value={admission.referralId ?? "Direct admission"} mono />

                <Field label="Planned/SOC" value={fmtDate(admission.admissionAt)} />
              </div>

              {admission.patientId ? (
                <PatientIntakeDetails
                  patientId={admission.patientId}
                  onSaved={load}
                  referralNumbers={referralNumbers}
                />
              ) : null}

              <RequirementLine
                requirement={readiness?.requirements.find((r) => r.code === "admission_details")}
              />

              {readiness?.requirements.find((r) => r.code === "admission_details")?.status !==
              "complete" ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setCeremony("admission-details")}
                    style={ghostBtn}
                  >
                    Complete admission details
                  </button>
                </div>
              ) : null}
            </div>
          </Section>
          <Section title="HOPE">
            <HopeEntry
              summary={hope}
              admissionId={admission.id}
              active={admission.state === "active"}
              onOpen={() => navigate(`/admissions/${admission.id}/hope`)}
            />
          </Section>
          <Section title="Notice of Rights">
            <div id="notice-of-rights" style={sectionInnerStyle}>
              <RequirementLine
                requirement={readiness?.requirements.find((r) => r.code === "notice_of_rights")}
              />
              {canAcknowledgeNor ? (
                <button type="button" onClick={() => setCeremony("nor")} style={ghostBtn}>
                  Complete Notice of Rights
                </button>
              ) : null}
            </div>
          </Section>
          <Section title="Election">
            <div id="election" style={sectionStackStyle}>
              <RequirementLine
                requirement={readiness?.requirements.find((r) => r.code === "election_statement")}
              />
              <div style={fieldGridStyle}>
                <Field
                  label="Period"
                  value={period ? `Period ${period.sequenceNumber}` : "Not created"}
                />
                <Field
                  label="Statement"
                  value={electionStatement ? stateLabel(electionStatement.state) : "Not created"}
                />
                <Field label="Signed" value={fmtDate(electionStatement?.signedAt)} />
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => setCeremony(electionStatement ? "sign-election" : "election")}
                  style={ghostBtn}
                  disabled={!period || electionStatement?.state === "signed"}
                >
                  {electionStatement?.state === "signed"
                    ? "Election signed"
                    : electionStatement
                      ? "Complete Election signature"
                      : "Complete Election Statement"}
                </button>
              </div>
            </div>
          </Section>
          <Section title="CTI">
            <div id="cti" style={sectionStackStyle}>
              <RequirementLine
                requirement={readiness?.requirements.find((r) => r.code === "cti")}
              />
              <div style={fieldGridStyle}>
                <Field label="CTI" value={cti ? stateLabel(cti.state) : "Not created"} />
                <Field
                  label="Hospice Physician"
                  value={physicianLabel(admission.hospicePhysician, admission.hospicePhysicianId)}
                />
              </div>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    setCeremony(
                      !cti
                        ? "cti"
                        : !cti.hospiceMdSigned
                          ? "sign-cti-hospice-md"
                          : "sign-cti-hospice-md",
                    )
                  }
                  style={ghostBtn}
                  disabled={!period || cti?.state === "signed" || !admission.hospicePhysicianId}
                >
                  {!cti
                    ? "Complete CTI"
                    : cti.state === "signed"
                      ? "CTI signed"
                      : !cti.hospiceMdSigned
                        ? "Complete CTI signature"
                        : "Review CTI"}
                </button>
              </div>
            </div>
          </Section>
          <Section title="Face-to-Face">
            <RequirementLine requirement={readiness?.requirements.find((r) => r.code === "f2f")} />
          </Section>
          <AdmissionRecommendationSection
            admissionId={admission.id}
            recommendation={admission.admissionRecommendation}
            editable
            onRecord={() => setRecommending(true)}
          />
          <Section title="Documents">
            <AdmissionDocuments
              requirements={readiness?.requirements ?? []}
              onView={viewDocument}
            />
          </Section>
          <Section title="Activity">
            <RowList
              rows={windows}
              empty="No intake activity timeline is available yet."
              toneFor={WINDOW_TONE}
            />
          </Section>
        </div>
        {renderCeremonies()}
      </DetailPageLayout>
    );
  }

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Admission"
          breadcrumb="Admissions / Detail"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
              <StatusPill
                label={stateLabel(admission.state)}
                tone={ADMISSION_TONE[admission.state] ?? "neutral"}
              />
              {canAcknowledgeNor ? (
                <button type="button" onClick={() => setCeremony("nor")} style={ghostBtn}>
                  Acknowledge NOR
                </button>
              ) : null}
              {canActivate ? (
                <button type="button" onClick={() => setCeremony("activate")} style={primaryBtn}>
                  Activate
                </button>
              ) : null}
              {hasPermission("admission.hold") ? (
                <AdmissionHoldAction
                  admissionId={admission.id}
                  state={admission.state}
                  version={admission.version}
                  onChanged={() => void load()}
                />
              ) : null}
              {canEndService ? (
                <Link to={`/admissions/${admission.id}/discharge`} className="wx-btn-secondary">
                  Discharge / transfer…
                </Link>
              ) : null}
              {(admission.state === "discharged" || admission.state === "closed") &&
              hasPermission("admission.create") ? (
                <Link to={`/admissions/${admission.id}/readmit`} className="wx-btn-secondary">
                  Readmit patient
                </Link>
              ) : null}
              {(admission.state === "active" || admission.state === "on_hold") &&
              hasPermission("loc.change") ? (
                <Link
                  to={`/admissions/${admission.id}/level-of-care/new`}
                  className="wx-btn-secondary"
                >
                  Change level of care
                </Link>
              ) : null}
              {(admission.state === "active" || admission.state === "on_hold") &&
              hasPermission("discharge.death") ? (
                <Link to={`/admissions/${admission.id}/death`} className="wx-btn-secondary">
                  Record death
                </Link>
              ) : null}
            </div>
          }
        >
          <div
            style={{
              color: "var(--color-on-surface-variant)",
              fontSize: "0.875rem",
            }}
          >
            Admission <span className="wx-data-md">{admission.id}</span> · version{" "}
            <span className="tabular-nums">{admission.version}</span>
            {admission.patientId ? (
              <>
                {" "}
                · Patient{" "}
                <AdmissionPatientLink patientId={admission.patientId} patient={patient} compact />
              </>
            ) : null}
          </div>
        </PageHeader>
      }
      aside={
        recommending ? (
          <AdmissionRecommendationDrawer
            admissionId={admission.id}
            version={admission.version}
            hasAttending={!!admission.attendingPhysicianId}
            onClose={() => setRecommending(false)}
            onSaved={() => {
              setRecommending(false);
              void load();
            }}
          />
        ) : (
          <RightDetailPanel title="Activation gate">
            <ActivationChecklist gate={admission.activationGate} />
          </RightDetailPanel>
        )
      }
    >
      <div style={contentShellStyle}>
        {flashNotice ? <InlineAlert tone="success">{flashNotice}</InlineAlert> : null}
        <MissingDischargeDetailsAlert admissionId={admission.id} admissionState={admission.state} />
        <TransferNoticeStatus admissionId={admission.id} />
        <section style={summaryCardStyle}>
          <div style={summaryHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Admission state</h2>
              <div style={summaryMetaStyle}>
                Server-truth lifecycle state and activation readiness.
              </div>
            </div>
            <StatusPill
              label={stateLabel(admission.state)}
              tone={ADMISSION_TONE[admission.state] ?? "neutral"}
            />
          </div>
          <div style={fieldGridStyle}>
            <Field label="Admission ID" value={admission.id} mono />
            <Field
              label="Patient"
              value={<AdmissionPatientLink patientId={admission.patientId} patient={patient} />}
            />
            <Field label="Version" value={String(admission.version)} mono />
            <Field
              label="Activation"
              value={admission.activationGate.ready ? "Ready" : "Blocked"}
            />
          </div>
        </section>

        <Section title="Election periods">
          <RowList rows={periods} empty="No election periods yet." />
        </Section>
        <Section title="HOPE">
          <HopeEntry
            summary={hope}
            admissionId={admission.id}
            active={admission.state === "active"}
            onOpen={() => navigate(`/admissions/${admission.id}/hope`)}
          />
        </Section>
        <Section title="Compliance windows">
          <RowList rows={windows} empty="No open compliance windows." toneFor={WINDOW_TONE} />
        </Section>
        <AdmissionRecommendationSection
          admissionId={admission.id}
          recommendation={admission.admissionRecommendation}
          editable={admission.state === "active" || admission.state === "on_hold"}
          onRecord={() => setRecommending(true)}
        />
        <DischargeOrderSection admissionId={admission.id} />
      </div>

      {renderCeremonies()}
    </DetailPageLayout>
  );

  function renderCeremonies(): JSX.Element {
    const privacy = readiness?.requirements.find((r) => r.code === "patient_privacy");
    return (
      <>
        <PrivacyReviewDialog
          open={ceremony === "privacy"}
          onClose={closeCeremony}
          onRecheck={() => {
            closeCeremony();
            void load();
          }}
          reasonCode={privacy?.reasonCode}
          message={privacy?.message}
          patientId={admission?.patientId ?? null}
        />
        <Modal
          open={ceremony === "admission-details"}
          onClose={busy ? undefined : closeCeremony}
          ariaLabel="Complete admission details"
          width="36rem"
        >
          <div style={admissionDetailsModalStyle}>
            <div style={admissionDetailsModalHeaderStyle}>
              <h2 style={admissionDetailsModalTitleStyle}>Complete admission details</h2>

              <p style={admissionDetailsModalDescriptionStyle}>
                Set the planned admission/SOC date, hospice provider and Hospice Physician. The CTI
                step records the terminal diagnosis and certification details.
              </p>
            </div>

            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Set the planned admission/SOC date first. The CTI step records the terminal
                diagnosis and certifying physician.
              </span>
              <label htmlFor="admission-date" style={fieldLabel}>
                Admission/SOC date
              </label>
              <input
                id="admission-date"
                type="date"
                value={admissionDate}
                onChange={(ev) => setAdmissionDate(ev.target.value)}
                style={inputStyle}
              />
              <ProviderEntityLookupField
                label="Hospice provider"
                value={providerEntityId}
                onChange={setProviderEntityId}
                required
              />

              <ServiceLocationBlock
                patientId={admission!.patientId}
                address={currentResidenceAddress(patientAddresses)}
              />

              <MdmEntityLookupField
                kind="physician"
                label="Hospice Physician"
                value={hospicePhysicianId}
                onChange={setHospicePhysicianId}
                valueLabel={admission!.hospicePhysician?.displayName}
                required
              />

              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>

            <div style={admissionDetailsModalSignerStyle}>
              <span style={fieldLabelStyle}>Recorded by</span>
              <strong>Admission coordinator</strong>
              <span style={hintTextStyle}>This session</span>
            </div>

            <div style={admissionDetailsModalActionsStyle}>
              <button type="button" style={ghostBtn} onClick={closeCeremony} disabled={busy}>
                Cancel
              </button>

              <button
                type="button"
                style={busy ? disabledBtn : primaryBtn}
                disabled={busy}
                onClick={() => void completeAdmissionDetails()}
              >
                {busy ? "Saving..." : "Save admission details"}
              </button>
            </div>
          </div>
        </Modal>

        <CeremonyModal
          open={ceremony === "nor"}
          title="Complete Notice of Rights"
          attestation={
            <RequirementMethodPicker
              options={[
                {
                  title: "Record in WardenX",
                  description: "Enter acknowledgment information manually.",
                  onChoose: () => setCeremony("nor-record"),
                },
                {
                  title: "Upload document",
                  description: "Upload an existing scanned or completed Notice of Rights.",
                  onChoose: () => setCeremony("nor-upload"),
                },
              ]}
            />
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel="Close"
          onCommit={closeCeremony}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "election"}
          title="Complete Election Statement"
          attestation={
            <RequirementMethodPicker
              options={[
                {
                  title: "Create in WardenX",
                  description: "Prepare the Election Statement here, then collect signature.",
                  onChoose: () => setCeremony("election-create"),
                },
                {
                  title: "Upload document",
                  description: "Upload an existing Election Statement.",
                  onChoose: () => setCeremony("election-upload"),
                },
              ]}
            />
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel="Close"
          onCommit={closeCeremony}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "sign-election"}
          title="Complete Election signature"
          attestation={
            <RequirementMethodPicker
              options={[
                {
                  title: "Sign in WardenX",
                  description: "Capture the signer attestation electronically.",
                  onChoose: () => setCeremony("election-sign-record"),
                },
                {
                  title: "Upload signed document",
                  description: "Attach the signed paper Election Statement.",
                  onChoose: () => {
                    setUploadedSignedState("signed");
                    setCeremony("election-sign-upload");
                  },
                },
              ]}
            />
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel="Close"
          onCommit={closeCeremony}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "cti"}
          title="Complete CTI"
          attestation={
            <div style={formStackStyle}>
              <Field
                label="Hospice Physician"
                value={physicianLabel(admission!.hospicePhysician, admission!.hospicePhysicianId)}
              />
              {!admission!.hospicePhysicianId ? (
                <div role="alert" style={blockerBoxStyle}>
                  Select a Hospice Physician in Admission Details before completing the CTI.
                </div>
              ) : (
                <RequirementMethodPicker
                  options={[
                    {
                      title: "Create in WardenX",
                      description: "Enter CTI clinical information here.",
                      onChoose: () => setCeremony("cti-create"),
                    },
                    {
                      title: "Upload document",
                      description: "Upload an existing CTI.",
                      onChoose: () => setCeremony("cti-upload"),
                    },
                  ]}
                />
              )}
            </div>
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel="Close"
          onCommit={closeCeremony}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "election-create"}
          title="Create Election Statement"
          attestation={
            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Create the election document for the first benefit period. After it is created, the
                patient or representative can sign it from this same page.
              </span>
              <label htmlFor="election-effective-date" style={fieldLabel}>
                Effective date
              </label>
              <input
                id="election-effective-date"
                type="date"
                value={electionEffectiveDate}
                onChange={(ev) => setElectionEffectiveDate(ev.target.value)}
                style={inputStyle}
              />
              <CodeSearchInput
                label="Primary diagnosis ICD-10"
                system="icd10cm"
                value={primaryDiagnosisIcd10}
                onChange={(code) => setPrimaryDiagnosisIcd10(code)}
                placeholder="Search ICD-10-CM, e.g. C34.90"
              />
              <ProviderEntityLookupField
                label="Elected hospice provider"
                value={electedProviderEntityId}
                onChange={(value) => setElectedProviderEntityId(value)}
                required
              />
              <MdmEntityLookupField
                kind="physician"
                label="Elected attending physician"
                value={electedAttendingPhysicianId}
                onChange={(value) => setElectedAttendingPhysicianId(value)}
                clearable
              />
              <label style={checkboxLabelStyle}>
                <input
                  type="checkbox"
                  checked={waiverAcknowledged}
                  onChange={(ev) => setWaiverAcknowledged(ev.target.checked)}
                />
                Patient/representative acknowledged hospice election and applicable waiver.
              </label>
              <label htmlFor="state-addendum" style={fieldLabel}>
                State addendum
              </label>
              <textarea
                id="state-addendum"
                value={stateAddendum}
                onChange={(ev) => setStateAddendum(ev.target.value)}
                style={textareaStyle}
                rows={3}
              />
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel={busy ? "Creating..." : "Create statement"}
          onCommit={() => void createElectionStatement()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "election-sign-record"}
          title="Sign Election Statement"
          attestation={
            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Capture the patient or representative signature. This is required before the
                admission can activate.
              </span>
              <label htmlFor="election-signer-name" style={fieldLabel}>
                Signer name
              </label>
              <input
                id="election-signer-name"
                value={electionSignerName}
                onChange={(ev) => setElectionSignerName(ev.target.value)}
                style={inputStyle}
              />
              <label htmlFor="election-signer-role" style={fieldLabel}>
                Signer role
              </label>
              <select
                id="election-signer-role"
                value={electionSignerRole}
                onChange={(ev) =>
                  setElectionSignerRole(
                    ev.target.value as "patient" | "legal_representative" | "caregiver",
                  )
                }
              >
                <option value="patient">Patient</option>
                <option value="legal_representative">Legal representative</option>
                <option value="caregiver">Caregiver</option>
              </select>
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          legalText="I attest the Election Statement was reviewed and signed by the named signer."
          signer={{ name: "Recording clinician", role: "This session" }}
          commitLabel={busy ? "Signing..." : "Sign statement"}
          onCommit={() => void signElectionStatement()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "cti-create"}
          title="Create Certification of Terminal Illness"
          attestation={
            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Create the CTI with the selected Hospice Physician, terminal diagnosis, prognosis,
                and clinical narrative. Signature is a separate governed action.
              </span>
              {admission!.primaryDiagnosisIcd10 || admission!.referringDxText ? (
                <span style={hintTextStyle}>
                  Diagnosis was prefilled from the referral/admission when available; edit it here
                  if the CTI needs a different value.
                </span>
              ) : null}
              <Field
                label="Certifying Hospice Physician"
                value={physicianLabel(admission!.hospicePhysician, admission!.hospicePhysicianId)}
              />
              <CodeSearchInput
                label="Terminal diagnosis ICD-10"
                system="icd10cm"
                value={ctiDiagnosisIcd10}
                onChange={(code) => setCtiDiagnosisIcd10(code)}
                placeholder="Search ICD-10-CM, e.g. C34.90"
              />
              <label htmlFor="cti-secondary-diagnoses" style={fieldLabel}>
                Secondary diagnoses
              </label>
              <textarea
                id="cti-secondary-diagnoses"
                value={ctiSecondaryDiagnoses}
                onChange={(ev) => setCtiSecondaryDiagnoses(ev.target.value)}
                style={textareaStyle}
                rows={4}
                placeholder="One diagnosis per line, e.g. I50.9 Congestive heart failure"
              />
              <label htmlFor="cti-prognosis" style={fieldLabel}>
                Prognosis statement
              </label>
              <input
                id="cti-prognosis"
                value={ctiPrognosis}
                onChange={(ev) => setCtiPrognosis(ev.target.value)}
                style={inputStyle}
              />
              <label htmlFor="cti-narrative" style={fieldLabel}>
                Clinical narrative
              </label>
              <textarea
                id="cti-narrative"
                value={ctiNarrative}
                onChange={(ev) => setCtiNarrative(ev.target.value)}
                style={textareaStyle}
                rows={5}
              />
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          signer={{ name: "Admission coordinator", role: "This session" }}
          commitLabel={busy ? "Creating..." : "Create CTI"}
          onCommit={() => void createCti()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "sign-cti-hospice-md"}
          title="Hospice Physician CTI signature"
          attestation={
            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Capture the CTI signature for the Hospice Physician selected in Admission Details.
              </span>
              <Field
                label="Physician name"
                value={
                  admission!.hospicePhysician?.displayName ??
                  physicianLabel(admission!.hospicePhysician, admission!.hospicePhysicianId)
                }
              />
              <Field label="NPI" value={admission!.hospicePhysician?.npi ?? "NPI not on file"} />
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          legalText="I attest this physician signature applies to the Certification of Terminal Illness."
          signer={{ name: "Recording user", role: "This session" }}
          commitLabel={busy ? "Signing..." : "Sign CTI"}
          onCommit={() => void signCti()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "nor-record"}
          title="Acknowledge Notice of Rights"
          attestation={
            <div style={formStackStyle}>
              <span style={hintTextStyle}>
                Records that the patient (or their legal representative) received and acknowledged
                the Notice of Rights. Required before the admission can activate.
              </span>
              <label htmlFor="nor-method" style={fieldLabel}>
                Delivery method
              </label>
              <select
                id="nor-method"
                value={deliveryMethod}
                onChange={(ev) => setDeliveryMethod(ev.target.value as NorMethod)}
              >
                {NOR_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <label htmlFor="nor-name" style={fieldLabel}>
                Acknowledged by (name)
              </label>
              <input
                id="nor-name"
                value={acknowledgedByName}
                onChange={(ev) => setAcknowledgedByName(ev.target.value)}
                style={inputStyle}
              />
              <label htmlFor="nor-role" style={fieldLabel}>
                Acknowledged by (role)
              </label>
              <select
                id="nor-role"
                value={acknowledgedByRole}
                onChange={(ev) =>
                  setAcknowledgedByRole(ev.target.value as "patient" | "legal_representative")
                }
              >
                <option value="patient">Patient</option>
                <option value="legal_representative">Legal representative</option>
              </select>
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          signer={{ name: "Recording clinician", role: "This session" }}
          commitLabel={busy ? "Recording..." : "Record acknowledgment"}
          onCommit={() => void acknowledgeNor()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "activate"}
          title="Activate admission"
          attestation={
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--color-on-surface-variant)",
                }}
              >
                All four R-AC-01 preconditions are satisfied. Activating opens active-period billing
                and compliance tracking for this admission.
              </span>
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          legalText="I attest the admission is ready for activation."
          signer={{ name: "Activating clinician", role: "This session" }}
          commitLabel={busy ? "Activating..." : "Activate"}
          onCommit={() => void activate()}
          onCancel={closeCeremony}
        />
      </>
    );
  }
}

function HopeEntry({
  summary,
  admissionId,
  active,
  onOpen,
}: {
  summary: HopeSummary | null;
  admissionId: string;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  if (!active) {
    return (
      <div style={hopeEntryStyle}>
        <div>
          <h3 style={miniTitleStyle}>HOPE workflow</h3>
          <p style={emptyTextStyle}>
            Activate this admission before accessing or creating HOPE assessments.
          </p>
        </div>
        {/* <button type="button" disabled style={ghostBtn}>Open HOPE</button> */}
      </div>
    );
  }
  if (!summary) {
    return (
      <div style={hopeEntryStyle}>
        <div>
          <h3 style={miniTitleStyle}>HOPE workflow</h3>
          <p style={emptyTextStyle}>
            HOPE summary is unavailable or not visible for admission {admissionId}.
          </p>
        </div>
        <button type="button" onClick={onOpen} style={ghostBtn}>
          Open HOPE
        </button>
      </div>
    );
  }
  const openSfvs = summary.sfvs.filter((s) => s.status === "open" || s.status === "overdue").length;
  const workflowIssueCount = summary.summary.workflowIssueCount ?? 0;
  const overdueCount = summary.summary.overdueCount ?? 0;
  const dueSoonCount = summary.summary.dueSoonCount ?? 0;
  return (
    <div style={hopeEntryStyle}>
      <div style={hopeMiniGrid}>
        <HopeMini
          label="HOPE Admission Assessment"
          status={summary.admissionAssessment.status}
          attention={summary.admissionAssessment.attention?.state}
        />
        <HopeMini
          label="HUV1"
          status={summary.huv1.status}
          attention={summary.huv1.attention?.state}
        />
        <HopeMini
          label="HUV2"
          status={summary.huv2.status}
          attention={summary.huv2.attention?.state}
        />
        <HopeMini
          label="SFV"
          status={openSfvs > 0 ? `${openSfvs} open` : "none open"}
          attention={
            summary.sfvs.find((s) => s.attention?.state && s.attention.state !== "none")?.attention
              ?.state
          }
        />
        <HopeMini
          label="Discharge Assessment"
          status={summary.dischargeAssessment.status}
          attention={summary.dischargeAssessment.attention?.state}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          alignItems: "flex-start",
        }}
      >
        <StatusPill
          label={compactHopeLabel(
            summary.summary.actionableCount,
            workflowIssueCount,
            overdueCount,
            dueSoonCount,
          )}
          tone={
            (summary.summary.highestSeverity ?? "none") === "critical" || workflowIssueCount > 0
              ? "error"
              : summary.summary.actionableCount > 0 || dueSoonCount > 0
                ? "warning"
                : "success"
          }
        />
        {overdueCount > 0 ? (
          <span style={summaryMetaStyle}>{overdueCount} overdue or missed</span>
        ) : null}
        <span style={summaryMetaStyle}>Next deadline {fmtDate(summary.summary.nextDeadline)}</span>
        <button type="button" onClick={onOpen} style={primaryBtn}>
          Open HOPE
        </button>
      </div>
    </div>
  );
}

function HopeMini({
  label,
  status,
  attention,
}: {
  label: string;
  status: string;
  attention?: string;
}): JSX.Element {
  const display = attention && attention !== "none" ? attention : status;
  const tone: StatusTone =
    display.includes("open") || display === "late" || display === "due" || display === "due_soon"
      ? "warning"
      : display === "completed"
        ? "success"
        : display === "expired" ||
            display === "workflow_not_initialized" ||
            display === "workflow_issue" ||
            display === "window_expired" ||
            display === "overdue" ||
            display === "missed"
          ? "error"
          : "neutral";
  return (
    <div style={hopeMiniStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <StatusPill label={displayHopeStatus(display)} tone={tone} />
    </div>
  );
}

function displayHopeStatus(status: string): string {
  if (status === "open") return "Action required";
  if (status === "late") return "Late completion";
  if (status === "due_soon") return "Due soon";
  if (status === "window_expired") return "Capture window expired";
  if (status === "workflow_issue") return "Workflow issue";
  if (status === "workflow_not_initialized") return "Workflow not initialized";
  if (status === "not_applicable") return "Not applicable";
  if (status === "none open") return "None open";
  return stateLabel(status);
}

function compactHopeLabel(
  actionable: number,
  workflowIssues: number,
  overdue: number,
  dueSoon: number,
): string {
  if (workflowIssues > 0)
    return `${workflowIssues} workflow issue${workflowIssues === 1 ? "" : "s"}`;
  if (overdue > 0) return `${overdue} overdue or missed`;
  if (dueSoon > 0) return `${dueSoon} due soon`;
  if (actionable > 0) return `${actionable} action required`;
  return "HOPE up to date";
}

function currentPeriod(
  electionCert: ElectionCertificationView | null,
  fallbackPeriods: SummaryRow[],
): ElectionPeriodView | (SummaryRow & Partial<ElectionPeriodView>) | null {
  const electionPeriods = Array.isArray(electionCert?.periods) ? electionCert.periods : [];
  return (
    electionPeriods.find((p) => p.sequenceNumber === 1) ??
    electionPeriods[0] ??
    fallbackPeriods[0] ??
    null
  );
}

function currentResidenceAddress(addresses: AddressView[] | null): AddressView | null {
  if (!addresses?.length) return null;
  return (
    addresses.find((a) => a.current && a.isPrimary && a.kind === "home") ??
    addresses.find((a) => a.current && a.kind === "home") ??
    addresses.find((a) => a.current && a.isPrimary) ??
    null
  );
}

function addressLines(address: AddressView | null | undefined): string[] {
  if (!address) return [];
  return [
    address.line1,
    address.line2,
    [address.city, [address.state, address.postalCode].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", "),
    address.country && address.country !== "US" ? address.country : null,
  ].filter(Boolean) as string[];
}

function ServiceLocationBlock({
  patientId,
  address,
}: {
  patientId?: string;
  address: AddressView | null;
}): JSX.Element {
  return (
    <div style={formStackStyle}>
      <span style={fieldLabel}>Service location / residence</span>
      {address ? (
        <div style={addressBoxStyle}>
          <strong>Patient residence</strong>
          {addressLines(address).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : (
        <div style={addressBoxStyle}>
          <strong>No patient residence address on file.</strong>

          <div style={hintTextStyle}>
            Residence address is optional at this stage. You can continue admission and add it
            later.
          </div>

          {patientId ? <IntakePendingAddressHint patientId={patientId} /> : null}

          {patientId ? (
            <Link to={`/patients/${patientId}?view=addresses`} style={patientLinkStyle}>
              Open patient addresses
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

type PendingAddressBatch = {
  batchId: string;
  uploadedAt: string;
  pendingCount: number;
  approvedCount: number;
};

/**
 * F-238 — "an address is waiting in intake review". DocLens often extracted a residence address from the
 * referral packet before the patient has one in M5; it only reaches the chart once a reviewer approves it
 * AND completes the review. The M22 read answers counts + batch ids only (never the value); a caller who
 * cannot see intake (403) or any failure renders nothing.
 */
function IntakePendingAddressHint({ patientId }: { patientId: string }): JSX.Element | null {
  const client = useApiClient();
  const [batches, setBatches] = useState<PendingAddressBatch[]>([]);
  useEffect(() => {
    let live = true;
    setBatches([]);
    client
      .GET("/api/v1/patients/{patientId}/intake-pending-address", {
        params: { path: { patientId } },
      })
      .then(({ data, error }) => {
        if (live && !error && Array.isArray(data?.items)) setBatches(data.items);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, patientId]);
  if (batches.length === 0) return null;
  const anyUnreviewed = batches.some((b) => b.pendingCount > 0);
  return (
    <div data-testid="intake-pending-address" style={hintTextStyle}>
      {anyUnreviewed
        ? "An address was found in intake records that haven't been reviewed yet. Review it — once approved it's added to the patient."
        : "An address from intake records was approved — complete the review to add it to the patient."}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", marginTop: "0.3rem" }}>
        {batches.map((b) => (
          <Link key={b.batchId} to={`/intake/${b.batchId}/review`} style={patientLinkStyle}>
            {b.pendingCount > 0 ? "Review intake records" : "Complete the intake review"}
            {` (received ${formatIntakeDate(b.uploadedAt)})`}
          </Link>
        ))}
      </div>
    </div>
  );
}

function formatIntakeDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function postUntyped(
  client: ApiClient,
  path: string,
  body: Record<string, unknown>,
): Promise<{ error?: unknown; response?: Response }> {
  const post = client.POST as unknown as (
    path: string,
    init: { body: Record<string, unknown> },
  ) => Promise<{ error?: unknown; response?: Response }>;
  return post(path, { body });
}

function RequirementMethodPicker({
  options,
}: {
  options: Array<{ title: string; description: string; onChoose: () => void }>;
}): JSX.Element {
  return (
    <div style={methodGridStyle}>
      {options.map((option) => (
        <button
          key={option.title}
          type="button"
          onClick={option.onChoose}
          style={methodButtonStyle}
        >
          <strong>{option.title}</strong>
          <span>{option.description}</span>
        </button>
      ))}
    </div>
  );
}

function AdmissionDocuments({
  requirements,
  onView,
}: {
  requirements: ReadinessRequirement[];
  onView: (evidence: ReadinessRequirement["evidence"]) => void;
}): JSX.Element {
  const rows = requirements.filter((r) => r.evidence?.documentId && r.evidence.documentVersionId);
  if (rows.length === 0) {
    return (
      <p id="documents" style={emptyTextStyle}>
        No admission intake documents are attached yet.
      </p>
    );
  }
  return (
    <table id="documents" style={tableStyle}>
      <thead>
        <tr style={rowStyle}>
          <th style={thStyle}>Document type</th>
          <th style={thStyle}>Source</th>
          <th style={thStyle}>Date</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>View</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.code}-${r.evidence?.documentVersionId}`} style={rowStyle}>
            <td style={tdStyle}>{r.label}</td>
            <td style={tdStyle}>Uploaded document</td>
            <td style={tdStyle}>{fmtDate(r.evidence?.completedAt)}</td>
            <td style={tdStyle}>
              <StatusPill label={stateLabel(r.status)} tone={requirementTone(r.status)} />
            </td>
            <td style={tdStyle}>
              <button type="button" style={ghostBtn} onClick={() => onView(r.evidence)}>
                View document
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The actions `triggerAction` opens something for. A requirement action outside this set (one the
 * server added before this screen learned it, or one completed elsewhere) renders as a DISABLED button
 * with a tooltip — never as a button that silently does nothing.
 */
function isActionHandled(
  action: string,
  context: { electionStatement: ElectionStatementView | null; cti: CtiView | null },
): boolean {
  switch (action) {
    case "ACKNOWLEDGE_NOR":
    case "COMPLETE_NOTICE_OF_RIGHTS":
    case "COMPLETE_ADMISSION_DETAILS":
    case "COMPLETE_ELECTION":
    case "COMPLETE_ELECTION_STATEMENT":
    case "COMPLETE_ELECTION_SIGNATURE":
    case "COMPLETE_CTI":
    case "COMPLETE_CTI_SIGNATURE":
    case "REVIEW_PRIVACY":
    case "RECORD_ADMISSION_RECOMMENDATION":
    case "COMPLETE_ELECTION_ADDENDUM":
      return true;
    case "REVIEW_CTI":
      return !context.cti || !context.cti.hospiceMdSigned;
    default:
      return false;
  }
}

function RequirementActionButton({
  action,
  context,
  onAction,
  style,
}: {
  action: string;
  context: { electionStatement: ElectionStatementView | null; cti: CtiView | null };
  onAction: (action: string) => void;
  style: CSSProperties;
}): JSX.Element {
  const label = actionLabel(action, context);
  if (!isActionHandled(action, context)) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="This step can't be completed from this screen yet."
        style={{ ...style, opacity: 0.5, cursor: "not-allowed" }}
      >
        {label}
      </button>
    );
  }
  return (
    <button type="button" style={style} onClick={() => onAction(action)}>
      {label}
    </button>
  );
}

interface SudPendingBatch {
  id: string;
  createdAt: string;
  sourceChannel: string;
  pageCount: number | null;
  documentCount: number | null;
}

const INTAKE_SOURCE_LABEL: Record<string, string> = {
  fax: "fax",
  email_ingest: "email",
  portal_upload: "portal upload",
  admin_upload: "upload",
  api: "interface",
};

/**
 * One flagged intake batch, distinguishable from its siblings: the channel, the received date AND time,
 * and its size — e.g. "fax received Oct 4, 2026, 2:38 AM · 3 documents · 21 pages". Counts only.
 */
function describeIntakeBatch(b: SudPendingBatch): string {
  const d = new Date(b.createdAt);
  const when = Number.isNaN(d.getTime())
    ? b.createdAt
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    `${INTAKE_SOURCE_LABEL[b.sourceChannel] ?? "document"} received ${when}`,
    b.documentCount !== null && b.documentCount > 1 ? plural(b.documentCount, "document") : null,
    b.pageCount !== null ? plural(b.pageCount, "page") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * REVIEW_PRIVACY — explains the patient-privacy requirement (the server's category-free `reasonCode`)
 * and links to the one workflow that can lift it. No override exists: M5 reports `overrideAllowed`,
 * but no privacy-override route is built, so none is offered.
 *
 *   INTAKE_DETECTION_UNREVIEWED  ADVISORY (F-238: never blocks activation). The open, non-discarded
 *                                intake batches for this patient whose detection is still `detected`
 *                                (GET /api/v1/intake/uploads — ids, dates, counts); confirming/rejecting
 *                                there drives the M5 flag (M22 §7.4 W4)
 *   CONSENT_REQUIRED             the patient's consent record (M39) — an active release lifts it
 *   anything else                who to ask, plus a re-check
 */
function PrivacyReviewDialog({
  open,
  onClose,
  onRecheck,
  reasonCode,
  message,
  patientId,
}: {
  open: boolean;
  onClose: () => void;
  onRecheck: () => void;
  reasonCode: string | undefined;
  message: string | undefined;
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const can = (key: string): boolean => session?.permissions?.includes(key) ?? false;
  const [batches, setBatches] = useState<SudPendingBatch[] | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const wantsBatches = open && reasonCode === "INTAKE_DETECTION_UNREVIEWED" && !!patientId;

  useEffect(() => {
    if (!wantsBatches || !patientId) return;
    let live = true;
    setBatches(null);
    setLookupFailed(false);
    // Open batches only: discarding a batch withdraws its unreviewed detection (F-238), so a discarded
    // batch is never one to resolve — and a completed one cannot still be `detected` (completion is
    // refused while the detection is unresolved). Filtered on status too, defensively.
    client
      .GET("/api/v1/intake/uploads", {
        params: { query: { view: "open", patientId, sudStatus: "detected" } },
      })
      .then(({ data, error }) => {
        if (!live) return;
        if (error || !Array.isArray(data?.items)) {
          setLookupFailed(true);
          return;
        }
        setBatches(
          data.items
            .filter((b) => b.status !== "discarded")
            .map((b) => ({
              id: b.id,
              createdAt: b.createdAt,
              sourceChannel: b.sourceChannel,
              pageCount: b.pageCount ?? null,
              documentCount: b.documentCount ?? null,
            })),
        );
      })
      .catch(() => {
        if (live) setLookupFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client, wantsBatches, patientId]);

  let body: ReactNode;
  if (reasonCode === "INTAKE_DETECTION_UNREVIEWED") {
    body = (
      <>
        <p style={admissionDetailsModalDescriptionStyle}>
          An intake document for this patient was flagged as possibly containing specially protected
          records, which placed an interim confidentiality restriction on those records.{" "}
          <strong>This doesn't block admission.</strong> The records stay restricted until an intake
          reviewer confirms or rejects the flag. Rejecting a false positive lifts the restriction;
          confirming it means a patient consent must be recorded before the records can be shared.
        </p>
        {lookupFailed ? (
          <p style={hintTextStyle} data-testid="privacy-intake-unavailable">
            You can't open intake review. Ask an intake reviewer to resolve the flagged document.
          </p>
        ) : batches === null ? (
          <p style={hintTextStyle}>Looking for the flagged intake documents…</p>
        ) : batches.length === 0 ? (
          <p style={hintTextStyle} data-testid="privacy-intake-none">
            No intake document for this patient is waiting on this review, so it can't be resolved
            from intake review. This restriction can't be cleared in WardenX yet — escalate to your
            privacy officer.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {batches.map((b) =>
              can("intake.review") ? (
                <Link key={b.id} to={`/intake/${b.id}/review`} style={patientLinkStyle}>
                  {`Resolve the flag in intake review — ${describeIntakeBatch(b)}`}
                </Link>
              ) : (
                <span key={b.id} style={hintTextStyle}>
                  {`Intake ${describeIntakeBatch(b)} — an intake reviewer must resolve it.`}
                </span>
              ),
            )}
          </div>
        )}
      </>
    );
  } else if (reasonCode === "CONSENT_REQUIRED") {
    body = (
      <>
        <p style={admissionDetailsModalDescriptionStyle}>
          This patient has a confirmed confidentiality restriction. It is lifted when the patient's
          consent for these records is recorded.
        </p>
        {patientId && (can("consent.author") || can("consent.read")) ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {can("consent.author") ? (
              <Link to={`/patients/${patientId}/consents/new`} style={patientLinkStyle}>
                Record patient consent
              </Link>
            ) : null}
            {can("consent.read") ? (
              <Link to={`/patients/${patientId}/consents`} style={patientLinkStyle}>
                View the patient's consents
              </Link>
            ) : null}
          </div>
        ) : (
          <p style={hintTextStyle}>Ask a team member who records consents to capture it.</p>
        )}
      </>
    );
  } else if (reasonCode === "PRIVACY_CLEARANCE_UNAVAILABLE") {
    body = (
      <p style={admissionDetailsModalDescriptionStyle}>
        The privacy check could not be completed right now. Check again in a moment.
      </p>
    );
  } else {
    body = (
      <p style={admissionDetailsModalDescriptionStyle}>
        {message ?? "A patient restriction requires authorized review."} This kind of restriction
        can't be reviewed or cleared in WardenX yet — escalate to your privacy officer.
      </p>
    );
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Review patient privacy" width="34rem">
      <div style={admissionDetailsModalStyle}>
        <div style={admissionDetailsModalHeaderStyle}>
          <h2 style={admissionDetailsModalTitleStyle}>Review patient privacy</h2>
        </div>
        {body}
        <div style={admissionDetailsModalActionsStyle}>
          <button type="button" style={ghostBtn} onClick={onClose}>
            Close
          </button>
          <button type="button" style={primaryBtn} onClick={onRecheck}>
            Check again
          </button>
        </div>
      </div>
    </Modal>
  );
}

function actionLabel(
  action: string,
  context: {
    electionStatement: ElectionStatementView | null;
    cti: CtiView | null;
  },
): string {
  if (action === "ACKNOWLEDGE_NOR" || action === "COMPLETE_NOTICE_OF_RIGHTS")
    return "Complete Notice of Rights";

  if (action === "COMPLETE_ADMISSION_DETAILS") {
    return "Complete admission details";
  }

  if (action === "COMPLETE_ELECTION" || action === "COMPLETE_ELECTION_STATEMENT") {
    return context.electionStatement
      ? "Complete Election signature"
      : "Complete Election Statement";
  }
  if (action === "COMPLETE_ELECTION_SIGNATURE") return "Complete Election signature";
  if (action === "COMPLETE_CTI") return "Complete CTI";
  if (action === "COMPLETE_CTI_SIGNATURE") return "Complete CTI signature";
  if (action === "REVIEW_PRIVACY") return "Review privacy";
  if (action === "RECORD_ADMISSION_RECOMMENDATION") return "Record recommendation";
  if (action === "COMPLETE_ELECTION_ADDENDUM") return "Open election addendum";

  if (action === "REVIEW_CTI") {
    if (!context.cti) {
      return "Create CTI";
    }

    if (!context.cti.hospiceMdSigned) {
      return "Sign CTI as Hospice MD";
    }

    return "Review CTI";
  }

  return stateLabel(action);
}

function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function dateInputToIso(value: string): string {
  return `${value}T12:00:00.000Z`;
}

const primaryBtn = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
} as const;
const disabledBtn: CSSProperties = {
  ...primaryBtn,
  opacity: 0.5,
  cursor: "not-allowed",
};
const ghostBtn: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const fieldLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const addressBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface-container)",
  fontSize: "0.85rem",
};
const alertStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-error)",
};

const hintTextStyle: CSSProperties = {
  fontSize: "0.8125rem",
  color: "var(--color-on-surface-variant)",
};

const formStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
};

const admissionDetailsModalStyle: CSSProperties = {
  width: "100%",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "1.25rem",
};

const admissionDetailsModalHeaderStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

const admissionDetailsModalTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.125rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const admissionDetailsModalDescriptionStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  lineHeight: 1.5,
  color: "var(--color-on-surface-variant)",
};

const admissionDetailsModalSignerStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
};

const admissionDetailsModalActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: "0.75rem",
  paddingTop: "0.25rem",
};

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const summaryCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const summaryHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const summaryMetaStyle: CSSProperties = {
  marginTop: "0.25rem",
  fontSize: "0.82rem",
  color: "var(--color-on-surface-variant)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem 1rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const fieldLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 600,
};

const fieldValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};

const patientLinkStyle: CSSProperties = {
  color: "var(--color-primary)",
  fontWeight: 700,
  textDecoration: "none",
};

const patientMetaStyle: CSSProperties = {
  display: "block",
  marginTop: "0.2rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
  fontWeight: 500,
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
};
const thStyle: CSSProperties = {
  ...tdStyle,
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  color: "var(--color-on-surface-variant)",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const tabStyle: CSSProperties = {
  minHeight: "2rem",
  padding: "0.45rem 0.7rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  textDecoration: "none",
  fontSize: "0.8rem",
  fontWeight: 600,
};

const blockerBoxStyle: CSSProperties = {
  border: "1px solid var(--color-error)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
  color: "var(--color-on-surface)",
  background: "var(--color-error-container)",
};

const readyBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
  background: "var(--color-surface-container)",
};

const nextStepStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  border: "1px solid var(--color-outline-variant)",
};

const sectionInnerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const sectionStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const checkboxLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.55rem",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "5rem",
  resize: "vertical",
};

const hopeEntryStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "1rem",
  alignItems: "start",
};
const hopeMiniGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const hopeMiniStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const miniTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 700,
};

const requirementGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};

const requirementCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
};

const requirementHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};

const requirementMessageStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.82rem",
};

const actionHintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  fontWeight: 600,
};

const requirementLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  flexWrap: "wrap",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};
const methodGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem",
};
const methodButtonStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  textAlign: "left",
  padding: "0.8rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
};
// §5.2.5 activation gate as a Guardrail treatment: a blocked GuardChip summary (or a success pill when
// ready) over a GateStepper whose rows render server-truth — each unmet precondition is `blocked`
// (alert glyph, error tint, surfaced first), each met one `complete` (check, struck through).
function ActivationChecklist({
  gate,
}: {
  gate: AdmissionDetailView["activationGate"];
}): JSX.Element {
  const items: GateItem[] = GATE_ROWS.map((row) => ({
    id: row.code,
    label: row.label,
    status: gate.missing.includes(row.code) ? "blocked" : "complete",
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {gate.ready ? (
        <StatusPill tone="success" label="Ready to activate" />
      ) : (
        <GuardChip
          tone="error"
          reason={`${gate.missing.length} precondition${gate.missing.length === 1 ? "" : "s"} block activation`}
        />
      )}
      <GateStepper items={items} ariaLabel="Activation preconditions" />
    </div>
  );
}

function ReadinessChecklist({
  readiness,
}: {
  readiness: AdmissionReadiness;
}): JSX.Element {
  const items: GateItem[] = readiness.requirements.map((r) => ({
    id: r.code,
    label: r.label,
    status:
      r.status === "complete" || r.status === "not_applicable"
        ? "complete"
        : r.status === "pending" || r.status === "awaiting_signature" || isAdvisory(r)
          ? "in-progress"
          : "blocked",
    ...(isAdvisory(r) ? { detail: "Review advised — doesn't block activation" } : {}),
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <StatusPill
        tone={
          readiness.canActivate ? "success" : readiness.status === "blocked" ? "error" : "warning"
        }
        label={
          readiness.canActivate ? "Ready to activate" : `${readiness.blockingRemaining} blockers`
        }
      />
      <GateStepper items={items} ariaLabel="Admission readiness requirements" />
    </div>
  );
}

function RequirementCards({
  requirements,
  electionStatement,
  cti,
  onAction,
}: {
  requirements: ReadinessRequirement[];
  electionStatement: ElectionStatementView | null;
  cti: CtiView | null;
  onAction: (action: string) => void;
}): JSX.Element {
  if (requirements.length === 0) return <p style={emptyTextStyle}>Readiness is loading.</p>;
  return (
    <div style={requirementGridStyle}>
      {requirements.map((r) => (
        <div key={r.code} style={requirementCardStyle}>
          <div style={requirementHeaderStyle}>
            <strong>{r.label}</strong>
            <RequirementPill requirement={r} />
          </div>
          <p style={requirementMessageStyle}>
            {r.message ?? (r.status === "complete" ? "Complete" : "No action required.")}
          </p>
          {r.action ? (
            <RequirementActionButton
              action={r.action}
              context={{ electionStatement, cti }}
              onAction={onAction}
              style={ghostBtn}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RequirementLine({
  requirement,
}: {
  requirement: ReadinessRequirement | undefined;
}): JSX.Element {
  if (!requirement) return <p style={emptyTextStyle}>No readiness data available.</p>;
  return (
    <div style={requirementLineStyle}>
      <RequirementPill requirement={requirement} />
      <span>{requirement.message ?? requirement.label}</span>
    </div>
  );
}

/** A non-blocking requirement that still owes an action — shown, never counted as a blocker. */
function isAdvisory(r: ReadinessRequirement): boolean {
  return !r.blocking && r.status === "action_required";
}

function RequirementPill({ requirement }: { requirement: ReadinessRequirement }): JSX.Element {
  return isAdvisory(requirement) ? (
    <StatusPill label="Review advised" tone="warning" />
  ) : (
    <StatusPill label={stateLabel(requirement.status)} tone={requirementTone(requirement.status)} />
  );
}

function requirementTone(status: ReadinessRequirement["status"]): StatusTone {
  if (status === "complete" || status === "not_applicable") return "success";
  if (status === "pending" || status === "awaiting_signature") return "progress";
  if (status === "blocked" || status === "overdue") return "error";
  return "warning";
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function patientDisplayName(patient: PatientSummary | null, patientId?: string): string {
  const name = [patient?.firstName, patient?.lastName].filter(Boolean).join(" ").trim();
  return name || patient?.mrn || patientId || "Unresolved";
}

function patientMeta(patient: PatientSummary | null): string | null {
  if (!patient) return null;
  return [
    patient.dob ? `DOB ${fmtDate(patient.dob)}` : null,
    patient.mrn ? `MRN ${patient.mrn}` : null,
    patient.status ? stateLabel(patient.status) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function physicianLabel(
  physician: PhysicianSummary | null | undefined,
  fallbackId?: string | null,
): string {
  if (physician?.displayName) {
    return physician.npi
      ? `${physician.displayName} · NPI ${physician.npi}`
      : physician.displayName;
  }
  return fallbackId ? `Physician ${fallbackId.slice(0, 8)}` : "Not selected";
}

function normalizeSecondaryDiagnoses(value: string): string[] {
  return value
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function AdmissionPatientLink({
  patientId,
  patient,
  compact,
}: {
  patientId?: string;
  patient: PatientSummary | null;
  compact?: boolean;
}): JSX.Element {
  if (!patientId) return <span>Unresolved</span>;
  return (
    <>
      <Link to={`/patients/${patientId}`} style={patientLinkStyle}>
        {patientDisplayName(patient, patientId)}
      </Link>
      {!compact && patientMeta(patient) ? (
        <span style={patientMetaStyle}>{patientMeta(patient)}</span>
      ) : null}
    </>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span className={mono ? "wx-data-md" : undefined} style={fieldValueStyle}>
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section style={sectionCardStyle}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

function RowList({
  rows,
  empty,
  toneFor,
}: {
  rows: SummaryRow[];
  empty: string;
  toneFor?: Record<string, StatusTone>;
}): JSX.Element {
  if (rows.length === 0) return <p style={emptyTextStyle}>{empty}</p>;
  return (
    <table style={tableStyle}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={rowStyle}>
            <td className="wx-data-md" style={tdStyle}>
              {r.id}
            </td>
            <td style={tdStyle}>
              <StatusPill label={stateLabel(r.state)} tone={toneFor?.[r.state] ?? "neutral"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
