// @chartwarden/messaging — channel-member administration authority (M36 spec §4.5, GAP-103).
//
// `messaging.manage_members` is held by org_admin and by clinical_lead "limited to their location
// channels" (`location_membership`). The permission alone is NOT enough: a holder could otherwise add
// themselves to any care_team channel, and because channel visibility is a membership check that is a
// PHI read grant. This pure rule is shared by the route predicate and both service implementations.
import { ForbiddenError, ChartWardenError } from "@chartwarden/types";
import type { ChannelKind } from "./interfaces/kinds";

/** Who is administering members. Internal/system callers pass the explicit `system` marker — it is
 *  never inferred from a role string. */
export type MemberAdminActor =
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly roles: readonly string[];
      readonly locationIds: readonly string[];
    }
  | { readonly kind: "system" };

export const ORG_ADMIN_ROLE = "org_admin";
export const CLINICAL_LEAD_ROLE = "clinical_lead";

/** Resolves the location ids a patient is currently sited at. The caller (backend) binds this to its
 *  siting seam; this package never imports the backend. Any throw is treated as "no locations". */
export type PatientLocationResolver = (
  organizationId: string,
  patientId: string,
) => Promise<readonly string[]>;

/** Fail-closed: org_admin → any channel; clinical_lead → a `location` channel whose subject is one of
 *  the actor's own locations, or a `care_team` channel whose subject patient is sited at (at least) one
 *  of the actor's locations (`patientLocationIds`, resolved by the caller); everyone else → false. */
export function mayManageChannelMembers(
  actor: MemberAdminActor,
  channel: { readonly kind: ChannelKind | string; readonly subjectId: string | null },
  patientLocationIds?: readonly string[],
): boolean {
  if (actor.kind === "system") return true;
  if (actor.roles.includes(ORG_ADMIN_ROLE)) return true;
  if (!actor.roles.includes(CLINICAL_LEAD_ROLE)) return false;
  if (!channel.subjectId) return false;
  if (channel.kind === "location") return actor.locationIds.includes(channel.subjectId);
  if (channel.kind === "care_team") {
    return (patientLocationIds ?? []).some((id) => actor.locationIds.includes(id));
  }
  return false;
}

/** Resolves the patient's siting only when the decision needs it (a clinical_lead on a care_team
 *  channel), then applies the pure rule. A missing or throwing resolver denies. */
export async function mayManageChannelMembersResolved(
  actor: MemberAdminActor,
  channel: { readonly kind: ChannelKind | string; readonly subjectId: string | null },
  resolve: ((patientId: string) => Promise<readonly string[]>) | undefined,
): Promise<boolean> {
  const needsSiting =
    actor.kind === "user" &&
    !actor.roles.includes(ORG_ADMIN_ROLE) &&
    actor.roles.includes(CLINICAL_LEAD_ROLE) &&
    channel.kind === "care_team" &&
    !!channel.subjectId;
  if (!needsSiting) return mayManageChannelMembers(actor, channel);
  if (!resolve || !channel.subjectId) return false;
  try {
    return mayManageChannelMembers(actor, channel, await resolve(channel.subjectId));
  } catch {
    return false; // fail closed: an unbound/unreadable siting seam never grants access
  }
}

/** Channel kinds an admin may archive by hand. The others are not the admin's to close: `dm` is private,
 *  `announcement` is the tenant's one broadcast channel, and `care_team` / `bereavement` / `on_call` are driven by
 *  the M5/M6/M16/M19 lifecycle (a manual archive would be silently reopened by the next assignment event). */
export const ADMIN_ARCHIVABLE_CHANNEL_KINDS: readonly string[] = ["discipline", "location"];

/** The archive / unarchive decision both service implementations share: org_admin only (else 403), a `dm` is 403,
 *  and any other lifecycle-managed kind is 409. Throws; returns when the change may proceed. */
export function assertMayArchiveChannel(
  actor: MemberAdminActor,
  kind: ChannelKind | string,
  verb: "archive" | "unarchive" = "archive",
): void {
  if (actor.kind !== "user" || !actor.roles.includes(ORG_ADMIN_ROLE)) {
    throw new ForbiddenError(`only an org admin may ${verb} a channel`);
  }
  if (kind === "dm") throw new ForbiddenError(`a direct message cannot be ${verb}d`);
  if (!ADMIN_ARCHIVABLE_CHANNEL_KINDS.includes(kind)) {
    throw new ChartWardenError(
      "CHANNEL_LIFECYCLE_MANAGED",
      "this channel's archive state follows its source record",
      409,
    );
  }
}
