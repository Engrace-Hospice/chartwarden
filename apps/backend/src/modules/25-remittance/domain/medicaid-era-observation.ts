import type { ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";
import { projectEraFinancialReview } from "./era-financial-review";
import { decimalDollarsToCents } from "./era-match-review";

/** Offline M24 observation. Raw values are transient X12 facts; this model is never persisted or logged. */
export interface MedicaidEraObservation {
  readonly source: {
    /** Parser invocation context, not an identity attested inside the X12 file. */
    readonly parserPayerProgramContext: ParsedRemittanceAdvice["payerProgram"];
    readonly interchangeControlNumber: string;
    readonly functionalGroupControlNumber: string | null;
    readonly transactionSetControlNumber: string;
    readonly senderCode: string | null;
    readonly receiverCode: string | null;
    readonly traceNumber: string | null;
    readonly paymentDate: string | null;
    readonly paymentMethod: ParsedRemittanceAdvice["paymentMethod"];
    readonly paymentCents: number | null;
    readonly payer: { readonly name: string | null; readonly identifier: string | null };
    readonly payee: { readonly name: string | null; readonly identifier: string | null };
  };
  readonly claims: readonly {
    readonly patientControlNumber: string | null;
    readonly payerClaimControlNumber: string | null;
    readonly statusCode: number;
    readonly serviceFrom: string | null;
    readonly serviceTo: string | null;
    readonly chargeCents: number | null;
    readonly paidCents: number | null;
    readonly patientResponsibilityCents: number | null;
    readonly adjustments: readonly {
      readonly groupCode: string;
      readonly reasonCode: string;
      readonly amountCents: number | null;
      readonly quantity: number | null;
    }[];
    readonly remarks: readonly { readonly kind: string; readonly code: string }[];
    readonly serviceLines: readonly {
      readonly serviceIdQualifier: string | null;
      readonly procedureCode: string | null;
      readonly submittedProcedureCode: string | null;
      readonly revenueCode: string | null;
      readonly modifiers: readonly string[];
      readonly chargeCents: number | null;
      readonly paidCents: number | null;
      readonly submittedUnits: number | null;
      readonly paidUnits: number | null;
      readonly adjustments: readonly {
        readonly groupCode: string;
        readonly reasonCode: string;
        readonly amountCents: number | null;
        readonly quantity: number | null;
      }[];
      readonly remarks: readonly { readonly kind: string; readonly code: string }[];
      readonly references: readonly { readonly qualifier: string; readonly value: string }[];
    }[];
  }[];
  readonly providerAdjustments: readonly {
    readonly reason: string;
    readonly reference: string | null;
    readonly amountCents: number | null;
  }[];
  readonly financialReview: ReturnType<typeof projectEraFinancialReview>;
  readonly attribution: "unverified";
  readonly postingAuthorized: false;
}

const cents = (amount: number | null | undefined): number | null =>
  amount === null || amount === undefined ? null : decimalDollarsToCents(amount);

/**
 * Adapt the shared M25 parser output into a transient Medicaid financial observation.
 * This deliberately does not establish tenant, provider, account, payer or submission trust.
 */
export function observeParsedMedicaidEra(parsed: ParsedRemittanceAdvice): MedicaidEraObservation {
  const projectAdjustments = (
    adjustments: ParsedRemittanceAdvice["claims"][number]["adjustments"],
  ) =>
    adjustments.map((adjustment) => ({
      groupCode: adjustment.groupCode,
      reasonCode: adjustment.reasonCode,
      amountCents: cents(adjustment.amount),
      quantity: adjustment.quantity ?? null,
    }));
  const claims = parsed.claims.map((claim) => ({
    patientControlNumber: claim.patientControlNumber ?? null,
    payerClaimControlNumber: claim.payerIcn ?? null,
    statusCode: claim.statusCode,
    serviceFrom: claim.serviceFrom ?? null,
    serviceTo: claim.serviceTo ?? null,
    chargeCents: cents(claim.totalCharge),
    paidCents: cents(claim.totalPayment),
    patientResponsibilityCents: cents(claim.patientResponsibility),
    adjustments: projectAdjustments(claim.adjustments),
    remarks: claim.remarks.map(({ kind, code }) => ({ kind, code })),
    serviceLines: claim.serviceLines.map((line) => ({
      serviceIdQualifier: line.serviceIdQualifier ?? null,
      procedureCode: line.procedureCode ?? null,
      submittedProcedureCode: line.submittedProcedureCode ?? null,
      revenueCode: line.revenueCode ?? null,
      modifiers: line.modifiers ?? [],
      chargeCents: cents(line.chargeAmount),
      paidCents: cents(line.paidAmount),
      submittedUnits: line.submittedUnits ?? null,
      paidUnits: line.paidUnits ?? null,
      adjustments: projectAdjustments(line.adjustments),
      remarks: line.remarks.map(({ kind, code }) => ({ kind, code })),
      references: (line.references ?? []).map(({ qualifier, value }) => ({ qualifier, value })),
    })),
  }));
  const providerAdjustments = (parsed.providerAdjustments ?? []).map((adjustment) => ({
    reason: adjustment.reason,
    reference: adjustment.reference ?? null,
    amountCents: cents(adjustment.amount),
  }));
  const financialReview = projectEraFinancialReview({
    stageState: "held",
    duplicateClassification: "none",
    reportedPayment: parsed.totalPaymentAmount,
    claims: parsed.claims.map((claim) => ({
      statusCode: claim.statusCode,
      totalCharge: claim.totalCharge,
      totalPayment: claim.totalPayment,
      patientResponsibility: claim.patientResponsibility,
      adjustments: claim.adjustments.map((adjustment) => ({
        groupCode: adjustment.groupCode,
        reasonCode: adjustment.reasonCode,
        amount: adjustment.amount,
      })),
      serviceLines: claim.serviceLines.map((line) => ({
        chargeAmount: line.chargeAmount,
        paidAmount: line.paidAmount,
        payerLineReference:
          line.references?.find((reference) => reference.qualifier === "6R")?.value ?? null,
        adjustments: line.adjustments.map((adjustment) => ({
          groupCode: adjustment.groupCode,
          reasonCode: adjustment.reasonCode,
          amount: adjustment.amount,
        })),
      })),
    })),
    providerAdjustments: (parsed.providerAdjustments ?? []).map((adjustment) => ({
      reason: adjustment.reason,
      reference: adjustment.reference ?? null,
      amount: adjustment.amount,
    })),
    identityOutcomes: parsed.claims.map(() => "unmatched"),
  });
  return {
    source: {
      parserPayerProgramContext: parsed.payerProgram,
      interchangeControlNumber: parsed.interchangeControlNumber,
      functionalGroupControlNumber: parsed.functionalGroupControlNumber ?? null,
      transactionSetControlNumber: parsed.transactionSetControlNumber,
      senderCode: parsed.interchangeSenderCode ?? null,
      receiverCode: parsed.interchangeReceiverCode ?? null,
      traceNumber: parsed.checkOrEftTraceNumber ?? null,
      paymentDate: parsed.paymentEffectiveDate ?? null,
      paymentMethod: parsed.paymentMethod,
      paymentCents: cents(parsed.totalPaymentAmount),
      payer: { name: parsed.payer?.name ?? null, identifier: parsed.payer?.id ?? null },
      payee: { name: parsed.payee?.name ?? null, identifier: parsed.payee?.id ?? null },
    },
    claims,
    providerAdjustments,
    financialReview,
    attribution: "unverified",
    postingAuthorized: false,
  };
}
