// @chartwarden/ui — the M22 VERIFIED UPLOAD ceremony (hash, reserve, PUT, commit, abort), shared by every web module that files a document
// through `POST /api/v1/document-uploads` (M22's own documents screens, M16's grief library). One implementation, because a half-uploaded
// document is the failure mode worth being careful about; moved here from apps/web/src/modules/22-documents/documents-api.ts so a module
// other than M22 does not import M22's web module (arch:boundaries).
import type { ApiClient } from "./client";
import type { operations } from "./schema";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type InitiateUploadBody = ReqBody<operations["postApiV1Documentuploads"]>;
export type InitiateUploadResult = Ok<operations["postApiV1Documentuploads"]>;
export type CompleteUploadResult = Ok<operations["postApiV1DocumentuploadsByIdComplete"]>;
/** The MIME types the verified upload contract states (`video/mp4` is accepted for a grief-library document only). */
export type UploadMimeType = InitiateUploadBody["mimeType"];

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
export function writeFailure<T>(status: number | undefined, body: unknown): WriteResult<T> {
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
  if (error || !data) return writeFailure(response?.status, error);
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
  if (error || !data) return writeFailure(response?.status, error);
  return { ok: true, value: data as CompleteUploadResult };
}

/** Abort a reserved upload. Best-effort: the caller is already handling a failure. */
export async function abortUpload(client: ApiClient, uploadId: string): Promise<void> {
  await client.DELETE("/api/v1/document-uploads/{id}", { params: { path: { id: uploadId } } });
}
