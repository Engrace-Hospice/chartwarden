// M23-CM-4A.1 — authoritative NOE/NOTR/8xC/8xD data loading and builder mapping.
// This module has no transport port. MBI and street-address values exist only in the returned in-memory
// builder input and must never be logged, queued, or exposed through an API.
import { createHash } from "node:crypto";
import { repositories } from "@chartwarden/billing";
import type { MdmEntityProvider } from "@chartwarden/mdm";
import type {
  MbiUnlockReader,
  PatientAddressReader,
  PatientCoverage,
  PatientCoverageReader,
  PatientReader,
} from "@chartwarden/types";
import type {
  Notice837iInput,
  TransferNotice837iInput,
  X12Physician,
} from "@chartwarden/x12-837-client";
import type { Claim837iPartiesPort } from "./claim-837i-loader";
import {
  type MedicareNoticeRenderIdentity,
  type MedicareNoticeSourceFacts,
  type MedicareNoticeSourceLoader,
  type MedicareTransferSourceFacts,
  MedicareNoticeRenderHold,
} from "./medicare-notice-renderer";

export const MEDICARE_NOTICE_MBI_DISCLOSURE_PURPOSE = "medicare_notice_render" as const;
export const MEDICARE_NOTICE_MAPPER_VERSION = "m23-notice-authoritative-v2";

export interface AuthoritativeNoticeClinicalFacts {
  readonly organizationId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly electionPeriodId: string;
  readonly electionStatementId: string;
  readonly relatedSourceId: string;
  readonly admissionDate: string;
  readonly statementFromDate: string;
  readonly terminationDate: string | null;
  readonly principalDiagnosis: string;
  readonly attendingPhysicianId: string;
  readonly certifyingPhysicianId: string;
  readonly sourceVersions: Readonly<Record<string, number | string>>;
}

/** Structural M6 seam; its implementation remains owned by module 6. */
export interface MedicareNoticeClinicalPort {
  loadNoe(input: {
    organizationId: string;
    admissionId: string;
    electionPeriodId: string;
    patientId: string;
    providerEntityId: string;
    electionEffectiveDate: string;
  }): Promise<AuthoritativeNoticeClinicalFacts>;
  loadNotr(input: {
    organizationId: string;
    admissionId: string;
    patientId: string;
    providerEntityId: string;
    triggerKind: "revocation" | "transfer_out" | "discharge";
    revocationEventId: string | null;
    transferEventId: string | null;
    dischargeEventId: string | null;
    effectiveEndDate: string;
  }): Promise<AuthoritativeNoticeClinicalFacts>;
  loadTransferOrCancellation(input: {
    organizationId: string;
    admissionId: string;
    electionPeriodId: string;
    transferEventId: string;
    patientId: string;
    providerEntityId: string;
    statementFromDate: string;
    action: "original" | "correction" | "void";
  }): Promise<AuthoritativeNoticeClinicalFacts>;
}

export interface MedicareNoticeRouteFacts {
  readonly jurisdiction: string;
  readonly vendor: "claimmd" | "stedi" | "direct_mac";
  /** Stable non-secret account identifier, never a token or AccountKey. */
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly payerId: string;
  readonly canonicalPayerId: string;
  readonly routeFingerprint: string;
  /** Informational only. Rendering does not authorize sending. */
  readonly transactionSupportVerified: boolean;
}

export interface MedicareNoticeRoutePort {
  resolve(input: {
    organizationId: string;
    providerEntityId: string;
    patientId: string;
    patientPayerId: string;
    effectiveDate: string;
    transaction: "noe" | "notr" | "transfer" | "cancellation";
  }): Promise<MedicareNoticeRouteFacts>;
}

export interface MedicareNoticePersistencePort {
  noeById(organizationId: string, id: string): Promise<repositories.NoeRecord | null>;
  notrById(organizationId: string, id: string): Promise<repositories.NotrRecord | null>;
  transferById(
    organizationId: string,
    id: string,
  ): Promise<repositories.TransferNoticeRecord | null>;
  submissionById(
    organizationId: string,
    id: string,
  ): Promise<Awaited<ReturnType<repositories.ClaimSubmissionRepository["findById"]>>>;
  /** A completed final claim replaces a discharge-alive NOTR under CMS Pub. 100-04, Ch. 11 §20.1.2. */
  finalClaimFiledForAdmission(
    organizationId: string,
    admissionId: string,
    throughDate: string,
  ): Promise<boolean>;
}

export interface MedicareNoticeProviderFactsPort {
  ccnFor(organizationId: string, providerEntityId: string): Promise<string | null>;
}

export interface MedicareNoticeLoaderDeps {
  readonly persistence: MedicareNoticePersistencePort;
  readonly clinical: MedicareNoticeClinicalPort;
  readonly coverages: PatientCoverageReader;
  readonly mbiUnlock: () => MbiUnlockReader;
  readonly patients: PatientReader;
  readonly addresses: PatientAddressReader;
  readonly physicians: Pick<MdmEntityProvider, "resolvePhysician">;
  readonly provider: MedicareNoticeProviderFactsPort;
  readonly route: MedicareNoticeRoutePort;
  readonly partiesFor: (routeKey: string) => Claim837iPartiesPort;
}

type Noe = repositories.NoeRecord;
type Notr = repositories.NotrRecord;
type Transfer = repositories.TransferNoticeRecord;

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function hold(code: ConstructorParameters<typeof MedicareNoticeRenderHold>[0], field?: string): never {
  throw new MedicareNoticeRenderHold(code, field);
}

async function clinicalFacts<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "field" in error) {
      const code = String(error.code);
      const field = typeof error.field === "string" ? error.field : "clinicalSource";
      if (code.startsWith("M6_")) hold("NOTICE_SOURCE_INVALID", field);
    }
    throw error;
  }
}

function ensureReadyState(state: string): void {
  if (state !== "ready") hold("NOTICE_SOURCE_INVALID", "notice.state");
}

function sameIdentity(
  record: { organizationId: string; providerEntityId: string; patientId: string },
  clinical: AuthoritativeNoticeClinicalFacts,
): void {
  if (
    clinical.organizationId !== record.organizationId ||
    clinical.providerEntityId !== record.providerEntityId ||
    clinical.patientId !== record.patientId
  ) hold("NOTICE_SOURCE_INVALID", "sourceOwnership");
}

function attemptMatches(
  attempt: Awaited<ReturnType<MedicareNoticePersistencePort["submissionById"]>>,
  input: {
    organizationId: string;
    providerEntityId: string;
    submissionId: string;
    kind: "noe" | "notr" | "transfer_notice";
    noticeId: string;
  },
): void {
  const subjectId = input.kind === "noe"
    ? attempt?.noeId
    : input.kind === "notr"
      ? attempt?.notrId
      : attempt?.transferNoticeId;
  if (
    !attempt ||
    attempt.id !== input.submissionId ||
    attempt.organizationId !== input.organizationId ||
    attempt.providerEntityId !== input.providerEntityId ||
    attempt.kind !== input.kind ||
    subjectId !== input.noticeId ||
    attempt.outcome !== "queued" ||
    attempt.dispatchState !== "pending"
  ) hold("NOTICE_SOURCE_INVALID", "submissionAttempt");
}

async function beneficiaryAndRoute(
  deps: MedicareNoticeLoaderDeps,
  input: {
    organizationId: string;
    patientId: string;
    providerEntityId: string;
    submissionId: string;
    effectiveDate: string;
    transaction: "noe" | "notr" | "transfer" | "cancellation";
  },
) {
  const coverage = await deps.coverages.activeCoverageOfKind({
    organizationId: input.organizationId,
    patientId: input.patientId,
    coverageKind: "medicare_ffs",
    onDate: input.effectiveDate,
  });
  if (!coverage) hold("NOTICE_FACTS_INCOMPLETE", "coverage.medicareFfs");
  const patient = await deps.patients.findById({ organizationId: input.organizationId, id: input.patientId });
  if (!patient) hold("NOTICE_SOURCE_NOT_FOUND", "patient");
  if (patient.administrativeSex !== "M" && patient.administrativeSex !== "F") {
    hold("NOTICE_FACTS_INCOMPLETE", "subscriber.sex");
  }
  const address = await deps.addresses.primaryAddressAt(
    input.organizationId,
    input.patientId,
    input.effectiveDate,
  );
  if (!address?.state) hold("NOTICE_FACTS_INCOMPLETE", "subscriber.address");
  const route = await deps.route.resolve({
    ...input,
    patientPayerId: coverage.id,
  });
  const identity = await deps.mbiUnlock().unlockForEligibility({
    organizationId: input.organizationId,
    patientId: input.patientId,
    onDate: input.effectiveDate,
    expectedPatientPayerId: coverage.id,
    disclosure: {
      purpose: MEDICARE_NOTICE_MBI_DISCLOSURE_PURPOSE,
      subjectId: input.submissionId,
    },
  });
  if (!identity) hold("NOTICE_FACTS_INCOMPLETE", "subscriber.mbi");
  if (identity.patientPayerId !== coverage.id) hold("NOTICE_SOURCE_INVALID", "subscriber.mbiCoverage");
  return {
    coverage: coverage as PatientCoverage,
    route,
    subscriber: {
      mbi: identity.mbi,
      lastName: identity.lastName,
      firstName: identity.firstName,
      birthDate: identity.dateOfBirth,
      sex: patient.administrativeSex,
      address: {
        line1: address.line1,
        ...(address.line2 ? { line2: address.line2 } : {}),
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
      },
    } as const,
  };
}

async function physician(
  deps: MedicareNoticeLoaderDeps,
  organizationId: string,
  id: string,
  field: string,
): Promise<X12Physician> {
  const resolved = await deps.physicians.resolvePhysician(organizationId, id);
  const npi = resolved?.canonical.identifierValue;
  if (!resolved || resolved.status !== "active" || !npi) hold("NOTICE_FACTS_INCOMPLETE", field);
  return {
    firstName: resolved.canonical.firstName,
    lastName: resolved.canonical.lastName,
    npi,
  };
}

async function commonBuilderFacts(
  deps: MedicareNoticeLoaderDeps,
  input: {
    organizationId: string;
    patientId: string;
    providerEntityId: string;
    submissionId: string;
    effectiveDate: string;
    transaction: "noe" | "notr" | "transfer" | "cancellation";
    clinical: AuthoritativeNoticeClinicalFacts;
  },
) {
  const [beneficiary, attendingPhysician, certifyingPhysician, providerCcn] = await Promise.all([
    beneficiaryAndRoute(deps, input),
    physician(deps, input.organizationId, input.clinical.attendingPhysicianId, "attendingPhysician"),
    physician(deps, input.organizationId, input.clinical.certifyingPhysicianId, "otherPhysician"),
    deps.provider.ccnFor(input.organizationId, input.providerEntityId),
  ]);
  if (!providerCcn?.trim()) hold("NOTICE_FACTS_INCOMPLETE", "billingProvider.ccn");
  const parties = await deps.partiesFor(beneficiary.route.vendor).partiesFor({
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    patientPayerId: beneficiary.coverage.id,
    payerId: beneficiary.route.payerId,
    canonicalPayerId: beneficiary.route.canonicalPayerId,
  });
  if (!parties.submitter) hold("NOTICE_ROUTE_NOT_READY", "submitter");
  if (!parties.receiver) hold("NOTICE_ROUTE_NOT_READY", "receiver");
  if (!parties.billingProvider) hold("NOTICE_FACTS_INCOMPLETE", "billingProvider");
  if (!parties.payer) hold("NOTICE_ROUTE_NOT_READY", "payer");
  return {
    beneficiary,
    attendingPhysician,
    certifyingPhysician,
    providerCcn,
    parties: {
      submitter: parties.submitter,
      receiver: parties.receiver,
      billingProvider: parties.billingProvider,
      subscriber: beneficiary.subscriber,
      payer: parties.payer,
    },
  };
}

function renderIdentity(input: {
  organizationId: string;
  noticeId: string;
  submissionId: string;
  kind: MedicareNoticeRenderIdentity["kind"];
  providerEntityId: string;
  controlNumber: string;
  noticeVersion: number;
  clinical: AuthoritativeNoticeClinicalFacts;
  route: MedicareNoticeRouteFacts;
}): MedicareNoticeRenderIdentity {
  return {
    organizationId: input.organizationId,
    noticeId: input.noticeId,
    submissionId: input.submissionId,
    kind: input.kind,
    relatedSourceId: input.clinical.relatedSourceId,
    sourceVersion: sha256({ notice: input.noticeVersion, ...input.clinical.sourceVersions }),
    routeFingerprint: input.route.routeFingerprint,
    providerEntityId: input.providerEntityId,
    jurisdiction: input.route.jurisdiction,
    vendor: input.route.vendor,
    accountReference: input.route.accountReference,
    usage: input.route.usage,
    mapperVersion: MEDICARE_NOTICE_MAPPER_VERSION,
    controlNumber: input.controlNumber,
  };
}

async function loadNoe(
  deps: MedicareNoticeLoaderDeps,
  request: { organizationId: string; noticeId: string; submissionId: string },
): Promise<MedicareNoticeSourceFacts> {
  const [notice, attempt] = await Promise.all([
    deps.persistence.noeById(request.organizationId, request.noticeId),
    deps.persistence.submissionById(request.organizationId, request.submissionId),
  ]);
  if (!notice || notice.organizationId !== request.organizationId) hold("NOTICE_SOURCE_NOT_FOUND", "noe");
  ensureReadyState(notice.state);
  attemptMatches(attempt, { ...request, providerEntityId: notice.providerEntityId, kind: "noe" });
  const clinical = await clinicalFacts(() => deps.clinical.loadNoe({
    organizationId: request.organizationId,
    admissionId: notice.admissionId,
    electionPeriodId: notice.electionPeriodId,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    electionEffectiveDate: notice.electionEffectiveDate,
  }));
  sameIdentity(notice, clinical);
  const common = await commonBuilderFacts(deps, {
    ...request,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    effectiveDate: notice.electionEffectiveDate,
    transaction: "noe",
    clinical,
  });
  const input: Notice837iInput = {
    ...common.parties,
    envelope: {
      senderId: common.parties.submitter.id,
      receiverId: common.parties.receiver.id,
      applicationReceiverCode: common.parties.receiver.applicationCode,
      interchangeControlNumber: 1,
      usage: common.beneficiary.route.usage === "test" ? "T" : "P",
      createdAt: new Date(0),
    },
    notice: { kind: "NOE", controlNumber: notice.noeControlNumber, admissionDate: clinical.statementFromDate },
    principalDiagnosis: clinical.principalDiagnosis,
    attendingPhysician: common.attendingPhysician,
    otherPhysician: common.certifyingPhysician,
  };
  return {
    ready: true,
    input,
    identity: renderIdentity({
      ...request,
      kind: "noe",
      providerEntityId: notice.providerEntityId,
      controlNumber: notice.noeControlNumber,
      noticeVersion: notice.version,
      clinical,
      route: common.beneficiary.route,
    }),
  };
}

async function loadNotr(
  deps: MedicareNoticeLoaderDeps,
  request: { organizationId: string; noticeId: string; submissionId: string },
): Promise<MedicareNoticeSourceFacts> {
  const [notice, attempt] = await Promise.all([
    deps.persistence.notrById(request.organizationId, request.noticeId),
    deps.persistence.submissionById(request.organizationId, request.submissionId),
  ]);
  if (!notice || notice.organizationId !== request.organizationId) hold("NOTICE_SOURCE_NOT_FOUND", "notr");
  ensureReadyState(notice.state);
  attemptMatches(attempt, { ...request, providerEntityId: notice.providerEntityId, kind: "notr" });
  if (notice.triggerKind === "transfer_out") hold("NOTICE_SOURCE_INVALID", "notr.triggerKind");
  if (
    notice.triggerKind === "discharge" &&
    await deps.persistence.finalClaimFiledForAdmission(
      request.organizationId,
      notice.admissionId,
      notice.effectiveEndDate,
    )
  ) {
    hold("NOTICE_SOURCE_INVALID", "notr.finalClaimAlreadyFiled");
  }
  const clinical = await clinicalFacts(() => deps.clinical.loadNotr({
    organizationId: request.organizationId,
    admissionId: notice.admissionId,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    triggerKind: notice.triggerKind,
    revocationEventId: notice.revocationEventId,
    transferEventId: notice.transferEventId,
    dischargeEventId: notice.dischargeEventId,
    effectiveEndDate: notice.effectiveEndDate,
  }));
  sameIdentity(notice, clinical);
  if (!clinical.terminationDate) hold("NOTICE_FACTS_INCOMPLETE", "notice.terminationDate");
  const common = await commonBuilderFacts(deps, {
    ...request,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    effectiveDate: notice.effectiveEndDate,
    transaction: "notr",
    clinical,
  });
  const input: Notice837iInput = {
    ...common.parties,
    envelope: {
      senderId: common.parties.submitter.id,
      receiverId: common.parties.receiver.id,
      applicationReceiverCode: common.parties.receiver.applicationCode,
      interchangeControlNumber: 1,
      usage: common.beneficiary.route.usage === "test" ? "T" : "P",
      createdAt: new Date(0),
    },
    notice: {
      kind: "NOTR",
      controlNumber: notice.notrControlNumber,
      admissionDate: clinical.statementFromDate,
      terminationDate: clinical.terminationDate,
    },
    principalDiagnosis: clinical.principalDiagnosis,
    attendingPhysician: common.attendingPhysician,
    otherPhysician: common.certifyingPhysician,
  };
  return {
    ready: true,
    input,
    identity: renderIdentity({
      ...request,
      kind: "notr",
      providerEntityId: notice.providerEntityId,
      controlNumber: notice.notrControlNumber,
      noticeVersion: notice.version,
      clinical,
      route: common.beneficiary.route,
    }),
  };
}

async function loadTransferLike(
  deps: MedicareNoticeLoaderDeps,
  request: { organizationId: string; noticeId: string; submissionId: string },
  expected: "transfer" | "cancellation",
): Promise<MedicareTransferSourceFacts> {
  const [notice, attempt] = await Promise.all([
    deps.persistence.transferById(request.organizationId, request.noticeId),
    deps.persistence.submissionById(request.organizationId, request.submissionId),
  ]);
  if (!notice || notice.organizationId !== request.organizationId) hold("NOTICE_SOURCE_NOT_FOUND", "transferNotice");
  ensureReadyState(notice.state);
  attemptMatches(attempt, { ...request, providerEntityId: notice.providerEntityId, kind: "transfer_notice" });
  if ((expected === "cancellation") !== (notice.action === "void")) {
    hold("NOTICE_SOURCE_INVALID", "transferNotice.action");
  }
  if (!notice.electionPeriodId || !notice.admissionDate) {
    hold("NOTICE_FACTS_INCOMPLETE", "transferNotice.admission");
  }
  const electionPeriodId = notice.electionPeriodId;
  let superseded: Transfer | null = null;
  if (notice.action === "correction" || notice.action === "void") {
    if (!notice.supersedesNoticeId) hold("NOTICE_FACTS_INCOMPLETE", "transferNotice.supersedesNoticeId");
    superseded = await deps.persistence.transferById(request.organizationId, notice.supersedesNoticeId);
    if (
      !superseded ||
      superseded.organizationId !== notice.organizationId ||
      superseded.providerEntityId !== notice.providerEntityId ||
      superseded.patientId !== notice.patientId ||
      superseded.transferEventId !== notice.transferEventId ||
      superseded.action === "void"
    ) hold("NOTICE_SOURCE_INVALID", "transferNotice.superseded");
  }
  if (notice.action === "correction" && !notice.originalTransferDate) {
    hold("NOTICE_FACTS_INCOMPLETE", "transferNotice.originalTransferDate");
  }
  if (notice.action === "void") {
    if (!notice.cancelReason?.trim()) hold("NOTICE_FACTS_INCOMPLETE", "cancellation.reason");
    if (!superseded || !["submitted", "ack_pending", "ack_accepted"].includes(superseded.state)) {
      hold("NOTICE_SOURCE_INVALID", "cancellation.originalTransaction");
    }
    if (notice.admissionDate !== notice.statementFromDate) {
      hold("NOTICE_SOURCE_INVALID", "cancellation.admissionDate");
    }
  } else if (
    !notice.priorBillingConfirmedAt ||
    !notice.priorHospiceThroughDate ||
    !notice.priorHospicePatientStatus
  ) {
    hold("NOTICE_FACTS_INCOMPLETE", "transferNotice.priorBillingConfirmation");
  }
  const clinical = await clinicalFacts(() => deps.clinical.loadTransferOrCancellation({
    organizationId: request.organizationId,
    admissionId: notice.admissionId,
    electionPeriodId,
    transferEventId: notice.transferEventId,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    statementFromDate: notice.statementFromDate,
    action: notice.action,
  }));
  sameIdentity(notice, clinical);
  const common = await commonBuilderFacts(deps, {
    ...request,
    patientId: notice.patientId,
    providerEntityId: notice.providerEntityId,
    effectiveDate: notice.statementFromDate,
    transaction: expected,
    clinical,
  });
  if (notice.priorHospiceCcn && notice.priorHospiceCcn === common.providerCcn) {
    hold("NOTICE_SOURCE_INVALID", "transferNotice.priorHospiceCcn");
  }
  const occurrenceCodes = [
    ...(notice.action === "correction" && notice.originalTransferDate
      ? [{ code: "56", date: notice.originalTransferDate }]
      : []),
    ...(notice.benefitPeriodStartDate === notice.statementFromDate
      ? [{ code: "27", date: notice.statementFromDate }]
      : []),
  ];
  const input: TransferNotice837iInput = {
    ...common.parties,
    envelope: {
      senderId: common.parties.submitter.id,
      receiverId: common.parties.receiver.id,
      applicationReceiverCode: common.parties.receiver.applicationCode,
      interchangeControlNumber: 1,
      usage: common.beneficiary.route.usage === "test" ? "T" : "P",
      createdAt: new Date(0),
    },
    document: {
      controlNumber: notice.controlNumber,
      action: notice.action,
      tob: notice.tob,
      frequencyCode: notice.action === "void" ? "D" : "C",
      statementFromDate: notice.statementFromDate,
      admissionDate: notice.admissionDate,
      conditionCodes: notice.action === "correction" ? ["D0"] : [],
      occurrenceCodes,
    },
    principalDiagnosis: clinical.principalDiagnosis,
    attendingPhysician: common.attendingPhysician,
    otherPhysician: common.certifyingPhysician,
  };
  return {
    ready: true,
    input,
    identity: renderIdentity({
      ...request,
      kind: expected === "cancellation" ? "cancellation_notice" : "transfer_notice",
      providerEntityId: notice.providerEntityId,
      controlNumber: notice.controlNumber,
      noticeVersion: notice.version,
      clinical,
      route: common.beneficiary.route,
    }),
  };
}

export function createAuthoritativeMedicareNoticeSourceLoader(
  deps: MedicareNoticeLoaderDeps,
): MedicareNoticeSourceLoader {
  return {
    loadNoe: (request) => loadNoe(deps, request),
    loadNotr: (request) => loadNotr(deps, request),
    loadTransfer: (request) => loadTransferLike(deps, request, "transfer"),
    loadCancellation: (request) => loadTransferLike(deps, request, "cancellation"),
  };
}
