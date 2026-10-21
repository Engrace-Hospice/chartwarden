// apps/backend/src/modules/20-field-safety/consumers/m19-after-hours.ts — M20-T04 (§7.5 D14, §4.4, §4.5).
//
// The M19 arm of the §4.5 `field_safety_composed` recipient set: when an SOS (or an `sos_equivalent`
// overdue rung) fires inside the tenant's after-hours window, the on-call rotation is paged in PARALLEL
// with the clinician's own supervisors. Landing this is what REPLACES the Phase-1 SOS degraded fallback
// (Wave P2-2 acceptance #3). The union itself — supervisors ∪ this set — is M20-T05's, where
// `SafetySupervisorProvider` exists to supply the other side.
//
// THREE ANSWERS, NOT ONE LIST. `SafetyAfterHoursParallelSet` is a discriminated union because the three
// outcomes route differently and collapsing any two of them loses a life-safety distinction:
//
//   • `not_after_hours` — 11 a.m. on a Tuesday. There is no parallel set; §7.4 is explicit that M19 is not
//     consulted, and asking anyway would page the on-call RN for every daytime press.
//   • `resolved` — M19 answered. `recipients` may be EMPTY and that is a real answer (nobody is rostered
//     tonight), which is a finding the fan-out layer surfaces rather than hides.
//   • `unavailable` — M19 did not answer. M19 states the posture on the seam itself and M20 must not
//     soften it: "we cannot tell you who is on call" is NOT "nobody is on call". Catching the throw into
//     an empty array would make a registry outage indistinguishable from a genuine coverage gap and would
//     drop the on-call rotation out of a 3 a.m. SOS in silence. The alert layer's branch on `unavailable`
//     is the tenant emergency number (M20-F01).
//
// AN EXTERNAL TRIAGE VENDOR IS NOT A MEMBERSHIP, AND THE SET SAYS SO. `OnCallActor` is discriminated on
// `membership` vs `external_vendor`, and the vendor arm carries an `ExternalTriageVendorId` with NO
// membership id — there is nothing for M36 to deliver an in-app or push notification to. Dropping that arm
// would produce an EMPTY `recipients` array for a Saturday night that is in fact covered, which reads on
// every downstream surface as an uncovered night. So vendor actors are carried on their own field:
// `recipients.length === 0 && externalActors.length > 0` is "covered, but not by anyone M36 can reach as a
// membership", and it is the fan-out layer's job (M20-T06) to route that through the vendor's own channel.
// The distinction is made HERE, in the open, rather than by an empty list somewhere downstream.
import type {
  IsoInstant,
  OnCallActor,
  OrgId,
  ProviderEntityId,
  SafetyPolicyEffectiveDto,
} from "@chartwarden/types";
import { isAfterHours } from "../lifecycle/policy";
import { getOnCallProvider } from "../seams/consumed";

/** One M19 on-call actor as an M36 recipient. `scope` is the §4.5 label the composed resolver emits, kept
 *  literal so a supervisor row and an on-call row can never be confused after the union. */
export interface SafetyOnCallParallelRecipient {
  readonly membershipId: string;
  /** M19's OWN user id for the membership (`OnCallActor.userId`). M36 delivers to users, and the §4.5
   *  composed resolver (../alert-rules, M20-T05) uses this rather than re-resolving the membership: a
   *  second lookup could disagree with M19 about which account holds tonight's shift, and the pager is
   *  the wrong place to discover that. */
  readonly userId: string;
  readonly scope: "on_call_parallel";
  readonly shiftId: string;
  readonly discipline: string;
  readonly isBackup: boolean;
}

/** An on-call shift covered by an external triage vendor — real coverage with no membership to page. */
export interface SafetyOnCallExternalActor {
  readonly shiftId: string;
  readonly externalActorId: string;
  readonly externalActorLabel: string | null;
}

/** The D14 answer. See the header on why all three arms exist. */
export type SafetyAfterHoursParallelSet =
  | { readonly kind: "not_after_hours" }
  | {
      readonly kind: "resolved";
      readonly recipients: readonly SafetyOnCallParallelRecipient[];
      readonly externalActors: readonly SafetyOnCallExternalActor[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Split M19's actor union into the two things M36 can act on.
 *
 * Deduplicated by membership, primary beating backup: one person may hold the primary slot on one shift
 * and the backup slot on another, and paging the same phone twice for one SOS is noise on the channel that
 * can least afford it. Primaries are emitted first so a fan-out that treats position as priority reaches
 * the person who is actually holding the pager.
 */
export function partitionOnCallActors(actors: readonly OnCallActor[]): {
  readonly recipients: readonly SafetyOnCallParallelRecipient[];
  readonly externalActors: readonly SafetyOnCallExternalActor[];
} {
  const byMembership = new Map<string, SafetyOnCallParallelRecipient>();
  const externalActors: SafetyOnCallExternalActor[] = [];

  for (const actor of actors) {
    if (actor.kind === "external_vendor") {
      externalActors.push({
        shiftId: actor.shiftId,
        externalActorId: actor.externalActorId,
        externalActorLabel: actor.externalActorLabel,
      });
      continue;
    }
    const existing = byMembership.get(actor.membershipId);
    if (existing !== undefined && !existing.isBackup) continue;
    byMembership.set(actor.membershipId, {
      membershipId: actor.membershipId,
      userId: actor.userId,
      scope: "on_call_parallel",
      shiftId: actor.shiftId,
      discipline: actor.discipline,
      isBackup: actor.isBackup,
    });
  }

  const recipients = [...byMembership.values()].sort(
    (a, b) => Number(a.isBackup) - Number(b.isBackup),
  );
  return { recipients, externalActors };
}

/**
 * §7.5 D14 — resolve the parallel set for one alert instant.
 *
 * `orgTimeZone` is REQUIRED and has no default. The policy row carries `after_hours_start_hour` /
 * `_end_hour` as bare integers with no zone column (§3.3), so reading them off UTC puts a Pacific agency's
 * night shift at 10 a.m. and the D14 union never fires for the hours it exists for. `isAfterHours`
 * (../lifecycle/policy) is where the midnight-wrapping disjunction lives.
 */
export async function resolveAfterHoursParallelSet(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly atIso: IsoInstant;
  readonly policy: Pick<SafetyPolicyEffectiveDto, "afterHoursStartHour" | "afterHoursEndHour">;
  readonly orgTimeZone: string;
}): Promise<SafetyAfterHoursParallelSet> {
  if (!isAfterHours(input.policy, input.atIso, input.orgTimeZone)) {
    return { kind: "not_after_hours" };
  }

  try {
    const actors = await getOnCallProvider().currentOnCallActors(
      input.orgId,
      input.providerEntityId,
      input.atIso,
    );
    return { kind: "resolved", ...partitionOnCallActors(actors) };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "OnCallProvider read failed",
    };
  }
}
