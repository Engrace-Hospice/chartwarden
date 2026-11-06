// apps/web/src/modules/16-bereavement — the access layer for the three family PROGRAMS of ADR-0109 D10 (PR 3): support groups (routes 53-66),
// memorial services (routes 67-76) and the grief library (routes 77-81).
//
// Same contract as bereavement-api.ts: every wire shape is a type alias into the generated `operations` map, every write carries an
// `Idempotency-Key`, and every state change on a row the caller READ carries `If-Match: <version>` (the header decides; no body field does).
// Every helper answers `{ data, error, status }` and never rejects, so a screen can tell 403 (show nothing) from a failure (say so) and
// retry a lost response with the SAME key.
import {
  type ApiClient,
  type InitiateUploadBody,
  type UploadMimeType,
  abortUpload,
  completeUpload,
  initiateUpload,
  type operations,
  putUploadBytes,
  sha256Hex,
} from "@chartwarden/ui";
import { send, writeHeaders } from "./bereavement-api";
import type { Fetched } from "./mailing-load";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;
type ReqQuery<Op> = Op extends { parameters: { query?: infer Q } } ? Q : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type GroupPage = Ok<operations["getApiV1BereavementGroups"]>;
export type GroupListItem = GroupPage["data"][number];
export type Group = Ok<operations["getApiV1BereavementGroupsByGroupId"]>;
export type GroupStatus = Group["status"];
export type GroupCreateBody = ReqBody<operations["postApiV1BereavementGroups"]>;
export type GroupUpdateBody = ReqBody<operations["patchApiV1BereavementGroupsByGroupId"]>;
export type GroupRecurrence = NonNullable<GroupCreateBody["recurrence"]>;
export type GroupSession = Ok<operations["getApiV1BereavementGroupsByGroupIdSessions"]>[number];
export type GroupRoster = Ok<operations["getApiV1BereavementGroupsByGroupIdRoster"]>;
export type RosterEntry = GroupRoster["entries"][number];
export type AttendanceResult = Ok<
  operations["postApiV1BereavementGroupsByGroupIdSessionsBySessionIdAttendance"]
>;
export type Enrollment = Ok<
  operations["getApiV1BereavementContactsByContactIdSupportgroups"]
>[number];
export type WithdrawReason = ReqBody<
  operations["postApiV1BereavementGroupsByGroupIdEnrollmentsByContactIdWithdraw"]
>["reason"];

export type MemorialPage = Ok<operations["getApiV1BereavementMemorials"]>;
export type MemorialListItem = MemorialPage["data"][number];
export type Memorial = Ok<operations["getApiV1BereavementMemorialsByServiceId"]>;
export type MemorialStatus = Memorial["status"];
export type MemorialBody = ReqBody<operations["postApiV1BereavementMemorials"]>;
export type MemorialInvitation = Ok<
  operations["getApiV1BereavementMemorialsByServiceIdInvitations"]
>[number];
export type ContactInvitation = Ok<
  operations["getApiV1BereavementContactsByContactIdMemorialinvitations"]
>[number];
export type RsvpBody = ReqBody<
  operations["putApiV1BereavementContactsByContactIdMemorialinvitationsByInvitationIdRsvp"]
>;

export type LibraryItem = Ok<operations["getApiV1BereavementLibrary"]>[number];
export type LibraryStatus = LibraryItem["status"];
export type LibraryCategory = LibraryItem["category"];
export type LibraryCreateBody = ReqBody<operations["postApiV1BereavementLibrary"]>;
export type LibraryUpdateBody = ReqBody<operations["patchApiV1BereavementLibraryByItemId"]>;
export type LibraryUrl = Ok<operations["getApiV1BereavementLibraryByItemIdUrl"]>;
export type LibraryPart = NonNullable<
  ReqQuery<operations["getApiV1BereavementLibraryByItemIdUrl"]>
>["part"];

const done = <T>({ data, error, status }: { data: T | null; error: unknown; status: number }) =>
  ({ data, error, status }) as Fetched<T>;

// ── support groups (routes 53-66) ──────────────────────────────────────────────────────────────────────

export const listGroups = (
  client: ApiClient,
  query: ReqQuery<operations["getApiV1BereavementGroups"]>,
): Promise<Fetched<GroupPage>> =>
  send(() => client.GET("/api/v1/bereavement/groups", { params: { query } })).then(done);

export const createGroup = (
  client: ApiClient,
  body: GroupCreateBody,
  key?: string,
): Promise<Fetched<Group>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups", { headers: writeHeaders(null, key), body }),
  ).then(done);

export const getGroup = (client: ApiClient, groupId: string): Promise<Fetched<Group>> =>
  send(() =>
    client.GET("/api/v1/bereavement/groups/{groupId}", { params: { path: { groupId } } }),
  ).then(done);

export const updateGroup = (
  client: ApiClient,
  groupId: string,
  version: number,
  body: GroupUpdateBody,
  key?: string,
): Promise<Fetched<Group>> =>
  send(() =>
    client.PATCH("/api/v1/bereavement/groups/{groupId}", {
      params: { path: { groupId } },
      headers: writeHeaders(version, key),
      body,
    }),
  ).then(done);

export const openGroup = (
  client: ApiClient,
  groupId: string,
  version: number,
  key?: string,
): Promise<Fetched<Group>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/open", {
      params: { path: { groupId } },
      headers: writeHeaders(version, key),
    }),
  ).then(done);

export const closeGroup = (
  client: ApiClient,
  groupId: string,
  version: number,
  status: "completed" | "cancelled",
  key?: string,
): Promise<Fetched<Group>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/close", {
      params: { path: { groupId } },
      headers: writeHeaders(version, key),
      body: { status },
    }),
  ).then(done);

export const listSessions = (
  client: ApiClient,
  groupId: string,
): Promise<Fetched<GroupSession[]>> =>
  send(() =>
    client.GET("/api/v1/bereavement/groups/{groupId}/sessions", {
      params: { path: { groupId } },
    }),
  ).then(done);

export const addSession = (
  client: ApiClient,
  groupId: string,
  body: { startsAt: string; endsAt: string },
  key?: string,
): Promise<Fetched<GroupSession>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/sessions", {
      params: { path: { groupId } },
      headers: writeHeaders(null, key),
      body,
    }),
  ).then(done);

export const cancelSession = (
  client: ApiClient,
  groupId: string,
  sessionId: string,
  version: number,
  key?: string,
): Promise<Fetched<GroupSession>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/sessions/{sessionId}/cancel", {
      params: { path: { groupId, sessionId } },
      headers: writeHeaders(version, key),
    }),
  ).then(done);

export const getRoster = (client: ApiClient, groupId: string): Promise<Fetched<GroupRoster>> =>
  send(() =>
    client.GET("/api/v1/bereavement/groups/{groupId}/roster", { params: { path: { groupId } } }),
  ).then(done);

export const recordAttendance = (
  client: ApiClient,
  groupId: string,
  sessionId: string,
  contactIds: string[],
  key?: string,
): Promise<Fetched<AttendanceResult>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/sessions/{sessionId}/attendance", {
      params: { path: { groupId, sessionId } },
      headers: writeHeaders(null, key),
      body: { contactIds },
    }),
  ).then(done);

export const enrollContact = (
  client: ApiClient,
  groupId: string,
  contactId: string,
  key?: string,
): Promise<Fetched<Enrollment>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/enrollments", {
      params: { path: { groupId } },
      headers: writeHeaders(null, key),
      body: { contactId },
    }),
  ).then(done);

export const withdrawEnrollment = (
  client: ApiClient,
  groupId: string,
  contactId: string,
  reason: WithdrawReason,
  key?: string,
): Promise<Fetched<Enrollment>> =>
  send(() =>
    client.POST("/api/v1/bereavement/groups/{groupId}/enrollments/{contactId}/withdraw", {
      params: { path: { groupId, contactId } },
      headers: writeHeaders(null, key),
      body: { reason },
    }),
  ).then(done);

export const listContactEnrollments = (
  client: ApiClient,
  contactId: string,
): Promise<Fetched<Enrollment[]>> =>
  send(() =>
    client.GET("/api/v1/bereavement/contacts/{contactId}/support-groups", {
      params: { path: { contactId } },
    }),
  ).then(done);

// ── memorial services (routes 67-76) ───────────────────────────────────────────────────────────────────

export const listMemorials = (
  client: ApiClient,
  query: ReqQuery<operations["getApiV1BereavementMemorials"]>,
): Promise<Fetched<MemorialPage>> =>
  send(() => client.GET("/api/v1/bereavement/memorials", { params: { query } })).then(done);

export const createMemorial = (
  client: ApiClient,
  body: MemorialBody,
  key?: string,
): Promise<Fetched<Memorial>> =>
  send(() =>
    client.POST("/api/v1/bereavement/memorials", { headers: writeHeaders(null, key), body }),
  ).then(done);

export const getMemorial = (client: ApiClient, serviceId: string): Promise<Fetched<Memorial>> =>
  send(() =>
    client.GET("/api/v1/bereavement/memorials/{serviceId}", { params: { path: { serviceId } } }),
  ).then(done);

export const updateMemorial = (
  client: ApiClient,
  serviceId: string,
  version: number,
  body: MemorialBody,
  key?: string,
): Promise<Fetched<Memorial>> =>
  send(() =>
    client.PATCH("/api/v1/bereavement/memorials/{serviceId}", {
      params: { path: { serviceId } },
      headers: writeHeaders(version, key),
      body,
    }),
  ).then(done);

export const publishMemorial = (
  client: ApiClient,
  serviceId: string,
  version: number,
  key?: string,
): Promise<Fetched<Memorial>> =>
  send(() =>
    client.POST("/api/v1/bereavement/memorials/{serviceId}/publish", {
      params: { path: { serviceId } },
      headers: writeHeaders(version, key),
    }),
  ).then(done);

export const closeMemorial = (
  client: ApiClient,
  serviceId: string,
  version: number,
  status: "held" | "cancelled",
  key?: string,
): Promise<Fetched<Memorial>> =>
  send(() =>
    client.POST("/api/v1/bereavement/memorials/{serviceId}/close", {
      params: { path: { serviceId } },
      headers: writeHeaders(version, key),
      body: { status },
    }),
  ).then(done);

export const listInvitations = (
  client: ApiClient,
  serviceId: string,
): Promise<Fetched<MemorialInvitation[]>> =>
  send(() =>
    client.GET("/api/v1/bereavement/memorials/{serviceId}/invitations", {
      params: { path: { serviceId } },
    }),
  ).then(done);

export const recordMemorialAttendance = (
  client: ApiClient,
  serviceId: string,
  invitationId: string,
  attended: boolean,
  key?: string,
): Promise<Fetched<MemorialInvitation>> =>
  send(() =>
    client.POST("/api/v1/bereavement/memorials/{serviceId}/invitations/{invitationId}/attendance", {
      params: { path: { serviceId, invitationId } },
      headers: writeHeaders(null, key),
      body: { attended },
    }),
  ).then(done);

export const listContactInvitations = (
  client: ApiClient,
  contactId: string,
): Promise<Fetched<ContactInvitation[]>> =>
  send(() =>
    client.GET("/api/v1/bereavement/contacts/{contactId}/memorial-invitations", {
      params: { path: { contactId } },
    }),
  ).then(done);

export const recordPhoneRsvp = (
  client: ApiClient,
  contactId: string,
  invitationId: string,
  body: RsvpBody,
  key?: string,
): Promise<Fetched<ContactInvitation>> =>
  send(() =>
    client.PUT(
      "/api/v1/bereavement/contacts/{contactId}/memorial-invitations/{invitationId}/rsvp",
      {
        params: { path: { contactId, invitationId } },
        headers: writeHeaders(null, key),
        body,
      },
    ),
  ).then(done);

// ── the grief library (routes 77-81) ───────────────────────────────────────────────────────────────────

export const listLibrary = (
  client: ApiClient,
  query: ReqQuery<operations["getApiV1BereavementLibrary"]> = {},
): Promise<Fetched<LibraryItem[]>> =>
  send(() => client.GET("/api/v1/bereavement/library", { params: { query } })).then(done);

export const registerLibraryItem = (
  client: ApiClient,
  body: LibraryCreateBody,
  key?: string,
): Promise<Fetched<LibraryItem>> =>
  send(() =>
    client.POST("/api/v1/bereavement/library", { headers: writeHeaders(null, key), body }),
  ).then(done);

export const updateLibraryItem = (
  client: ApiClient,
  itemId: string,
  version: number,
  body: LibraryUpdateBody,
  key?: string,
): Promise<Fetched<LibraryItem>> =>
  send(() =>
    client.PATCH("/api/v1/bereavement/library/{itemId}", {
      params: { path: { itemId } },
      headers: writeHeaders(version, key),
      body,
    }),
  ).then(done);

export const setLibraryStatus = (
  client: ApiClient,
  itemId: string,
  version: number,
  status: LibraryStatus,
  key?: string,
): Promise<Fetched<LibraryItem>> =>
  send(() =>
    client.POST("/api/v1/bereavement/library/{itemId}/status", {
      params: { path: { itemId } },
      headers: writeHeaders(version, key),
      body: { status },
    }),
  ).then(done);

/** A short-lived preview URL: a credential, held only until it is opened. `no-store` keeps it out of any cache. */
export const libraryUrl = (
  client: ApiClient,
  itemId: string,
  part: LibraryPart = "document",
): Promise<Fetched<LibraryUrl>> =>
  send(() =>
    client.GET("/api/v1/bereavement/library/{itemId}/url", {
      params: { path: { itemId }, query: { part } },
      cache: "no-store",
    }),
  ).then(done);

/** What the library upload accepts: MP4 video up to 500 MB (library items only, server-enforced), other files up to 25 MB. */
export const LIBRARY_UPLOAD_MIME: readonly UploadMimeType[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "video/mp4",
];
export const LIBRARY_MAX_BYTES = 25 * 1024 * 1024;
export const LIBRARY_MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** Steps 1-4 of the M22 verified upload for an org-level, patient-facing library document; aborts the reservation on any later failure. */
export async function uploadLibraryDocument(
  client: ApiClient,
  file: File,
  title: string,
): Promise<{ documentId: string } | { message: string }> {
  if (!LIBRARY_UPLOAD_MIME.includes(file.type as UploadMimeType)) {
    return { message: "Choose a PDF, PNG, JPEG or MP4 file." };
  }
  const isVideo = file.type === "video/mp4";
  if (file.size > (isVideo ? LIBRARY_MAX_VIDEO_BYTES : LIBRARY_MAX_BYTES)) {
    return {
      message: isVideo ? "That video is larger than 500 MB." : "That file is larger than 25 MB.",
    };
  }
  const digest = await sha256Hex(file);
  if (digest === null) {
    return { message: "This browser cannot hash the file (a secure connection is required)." };
  }
  const body: InitiateUploadBody = {
    mode: "new_document",
    aggregateType: "bereavement_library_item",
    retentionClass: "bereavement",
    patientFacing: true,
    title,
    mimeType: file.type as UploadMimeType,
    byteSize: file.size,
    sha256Hex: digest,
  };
  let started: Awaited<ReturnType<typeof initiateUpload>>;
  try {
    started = await initiateUpload(client, body);
  } catch {
    return { message: "The server could not be reached. Nothing was uploaded." };
  }
  if (!started.ok) return { message: started.message };
  const put = await putUploadBytes(started.value, file);
  if (!put.ok) {
    await abortUpload(client, started.value.uploadId).catch(() => undefined);
    return { message: put.message };
  }
  const completed = await completeUpload(client, started.value.uploadId).catch(() => null);
  if (!completed?.ok) {
    await abortUpload(client, started.value.uploadId).catch(() => undefined);
    return { message: completed?.message ?? "The upload could not be completed." };
  }
  return { documentId: completed.value.documentId };
}
