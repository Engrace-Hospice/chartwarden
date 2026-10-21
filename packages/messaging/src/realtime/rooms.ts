// @chartwarden/messaging — Socket.IO room grammar + connect-time room-set computation (M36-T08, §4.3).
//
// Pure, infra-free room-name builders and the one-shot room-set computation the Socket.IO handshake
// runs at connect (§4.3): given the authenticated user's current channel memberships, on-call
// rotation, roles, default locations, and tenant context, return the EXACT set of rooms to join.
// The Socket.IO server (M1 infra) calls `computeRoomSet` after Better Auth validates the handshake
// token, then `socket.join(room)` for each. Recomputed on `permissions.changed` (M3 §11 D6). This
// module imports no socket.io / Valkey client — the room set is cached under `rooms:user:<id>`
// (cache/keys) by the wiring layer.
//
// §4.3 invariant encoded here: every authenticated user joins `user:<orgId>:<id>` (personal alerts) and
// `org:<orgId>` (announcements). All other rooms are EARNED — a membership row, a held role, an
// on-call/billing assignment. The set is sorted + de-duplicated so a recompute is diffable.

import type { ChannelKind } from "../interfaces/kinds";

// --- room-name builders (the §4.3 room table) -------------------------------------------------

/**
 * `user:<orgId>:<userId>` — personal alerts. Org-scoped on purpose: a user with memberships in two orgs holds one
 * socket per session org, and a hint or revoke for org A must never reach their org B socket.
 */
export function userRoom(orgId: string, userId: string): string {
  return `user:${orgId}:${userId}`;
}
/** `account:<userId>` — every socket of the person, any org; only for platform-wide offboarding (never for hints). */
export function accountRoom(userId: string): string {
  return `account:${userId}`;
}
/** `careteam:<patientId>` — one room per active care-team channel. */
export function careTeamRoom(patientId: string): string {
  return `careteam:${patientId}`;
}
/** `discipline:<orgId>:<disciplineKey>` — members holding the discipline role. */
export function disciplineRoom(orgId: string, disciplineKey: string): string {
  return `discipline:${orgId}:${disciplineKey}`;
}
/** `location:<locationId>` — members whose default locations include it. */
export function locationRoom(locationId: string): string {
  return `location:${locationId}`;
}
/** `oncall:<providerEntityId>` — current on-call (from M19), rotated on shift change. */
export function onCallRoom(providerEntityId: string): string {
  return `oncall:${providerEntityId}`;
}
/** `safety:<orgId>` — supervisor-role members; high-priority SOS broadcast. */
export function fieldSafetyRoom(orgId: string): string {
  return `safety:${orgId}`;
}
/** `org:<orgId>` — every authenticated user in the org (announcements only). */
export function orgRoom(orgId: string): string {
  return `org:${orgId}`;
}
/** `billing:<providerEntityId>` — billing-role members in that ProviderEntity. */
export function billingRoom(providerEntityId: string): string {
  return `billing:${providerEntityId}`;
}
/** `idg:<locationId>` — IDG-attendee role members. */
export function idgRoom(locationId: string): string {
  return `idg:${locationId}`;
}

/** A channel the connecting user is an active member of — the room-set input for channel rooms. */
export interface ConnectChannelMembership {
  readonly channelId: string;
  readonly kind: ChannelKind;
  /** The channel's subject id (patientId for care_team, locationId for location, …); null for DM/announcement. */
  readonly subjectId: string | null;
}

/**
 * Everything the connect-time room computation reads (§4.3). One-shot at connect: the wiring layer
 * assembles this from the M2 session (roles), the channel-member rows, and the M19 on-call / M2
 * location seams. `supervisorRole` / `billingRole` / `idgRole` are pre-resolved booleans/lists so
 * this function stays free of any role-string convention.
 */
export interface RoomSetInput {
  readonly userId: string;
  readonly orgId: string;
  /** Active channel memberships (drives care_team / discipline / location channel rooms). */
  readonly channels: readonly ConnectChannelMembership[];
  /** Discipline keys the user's roles grant (re-evaluated on role grant). */
  readonly disciplineKeys?: readonly string[];
  /** The user's default location ids (location rooms + IDG when an IDG attendee). */
  readonly defaultLocationIds?: readonly string[];
  /** Provider entities the user is currently on-call for (from M19). */
  readonly onCallProviderEntityIds?: readonly string[];
  /** Provider entities the user holds the billing role in. */
  readonly billingProviderEntityIds?: readonly string[];
  /** True when the user holds a field-safety supervisor role (joins `safety:<orgId>`). */
  readonly isFieldSafetySupervisor?: boolean;
  /** True when the user is an IDG attendee (joins `idg:<locationId>` for each default location). */
  readonly isIdgAttendee?: boolean;
}

/**
 * Compute the EXACT set of Socket.IO rooms the connecting user joins (§4.3). Pure: same input → same
 * sorted, de-duplicated set, so a recompute on `permissions.changed` produces a diffable join/leave.
 *
 *   • always         → `user:<orgId>:<id>`, `account:<id>`, `org:<orgId>`
 *   • per membership → care_team→`careteam:<patientId>`, discipline→`discipline:<org>:<key>`,
 *                      location→`location:<locationId>` (subject-backed; on_call channels surface
 *                      via the on-call assignment list below, not their channel row)
 *   • per role/assn  → on-call→`oncall:<pe>`, billing→`billing:<pe>`, supervisor→`safety:<org>`,
 *                      IDG attendee→`idg:<locationId>`, discipline role→`discipline:<org>:<key>`
 *
 * A care_team / location channel with a null subject contributes no channel room (defensive — the
 * §3.3 CHECK forbids it, but the computation never trusts a malformed row into a cross-patient room).
 */
export function computeRoomSet(input: RoomSetInput): string[] {
  const rooms = new Set<string>([
    userRoom(input.orgId, input.userId),
    accountRoom(input.userId),
    orgRoom(input.orgId),
  ]);

  for (const ch of input.channels) {
    if (ch.subjectId === null) continue; // DM / announcement carry no subject-backed room
    if (ch.kind === "care_team") rooms.add(careTeamRoom(ch.subjectId));
    else if (ch.kind === "discipline") rooms.add(disciplineRoom(input.orgId, ch.subjectId));
    else if (ch.kind === "location") rooms.add(locationRoom(ch.subjectId));
  }

  for (const key of input.disciplineKeys ?? []) rooms.add(disciplineRoom(input.orgId, key));
  for (const loc of input.defaultLocationIds ?? []) rooms.add(locationRoom(loc));
  for (const pe of input.onCallProviderEntityIds ?? []) rooms.add(onCallRoom(pe));
  for (const pe of input.billingProviderEntityIds ?? []) rooms.add(billingRoom(pe));
  if (input.isFieldSafetySupervisor) rooms.add(fieldSafetyRoom(input.orgId));
  if (input.isIdgAttendee)
    for (const loc of input.defaultLocationIds ?? []) rooms.add(idgRoom(loc));

  return [...rooms].sort();
}
