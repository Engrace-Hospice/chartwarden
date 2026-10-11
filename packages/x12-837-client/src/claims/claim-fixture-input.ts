// Synthetic, PHI-free inputs that reproduce the Stedi-sandbox-validated claim (freq 3), replacement (freq 7)
// and void (freq 8) payloads.
import type { Claim837iInput } from "./build-837i-claim";

const COMMON = {
  submitter: {
    name: "Example Hospice of Oregon",
    id: "WARDENX01",
    contactName: "Billing Office",
    contactPhone: "5035550100",
  },
  receiver: { name: "Stedi Test Payer", id: "STEDI" },
  billingProvider: {
    organizationName: "Example Hospice of Oregon",
    npi: "1234567893",
    taxId: "931234567",
    address: { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201-1234" },
  },
  subscriber: {
    lastName: "Doe",
    firstName: "Jane",
    mbi: "1EG4TE5MK73",
    address: { line1: "200 Oak Ave", city: "Salem", state: "OR", postalCode: "97301" },
    birthDate: "1940-03-15",
    sex: "F",
  },
  payer: { name: "Stedi Test Payer", payerId: "STEDI" },
  attendingPhysician: { lastName: "Smith", firstName: "Alan", npi: "1245319599" },
} as const;

const envelope = (interchangeControlNumber: number) => ({
  senderId: "WARDENX01",
  receiverId: "STEDI",
  applicationReceiverCode: "STEDI",
  interchangeControlNumber,
  usage: "T" as const,
  createdAt: new Date("2026-10-09T15:00:00.000Z"),
});

const CLAIM = {
  controlNumber: "WXHOSP0001",
  frequency: "3",
  statementFromDate: "2026-01-01",
  statementThroughDate: "2026-01-31",
  admissionDate: "2026-01-01",
  admissionSource: "1",
  patientStatus: "30",
  principalDiagnosis: "C34.90",
  otherDiagnoses: [],
  conditionCodes: [],
  occurrenceCodes: [{ code: "27", date: "2026-01-01" }],
  valueCodes: [
    { code: "61", amount: "38900" },
    { code: "G8", amount: "38900" },
  ],
  lines: [
    {
      revenueCode: "0651",
      hcpcs: "Q5001",
      chargeCents: 20000,
      units: 1,
      serviceDate: "2026-01-01",
    },
    {
      revenueCode: "0652",
      hcpcs: "Q5001",
      chargeCents: 80000,
      units: 32,
      serviceDate: "2026-01-02",
    },
    {
      revenueCode: "0655",
      hcpcs: "Q5006",
      chargeCents: 50000,
      units: 1,
      serviceDate: "2026-01-10",
    },
  ],
} as const;

export const CLAIM_INPUT: Claim837iInput = {
  ...COMMON,
  envelope: envelope(101),
  claim: CLAIM,
};

export const REPLACEMENT_INPUT: Claim837iInput = {
  ...COMMON,
  envelope: envelope(301),
  claim: { ...CLAIM, frequency: "7", payerClaimControlNumber: "12345678901234" },
};

export const VOID_INPUT: Claim837iInput = {
  ...COMMON,
  envelope: envelope(302),
  claim: { ...CLAIM, frequency: "8", payerClaimControlNumber: "12345678901234" },
};
