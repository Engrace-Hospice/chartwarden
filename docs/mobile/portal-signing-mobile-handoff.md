# Portal admission-document signing: mobile contract (draft)

Status: **draft handoff** for the mobile repository, `Engrace-Hospice/chartwarden-mobile` (ADR-0072 calls it `wardenx-mobile`). The backend work is ADR-0107
(**Proposed**). Nothing here creates a second auth surface: the mobile app uses the same portal session as
the portal web app and only calls the routes listed below. If this page and `docs/api/openapi.json`
disagree, the OpenAPI file wins; regenerate your client from it.

## What the user can do

A patient, or the person acting for them, signs four documents from the app: the Hospice Election
Statement, the Notice of Patient Rights acknowledgement, the HIPAA Notice of Privacy Practices (NPP)
acknowledgement and the Consent to Treat. Staff send each one as a **signature request**. The person signs
in the app with a typed name, an attestation checkbox and an authenticator (TOTP) code, or uploads a
photo or PDF of a document signed on paper. Staff review an uploaded copy.

## Request states

`pending` (waiting for the person) → `signed`, or → `uploaded_pending_review` (a paper copy was sent;
staff review it) → `signed`, or back to `pending` if staff reject the copy. `voided` requests are never
shown to the patient. `signed` is final. A request never expires; it is reminded daily until it is signed
or withdrawn.

## Routes (all under the portal session; `Idempotency-Key` required on every POST)

| Route | Permission | Purpose |
|---|---|---|
| `GET /api/v1/portal/signature-requests` | `portal.signature.read` | The session patient's requests, newest first (`id`, `docKind`, `status`, `templateVersion`, `requestedAt`, `signedAt`, `signerRole`). |
| `GET /api/v1/portal/signature-requests/{requestId}` | `portal.signature.read` | One request plus `attestationText`, the exact sentence the signer agrees to, and for the privacy notice and Consent to Treat also `documentTitle` and `documentParagraphs` (the document wording). Show all of it verbatim, wording first, then the attestation; never substitute your own. The Election Statement and Notice of Patient Rights carry no wording here: the app shows the M06 document the care team sent. |
| `POST /api/v1/portal/sessions/step-up` | portal session | Body `{ totpCode }` (6 to 8 digits). A fresh step-up is required immediately before signing. |
| `POST /api/v1/portal/signature-requests/{requestId}/sign` | `portal.signature.sign` | Body `{ signedTypedName, attested: true, signerRelationshipText?, patientUnableReason? }`. Returns `{ request, alreadySigned }`. |
| `POST /api/v1/portal/documents/upload-init`, `PUT .../uploads/{uploadId}/content`, `POST .../upload-complete/{uploadId}` | `portal.documents.upload` | The existing three-step upload, with `purpose: "signed_admission_document"`. |
| `POST /api/v1/portal/signature-requests/{requestId}/signed-copy` | `portal.signature.sign` | Body `{ uploadId }`. Attaches the completed upload; the request becomes `uploaded_pending_review`. It is never signed by the upload itself. |

### Signing

1. `GET` the request and show `attestationText`, the typed-name field and the attestation checkbox.
2. Ask for the authenticator code and call `step-up`. Do the step-up right before the sign call; a stale one
   answers `403 STEP_UP_REQUIRED`.
3. `POST .../sign` with a **new `Idempotency-Key` per attempt, reused if you retry the same attempt** (for
   example after a lost response). A retry with the same key and an already-signed request returns
   `200` with `alreadySigned: true`.

Who must say more (the server decides; the app shows the fields when it is told, or up front when the
signed-in person is not the patient):

| Signer | Extra fields |
|---|---|
| The patient | none |
| Healthcare agent (DPOA) | `signerRelationshipText` |
| Family caregiver | `signerRelationshipText` and `patientUnableReason` (the patient could not sign) |
| Post-death representative (NPP only) | `signerRelationshipText` |

Who may sign which document is enforced on the server (ADR-0107 D3). In short: a caregiver cannot sign the
Election Statement, and a bereaved-family account signs nothing. Treat `403` as final and say so in plain
words; do not offer a retry.

### Paper copy

Upload with purpose `signed_admission_document` (PDF, JPEG, PNG, HEIC or TIFF, up to 50 MB, same limits as
any portal upload), then call `signed-copy`. Show "Waiting for your care team to review". Do not show the
document as signed. If staff reject it the request returns to `pending` and the person may sign in the app
or upload again. Do not offer this purpose in the generic documents picker.

## Errors the app must handle

| Status | Code | Meaning for the user |
|---|---|---|
| 403 | `STEP_UP_REQUIRED` | Ask for the authenticator code again. |
| 403 | `FORBIDDEN`, `NOT_AUTHORIZED_FOR_DOCUMENT`, `GRANT_KIND_UNSUPPORTED` | "You are not able to sign this document for this patient." |
| 403 | `DPOA_CONSENT_NOT_ACTIVE` | "Your authority to act for this patient could not be confirmed. Please contact your care team." |
| 404 | `REQUEST_NOT_FOUND` / not found | The request is gone or belongs to someone else. Refresh the list. |
| 409 | `REQUEST_NOT_OPEN`, `REQUEST_NOT_PENDING` | Already handled or withdrawn. Refresh. |
| 409 | `TEMPLATE_PENDING_LEGAL_REVIEW`, `REQUEST_TARGET_MISSING` | "This document is not ready to sign yet. Your care team will let you know." (The Consent to Treat is a placeholder until legal review is recorded.) |
| 409 | `CONFLICT` | The care team withdrew the request while the person was signing. Refresh. |
| 422 | `RELATIONSHIP_REQUIRED`, `PATIENT_UNABLE_REASON_REQUIRED`, `SIGNER_NAME_REQUIRED` | Show the missing field. |
| 422 | `UPLOAD_NOT_USABLE` | The file cannot be used; upload it again. |

Error bodies carry a code and a lay message, never record content.

## Security and storage rules for the app

- The typed name, the relationship text, the reason and the authenticator code are **never** written to
  logs, crash reports, analytics, the SQLCipher outbox or any offline queue. Clear the code field after use.
- **Signing is online-only.** It needs a fresh step-up and a server-side check; never queue a signature to
  send later. A paper-copy upload may use the app's normal upload retry, but only for the file, not the
  signature.
- Idempotency keys are random per attempt. They are not secrets, but they are not reused across attempts.
- The attestation text can change with the template version. Always display what `GET` returned for this
  request.

## Notifications (open dependency, not yet usable)

Product decision: a push when a request is sent, then a daily reminder until it is signed or withdrawn.
The backend already emits `m31.signature_request.requested` and `m31.signature_request.reminded` (ids only)
and runs the daily reminder cadence. **Delivery to a patient's or caregiver's device is not built:** a
portal session cannot register a native push endpoint (`notifications.endpoint.manage` is not held by any
portal session class), and the alert recipient model only reaches staff and portal-caregiver channel
members. Until that decision is made, the app should show requests from the list and must not assume a push
arrives. When it is built, the payload will stay generic and PHI-free (ADR-0072 decisions 8 to 12): no
document name, patient name or request id in the notification text; the app opens the Signatures list on
tap.

## Test checklist for the app

- Patient signs the NPP end to end (step-up, then sign), then reopens the request and sees it signed.
- Retry after a dropped response with the same key shows signed once; a new attempt after a refusal uses a
  new key.
- Caregiver sees the relationship and patient-unable fields, cannot sign the Election Statement, and gets
  the plain refusal.
- Paper copy: upload, attach, see "waiting for review"; after a staff rejection the request is `pending`
  again.
- A voided request disappears from the list on refresh; a withdrawn-while-signing request shows the
  withdrawn message.
- Nothing from the signing screens appears in logs, analytics or the offline store.
