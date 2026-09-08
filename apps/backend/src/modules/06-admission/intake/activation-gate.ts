// apps/backend/src/modules/06-admission/intake/activation-gate.ts — M6-T07 the R-AC-01 admission
// activation gate (§7.2 W-AD-05; screen §5.2.5). PURE: given the period-1 bundle facts, decide
// whether `POST /admissions/:id/activate` (route 14) may proceed and, if not, WHICH preconditions are
// unmet (the §4.2.2 `412 PRECONDITION_FAILED { missing }` codes). One function is the single source of
// truth for BOTH the server-side gate (`activateAdmission`) and the read-back checklist on the
// admission aggregate (route 10), so the §5.2.5 UI checklist and the server can never diverge (§7.2
// "Done means" — the gate is verified by re-fetch after out-of-band mutation).

export type AdmissionReadinessStatus = "blocked" | "action_required" | "ready";
export type RequirementStatus =
  | "complete"
  | "action_required"
  | "awaiting_signature"
  | "pending"
  | "blocked"
  | "overdue"
  | "not_applicable";
export type RequirementCode =
  | "patient_identity"
  | "admission_details"
  | "patient_privacy"
  | "notice_of_rights"
  | "election_statement"
  | "cti"
  | "f2f";
export type RequirementAction =
  | "RESOLVE_PATIENT"
  | "COMPLETE_ADMISSION_DETAILS"
  | "REVIEW_PRIVACY"
  | "COMPLETE_NOTICE_OF_RIGHTS"
  | "COMPLETE_ELECTION_STATEMENT"
  | "COMPLETE_ELECTION_SIGNATURE"
  | "COMPLETE_CTI"
  | "COMPLETE_CTI_SIGNATURE"
  | "REVIEW_F2F";

export interface AdmissionRequirementEvidence {
  readonly sourceType: "structured" | "uploaded";
  readonly evidenceId: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly structuredEntityId?: string;
  readonly completedAt?: string;
}

export interface AdmissionReadinessRequirement {
  readonly code: RequirementCode;
  readonly label: string;
  readonly status: RequirementStatus;
  readonly blocking: boolean;
  readonly message?: string;
  readonly action?: RequirementAction;
  readonly satisfiedBy?: "normal" | "override";
  readonly evidence?: AdmissionRequirementEvidence;
}

export interface AdmissionReadinessResult {
  readonly admissionId: string;
  readonly status: AdmissionReadinessStatus;
  readonly canActivate: boolean;
  readonly completed: number;
  readonly blockingRemaining: number;
  readonly requirements: readonly AdmissionReadinessRequirement[];
}

export interface AdmissionReadinessFacts {
  readonly admissionId: string;
  readonly patientIdentity: {
    readonly patientId: string | null;
    readonly referralPatientId?: string | null;
    readonly referralPatientResolutionStatus?: string | null;
  };
  readonly admissionDetails: {
    readonly admissionDatePresent: boolean;
    // readonly primaryDiagnosisPresent: boolean;
    // readonly hospiceMedicalDirectorPresent: boolean;
    readonly providerEntityPresent: boolean;
    readonly locationPresent: boolean;
  };
  readonly patientPrivacy: {
    readonly allowed: boolean;
    readonly reason?: string;
    readonly overrideAllowed?: boolean;
    readonly satisfiedBy?: "normal" | "override";
  };
  readonly noticeOfRights: {
    readonly acknowledged: boolean;
    readonly acknowledgedAtPresent: boolean;
    readonly signerValid: boolean;
    readonly methodValid: boolean;
    readonly evidence?: AdmissionRequirementEvidence;
  };
  readonly electionStatement: {
    readonly exists: boolean;
    readonly status: string | null;
    readonly signedAtPresent: boolean;
    readonly belongsToCurrentPeriod: boolean;
    readonly evidence?: AdmissionRequirementEvidence;
    readonly signatureEvidence?: AdmissionRequirementEvidence;
  };
  readonly cti: {
    readonly exists: boolean;
    readonly status: string | null;
    readonly evidence?: AdmissionRequirementEvidence;
    readonly signatureEvidence?: AdmissionRequirementEvidence;
    readonly hospiceMdSigned: boolean;
  };
  readonly f2f: {
    readonly required: boolean;
    readonly exists: boolean;
    readonly status: string | null;
    readonly completed: boolean;
    readonly attestationRequired: boolean;
    readonly attested: boolean;
    readonly overdue?: boolean;
    readonly satisfiedBy?: "normal" | "override";
  };
}

const complete = (
  code: RequirementCode,
  label: string,
  evidence?: AdmissionRequirementEvidence,
): AdmissionReadinessRequirement => ({
  code,
  label,
  status: "complete",
  blocking: true,
  ...(evidence ? { evidence } : {}),
});

export function evaluateAdmissionReadiness(
  facts: AdmissionReadinessFacts,
): AdmissionReadinessResult {
  const requirements: AdmissionReadinessRequirement[] = [];
  const identityResolved =
    !!facts.patientIdentity.patientId &&
    (!facts.patientIdentity.referralPatientId ||
      (facts.patientIdentity.patientId === facts.patientIdentity.referralPatientId &&
        ["matched", "created"].includes(
          facts.patientIdentity.referralPatientResolutionStatus ?? "",
        )));
  requirements.push(
    identityResolved
      ? complete("patient_identity", "Patient identity")
      : {
          code: "patient_identity",
          label: "Patient identity",
          status: "blocked",
          blocking: true,
          message: "A canonical M5 patient must be resolved before activation.",
          action: "RESOLVE_PATIENT",
        },
  );

  const missingDetails: string[] = [];
  if (!facts.admissionDetails.admissionDatePresent) missingDetails.push("admission date");
  // if (!facts.admissionDetails.primaryDiagnosisPresent) missingDetails.push("terminal diagnosis");
  // if (!facts.admissionDetails.hospiceMedicalDirectorPresent)
  //   missingDetails.push("hospice medical director");
  if (!facts.admissionDetails.providerEntityPresent) missingDetails.push("provider entity");
  if (!facts.admissionDetails.locationPresent) missingDetails.push("location");
  requirements.push(
    missingDetails.length === 0
      ? complete("admission_details", "Admission details")
      : {
          code: "admission_details",
          label: "Admission details",
          status: "action_required",
          blocking: true,
          message: `Missing ${missingDetails.join(", ")}.`,
          action: "COMPLETE_ADMISSION_DETAILS",
        },
  );

  requirements.push(
    facts.patientPrivacy.allowed
      ? {
          code: "patient_privacy",
          label: "Patient privacy",
          status: "complete",
          blocking: true,
          satisfiedBy: facts.patientPrivacy.satisfiedBy ?? "normal",
        }
      : {
          code: "patient_privacy",
          label: "Patient privacy",
          status: "blocked",
          blocking: true,
          message: "A patient restriction requires authorized review.",
          action: "REVIEW_PRIVACY",
        },
  );

  const norComplete =
    facts.noticeOfRights.acknowledged &&
    facts.noticeOfRights.acknowledgedAtPresent &&
    facts.noticeOfRights.signerValid &&
    facts.noticeOfRights.methodValid;
  requirements.push(
    norComplete
      ? complete("notice_of_rights", "Notice of Rights", facts.noticeOfRights.evidence)
      : {
          code: "notice_of_rights",
          label: "Notice of Rights",
          status: "action_required",
          blocking: true,
          message: "Notice of Rights acknowledgment is required.",
          action: "COMPLETE_NOTICE_OF_RIGHTS",
        },
  );

  const electionStatementSatisfied = facts.electionStatement.evidence
    ? true
    : facts.electionStatement.exists;
  const electionSignatureSatisfied = facts.electionStatement.signatureEvidence
    ? true
    : facts.electionStatement.status === "signed" && facts.electionStatement.signedAtPresent;
  const electionComplete =
    facts.electionStatement.exists &&
    electionStatementSatisfied &&
    electionSignatureSatisfied &&
    facts.electionStatement.belongsToCurrentPeriod;
  const electionStatus =
    facts.electionStatement.status === "awaiting_signature"
      ? "awaiting_signature"
      : "action_required";
  requirements.push(
    electionComplete
      ? complete(
          "election_statement",
          "Election Statement",
          facts.electionStatement.signatureEvidence,
        )
      : {
          code: "election_statement",
          label: "Election Statement",
          status: electionStatus,
          blocking: true,
          message: facts.electionStatement.exists
            ? "Election Statement must be signed."
            : "Election Statement is required.",
          action: facts.electionStatement.exists
            ? "COMPLETE_ELECTION_SIGNATURE"
            : "COMPLETE_ELECTION_STATEMENT",
        },
  );

  let ctiRequirement: AdmissionReadinessRequirement;
  const ctiSatisfied = facts.cti.evidence ? true : facts.cti.exists;
  const ctiSignatureSatisfied = facts.cti.signatureEvidence ? true : facts.cti.hospiceMdSigned;
  if (!facts.cti.exists || facts.cti.status === "voided" || !ctiSatisfied) {
    ctiRequirement = {
      code: "cti",
      label: "Certification of Terminal Illness",
      status: "action_required",
      blocking: true,
      message: "Certification of Terminal Illness is required.",
      action: "COMPLETE_CTI",
    };
  } else if (!ctiSignatureSatisfied) {
    ctiRequirement = {
      code: "cti",
      label: "Certification of Terminal Illness",
      status: "awaiting_signature",
      blocking: true,
      message: "Hospice medical director signature is required.",
      action: "COMPLETE_CTI_SIGNATURE",
    };
  } else {
    ctiRequirement = complete(
      "cti",
      "Certification of Terminal Illness",
      facts.cti.signatureEvidence,
    );
  }
  requirements.push(ctiRequirement);

  if (!facts.f2f.required) {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "not_applicable",
      blocking: false,
      message: "Not required for this certification period.",
    });
  } else if (facts.f2f.satisfiedBy === "override") {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "complete",
      blocking: false,
      satisfiedBy: "override",
    });
  } else if (!facts.f2f.exists) {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "action_required",
      blocking: true,
      message: "Face-to-Face Encounter is required for this certification period.",
      action: "REVIEW_F2F",
    });
  } else if (facts.f2f.overdue) {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "overdue",
      blocking: true,
      message: "Face-to-Face Encounter window has been missed.",
      action: "REVIEW_F2F",
    });
  } else if (!facts.f2f.completed) {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "pending",
      blocking: true,
      message: "Face-to-Face Encounter is scheduled.",
      action: "REVIEW_F2F",
    });
  } else if (facts.f2f.attestationRequired && !facts.f2f.attested) {
    requirements.push({
      code: "f2f",
      label: "Face-to-Face Encounter",
      status: "awaiting_signature",
      blocking: true,
      message: "Face-to-Face attestation is required.",
      action: "REVIEW_F2F",
    });
  } else {
    requirements.push(complete("f2f", "Face-to-Face Encounter"));
  }

  const completed = requirements.filter(
    (r) => r.status === "complete" || r.status === "not_applicable",
  ).length;
  const blockingRemaining = requirements.filter(
    (r) => r.blocking && r.status !== "complete",
  ).length;
  const hasBlocked = requirements.some(
    (r) => r.blocking && (r.status === "blocked" || r.status === "overdue"),
  );
  return {
    admissionId: facts.admissionId,
    status: blockingRemaining === 0 ? "ready" : hasBlocked ? "blocked" : "action_required",
    canActivate: blockingRemaining === 0,
    completed,
    blockingRemaining,
    requirements,
  };
}

/** The §4.2.2 precondition codes the legacy activation gate reports as unmet. */
export type ActivationGap = "election_signed" | "nor_acknowledged" | "cti_signed";

/** Period-1 bundle facts the gate decides over (loaded org-scoped; never from client input). */
export interface ActivationFacts {
  /** The benefit-period sequence being activated. */
  readonly periodSequence: number;
  readonly electionSigned: boolean;
  readonly norAcknowledged: boolean;
  readonly ctiHospiceMdSigned: boolean;
}

/** The gate verdict: `ready` to activate, plus the ordered list of still-missing preconditions. */
export interface ActivationGate {
  readonly ready: boolean;
  readonly missing: readonly ActivationGap[];
}

/**
 * R-AC-01 — an admission activates only when, for period 1: the election statement is signed, the NOR
 * is acknowledged, and the CTI is signed by the selected hospice physician. The attending-physician CTI
 * signature is not an activation prerequisite. The order of
 * `missing` matches the §5.2.5 checklist top-to-bottom so the UI can render server truth verbatim.
 */
export function computeActivationGate(facts: ActivationFacts): ActivationGate {
  const readiness = evaluateAdmissionReadiness({
    admissionId: "",
    patientIdentity: { patientId: "legacy" },
    admissionDetails: {
      admissionDatePresent: true,
      // primaryDiagnosisPresent: true,
      // hospiceMedicalDirectorPresent: true,
      providerEntityPresent: true,
      locationPresent: true,
    },
    patientPrivacy: { allowed: true },
    noticeOfRights: {
      acknowledged: facts.norAcknowledged,
      acknowledgedAtPresent: facts.norAcknowledged,
      signerValid: facts.norAcknowledged,
      methodValid: facts.norAcknowledged,
    },
    electionStatement: {
      exists: facts.electionSigned,
      status: facts.electionSigned ? "signed" : null,
      signedAtPresent: facts.electionSigned,
      belongsToCurrentPeriod: facts.electionSigned,
    },
    cti: {
      exists: facts.ctiHospiceMdSigned,
      status: facts.ctiHospiceMdSigned ? "signed" : null,
      evidence: facts.ctiHospiceMdSigned
        ? { sourceType: "structured", evidenceId: "legacy", structuredEntityId: "legacy" }
        : undefined,
      signatureEvidence: facts.ctiHospiceMdSigned
        ? { sourceType: "structured", evidenceId: "legacy", structuredEntityId: "legacy" }
        : undefined,
      hospiceMdSigned: facts.ctiHospiceMdSigned,
    },
    f2f: {
      required: false,
      exists: false,
      status: null,
      completed: false,
      attestationRequired: false,
      attested: false,
    },
  });
  const missing: ActivationGap[] = [];
  if (
    readiness.requirements.some((r) => r.code === "election_statement" && r.status !== "complete")
  )
    missing.push("election_signed");
  if (readiness.requirements.some((r) => r.code === "notice_of_rights" && r.status !== "complete"))
    missing.push("nor_acknowledged");
  if (readiness.requirements.some((r) => r.code === "cti" && r.status !== "complete"))
    missing.push("cti_signed");
  return { ready: missing.length === 0, missing };
}
