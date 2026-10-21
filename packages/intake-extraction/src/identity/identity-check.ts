// @chartwarden/intake-extraction — is this document about the patient the fax is filed under? (F-238)
//
// A referral packet, and especially the older PCP and hospital records requested later, can carry another
// patient's page: a misfiled fax, a wrong chart printed, two patients faxed back to back. Every document
// the splitter finds is therefore compared with the TARGET — the chart patient, or, before one is resolved,
// the name and DOB the referral was received with — on two identifiers (Joint Commission NPSG.01.01.01):
// the DOB and the name.
//
//   match        DOB equal, and last name equal or one OCR character away (the packet's wound note reads
//                "DICLENS"); first name equal, an initial, one character away, or absent.
//   possible     DOB equal but a different last name (married / maiden name), or a different first name;
//                or the name matches but the DOB is only one OCR/transposition step away (03/02 ↔ 02/03).
//   mismatch     the DOB differs beyond that, or there is no DOB and the last name differs.
//   unverified   the document states no usable identifier (a lab table, a POLST page with the name only).
//
// `possible` and `mismatch` block completion until a reviewer resolves them; `unverified` is shown, not
// blocking. Nothing here ever merges or moves a record: it only says which pages disagree, by FIELD — the
// values themselves stay in the encrypted candidates.
// Pure and deterministic.

export type IdentityStatus = "match" | "possible" | "mismatch" | "unverified";
export type IdentityField = "dateOfBirth" | "lastName" | "firstName";

export interface IdentityTarget {
  readonly lastName: string | null;
  readonly firstName: string | null;
  /** ISO yyyy-mm-dd. */
  readonly dateOfBirth: string | null;
}

/** What one document states about its patient (raw, as extracted and grounded on the page). */
export interface DocumentIdentity {
  readonly lastName?: string | null;
  readonly firstName?: string | null;
  /** As written: 03/02/1941, 3/2/41, 1941-03-02, March 2, 1941… */
  readonly dateOfBirth?: string | null;
}

export interface IdentityVerdict {
  readonly status: IdentityStatus;
  /** The identifiers that disagree (or are near-misses) — field names only, never values. */
  readonly disagreeing: readonly IdentityField[];
}

/** Worst first: what a batch shows when its documents differ. */
export const IDENTITY_SEVERITY: Readonly<Record<IdentityStatus, number>> = {
  mismatch: 0,
  possible: 1,
  unverified: 2,
  match: 3,
};

export const identityBlocks = (s: IdentityStatus): boolean => s === "mismatch" || s === "possible";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A written DOB → ISO, or null. Two-digit years are read as 19xx (a hospice patient's DOB). */
export function normaliseDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = (m[3] as string).length === 2 ? 1900 + Number(m[3]) : Number(m[3]);
    return valid(y, Number(m[1]), Number(m[2]));
  }
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1] as string) + 1;
    return month > 0 ? valid(Number(m[3]), month, Number(m[2])) : null;
  }
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1880 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Letters only, upper-case, accents removed: "O'Brien-Smith" → "OBRIENSMITH". */
export function normaliseName(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

/** "DOCLENS, ARTHUR" / "Arthur Doclens" / "Arthur J. Doclens" → last + first. */
export function splitFullName(raw: string | null | undefined): {
  lastName: string | null;
  firstName: string | null;
} {
  const s = (raw ?? "").trim();
  if (!s) return { lastName: null, firstName: null };
  if (s.includes(",")) {
    const [last, rest] = s.split(",", 2);
    return { lastName: last?.trim() || null, firstName: rest?.trim().split(/\s+/)[0] || null };
  }
  const parts = s.split(/\s+/);
  return {
    lastName: parts.length > 1 ? (parts[parts.length - 1] as string) : (parts[0] as string),
    firstName: parts.length > 1 ? (parts[0] as string) : null,
  };
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

type NameAgreement = "same" | "near" | "initial" | "different" | "absent";

function compareName(doc: string | null | undefined, target: string | null): NameAgreement {
  const a = normaliseName(doc);
  const b = normaliseName(target);
  if (!a || !b) return "absent";
  if (a === b) return "same";
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? "initial" : "different";
  // One OCR slip, only on names long enough that one letter does not make a different common name.
  if (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1) return "near";
  return "different";
}

/** One OCR digit or a day/month transposition away: a near miss, not a different person by itself. */
function dobNearMiss(a: string, b: string): boolean {
  const [ay, am, ad] = a.split("-");
  const [by, bm, bd] = b.split("-");
  if (ay === by && am === bd && ad === bm) return true;
  const da = a.replace(/-/g, "");
  const db = b.replace(/-/g, "");
  let diff = 0;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
  return diff === 1;
}

export function compareIdentity(doc: DocumentIdentity, target: IdentityTarget): IdentityVerdict {
  const docDob = normaliseDob(doc.dateOfBirth);
  const last = compareName(doc.lastName, target.lastName);
  const first = compareName(doc.firstName, target.firstName);
  const disagreeing: IdentityField[] = [];
  const lastOk = last === "same" || last === "near";
  const firstOk = first === "same" || first === "near" || first === "initial" || first === "absent";
  if (last === "different") disagreeing.push("lastName");
  if (first === "different") disagreeing.push("firstName");

  if (docDob && target.dateOfBirth) {
    if (docDob === target.dateOfBirth) {
      // A DOB alone is one identifier: it cannot confirm the person.
      if (last === "absent") return { status: "unverified", disagreeing };
      return { status: lastOk && firstOk ? "match" : "possible", disagreeing };
    }
    disagreeing.unshift("dateOfBirth");
    // Same name, DOB one slip away: the DOB was misread or mistyped — a person must look.
    if (dobNearMiss(docDob, target.dateOfBirth) && lastOk && firstOk) {
      return { status: "possible", disagreeing };
    }
    return { status: "mismatch", disagreeing };
  }
  // No DOB to compare: a name alone is one identifier — it can refute, never confirm.
  if (last === "different") return { status: "mismatch", disagreeing };
  return { status: "unverified", disagreeing };
}

/** The batch's status: its worst document, ignoring documents a reviewer already resolved. */
export function worstIdentity(statuses: readonly IdentityStatus[]): IdentityStatus | null {
  if (statuses.length === 0) return null;
  return [...statuses].sort(
    (a, b) => IDENTITY_SEVERITY[a] - IDENTITY_SEVERITY[b],
  )[0] as IdentityStatus;
}
