// apps/web/src/modules/22-documents — the M22 WRITE access layer the §5.1 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/22-documents` issued ZERO mutations — 1537 lines across five
// screens, every one a read — and the STAFF APP HAD NO FILE INPUT ANYWHERE. `grep -rn 'type="file"'`
// over `apps/web`, `apps/admin` and `apps/portal` returned exactly one hit, in the PORTAL. A family
// member could attach a document; the clinical staff who run the agency could not. The M22 write
// routes were mounted, guarded and contract-enriched the whole time.
//
// THE UPLOAD IS FOUR STEPS, AND ONLY THREE OF THEM GO THROUGH THIS CLIENT.
//
//   1. Hash the file in the browser (`crypto.subtle.digest`) — the server stores that digest as an
//      EXPECTED value and re-verifies it against the object it finds, so the hash is a commitment,
//      not a formality. Computing it client-side is the whole point of the "verified" upload.
//   2. `POST /api/v1/document-uploads` → an upload id, a presigned `uploadUrl`, and the exact headers
//      that URL was signed for.
//   3. `PUT` the bytes to `uploadUrl` — DIRECTLY to object storage, with a bare `fetch`. Deliberately
//      not the typed api client: that URL is not an API route, carries its own signature instead of
//      the session, and must not receive the credentials/headers the client attaches to every call.
//   4. `POST /api/v1/document-uploads/:id/complete` → the server inspects the stored object, compares
//      size and SHA-256 against what was declared, and only then commits the document version.
//
// Anything that fails between 2 and 4 leaves a `pending` upload row and a staged object, so every
// failure path calls `DELETE /api/v1/document-uploads/:id`. A row nobody aborts expires on its own
// after 15 minutes, but relying on that would leave the user's next attempt racing a stale one.
import { type ApiClient, isStepUpRequired, type operations } from "@chartwarden/ui";

// ── schema-derived type extraction ─────────────────────────────────────────────────────────────────────

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op` — 200 or 201, whichever the route actually sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
/** The request body of operation `Op`. */
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type InitiateUploadBody = ReqBody<operations["postApiV1Documentuploads"]>;
export type InitiateUploadResult = Ok<operations["postApiV1Documentuploads"]>;
export type CompleteUploadResult = Ok<operations["postApiV1DocumentuploadsByIdComplete"]>;
export type DocumentView = Ok<operations["getApiV1DocumentsById"]>;
export type PatchDocumentBody = ReqBody<operations["patchApiV1DocumentsById"]>;
export type SignedUrlResult = Ok<operations["getApiV1DocumentsByIdVersionsByVersionIdContent"]>;

/** The §3.2 retention classes the server accepts. Derived, so a vocabulary change is a compile error. */
export type RetentionClass = InitiateUploadBody["retentionClass"];
/** The §3.2 aggregate types a document can be filed under. */
export type AggregateType = InitiateUploadBody["aggregateType"];
/** The MIME types the verified-upload path accepts (`MIME_TYPES` in `verified-upload.ts`). */
export type UploadMimeType = InitiateUploadBody["mimeType"];
/** The §4.2 §164.528 access purposes a signed URL must declare. */
export type AccessPurpose = NonNullable<
  operations["getApiV1DocumentsByIdVersionsByVersionIdContent"]["parameters"]["query"]
>["purpose"];

/**
 * The outcome of one write. A DISCRIMINATED result rather than a thrown error, because every caller
 * renders the failure in place — and because an upload has four failure points with genuinely
 * different meanings, which a thrown `Error` would flatten.
 */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly message: string;
      /** The server wants a fresh step-up before it will do this (403 STEP_UP_REQUIRED). */
      readonly stepUp?: boolean;
    };

/**
 * Turn a failure into copy a clinician can act on.
 *
 * M22's codes are unusually specific and each names a different next step — `DOCUMENT_IMMUTABLE` (409,
 * legal hold or tombstone), `UNSUPPORTED_MEDIA_TYPE` (415), `UPLOAD_EXPIRED` (410, the 15-minute TTL),
 * `UPLOAD_NOT_COMPLETABLE` (409), and the checksum mismatch `complete` raises when the stored object is
 * not what was declared. Surfacing the server's own `message` beats any sentence written here; the
 * fallbacks are only for a response that carries none.
 */
function failure<T>(status: number | undefined, body: unknown): WriteResult<T> {
  const code = typeof status === "number" ? status : null;
  // The server's envelope nests the reason (`{ error: { code, message } }`); a flat `{ message }` is also read.
  const nested =
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object"
      ? (body.error as { message?: unknown }).message
      : undefined;
  const flat = body && typeof body === "object" && "message" in body ? body.message : undefined;
  const detail = [nested, flat].find((m): m is string => typeof m === "string") ?? null;
  const message =
    code === 403
      ? (detail ?? "You are not permitted to change this document.")
      : code === 409
        ? (detail ?? "This document cannot be changed — it may be under legal hold.")
        : code === 410
          ? (detail ?? "This upload expired before it finished. Try again.")
          : code === 413 || code === 415
            ? (detail ?? "That file type or size is not accepted.")
            : code === 404
              ? "That document is no longer available to you."
              : code === 422
                ? (detail ?? "The server rejected the details supplied.")
                : (detail ?? "The action could not be completed.");
  return { ok: false, status: code, message };
}

// ── the verified upload ────────────────────────────────────────────────────────────────────────────────

/** The MIME types `verified-upload.ts` accepts, as the contract states them. */
export const ACCEPTED_UPLOAD_MIME: readonly UploadMimeType[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
];
/** `MAX_DOCUMENT_UPLOAD_BYTES`, mirrored so the picker can refuse before a round trip. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * SHA-256 of a file, lowercase hex — the digest the server re-verifies against the stored object.
 *
 * `crypto.subtle` is only present in a SECURE context, so this can genuinely be unavailable (plain
 * http on a LAN address, which is not a hypothetical for a field laptop). It returns null rather than
 * throwing so the caller can say why the upload cannot proceed instead of failing as "network error".
 */
export async function sha256Hex(file: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof file.arrayBuffer !== "function") return null;
  try {
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Reading the file can fail for reasons that have nothing to do with hashing — a file removed or
    // renamed between the picker and submit, a permission revoked. Null is the honest answer, and the
    // caller turns it into a sentence; a throw here would escape the dialog's async submit and leave
    // it stuck on "Uploading…" with no message at all.
    return null;
  }
}

/** Step 2 — reserve the upload and get the presigned target. */
export async function initiateUpload(
  client: ApiClient,
  body: InitiateUploadBody,
): Promise<WriteResult<InitiateUploadResult>> {
  const { data, error, response } = await client.POST("/api/v1/document-uploads", { body });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as InitiateUploadResult };
}

/**
 * Step 3 — PUT the bytes straight to object storage.
 *
 * A bare `fetch`, NOT the typed api client: `uploadUrl` is not an API route, it carries its own
 * signature rather than the session, and sending it the headers the client attaches to every call
 * would both leak them to the object store and break the signature it was minted with. Only the
 * `requiredHeaders` the server returned are sent, verbatim — they are part of what was signed.
 */
export async function putUploadBytes(
  target: InitiateUploadResult,
  file: Blob,
): Promise<WriteResult<null>> {
  try {
    const res = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { ...target.requiredHeaders },
      body: file,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `The file could not be stored (${res.status}). Nothing was saved.`,
      };
    }
    return { ok: true, value: null };
  } catch {
    // A network failure here is indistinguishable from a CORS refusal by the object store, and both
    // mean the same thing to the user: the bytes did not arrive.
    return { ok: false, status: null, message: "The file could not be sent to storage." };
  }
}

/** Step 4 — the server verifies size + checksum and commits the version. Idempotent on re-call. */
export async function completeUpload(
  client: ApiClient,
  uploadId: string,
): Promise<WriteResult<CompleteUploadResult>> {
  const { data, error, response } = await client.POST("/api/v1/document-uploads/{id}/complete", {
    params: { path: { id: uploadId } },
    body: {},
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as CompleteUploadResult };
}

/** Abort a reserved upload. Best-effort: the caller is already handling a failure. */
export async function abortUpload(client: ApiClient, uploadId: string): Promise<void> {
  await client.DELETE("/api/v1/document-uploads/{id}", { params: { path: { id: uploadId } } });
}

/**
 * The whole ceremony, as one call — hash, reserve, PUT, commit, and abort on any failure after the
 * reservation. Kept here rather than in the modal so the sequence (and its cleanup) has ONE
 * implementation: a half-uploaded document is the failure mode worth being careful about.
 */
export async function uploadDocument(
  client: ApiClient,
  file: File,
  meta: Omit<InitiateUploadBody, "mimeType" | "byteSize" | "sha256Hex">,
): Promise<WriteResult<CompleteUploadResult>> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: null, message: "That file is larger than the 25 MB limit." };
  }
  if (!ACCEPTED_UPLOAD_MIME.includes(file.type as UploadMimeType)) {
    return {
      ok: false,
      status: null,
      message: `${file.type || "That file type"} is not accepted.`,
    };
  }
  const digest = await sha256Hex(file);
  if (digest === null) {
    return {
      ok: false,
      status: null,
      message: "This browser cannot hash the file (a secure connection is required to upload).",
    };
  }

  const started = await initiateUpload(client, {
    ...meta,
    mimeType: file.type as UploadMimeType,
    byteSize: file.size,
    sha256Hex: digest,
  });
  if (!started.ok) return started;

  const put = await putUploadBytes(started.value, file);
  if (!put.ok) {
    await abortUpload(client, started.value.uploadId);
    return put;
  }

  const done = await completeUpload(client, started.value.uploadId);
  if (!done.ok) await abortUpload(client, started.value.uploadId);
  return done;
}

// ── document metadata ──────────────────────────────────────────────────────────────────────────────────

/** §4.1 — edit title / patient-facing. Refused under legal hold by `ABAC_LEGAL_HOLD`, not by this. */
export async function patchDocument(
  client: ApiClient,
  id: string,
  body: PatchDocumentBody,
): Promise<WriteResult<DocumentView>> {
  const { data, error, response } = await client.PATCH("/api/v1/documents/{id}", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as DocumentView };
}

/** §4.12 — the out-of-network partner a `disclosure` / `survey_export` mint is for (an M40 entity). */
export type DisclosureRecipient = {
  readonly kind: NonNullable<
    NonNullable<
      operations["getApiV1DocumentsByIdVersionsByVersionIdContent"]["parameters"]["query"]
    >["recipientKind"]
  >;
  readonly entityId: string;
};

/**
 * §4.2 — mint a short-lived signed URL for a version's content.
 *
 * A GET that MINTS: it writes a §164.528 disclosure-accounting record, which is why `purpose` is
 * required and why the TTL is clamped server-side. The caller opens the returned url; this layer does
 * not, because what to do with it (new tab, embed, download) is the screen's decision.
 */
export async function mintContentUrl(
  client: ApiClient,
  documentId: string,
  versionId: string,
  purpose: AccessPurpose,
  recipient?: DisclosureRecipient,
): Promise<WriteResult<SignedUrlResult>> {
  const getContent = () =>
    client.GET("/api/v1/documents/{id}/versions/{versionId}/content", {
      params: {
        path: { id: documentId, versionId },
        query: {
          purpose,
          ...(recipient
            ? { recipientKind: recipient.kind, recipientEntityId: recipient.entityId }
            : {}),
        },
      },
    });
  let result: Awaited<ReturnType<typeof getContent>>;
  try {
    result = await getContent();
  } catch {
    // openapi-fetch rethrows a rejected fetch; uncaught, the dialog's busy flag never clears.
    return { ok: false, status: null, message: "The server could not be reached. Try again." };
  }
  const { data, error, response } = result;
  if (error || !data) {
    const res = failure<SignedUrlResult>(response?.status, error);
    return !res.ok && isStepUpRequired(error)
      ? { ...res, message: "Confirm your identity to release this document.", stepUp: true }
      : res;
  }
  return { ok: true, value: data as SignedUrlResult };
}

// ── tags (§3.3) ────────────────────────────────────────────────────────────────────────────────────────
//
// This block used to be a paragraph explaining why tag editing could not be built (#153): `document_tag`
// had two writers and NO READER anywhere in the repo — no route projected tags, `GET /documents/:id`
// did not carry them, and no SELECT touched the table outside the eraser. The tag id was returned
// exactly once, by a POST whose contract declared no response body, so a typed client could not hold
// it and the DELETE was unreachable by construction. An editor could not have shown what was already
// on a document, and anything added through it would have been invisible and undeletable on reload.
//
// #153 is fixed: `GET /documents/:id/tags` exists, the POST publishes the created tag, and the
// cross-document `?tagKey=` query is wired. The editor below is the caller those routes were missing.

export type TagView = Ok<operations["getApiV1DocumentsByIdTags"]>["items"][number];
export type AddTagBody = ReqBody<operations["postApiV1DocumentsByIdTags"]>;
/** §3.3 — `free` values may carry PHI and are denylisted in the audit trigger; `structured` may not. */
export type TagKind = AddTagBody["tagKind"];

/** §3.3 — the document's tags, newest first. */
export async function listDocumentTags(
  client: ApiClient,
  documentId: string,
): Promise<WriteResult<TagView[]>> {
  const { data, error, response } = await client.GET("/api/v1/documents/{id}/tags", {
    params: { path: { id: documentId } },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: [...data.items] as TagView[] };
}

/** §3.3 — add a tag. The response carries the created row, INCLUDING the id the removal needs. */
export async function addDocumentTag(
  client: ApiClient,
  documentId: string,
  body: AddTagBody,
): Promise<WriteResult<TagView>> {
  const { data, error, response } = await client.POST("/api/v1/documents/{id}/tags", {
    params: { path: { id: documentId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as TagView };
}

/** §3.3 — remove a tag. 204; refused under legal hold by `ABAC_LEGAL_HOLD`, not by this. */
export async function removeDocumentTag(
  client: ApiClient,
  documentId: string,
  tagId: string,
): Promise<WriteResult<null>> {
  const { error, response } = await client.DELETE("/api/v1/documents/{id}/tags/{tagId}", {
    params: { path: { id: documentId, tagId } },
  });
  if (error) return failure(response?.status, error);
  return { ok: true, value: null };
}
