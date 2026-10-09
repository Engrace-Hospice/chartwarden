// apps/backend/src/modules/06-admission/render-payloads/build.ts - the typed render payloads M6 hands M22 for its
// CoP compliance documents (GAP-033). Each builder runs INSIDE the signing transaction, on the aggregate's own
// rows under RLS, so the document is a snapshot of what was signed - a CTI amended afterwards never changes the
// artifact already filed. Pure of request input: names, credentials and dates come from rows and the owning
// modules' seams, never from the request body.
//
// 42 CFR Part 2: ICD-10 F10-F19 (substance-related) codes are withheld from the rendering at this producer and
// only their COUNT travels; the chart row keeps the full code. Clinician-authored free text (the narrative) cannot
// be classified mechanically and is rendered as written - recorded as a residual in docs/history.
import { type DbClient, schema } from "@wardenx/db";
import {
  type CtiRenderPayload,
  type DischargeRenderPayload,
  type F2fRenderPayload,
  type NorRenderPayload,
  RENDER_PAYLOAD_VERSION,
  type RenderPatientIdentity,
  RenderPayloadError,
  type RevocationRenderPayload,
  type SignatureRecord,
  type TransferRenderPayload,
  assertCtiRenderPayload,
  assertDischargeRenderPayload,
  assertF2fRenderPayload,
  assertNorRenderPayload,
  assertRevocationRenderPayload,
  assertTransferRenderPayload,
  partitionPart2Diagnoses,
} from "@wardenx/types";
import { eq } from "drizzle-orm";
import { representativePrintedName } from "./representative";
import { RenderPayloadBuildError, type RenderSourcesPort } from "./sources";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const CTI = schema.certificationsOfTerminalIllness;
const F2F = schema.faceToFaceEncounters;
const NOR = schema.noticeOfRightsAcknowledgments;
const RE = schema.revocationEvents;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;
const USR = schema.users;

export interface RenderBuildCtx {
  readonly tx: DbClient;
  readonly organizationId: string;
  readonly sources: RenderSourcesPort;
  /** The hospice's legal name (the document letterhead); null when the admission names no provider entity. */
  readonly hospiceName: (providerEntityId: string | null) => Promise<string | null>;
}

const iso = (d: Date): string => d.toISOString();
const orNull = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v.trim() === "" ? null : v;

async function userName(ctx: RenderBuildCtx, userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await ctx.tx
    .select({ name: USR.name })
    .from(USR)
    .where(eq(USR.id, userId))
    .limit(1);
  return orNull(row?.name);
}

async function identity(
  ctx: RenderBuildCtx,
  artifact: string,
  patientId: string,
): Promise<RenderPatientIdentity> {
  const p = await ctx.sources.patient(ctx.organizationId, patientId);
  if (!p || p.name.trim() === "" || p.mrn.trim() === "") {
    // Patient identity is an integrity field of a legal document: never drawn blank.
    throw new RenderPayloadBuildError(artifact, "the patient's name / MRN did not resolve");
  }
  return { patientId, name: p.name, mrn: p.mrn, dateOfBirth: orNull(p.dateOfBirth) };
}

async function admissionFacts(ctx: RenderBuildCtx, artifact: string, admissionId: string) {
  const [adm] = await ctx.tx
    .select({ patientId: ADM.patientId, providerEntityId: ADM.providerEntityId })
    .from(ADM)
    .where(eq(ADM.id, admissionId))
    .limit(1);
  if (!adm) throw new RenderPayloadBuildError(artifact, "the admission row was not found");
  return { ...adm, hospiceName: await ctx.hospiceName(adm.providerEntityId ?? null) };
}

async function periodFacts(ctx: RenderBuildCtx, artifact: string, electionPeriodId: string) {
  const [ep] = await ctx.tx
    .select({ admissionId: EP.admissionId, sequence: EP.sequenceNumber })
    .from(EP)
    .where(eq(EP.id, electionPeriodId))
    .limit(1);
  if (!ep) throw new RenderPayloadBuildError(artifact, "the election period was not found");
  return { ...ep, ...(await admissionFacts(ctx, artifact, ep.admissionId)) };
}

const codes = (v: string | null): string[] =>
  (v ?? "")
    .split(/[\s,;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

// ── CTI ─────────────────────────────────────────────────────────────────────────────────────────────
export async function buildCtiRenderPayload(
  ctx: RenderBuildCtx,
  ctiId: string,
): Promise<CtiRenderPayload> {
  const [cti] = await ctx.tx.select().from(CTI).where(eq(CTI.id, ctiId)).limit(1);
  if (!cti) throw new RenderPayloadBuildError("cti", "the certification row was not found");
  if (!cti.hospiceMdSignedAt)
    throw new RenderPayloadBuildError("cti", "the hospice physician has not signed");
  const period = await periodFacts(ctx, "cti", cti.electionPeriodId);
  const [patient, hospiceMd] = await Promise.all([
    identity(ctx, "cti", period.patientId),
    ctx.sources.physician(ctx.organizationId, cti.hospiceMdId),
  ]);
  if (!hospiceMd) throw new RenderPayloadBuildError("cti", "the hospice physician did not resolve");
  const attending =
    cti.attendingMdId && cti.attendingMdSignedAt
      ? await ctx.sources.physician(ctx.organizationId, cti.attendingMdId)
      : null;
  if (cti.attendingMdId && cti.attendingMdSignedAt && !attending) {
    throw new RenderPayloadBuildError("cti", "the attending physician did not resolve");
  }
  const sign = (
    who: { name: string; credentials: string | null; npi: string | null },
    role: string,
    at: Date,
  ): SignatureRecord => ({
    role,
    printedName: who.name,
    credentials: who.credentials,
    npi: who.npi,
    capacity: null,
    signedAt: iso(at),
    method: "electronic",
    meaning: "certification",
    recordId: cti.id,
  });
  const terminal = partitionPart2Diagnoses(codes(cti.terminalDiagnosisIcd10));
  const related = partitionPart2Diagnoses(cti.relatedConditionsIcd10);
  return assertCtiRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    ctiId: cti.id,
    electionPeriodId: cti.electionPeriodId,
    patient,
    hospiceName: period.hospiceName,
    benefitPeriodSequence: period.sequence,
    isRecertification: period.sequence >= 2,
    periodStart: cti.periodStart,
    periodEnd: cti.periodEnd,
    terminalDiagnoses: terminal.shown,
    relatedConditions: related.shown,
    part2WithheldCount: terminal.withheldCount,
    relatedPart2WithheldCount: related.withheldCount,
    narrative: cti.narrative ?? "",
    signedLate: cti.signedLate,
    lateReason: orNull(cti.lateReason),
    hospiceMdSignature: sign(hospiceMd, "Hospice physician", cti.hospiceMdSignedAt),
    attendingSignature:
      attending && cti.attendingMdSignedAt
        ? sign(attending, "Attending physician", cti.attendingMdSignedAt)
        : null,
  });
}

// ── Face-to-face ────────────────────────────────────────────────────────────────────────────────────
export async function buildF2fRenderPayload(
  ctx: RenderBuildCtx,
  f2fId: string,
): Promise<F2fRenderPayload> {
  const [f2f] = await ctx.tx.select().from(F2F).where(eq(F2F.id, f2fId)).limit(1);
  if (!f2f) throw new RenderPayloadBuildError("f2f", "the face-to-face row was not found");
  if (!f2f.attestationSignedAt)
    throw new RenderPayloadBuildError("f2f", "the encounter is not attested");
  const period = await periodFacts(ctx, "f2f", f2f.electionPeriodId);
  const [patient, performerName] = await Promise.all([
    identity(ctx, "f2f", period.patientId),
    userName(ctx, f2f.performedByUserId),
  ]);
  if (!performerName)
    throw new RenderPayloadBuildError("f2f", "the performing clinician did not resolve");
  const tele = f2f.telehealthEligibility;
  return assertF2fRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    f2fId: f2f.id,
    electionPeriodId: f2f.electionPeriodId,
    patient,
    hospiceName: period.hospiceName,
    encounterDate: f2f.encounterDate,
    encounterLocation: f2f.encounterLocation,
    performerRole: f2f.performerRole,
    withinWindow: f2f.withinWindow,
    windowOverride: f2f.windowOverride,
    windowOverrideReason: orNull(f2f.windowOverrideReason),
    telehealthEligibility: tele
      ? {
          patientInMoratoriumArea: tele.patientInMoratoriumArea,
          hospiceUnderEnhancedOversight: tele.hospiceUnderEnhancedOversight,
          performerMedicareEnrolledOrOptedOut: tele.performerMedicareEnrolledOrOptedOut,
        }
      : null,
    attestationNarrative: orNull(f2f.attestationNarrative),
    linkedNoteEncounterId: orNull(f2f.encounterId),
    attestation: {
      role: "Clinician who performed the face-to-face encounter",
      printedName: performerName,
      credentials: null,
      npi: null,
      capacity: null,
      signedAt: iso(f2f.attestationSignedAt),
      method: "electronic",
      meaning: "attestation",
      recordId: f2f.id,
    },
  });
}

/**
 * Who the printed name on an acknowledgment / revocation is. A patient signs as themself; a representative's name
 * comes from the M39 consent that authorised them. The row carries no name, so when it does not resolve the build
 * THROWS: attributing a legal document to the patient when someone else signed is worse than no document.
 */
async function signerPrintedName(
  ctx: RenderBuildCtx,
  artifact: string,
  signer: {
    readonly kind: string;
    readonly representativeConsentId: string | null;
    readonly patient: RenderPatientIdentity;
  },
): Promise<string> {
  if (signer.kind !== "representative") return signer.patient.name;
  const name = signer.representativeConsentId
    ? await representativePrintedName(
        ctx.tx,
        ctx.sources,
        ctx.organizationId,
        signer.patient.patientId,
        signer.representativeConsentId,
      )
    : null;
  if (!name)
    throw new RenderPayloadBuildError(artifact, "the representative signer did not resolve");
  return name;
}

// ── Notice of rights acknowledgment ─────────────────────────────────────────────────────────────────
export async function buildNorRenderPayload(
  ctx: RenderBuildCtx,
  norId: string,
): Promise<NorRenderPayload> {
  const [nor] = await ctx.tx.select().from(NOR).where(eq(NOR.id, norId)).limit(1);
  if (!nor) throw new RenderPayloadBuildError("nor", "the acknowledgment row was not found");
  const [patient, adm, witnessName] = await Promise.all([
    identity(ctx, "nor", nor.patientId),
    admissionFacts(ctx, "nor", nor.admissionId),
    userName(ctx, nor.witnessUserId),
  ]);
  const signerName = await signerPrintedName(ctx, "nor", {
    kind: nor.signerKind,
    representativeConsentId: nor.representativeConsentId,
    patient,
  });
  return assertNorRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    norAcknowledgmentId: nor.id,
    admissionId: nor.admissionId,
    patient,
    hospiceName: adm.hospiceName,
    signerKind: nor.signerKind,
    acknowledgedDate: nor.acknowledgedAt,
    acknowledgmentMethod: nor.acknowledgmentMethod,
    acknowledgment: {
      role: "Acknowledgment of the notice of patient rights",
      printedName: signerName,
      credentials: null,
      npi: null,
      capacity:
        nor.signerKind === "representative" ? "Authorized representative of the patient" : null,
      signedAt: nor.acknowledgedAt,
      method: nor.acknowledgmentMethod === "wet_ink_scanned" ? "wet_ink_scanned" : "electronic",
      meaning: "acknowledgment",
      recordId: nor.id,
    },
    witness: witnessName
      ? {
          role: "Witness",
          printedName: witnessName,
          credentials: null,
          npi: null,
          capacity: null,
          // The row records the acknowledgment date only; the witness's own time is not captured, so none is printed.
          method: "electronic",
          meaning: "witness",
          recordId: nor.id,
        }
      : null,
  });
}

// ── Revocation ──────────────────────────────────────────────────────────────────────────────────────
export async function buildRevocationRenderPayload(
  ctx: RenderBuildCtx,
  revocationId: string,
): Promise<RevocationRenderPayload> {
  const [rev] = await ctx.tx.select().from(RE).where(eq(RE.id, revocationId)).limit(1);
  if (!rev) throw new RenderPayloadBuildError("revocation", "the revocation row was not found");
  const adm = await admissionFacts(ctx, "revocation", rev.admissionId);
  const patient = await identity(ctx, "revocation", adm.patientId);
  const signerName = await signerPrintedName(ctx, "revocation", {
    kind: rev.signerKind,
    representativeConsentId: rev.representativeConsentId,
    patient,
  });
  return assertRevocationRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    revocationEventId: rev.id,
    admissionId: rev.admissionId,
    electionPeriodId: rev.electionPeriodId,
    patient,
    hospiceName: adm.hospiceName,
    signerKind: rev.signerKind,
    effectiveDate: rev.effectiveAt,
    signedDate: rev.signedAt,
    reason: rev.revocationReason,
    narrative: orNull(rev.narrative),
    revocation: {
      role: "Revocation of the hospice election",
      printedName: signerName,
      credentials: null,
      npi: null,
      capacity:
        rev.signerKind === "representative" ? "Authorized representative of the patient" : null,
      signedAt: rev.signedAt,
      method: "electronic",
      meaning: "revocation",
      recordId: rev.id,
    },
  });
}

// ── Discharge summary ───────────────────────────────────────────────────────────────────────────────
const CAPACITY_LABEL: Readonly<Record<string, string>> = {
  medical_director: "Hospice medical director",
  physician_designee: "Physician designee of the medical director",
  idg_physician_member: "Physician member of the interdisciplinary group",
};

export async function buildDischargeRenderPayload(
  ctx: RenderBuildCtx,
  dischargeEventId: string,
): Promise<DischargeRenderPayload> {
  const [de] = await ctx.tx.select().from(DE).where(eq(DE.id, dischargeEventId)).limit(1);
  if (!de)
    throw new RenderPayloadBuildError("discharge_summary", "the discharge row was not found");
  const adm = await admissionFacts(ctx, "discharge_summary", de.admissionId);
  const [patient, filerName, orderSignerName, cosignerUserName] = await Promise.all([
    identity(ctx, "discharge_summary", adm.patientId),
    userName(ctx, de.filedByUserId),
    userName(ctx, de.dischargeOrderSignedByUserId),
    userName(ctx, de.medicalDirectorMembershipId),
  ]);
  const capacity = de.dischargeOrderSignerCapacity
    ? (CAPACITY_LABEL[de.dischargeOrderSignerCapacity] ?? de.dischargeOrderSignerCapacity)
    : null;
  const cosignerName = orNull(de.cosignerName) ?? cosignerUserName;
  return assertDischargeRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    dischargeEventId: de.id,
    admissionId: de.admissionId,
    patient,
    hospiceName: adm.hospiceName,
    dischargeType: de.dischargeType,
    status: de.status,
    effectiveDate: de.effectiveAt,
    narrative: orNull(de.narrative),
    forCauseReason: orNull(de.forCauseReason),
    dischargeOrder:
      de.dischargeOrderSignedAt && orderSignerName
        ? {
            text: orNull(de.dischargeOrderText),
            reference: orNull(de.dischargeOrderReference),
            signature: {
              role: "Physician discharge order",
              printedName: orderSignerName,
              credentials: null,
              npi: null,
              capacity,
              signedAt: iso(de.dischargeOrderSignedAt),
              method: "electronic",
              meaning: "discharge_order",
              recordId: de.id,
            },
          }
        : null,
    filedBy: filerName
      ? {
          role: "Discharge filed by",
          printedName: filerName,
          credentials: null,
          npi: null,
          capacity: null,
          signedAt: iso(de.createdAt),
          method: "electronic",
          meaning: "authorship",
          recordId: de.id,
        }
      : null,
    cosign: {
      required: de.cosignRequired,
      completed: de.cosignedAt !== null,
      signature:
        de.cosignedAt && cosignerName
          ? {
              role: "Medical-director cosign",
              printedName: cosignerName,
              credentials: null,
              npi: orNull(de.cosignerNpi),
              capacity,
              signedAt: iso(de.cosignedAt),
              method: "electronic",
              meaning: "cosignature",
              recordId: de.id,
            }
          : null,
    },
  });
}

// ── Transfer summary ────────────────────────────────────────────────────────────────────────────────
export async function buildTransferRenderPayload(
  ctx: RenderBuildCtx,
  transferEventId: string,
): Promise<TransferRenderPayload> {
  const [te] = await ctx.tx.select().from(TE).where(eq(TE.id, transferEventId)).limit(1);
  if (!te) throw new RenderPayloadBuildError("transfer", "the transfer row was not found");
  const adm = await admissionFacts(ctx, "transfer", te.admissionId);
  const patient = await identity(ctx, "transfer", adm.patientId);
  return assertTransferRenderPayload({
    schemaVersion: RENDER_PAYLOAD_VERSION,
    transferEventId: te.id,
    admissionId: te.admissionId,
    patient,
    hospiceName: adm.hospiceName,
    direction: te.direction,
    effectiveDate: te.effectiveAt,
    otherHospiceName: orNull(te.receivingOrSendingName),
    otherHospiceCcn: orNull(te.receivingOrSendingCcn),
    receivingCareSetting: orNull(te.receivingCareSetting),
    benefitPeriodSequence: te.periodSequenceAtTransfer,
    narrative: orNull(te.narrative),
  });
}

/**
 * Build a payload, or - when a SOURCE did not resolve - report it (ids only, never PHI) and return `undefined` so
 * the event is published without `renderPayload`. M22 refuses an id-only event (retry -> DLQ), which is the loud,
 * recoverable outcome; a SQL error is NOT caught here (it would leave the transaction aborted anyway).
 */
export async function buildOrOmit<T>(
  log: (event: string, detail: Record<string, unknown>) => void,
  detail: Record<string, unknown>,
  build: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await build();
  } catch (err) {
    if (err instanceof RenderPayloadBuildError) {
      log("m6.render_payload_unavailable", { ...detail, artifact: err.artifact, why: err.why });
      return undefined;
    }
    if (err instanceof RenderPayloadError) {
      // The row built but failed the typed schema (e.g. an empty narrative): report which paths, never values.
      log("m6.render_payload_invalid", {
        ...detail,
        artifact: err.templateKey,
        violations: err.violations.map((v) => v.split(":")[0]),
      });
      return undefined;
    }
    throw err;
  }
}
