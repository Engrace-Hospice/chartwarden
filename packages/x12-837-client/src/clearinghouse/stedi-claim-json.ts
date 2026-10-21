// @chartwarden/x12-837-client — maps the typed 837I claim input onto Stedi's JSON institutional-claims request
// (ADR-0053 D9). The same input builds the raw X12 (`build837iClaim`); this is the JSON route's twin, and
// `compareStediClaimJsonToX12` proves the two agree on charges, dates and codes before either is sent.
//
// JSON-route specifics (Stedi sandbox, 2026-10-09): occurrence/value/condition/other-diagnosis lists are arrays of
// arrays (one inner array per HI segment, at most 2 × 12) and `attending` is required. Whether Original Medicare
// accepts a JSON-route claim is unproven: the sandbox account cannot submit claims (ACCOUNT_NOT_PROVISIONED).
import {
  Claim837iBuildError,
  type Claim837iInput,
  type ClaimLine,
  build837iClaim,
  diagnosis,
  dollars,
} from "../claims/build-837i-claim";
import {
  NAME_LIMIT,
  ORG_NAME_LIMIT,
  addressSegments,
  d8,
  npi,
  optionalText,
  text,
} from "../x12/writer";

const MAX_PATIENT_CONTROL_NUMBER = 20; // Stedi's patientControlNumber limit (the raw CLM01 allows 38)
const HI_VALUES = 12;

export interface StediAddress {
  readonly address1: string;
  readonly address2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

type HiList<T> = readonly (readonly T[])[];

export interface StediClaimJson {
  readonly tradingPartnerServiceId: string;
  readonly usageIndicator: "P" | "T";
  readonly submitter: {
    readonly organizationName: string;
    readonly taxId: string;
    readonly contactInformation: { readonly name: string; readonly phoneNumber: string };
  };
  readonly receiver: { readonly organizationName: string };
  readonly billing: {
    readonly organizationName: string;
    readonly npi: string;
    readonly employerId: string;
    readonly address: StediAddress;
  };
  readonly attending: {
    readonly firstName: string;
    readonly lastName: string;
    readonly middleName?: string;
    readonly npi: string;
  };
  readonly subscriber: {
    readonly memberId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly middleName?: string;
    readonly gender: "M" | "F";
    readonly dateOfBirth: string;
    readonly paymentResponsibilityLevelCode: "P";
    readonly address: StediAddress;
  };
  readonly claimInformation: {
    readonly claimFilingCode: "MA";
    readonly claimChargeAmount: string;
    readonly claimFrequencyCode: string;
    readonly placeOfServiceCode: "81";
    readonly patientControlNumber: string;
    readonly benefitsAssignmentCertificationIndicator: "Y";
    readonly planParticipationCode: "A";
    readonly releaseInformationCode: "Y";
    readonly principalDiagnosis: {
      readonly principalDiagnosisCode: string;
      readonly qualifierCode: "ABK";
    };
    readonly otherDiagnosisInformationList?: HiList<{
      readonly otherDiagnosisCode: string;
      readonly qualifierCode: "ABF";
    }>;
    readonly claimCodeInformation: {
      readonly admissionTypeCode: string;
      readonly admissionSourceCode: string;
      readonly patientStatusCode: string;
    };
    readonly claimDateInformation: {
      readonly statementBeginDate: string;
      readonly statementEndDate: string;
      readonly admissionDateAndHour: string;
      readonly dischargeHour?: string;
    };
    readonly claimSupplementalInformation?: { readonly claimControlNumber: string };
    readonly occurrenceInformationList?: HiList<{
      readonly occurrenceSpanCode: string;
      readonly occurrenceSpanCodeDate: string;
    }>;
    /** HI*BI spans. Field names are UNVERIFIED against Stedi (modelled on the BH list); date is `CCYYMMDD-CCYYMMDD`. */
    readonly occurrenceSpanInformationList?: HiList<{
      readonly occurrenceSpanCode: string;
      readonly occurrenceSpanCodeDate: string;
    }>;
    readonly valueInformationList?: HiList<{
      readonly valueCode: string;
      readonly valueCodeAmount: string;
    }>;
    readonly conditionCodesList?: HiList<{ readonly conditionCode: string }>;
    readonly serviceLines: readonly {
      /** `CCYYMMDD`, or `CCYYMMDD-CCYYMMDD` for a from-through range (field shape UNVERIFIED against Stedi). */
      readonly serviceDate: string;
      readonly institutionalService: {
        readonly serviceLineRevenueCode: string;
        readonly procedureIdentifier: "HC";
        readonly procedureCode: string;
        readonly procedureModifiers?: readonly string[];
        readonly lineItemChargeAmount: string;
        readonly measurementUnit: "UN";
        readonly serviceUnitCount: string;
        /** SV207; omitted when zero. Field name UNVERIFIED against Stedi. */
        readonly nonCoveredChargeAmount?: string;
      };
    }[];
  };
}

/** One inner array per HI segment; undefined when empty (the field is then omitted — Stedi rejects flat lists). */
const hiList = <T>(items: readonly T[]): HiList<T> | undefined => {
  if (items.length === 0) return undefined;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += HI_VALUES) chunks.push(items.slice(i, i + HI_VALUES));
  return chunks;
};

const address = (a: Claim837iInput["billingProvider"]["address"], field: string): StediAddress => {
  const [n3, n4] = addressSegments(a, field);
  return {
    address1: n3?.[1] ?? "",
    ...(n3?.[2] ? { address2: n3[2] } : {}),
    city: n4?.[1] ?? "",
    state: n4?.[2] ?? "",
    postalCode: n4?.[3] ?? "",
  };
};

/** `CCYYMMDD`, or `CCYYMMDD-CCYYMMDD` when the line spans days (mirrors DTP*472 D8 / RD8). */
const serviceDate = (l: ClaimLine): string => {
  const start = d8(l.serviceDate, "claim.lines");
  const end = l.serviceThroughDate === undefined ? start : d8(l.serviceThroughDate, "claim.lines");
  return start === end ? start : `${start}-${end}`;
};

/** Decimal string with exactly two places ("38900" → "38900.00"); the input was validated by the raw builder. */
const money = (amount: string): string => {
  const [whole = "0", frac = ""] = amount.split(".");
  return `${Number(whole)}.${frac.padEnd(2, "0")}`;
};

/**
 * Map a claim onto Stedi's JSON request. Runs the raw builder first so the JSON route can never accept an input the
 * raw route refuses; throws {@link Claim837iBuildError} naming the field (never a value).
 */
export function buildStediClaimJson(input: Claim837iInput): StediClaimJson {
  build837iClaim(input);
  const c = input.claim;
  if (c.controlNumber.length > MAX_PATIENT_CONTROL_NUMBER) {
    throw new Claim837iBuildError("claim.controlNumber");
  }
  const s = input.subscriber;
  const attending = input.attendingPhysician;
  const totalCents = c.lines.reduce((sum, l) => sum + l.chargeCents, 0);
  const middle = optionalText(s.middleInitial, "subscriber.middleInitial", 1);
  const attendingMiddle = optionalText(
    attending.middleInitial,
    "attendingPhysician.middleInitial",
    1,
  );
  const otherDiagnoses = hiList(
    c.otherDiagnoses.map((d) => ({
      otherDiagnosisCode: diagnosis(d, "claim.otherDiagnoses"),
      qualifierCode: "ABF" as const,
    })),
  );
  const occurrences = hiList(
    c.occurrenceCodes.map((o) => ({
      occurrenceSpanCode: o.code,
      occurrenceSpanCodeDate: d8(o.date, "claim.occurrenceCodes"),
    })),
  );
  const spans = hiList(
    (c.occurrenceSpans ?? []).map((o) => ({
      occurrenceSpanCode: o.code,
      occurrenceSpanCodeDate: `${d8(o.fromDate, "claim.occurrenceSpans")}-${d8(o.throughDate, "claim.occurrenceSpans")}`,
    })),
  );
  const values = hiList(
    c.valueCodes.map((v) => ({ valueCode: v.code, valueCodeAmount: money(v.amount) })),
  );
  const conditions = hiList(c.conditionCodes.map((code) => ({ conditionCode: code })));
  const pccn = c.payerClaimControlNumber;
  return {
    tradingPartnerServiceId: text(input.payer.payerId, "payer.payerId", 80),
    usageIndicator: input.envelope.usage,
    submitter: {
      organizationName: text(input.submitter.name, "submitter.name", ORG_NAME_LIMIT),
      taxId: input.billingProvider.taxId,
      contactInformation: {
        name: text(input.submitter.contactName, "submitter.contactName", NAME_LIMIT),
        phoneNumber: input.submitter.contactPhone,
      },
    },
    receiver: { organizationName: text(input.receiver.name, "receiver.name", ORG_NAME_LIMIT) },
    billing: {
      organizationName: text(
        input.billingProvider.organizationName,
        "billingProvider.organizationName",
        ORG_NAME_LIMIT,
      ),
      npi: npi(input.billingProvider.npi, "billingProvider.npi"),
      employerId: input.billingProvider.taxId,
      address: address(input.billingProvider.address, "billingProvider.address"),
    },
    attending: {
      firstName: text(attending.firstName, "attendingPhysician.firstName", 35),
      lastName: text(attending.lastName, "attendingPhysician.lastName", NAME_LIMIT),
      ...(attendingMiddle ? { middleName: attendingMiddle } : {}),
      npi: npi(attending.npi, "attendingPhysician.npi"),
    },
    subscriber: {
      memberId: s.mbi.trim().toUpperCase(),
      firstName: text(s.firstName, "subscriber.firstName", 35),
      lastName: text(s.lastName, "subscriber.lastName", NAME_LIMIT),
      ...(middle ? { middleName: middle } : {}),
      gender: s.sex,
      dateOfBirth: d8(s.birthDate, "subscriber.birthDate"),
      paymentResponsibilityLevelCode: "P",
      address: address(s.address, "subscriber.address"),
    },
    claimInformation: {
      claimFilingCode: "MA",
      claimChargeAmount: dollars(totalCents),
      claimFrequencyCode: c.frequency,
      placeOfServiceCode: "81",
      patientControlNumber: c.controlNumber,
      benefitsAssignmentCertificationIndicator: "Y",
      planParticipationCode: "A",
      releaseInformationCode: "Y",
      principalDiagnosis: {
        principalDiagnosisCode: diagnosis(c.principalDiagnosis, "claim.principalDiagnosis"),
        qualifierCode: "ABK",
      },
      ...(otherDiagnoses ? { otherDiagnosisInformationList: otherDiagnoses } : {}),
      claimCodeInformation: {
        admissionTypeCode: c.admissionTypeCode,
        admissionSourceCode: c.admissionSource,
        patientStatusCode: c.patientStatus,
      },
      claimDateInformation: {
        statementBeginDate: d8(c.statementFromDate, "claim.statementFromDate"),
        statementEndDate: d8(c.statementThroughDate, "claim.statementThroughDate"),
        // UNVERIFIED against Stedi: the hour is appended to the date (CCYYMMDDHHMM); Stedi may expect a separate field.
        admissionDateAndHour: `${d8(c.admissionDate, "claim.admissionDate")}${c.admissionHour ?? ""}`,
        ...(c.dischargeHour === undefined ? {} : { dischargeHour: c.dischargeHour }),
      },
      ...(pccn === undefined || pccn === null
        ? {}
        : { claimSupplementalInformation: { claimControlNumber: pccn } }),
      ...(occurrences ? { occurrenceInformationList: occurrences } : {}),
      ...(spans ? { occurrenceSpanInformationList: spans } : {}),
      ...(values ? { valueInformationList: values } : {}),
      ...(conditions ? { conditionCodesList: conditions } : {}),
      serviceLines: c.lines.map((l) => ({
        serviceDate: serviceDate(l),
        institutionalService: {
          serviceLineRevenueCode: l.revenueCode,
          procedureIdentifier: "HC" as const,
          procedureCode: l.hcpcs,
          ...(l.modifiers && l.modifiers.length > 0
            ? { procedureModifiers: [...l.modifiers] }
            : {}),
          lineItemChargeAmount: dollars(l.chargeCents),
          measurementUnit: "UN" as const,
          serviceUnitCount: String(l.units),
          ...(l.noncoveredCents ? { nonCoveredChargeAmount: dollars(l.noncoveredCents) } : {}),
        },
      })),
    },
  };
}
