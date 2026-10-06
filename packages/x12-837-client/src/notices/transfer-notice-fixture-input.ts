// Synthetic, PHI-free inputs for the transfer-notice 837I golden tests (made-up names, a format-valid
// synthetic MBI, the NPI check-digit-valid sample NPIs CMS publishes in its NPI guidance).
import type { TransferNotice837iInput } from "./build-837i-transfer-notice";

export const ORIGINAL_8XC_INPUT: TransferNotice837iInput = {
  envelope: {
    senderId: "WARDENX01",
    receiverId: "NGSJ6",
    applicationReceiverCode: "NGSJ6",
    interchangeControlNumber: 42,
    usage: "T",
    createdAt: new Date("2026-01-12T15:30:00.000Z"),
  },
  submitter: {
    name: "Example Hospice of Oregon",
    id: "WARDENX01",
    contactName: "Billing Office",
    contactPhone: "5035550100",
  },
  receiver: { name: "NGS J6", id: "NGSJ6" },
  billingProvider: {
    organizationName: "Example Hospice of Oregon",
    npi: "1234567893",
    taxId: "931234567",
    address: { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201-1234" },
  },
  subscriber: {
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: "Q",
    mbi: "1EG4TE5MK73",
    address: { line1: "200 Oak Ave", city: "Salem", state: "OR", postalCode: "97301" },
    birthDate: "1940-03-15",
    sex: "F",
  },
  payer: { name: "Medicare Part A", payerId: "14211" },
  document: {
    controlNumber: "WX8C0001",
    action: "original",
    tob: "81C",
    frequencyCode: "C",
    statementFromDate: "2026-01-10",
    admissionDate: "2026-01-10",
    conditionCodes: [],
    occurrenceCodes: [{ code: "27", date: "2026-01-10" }],
  },
  principalDiagnosis: "C34.90",
  attendingPhysician: { lastName: "Smith", firstName: "Alan", npi: "1245319599" },
  otherPhysician: { lastName: "Jones", firstName: "Maria", npi: "1679576722" },
};
