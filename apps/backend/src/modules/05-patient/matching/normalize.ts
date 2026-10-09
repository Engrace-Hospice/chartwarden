// apps/backend/src/modules/05-patient/matching/normalize.ts — the §2.3 NRM (normalize) node.
// Pure normalizers the service applies to an incoming patient before matching: names upper-cased +
// whitespace-collapsed, DOB kept ISO, MBI/SSN trimmed of separators, phone reduced to its last 7
// digits, email lower-cased. Deterministic — same input, same comparable form.
import { normalizeSsn } from "../identifiers/ssn";
import type { MatchSubject } from "./matcher";

/** Upper-case, trim, collapse internal whitespace (name comparison form). */
export function normName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Strip non-alphanumerics + upper-case (MBI/SSN comparison form). */
export function normIdentifier(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** The last 7 digits of a phone number (the §2.3 phone feature compares the local 7). */
export function phoneLast7(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-7) : null;
}

/** Lower-case + trim an email (comparison form). */
export function normEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const e = s.trim().toLowerCase();
  return e.length > 0 ? e : null;
}

/** Raw incoming demographics, pre-normalization. */
export interface RawSubject {
  readonly lastName: string;
  readonly firstName: string;
  readonly dob: string;
  readonly mbi?: string | null;
  readonly ssn?: string | null;
  readonly primaryAddress?: { line1: string; city: string; postalCode: string } | null;
  readonly phone?: string | null;
  readonly email?: string | null;
}

/** Normalize a raw incoming subject into the comparable {@link MatchSubject} form (§2.3 NRM). */
export function normalizeSubject(raw: RawSubject): MatchSubject {
  return {
    lastName: normName(raw.lastName),
    firstName: normName(raw.firstName),
    dob: raw.dob.trim(),
    mbi: normIdentifier(raw.mbi),
    // GAP-010: the nine-number form, so "123-45-6789" and "123456789" probe the same blind-index token. Only the
    // INCOMING side is normalized here; stored candidates reach the matcher via the blind-index hit set.
    ssn: normalizeSsn(raw.ssn),
    primaryAddress: raw.primaryAddress
      ? {
          line1: normName(raw.primaryAddress.line1),
          city: normName(raw.primaryAddress.city),
          postalCode: raw.primaryAddress.postalCode.trim(),
        }
      : null,
    phoneLast7: phoneLast7(raw.phone),
    email: normEmail(raw.email),
  };
}
