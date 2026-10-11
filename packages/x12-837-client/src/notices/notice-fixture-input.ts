// Synthetic, PHI-free inputs that reproduce the Stedi-sandbox-validated NOE (81A) and NOTR (81B) payloads
// (made-up names, a format-valid synthetic MBI, CMS's published sample NPIs).
import type { Notice837iInput } from "./build-837i-notice";

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
  principalDiagnosis: "C34.90",
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

export const NOE_INPUT: Notice837iInput = {
  ...COMMON,
  envelope: envelope(106),
  notice: { kind: "NOE", controlNumber: "WXNOE0001", admissionDate: "2026-01-01" },
};

export const NOTR_INPUT: Notice837iInput = {
  ...COMMON,
  envelope: envelope(201),
  notice: {
    kind: "NOTR",
    controlNumber: "WXNOTR0001",
    admissionDate: "2026-01-01",
    terminationDate: "2026-01-31",
  },
};
