# ADR-0107 — Portal admission-document signing: a signature request in M31, a fail-closed authority matrix, M06 / M39 stay authoritative

- **Status:** **Proposed** (2026-11-04)
- **Date:** 2026-11-04
- **Related:** ADR-0015 (election and certification), ADR-0072 (separate React Native mobile app), ADR-0105 (native push installations), ADR-0097 / ADR-0106 (the guard, RLS and audit pattern this table follows), Module 31 (portal), Module 39 (consent), Module 6 (admission).

## Context

A hospice must collect the Election Statement, the Notice of Patient Rights acknowledgement, the HIPAA Notice of Privacy Practices (NPP) acknowledgement and a Consent to Treat from the patient or the person acting for them. Today:

- Election and Notice of Rights signing live in M06 and are staff-only, with a typed name and a role. A representative signer needs an active healthcare-DPOA consent (R-EL-01).
- M39 already defines the `electronic_portal_signature` capture method, but nothing in M31 produces it.
- A portal session holds no `election.*`, `nor.*` or `consent.*` permission, and there is no way for staff to ask a patient to sign. The portal can upload a file, but no upload purpose is an admission document.
- The mobile app lives in another repository (ADR-0072) and can only use `/api/v1/portal/*` through the pinned OpenAPI contract.

## Decision

- **D1. One workflow record, not four route sets.** `portal_signature_request` (migration 1301) is the portal-facing record: document kind, template and version, status, requester, signer evidence and reminder bookkeeping. It carries no document text. Four copies of the step-up, authority and idempotency logic would drift, and mobile would get four contracts.
- **D2. M06 and M39 stay authoritative.** The portal never writes their tables. The sign path (a later PR) runs inside one transaction and calls a service seam: M06 for the Election Statement and the Notice of Rights, M39 (`electronic_portal_signature`) for the NPP acknowledgement and Consent to Treat. `target_ref` records what that call produced. If the seam refuses (for example R-EL-01 or R-EL-04), the request stays `pending` and the portal gets a typed error. M39 is not made the single record, because M06 election rules (DPOA consent, curative-care acknowledgement, the state machine) are not M39's to know.
- **D3. Fail-closed authority matrix.** `portal-signing-authority.ts` decides, for a portal grant kind and a document kind, whether signing is allowed, under which signer role, and what the signer must state. Every pair is written out; an unknown kind is denied. It is the portal's first gate only; M06 / M39 still decide the document.

  | Document | patient_self | dpoa_healthcare | family_caregiver | personal_representative (post-death) | bereaved_family |
  |---|---|---|---|---|---|
  | Election Statement | patient | legal representative | deny | deny | deny |
  | Notice of Patient Rights | patient | legal representative | caregiver on behalf | deny | deny |
  | HIPAA NPP acknowledgement | patient | legal representative | caregiver on behalf | legal representative | deny |
  | Consent to Treat | patient | legal representative | caregiver on behalf | deny | deny |

  A family caregiver signs only when the patient cannot, so they must state who they are and why the patient did not sign (the paper NPP form's "reason patient did not sign" and "relationship or legal authority"). A caregiver never makes the hospice election. Product owner's answers, 2026-11-04.
- **D4. E-signature evidence.** A typed name, an attestation checkbox whose exact text is pinned by SHA-256, a fresh portal step-up (TOTP), a database-clock timestamp and the portal session id. Counsel accepted this method for the Election Statement (2026-11-04). It does not support a witness requirement.
- **D5. Lifecycle and guards.** `pending → signed | uploaded_pending_review | voided`; `uploaded_pending_review → signed | pending | voided`; `signed` and `voided` are terminal; nothing is deleted. One open request per (patient, document kind). A retried sign with the same idempotency key lands on the same row. Identity columns never change. The database enforces all of this in a guard trigger, not only the application.
- **D6. Uploaded paper copies.** A portal upload of a signed paper copy parks the request in `uploaded_pending_review` and never marks it signed. Staff accept or reject it, and acceptance goes through the existing M06 / M39 uploaded-evidence paths.
- **D7. Reminders, no expiry.** A new request sends a PHI-free push (ADR-0105). A pending request is reminded again, once a day by default, until it is signed or voided. There is no expiry. `last_reminded_at` and `reminder_count` drive the sweep.
- **D8. No PHI in the audit trail.** The audit trigger scrubs the signer's typed name, relationship, the patient's reason and the void reason. Audit rows carry ids, status and instants only.
- **D9. Legal wording.** The NPP template comes from the practice's own acknowledgement form. Consent to Treat has no approved wording yet, so it ships as an explicit "pending legal review" placeholder that cannot be signed on a production tenant.
- **D10. Retention.** Signed requests are legal records, kept at least as long as the signed document (the NPP form states 6 years, 45 CFR 164.530(j)). The portal eraser must not delete them. This needs checking against the M10 retention and legal-hold rules before the sign path ships.

## Consequences

- Signing is added in small PRs. This one adds the table, the mirrors and the matrix, and nothing is reachable from the portal yet.
- Two records of a consent-like act can exist for an election (M06) and a consent (M39). They are linked by `target_ref`; they are not merged.
- The mobile contract is the new M31 routes in the OpenAPI document, plus a draft mobile spec. The mobile repository itself is out of scope here.
- Control `CW-AC-09` tracks this feature and stays `partial` until the sign route, its step-up gate and the real-role live suite land.

## Open items

- Which `personal_representative` grant means "post-death"? The grant-kind enum has `personal_representative` and `bereaved_family`; the matrix treats the first as the post-death representative.
- A caregiver's relationship to the patient is free text today; whether the system verifies it is undecided.
- Legal wording for Consent to Treat, and the M10 retention rule for signed requests.
