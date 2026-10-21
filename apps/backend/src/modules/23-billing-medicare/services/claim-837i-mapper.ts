// M23 — PURE mapping of the detailed claim document (+ the transient beneficiary identity and the party records)
// onto the x12-837-client builders' `Claim837iInput`, and onward to the raw 837I and Stedi's JSON.
//
// The beneficiary identity (MBI, name, DOB, sex, address) is a PARAMETER of the render step: it is never part of the
// stored document, is never logged here, and the builders' errors name a FIELD only (never a value). Nothing is
// invented — the one thing this file adds to the document is arithmetic and renaming.
import type { ClaimDocument837iDetail, ClaimGap, GapResult } from "@chartwarden/billing";
import { gap } from "@chartwarden/billing";
import {
  type Claim837iInput,
  type StediClaimJson,
  type X12Address,
  X12BuildError,
  build837iClaim,
  buildStediClaimJson,
} from "@chartwarden/x12-837-client";

/** The 1000A/1000B/2010AA/2010BB party records the loader reads through its parties port. */
export interface Claim837iParties {
  readonly submitter: Claim837iInput["submitter"];
  readonly receiver: Claim837iInput["receiver"] & {
    /** GS03 — the receiver's application code. */
    readonly applicationCode: string;
  };
  readonly billingProvider: Claim837iInput["billingProvider"];
  readonly payer: Claim837iInput["payer"];
}

/** The beneficiary, in memory for ONE build. NEVER persist, log or serialise it. */
export interface TransientSubscriber {
  readonly mbi: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly dateOfBirth: string;
  readonly sex: "M" | "F";
  readonly address: X12Address;
}

export interface Claim837iEnvelopeInput {
  /** 1..999 999 999 (the transport owns uniqueness; see the submit worker's `deriveControlNumber`). */
  readonly interchangeControlNumber: number;
  readonly usage: "P" | "T";
  readonly createdAt: Date;
}

export interface MapClaimTo837iArgs {
  readonly document: ClaimDocument837iDetail;
  readonly subscriber: TransientSubscriber;
  readonly parties: Claim837iParties;
  readonly envelope: Claim837iEnvelopeInput;
}

/** The ABK diagnosis is the principal; every ABF follows in sequence order. */
function diagnosesOf(
  document: ClaimDocument837iDetail,
): { principal: string; others: string[] } | null {
  const principal = document.diagnoses.find((d) => d.qualifier === "ABK");
  if (!principal) return null;
  return {
    principal: principal.icd10Code,
    others: document.diagnoses.filter((d) => d.qualifier === "ABF").map((d) => d.icd10Code),
  };
}

/** Pure field renaming — no validation (the builders own that); a document without a principal is a gap. */
export function mapClaimTo837iInput(args: MapClaimTo837iArgs): GapResult<Claim837iInput> {
  const { document: d, subscriber: s, parties: p, envelope: e } = args;
  const dx = diagnosesOf(d);
  if (dx === null) return { ok: false, gaps: [gap("diagnoses.principal", "missing")] };
  if (d.admissionTypeCode == null)
    return { ok: false, gaps: [gap("admissionTypeCode", "missing")] };
  if (d.admissionSourceCode == null) {
    return { ok: false, gaps: [gap("admissionSourceCode", "missing")] };
  }
  const input: Claim837iInput = {
    envelope: {
      senderId: p.submitter.id,
      receiverId: p.receiver.id,
      applicationReceiverCode: p.receiver.applicationCode,
      interchangeControlNumber: e.interchangeControlNumber,
      usage: e.usage,
      createdAt: e.createdAt,
    },
    submitter: p.submitter,
    receiver: { name: p.receiver.name, id: p.receiver.id },
    billingProvider: p.billingProvider,
    subscriber: {
      lastName: s.lastName,
      firstName: s.firstName,
      mbi: s.mbi,
      address: s.address,
      birthDate: s.dateOfBirth,
      sex: s.sex,
    },
    payer: p.payer,
    attendingPhysician: {
      lastName: d.attendingPhysician.lastName,
      firstName: d.attendingPhysician.firstName,
      npi: d.attendingPhysician.npi,
    },
    claim: {
      controlNumber: d.claimControlNumber,
      frequency: d.frequency,
      statementFromDate: d.serviceFrom,
      statementThroughDate: d.serviceTo,
      admissionDate: d.admissionDate,
      admissionTypeCode: d.admissionTypeCode,
      admissionSource: d.admissionSourceCode,
      patientStatus: d.dischargeCodes.patientStatus,
      ...(d.payerClaimControlNumber === null
        ? {}
        : { payerClaimControlNumber: d.payerClaimControlNumber }),
      principalDiagnosis: dx.principal,
      otherDiagnoses: dx.others,
      conditionCodes: d.dischargeCodes.conditionCodes,
      occurrenceCodes: d.dischargeCodes.occurrenceCodes,
      occurrenceSpans: d.occurrenceSpans.map((o) => ({
        code: o.code,
        fromDate: o.from,
        throughDate: o.through,
      })),
      nonCoveredChargeCents: d.nonCoveredChargeCents,
      valueCodes: (d.valueCodes ?? []).map((v) => ({ code: v.code, amount: v.cbsaCode })),
      lines: d.lines.map((l) => ({
        revenueCode: l.revenueCode,
        hcpcs: l.hcpcs,
        ...(l.modifiers.length > 0 ? { modifiers: l.modifiers } : {}),
        chargeCents: l.chargeCents,
        units: l.units,
        serviceDate: l.serviceDateFrom,
        ...(l.serviceDateTo === l.serviceDateFrom ? {} : { serviceThroughDate: l.serviceDateTo }),
        ...(l.noncoveredCents > 0 ? { noncoveredCents: l.noncoveredCents } : {}),
      })),
    },
  };
  return { ok: true, value: input };
}

export interface Rendered837i {
  /** The raw 005010X223A2 interchange. Contains the MBI — transmit it, never store or log it. */
  readonly x12: string;
  /** Stedi's JSON institutional-claims request for the same claim. Contains the MBI likewise. */
  readonly stediJson: StediClaimJson;
}

/**
 * Run both builders; a builder REFUSAL (any `X12BuildError`) becomes a gap naming the builder's field (never a value). Any other error is
 * a bug, not an input gap, and is rethrown (its message is never composed from field values).
 */
export function render837i(input: Claim837iInput): GapResult<Rendered837i> {
  try {
    const x12 = build837iClaim(input);
    return { ok: true, value: { x12, stediJson: buildStediClaimJson(input) } };
  } catch (err) {
    // The base class: Claim837iBuildError AND the shared X12 writer's refusals (e.g. the Stedi-JSON-only checks).
    if (!(err instanceof X12BuildError)) throw err;
    const gaps: readonly ClaimGap[] = [gap(err.field, "invalid")];
    return { ok: false, gaps };
  }
}
