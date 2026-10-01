// apps/backend/src/modules/31-portal/telehealth/room-mint.ts — F-220 (#248): the LAZY room mint.
//
// DECISION (user-approved triage of the `m31 <- m17.visit.published` pair): M31 does NOT mint a room when a visit
// is published. M17 models no "video requested" flag (`VisitSetting` is patient_home|facility|inpatient_unit|
// telephonic), M31 has no jobs tier for a `m31.telehealth-room-mint` worker, and a published-visit push would mint
// a vendor room for every telephonic visit whether or not anyone ever opens it. Instead the room is minted on the
// FIRST clinician JOIN of a `telephonic` visit, through a seam PULL of the M17 visit (the org-explicit published
// `VisitReader`, composed at the composition root). `m31` is therefore a `seamConsumers` entry on
// `m17.visit.published`, not a `declaredConsumers` one.
//
// WHAT THIS DOES NOT DO (reported in F-220): the patient-side join is gated by the `telehealth_consent_active` ABAC
// predicate, which resolves the patient from an EXISTING `telehealth_visit` row — so a patient can join only after a
// clinician's join has minted the room; and the production composition root leaves the vendor adapter UNBOUND (no
// per-tenant Daily.co key vault), so until one is wired `mintRoom` is absent and a lazy mint fails CLOSED with
// `TELEHEALTH_VENDOR_UNAVAILABLE` (503) rather than writing a row with no real room behind it.
//
// IDEMPOTENT: an existing row for the M17 visit (unique on `m17_visit_id`) is returned untouched; a concurrent
// double-mint loses the INSERT race on that unique index and re-reads the winner (the loser's vendor room is an
// orphan the vendor reaps on its TTL — `mintRoom` is idempotent on the telehealth id it is given).
import type { TelehealthVisitDigest } from "@wardenx/types";
import type { PortalRoomCipher } from "../portal-crypto";
import { TelehealthStateError } from "./errors";

/** The slice of an M17 `VisitDto` the room mint reads (structural — M31 takes no M17 type edge at this seam). */
export interface M17VisitForRoom {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly assignedMembershipId: string;
  readonly visitSetting: string;
  readonly scheduledStartedAt: string;
  readonly status: string;
}

/** M17's org-explicit published visit read, injected at the composition root (`VisitReader.visitForEncounter`). */
export interface M17VisitRoomReaderPort {
  visitForOrg(organizationId: string, visitId: string): Promise<M17VisitForRoom | null>;
}

/** The vendor adapter slice the mint needs; `mintRoom` is optional so an unbound (NOOP) adapter fails closed. */
export interface RoomMintAdapterPort {
  readonly vendor: "daily_co" | "twilio_video" | "native_webrtc";
  mintRoom?(input: {
    telehealthVisitId: string;
    scheduledStartedAt: string;
    recordingEnabled: boolean;
  }): Promise<{ vendorRoomId: string; vendorRoomUrl: string }>;
}

/** The two owned-table ops the mint needs (a subset of `PortalOwnedTableOps`). */
export interface RoomMintStorePort {
  telehealthByM17VisitId(orgId: string, m17VisitId: string): Promise<TelehealthVisitDigest | null>;
  insertTelehealthVisitIfAbsent(
    orgId: string,
    userId: string,
    row: {
      readonly id: string;
      readonly providerEntityId: string;
      readonly locationId: string | null;
      readonly m17VisitId: string;
      readonly patientId: string;
      readonly assignedMembershipId: string;
      readonly vendor: "daily_co" | "twilio_video" | "native_webrtc";
      readonly vendorRoomIdCipher: string;
      readonly vendorRoomUrlCipher: string;
      readonly scheduledVisitSetting: "telephonic";
    },
  ): Promise<TelehealthVisitDigest | null>;
}

export interface RoomMintPorts {
  readonly visits: M17VisitRoomReaderPort;
  readonly cipher: PortalRoomCipher;
  readonly adapter: RoomMintAdapterPort;
  readonly store: RoomMintStorePort;
  readonly newId?: () => string;
}

/** M17 visit states in which a room is still useful (a published or in-progress visit; never a terminal one). */
export const ROOM_ELIGIBLE_VISIT_STATUSES: ReadonlySet<string> = new Set([
  "published",
  "en_route",
  "in_visit",
]);

/**
 * Pure eligibility decision: a `telephonic` visit, in THIS tenant, that is still live. Anything else (other
 * settings, terminal states, a visit from another org) is not a room the caller may mint — the caller answers 404,
 * indistinguishable from "no such visit".
 */
export function isRoomEligible(visit: M17VisitForRoom, organizationId: string): boolean {
  return (
    visit.organizationId === organizationId &&
    visit.visitSetting === "telephonic" &&
    ROOM_ELIGIBLE_VISIT_STATUSES.has(visit.status)
  );
}

/**
 * Return the telehealth room for an M17 visit, minting it if this is the first ask. `null` ⇒ no such visit, not
 * visible in this tenant, or not room-eligible. Throws `TELEHEALTH_VENDOR_UNAVAILABLE` (503) when the vendor adapter
 * cannot mint (unbound or failing) — never a half-written row.
 */
export async function ensureTelehealthRoomForVisit(
  ports: RoomMintPorts,
  organizationId: string,
  userId: string,
  m17VisitId: string,
): Promise<TelehealthVisitDigest | null> {
  const existing = await ports.store.telehealthByM17VisitId(organizationId, m17VisitId);
  if (existing) return existing;

  const visit = await ports.visits.visitForOrg(organizationId, m17VisitId);
  if (!visit || !isRoomEligible(visit, organizationId)) return null;

  const mint = ports.adapter.mintRoom?.bind(ports.adapter);
  if (!mint) {
    throw new TelehealthStateError(
      "TELEHEALTH_VENDOR_UNAVAILABLE",
      "no telehealth vendor adapter is bound, so a room cannot be minted for this visit",
    );
  }
  const id = (ports.newId ?? (() => crypto.randomUUID()))();
  let room: { vendorRoomId: string; vendorRoomUrl: string };
  try {
    room = await mint({
      telehealthVisitId: id,
      scheduledStartedAt: visit.scheduledStartedAt,
      recordingEnabled: false,
    });
  } catch {
    throw new TelehealthStateError(
      "TELEHEALTH_VENDOR_UNAVAILABLE",
      "the telehealth vendor could not mint a room for this visit",
    );
  }
  const [vendorRoomIdCipher, vendorRoomUrlCipher] = await Promise.all([
    ports.cipher.encrypt(organizationId, "vendor_room_id", room.vendorRoomId),
    ports.cipher.encrypt(organizationId, "vendor_room_url", room.vendorRoomUrl),
  ]);
  const inserted = await ports.store.insertTelehealthVisitIfAbsent(organizationId, userId, {
    id,
    providerEntityId: visit.providerEntityId,
    locationId: visit.locationId,
    m17VisitId: visit.id,
    patientId: visit.patientId,
    assignedMembershipId: visit.assignedMembershipId,
    vendor: ports.adapter.vendor,
    vendorRoomIdCipher,
    vendorRoomUrlCipher,
    scheduledVisitSetting: "telephonic",
  });
  // Lost the unique-index race to a concurrent mint: return the winner.
  return inserted ?? (await ports.store.telehealthByM17VisitId(organizationId, m17VisitId));
}
