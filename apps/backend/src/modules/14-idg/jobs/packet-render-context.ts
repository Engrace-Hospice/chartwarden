// apps/backend/src/modules/14-idg/jobs/packet-render-context.ts — the DISPLAY context the M22 `idg_patient_packet`
// PDF needs beyond the frozen `built_snapshot`: the organization / location names for the header, and the staff
// display names of the carry-forward action items' assignees.
//
// The snapshot stays ids-only (it is the immutable §2.4 record and the eraser walks it); names ride ONLY the
// outbox `renderPayload` (`meeting` + `memberNames`), are re-derived at every emit and are never stored.
// The packet build runs in a WORKER (no request), so both lookups go through the org-explicit `...ForOrg` ports
// M14 declares structurally (`IdgSiteDisplayPort` / `IdgMembershipDisplayPort`), bound at the composition root.
//
// Degrade, never fail: an unbound or throwing port yields no names (a warning is logged — ids/counts only, never
// a name or payload) and the PDF falls back to its own "Member xxxxxxxx" / header-less rendering.
// 42 CFR Part 2: `memberNamesForSnapshot` walks the snapshot AFTER redaction, so an action item the Part 2
// redactor elided is never named.
import type { PacketSnapshot } from "@chartwarden/types";
import type { IdgMembershipDisplayPort, IdgSiteDisplayPort } from "../routes/idg-enrichment";

type Warn = (event: string, context: Record<string, unknown>) => void;

/** `membershipDisplayForOrg` caps one call at 500 ids. */
const NAME_CHUNK = 500;

export interface PacketSiteNames {
  readonly organizationName: string | null;
  readonly locationName: string | null;
}

/** ONE call per meeting: the organization display name + the meeting location's name. Never throws. */
export async function resolvePacketSiteNames(
  port: IdgSiteDisplayPort | undefined,
  organizationId: string,
  locationId: string,
  warn: Warn,
): Promise<PacketSiteNames> {
  const none: PacketSiteNames = { organizationName: null, locationName: null };
  if (!port) return none;
  try {
    const site = await port.displayForSite(organizationId, [locationId]);
    return {
      organizationName: site.organizationName,
      locationName: site.locationNames.get(locationId) ?? null,
    };
  } catch (error) {
    warn("m14.packet_build.site_display_unavailable", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}

/** Batched membership id -> display name (names only). Never throws; unresolved ids are simply absent. */
export async function resolveMemberNames(
  port: IdgMembershipDisplayPort | undefined,
  organizationId: string,
  membershipIds: Iterable<string>,
  warn: Warn,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(membershipIds)];
  if (!port || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += NAME_CHUNK) {
      const chunk = await port.displayForMemberships(organizationId, ids.slice(i, i + NAME_CHUNK));
      for (const [id, label] of chunk) {
        const name = label.displayName?.trim();
        if (name) out.set(id, name);
      }
    }
  } catch (error) {
    warn("m14.packet_build.member_display_unavailable", {
      organizationId,
      idCount: ids.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return out;
}

/** The membership ids the packet PDF prints a name for: the (post-redaction) carry-forward assignees. */
export function packetMemberIds(snapshot: PacketSnapshot): string[] {
  return snapshot.carryForwardActionItems.map((a) => a.assignedToMembershipId as string);
}

/**
 * The per-patient render-payload additions: `meeting` (ids + header names, omitted when absent) and `memberNames`
 * restricted to the assignees PRESENT in this (already redacted) snapshot — the meeting-wide name map is a superset.
 */
export function buildPacketRenderContext(
  snapshot: PacketSnapshot,
  args: {
    readonly meetingId: string;
    readonly locationId: string;
    readonly site: PacketSiteNames;
    readonly names: ReadonlyMap<string, string>;
  },
): {
  readonly meeting: {
    readonly meetingId: string;
    readonly locationId: string;
    readonly organizationName?: string;
    readonly locationName?: string;
  };
  readonly memberNames: Record<string, string>;
} {
  const memberNames: Record<string, string> = {};
  for (const id of packetMemberIds(snapshot)) {
    const name = args.names.get(id);
    if (name) memberNames[id] = name;
  }
  return {
    meeting: {
      meetingId: args.meetingId,
      locationId: args.locationId,
      ...(args.site.organizationName ? { organizationName: args.site.organizationName } : {}),
      ...(args.site.locationName ? { locationName: args.site.locationName } : {}),
    },
    memberNames,
  };
}
