// apps/backend/src/modules/05-patient/admit-matching-db.ts — GAP-010: what `admit` feeds the §2.3 matcher
// and what it persists of the demographics it was handed.
//
// `admit` used to build every MatchCandidate from name + DOB + MBI alone, so the probabilistic score
// topped out at 0.25 + 0.15 + 0.20 = 0.60 — below the 0.75 soft-review floor — and the deterministic
// DOB+name+address rule could not fire (no candidate address). Only an exact MBI ever blocked, and
// `matchReviewIds` was always empty. It also accepted ssn / address / phone / email and threw them away.
//
// Now: each candidate carries its CURRENT PRIMARY address, phone (last 7) and email, so the §2.3
// thresholds are reachable; and the admitted address / phone / email are persisted as the patient's
// primary rows (and are what the NEXT admit is matched against). SSN is the one field that cannot be
// stored yet — the envelope-encrypted `patient_identifier` write path (KEK/DEK) does not exist — so it
// is refused with a 422 rather than accepted and silently discarded.
import { type DbClient, schema } from "@wardenx/db";
import { ValidationError } from "@wardenx/types";
import { and, eq, isNull } from "drizzle-orm";
import type { MatchCandidate } from "./matching/matcher";
import { normEmail, normIdentifier, normName, phoneLast7 } from "./matching/normalize";
import type { AdmitInput } from "./routes/service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const P = schema.patients;
const ID = schema.patientIdentifiers;
const ADDR = schema.patientAddresses;
const PHONE = schema.patientPhones;
const EMAIL = schema.patientEmails;

const US_NANP_LENGTH = 10;
const US_NANP_WITH_COUNTRY_LENGTH = 11;
const E164_MAX_DIGITS = 15;
const E164_MIN_DIGITS = 8;

export interface CandidatePatientRow {
  readonly id: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly dob: string;
  readonly mbi: string | null;
}
export interface CandidateAddressRow {
  readonly patientId: string;
  readonly line1: string;
  readonly city: string;
  readonly postalCode: string;
}
export interface CandidatePhoneRow {
  readonly patientId: string;
  readonly e164: string;
}
export interface CandidateEmailRow {
  readonly patientId: string;
  readonly email: string;
}

/** Fold the patient rows and their primary contact rows into the matcher's comparable candidates. */
export function buildMatchCandidates(
  patients: readonly CandidatePatientRow[],
  addresses: readonly CandidateAddressRow[],
  phones: readonly CandidatePhoneRow[],
  emails: readonly CandidateEmailRow[],
): MatchCandidate[] {
  const addressByPatient = new Map(addresses.map((a) => [a.patientId, a]));
  const phoneByPatient = new Map(phones.map((p) => [p.patientId, p]));
  const emailByPatient = new Map(emails.map((e) => [e.patientId, e]));
  return patients.map((r) => {
    const address = addressByPatient.get(r.id);
    return {
      id: r.id,
      lastName: normName(r.lastName),
      firstName: normName(r.firstName),
      dob: r.dob.trim(),
      mbi: normIdentifier(r.mbi),
      ssn: null,
      primaryAddress: address
        ? {
            line1: normName(address.line1),
            city: normName(address.city),
            postalCode: address.postalCode.trim(),
          }
        : null,
      phoneLast7: phoneLast7(phoneByPatient.get(r.id)?.e164),
      email: normEmail(emailByPatient.get(r.id)?.email),
    };
  });
}

/** Load every candidate the matcher compares against, in four org-scoped (RLS) reads. */
export async function loadMatchCandidates(tx: Tx): Promise<MatchCandidate[]> {
  const patients = (await tx
    .select({
      id: P.id,
      lastName: P.legalLastName,
      firstName: P.legalFirstName,
      dob: P.dob,
      mbi: ID.value,
    })
    .from(P)
    .leftJoin(ID, and(eq(ID.patientId, P.id), eq(ID.kind, "mbi")))) as CandidatePatientRow[];
  const addresses = (await tx
    .select({
      patientId: ADDR.patientId,
      line1: ADDR.line1,
      city: ADDR.city,
      postalCode: ADDR.postalCode,
    })
    .from(ADDR)
    .where(and(eq(ADDR.isPrimary, true), isNull(ADDR.effectiveTo)))) as CandidateAddressRow[];
  const phones = (await tx
    .select({ patientId: PHONE.patientId, e164: PHONE.e164 })
    .from(PHONE)
    .where(eq(PHONE.isPrimary, true))) as CandidatePhoneRow[];
  const emails = (await tx
    .select({ patientId: EMAIL.patientId, email: EMAIL.email })
    .from(EMAIL)
    .where(eq(EMAIL.isPrimary, true))) as CandidateEmailRow[];
  return buildMatchCandidates(patients, addresses, phones, emails);
}

/** Normalize a phone to E.164 (NANP assumed for 10/11-digit national numbers); null when unusable. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= E164_MIN_DIGITS && digits.length <= E164_MAX_DIGITS
      ? `+${digits}`
      : null;
  }
  if (digits.length === US_NANP_LENGTH) return `+1${digits}`;
  if (digits.length === US_NANP_WITH_COUNTRY_LENGTH && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function invalid(field: string, code: string, message: string): ValidationError {
  return new ValidationError(message, [{ field, code, message }]);
}

/**
 * Refuse, BEFORE any write, what admit cannot honestly keep: an SSN (no envelope-encryption writer yet),
 * a US address with no state (`patient_address_us_state_required`), a phone that is not a phone.
 */
export function assertAdmitDemographicsStorable(input: AdmitInput): void {
  if (normIdentifier(input.ssn)) {
    throw invalid(
      "ssn",
      "SSN_NOT_STORABLE",
      "SSN capture at admit is not available yet (no envelope-encrypted identifier writer); omit it",
    );
  }
  if (input.primaryAddress && !input.primaryAddress.state?.trim()) {
    throw invalid("primaryAddress.state", "REQUIRED", "a primary address needs a 2-letter state");
  }
  if (input.phone?.trim() && toE164(input.phone) === null) {
    throw invalid("phone", "INVALID", "phone is not a valid E.164-convertible number");
  }
}

/** Persist the admitted address / phone / email as the patient's primary rows (same transaction). */
export async function insertAdmitContactDetails(
  tx: Tx,
  organizationId: string,
  patientId: string,
  input: AdmitInput,
  effectiveFrom: string,
): Promise<void> {
  const address = input.primaryAddress;
  if (address) {
    await tx.insert(ADDR).values({
      patientId,
      organizationId,
      kind: "home",
      line1: address.line1,
      line2: address.line2 ?? null,
      city: address.city,
      state: address.state?.trim().toUpperCase() ?? null,
      postalCode: address.postalCode,
      isPrimary: true,
      effectiveFrom,
    });
  }
  const e164 = input.phone?.trim() ? toE164(input.phone) : null;
  if (e164) {
    await tx.insert(PHONE).values({ patientId, organizationId, e164, isPrimary: true });
  }
  const email = normEmail(input.email);
  if (email) {
    await tx.insert(EMAIL).values({ patientId, organizationId, email, isPrimary: true });
  }
}
