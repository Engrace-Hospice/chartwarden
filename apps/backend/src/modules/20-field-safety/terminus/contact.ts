// apps/backend/src/modules/20-field-safety/terminus/contact.ts - GAP-032: opening the sealed emergency contact
// at DIAL time, inside the terminus executor only.
//
// `safety_emergency_contact_consent.consent_scope_detail` is `{ contact: base64(sealed JSON), enc: "dek" }`
// (write-service-drizzle `grantConsent`). The sealed JSON is `{ name, phone, relationship }`; only the phone
// is returned from here and the caller passes it straight to the voice transport. The number is a third
// party's personal detail: it is never put in a thrown message, a log line, a result code or the ledger.
// Every failure collapses to the closed result `{ kind: "unreadable" }` / `{ kind: "invalid" }` so there is
// nothing sensitive to leak by construction.
import { normalizeE164 } from "@wardenx/shared/phone";
import type { SafetyDecipherPort } from "../routes/read-service-drizzle";

/** The default region for a number a clinician typed without a country code (US-only, R4). */
export const EMERGENCY_CONTACT_DEFAULT_REGION = "US" as const;

export type OpenedEmergencyContact =
  | { readonly kind: "ok"; readonly phone: string }
  | { readonly kind: "unreadable" };

/** Open the sealed contact for `organizationId`. Never throws; never returns anything but the phone. */
export async function openEmergencyContact(
  consentScopeDetail: unknown,
  deps: { readonly organizationId: string; readonly decipher: SafetyDecipherPort },
): Promise<OpenedEmergencyContact> {
  try {
    const sealed = (consentScopeDetail as { contact?: unknown } | null)?.contact;
    if (typeof sealed !== "string" || sealed === "") return { kind: "unreadable" };
    const plaintext = await deps.decipher.decrypt({
      organizationId: deps.organizationId,
      cipher: Buffer.from(sealed, "base64"),
    });
    if (plaintext === null) return { kind: "unreadable" };
    const phone = (JSON.parse(plaintext) as { phone?: unknown }).phone;
    return typeof phone === "string" && phone !== ""
      ? { kind: "ok", phone }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

export type DialNumber =
  | { readonly kind: "ok"; readonly e164: string }
  | { readonly kind: "invalid" };

/** Normalise the stored number to dialable E.164. Emergency/short codes and non-geographic numbers are refused. */
export function resolveDialNumber(stored: unknown): DialNumber {
  if (typeof stored !== "string") return { kind: "invalid" };
  const result = normalizeE164(stored, EMERGENCY_CONTACT_DEFAULT_REGION);
  return result.ok ? { kind: "ok", e164: result.e164 } : { kind: "invalid" };
}
