// apps/backend/src/modules/34-saas-tenant-platform/routes/free-text.ts — the one-line screens the M34 route handlers call right after
// `parse(...)`. Text an operator or a tenant user types that is STORED (a row a tenant can read, the audit trail, a job payload) is
// no place for a patient: it goes through the shared identifier screen (422 EVIDENCE_LOOKS_LIKE_PHI, the field named, the value never
// echoed). A field the service DISCARDS is not screened (a refusal would block an action for text nothing keeps); a change that
// starts storing one must screen it here.
import { assertNoPatientIdentifier, assertNoPatientIdentifierInValue } from "@chartwarden/shared";

type Texts = Readonly<Record<string, string | null | undefined>>;

/** Prose: a reason, a note, a narrative, a description. Absent fields are skipped. */
export function screenFreeText(fields: Texts): void {
  for (const [field, text] of Object.entries(fields)) {
    if (typeof text === "string") assertNoPatientIdentifier(field, text);
  }
}

/** A name (an organisation's or a person's): the shared advice about what was checked does not fit it, so it has its own text. */
export function screenNames(fields: Texts): void {
  for (const [field, text] of Object.entries(fields)) {
    if (typeof text !== "string") continue;
    assertNoPatientIdentifier(
      field,
      text,
      `${field} must not contain a patient identifier number (a Social Security or Medicare number); a name is a name, not a record.`,
    );
  }
}

/** A structured (JSON) value: every string leaf and key, within the shared walk's bounds. */
export function screenValue(field: string, value: unknown): void {
  assertNoPatientIdentifierInValue(field, value);
}
