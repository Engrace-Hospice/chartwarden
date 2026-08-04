// apps/backend/src/modules/20-field-safety/alert-rules.ts — M20-T05 (§4.5, §7.5 D14, §4.9).
//
// M20's contribution to M36's alert engine: the `field_safety_composed` recipient resolver that unions
// this clinician's supervisors (M20's `SafetySupervisorProvider`) with the on-call rotation (M19's
// `OnCallProvider`, through M20-T04's three-valued after-hours read) at the ONE point M36 resolves
// recipients. This is the ADR-0024 composition-resolver precedent (`registerCompositionResolvers`,
// packages/messaging/src/compose/resolvers.ts) and the M34 precedent (34-saas-tenant-platform/
// alert-rules.ts): M20 adds a NEW resolver name to M36's OPEN registry without changing M36's seven
// built-ins and without an import edge from M36 to M20. This file imports `@wardenx/messaging` (M36)
// types only; the inverse never happens.
//
// The composition is what makes a 3-AM SOS reach both the on-call supervisor (per M20's subscription
// rows) and the on-call clinical rotation (per M19's shift rows) without M20 importing M19's schema and
// without M19 knowing safety alerts exist.
//
// ── §4.5's SAMPLE RETURNS MEMBERSHIPS; M36's CONTRACT RETURNS USERS ───────────────────────────────────
//
// §4.5 sketches the resolver returning `{ membershipId, scope }` objects. M36's `RecipientResolverFn` is
// `(orgId, args, payload) => Promise<readonly string[]>` and those strings are `user_id`s — that is what
// the delivery rows are keyed on. M20 binds to the OWNER's contract rather than redefining it (the
// M15/M17 `VolunteerComplianceProvider` precedent: a re-declared seam is a permanently unbound one), so
// the membership→user resolution happens HERE, through the store, and the `scope` label the sample
// carries survives as the {@link SafetyComposedGap} reporting below rather than as a field M36 would
// discard.
//
// ── WHAT THE `string[]` RETURN CANNOT SAY, AND WHY THAT NEEDS A SECOND CHANNEL ────────────────────────
//
// Three things happen during composition that a list of user ids is structurally incapable of expressing,
// and every one of them is a life-safety fact:
//
//   1. M19 DID NOT ANSWER. `resolveAfterHoursParallelSet` returns `unavailable` (never `[]` — M20-T04's
//      rule, because `[]` from `OnCallProvider` is a REAL coverage gap). The supervisors are still
//      resolvable and must still be paged, so the resolver returns them; but the on-call rotation has
//      silently dropped out of a 3 a.m. SOS and something has to say so.
//   2. THE NIGHT IS COVERED BY AN EXTERNAL TRIAGE VENDOR. `OnCallActor`'s vendor arm carries no
//      membership and no user (M19-T01 made it structurally incapable of one), so there is nothing for
//      M36 to deliver an in-app or push notification to. `recipients.length === 0 &&
//      externalActors.length > 0` is "covered, but not by anyone M36 can reach as a membership" — routing
//      that through the vendor's own channel is M20-T06's, and dropping it silently would make a covered
//      Saturday look uncovered.
//   3. THE COMPOSED SET IS EMPTY. That is the §7.8 coverage gap the system-locked critical alert wakes
//      the DON for, and M36 will fan out to nobody.
//
// So `M20AlertResolverPorts.onCompositionGap` is a REQUIRED port, not an optional callback. Optional is
// exactly the hole: a wiring that forgot it would degrade in silence at 3 a.m. and every test would pass.
// The boot wiring binds it to a metric + a `warn` audit line; a test binds it to an array.
//
// ── THE RESOLVER DOES NOT CATCH ──────────────────────────────────────────────────────────────────────
//
// `SafetySupervisorProvider.supervisorsForClinician` throws when it cannot read (its own §4.3 fail
// posture), and this resolver lets that propagate to M36. Catching it into `[]` would reproduce the exact
// failure the seam's posture exists to prevent: M36 cannot tell an empty recipient list from a genuine
// coverage gap, so it would record a successful fan-out to nobody instead of taking its degraded alert
// path (which is what reaches the tenant emergency number, M20-F01).

import type { RecipientResolverFn } from "@wardenx/messaging";
import type { IsoInstant, MembershipId, OrgId, ProviderEntityId } from "@wardenx/types";
import type { SafetyAfterHoursParallelSet } from "./consumers/m19-after-hours";

/** The resolver name M20 adds to M36's registry (§4.5). */
export const M20_COMPOSED_RECIPIENT_RESOLVER = "field_safety_composed";

/** The M36 alert-rule key the composed resolver is bound to (§4.5 / M36 §4.5 seed). */
export const M20_SOS_ALERT_RULE_KEY = "field_safety.sos";

/**
 * §4.5 — the channel override the composed rule carries. `voice` is the Tier-1 escalation contract
 * (integrations §6.13) and the rule is `system_locked` in M36's catalog, so a tenant cannot switch it
 * off. Declared here as data; the boot UPSERT that writes it as an M36 rule row lands with the §4.1
 * routes (M20-T06), alongside the rest of M20's M36 wiring.
 */
export const M20_SOS_CHANNELS_OVERRIDE = ["in_app", "push", "sms", "voice"] as const;

/** What the composed set could not express as a user id. See the header — each is a life-safety fact. */
export type SafetyComposedGap =
  | { readonly kind: "on_call_unavailable"; readonly reason: string }
  | {
      readonly kind: "external_actors_unreachable";
      readonly shiftIds: readonly string[];
    }
  | { readonly kind: "no_recipients" }
  | {
      readonly kind: "unresolvable_memberships";
      readonly membershipIds: readonly MembershipId[];
    };

/**
 * The source-of-truth lookups the composed resolver delegates to — bound at boot to M20's own
 * `SafetySupervisorProvider`, M20-T04's D14 after-hours read and the seam store's membership→user map.
 * Plain async ports (the ADR-0024 `CompositionResolverPorts` / M34 `M34AlertResolverPorts` precedent) so
 * the composition stays pure and unit-testable with fakes.
 */
export interface M20AlertResolverPorts {
  /** M20's §4.3 `SafetySupervisorProvider.supervisorsForClinician`. THROWS on an unreadable registry. */
  supervisorsForClinician(
    orgId: OrgId,
    clinicianMembershipId: MembershipId,
    alertKind: "sos" | "overdue" | "incident" | "high_risk_area",
  ): Promise<
    readonly {
      readonly supervisorMembershipId: MembershipId;
      readonly isVacationForwarded: boolean;
      readonly vacationForwardToMembershipId: MembershipId | null;
    }[]
  >;
  /** M20-T04's §7.5 D14 read — three-valued, and `unavailable` is never `[]`. */
  afterHoursParallelSet(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    atIso: IsoInstant,
  ): Promise<SafetyAfterHoursParallelSet>;
  /** M36 delivers to USERS; M20's subscription rows name memberships. Absent ⇒ unresolvable. */
  userIdsForMemberships(
    orgId: OrgId,
    membershipIds: readonly MembershipId[],
  ): Promise<ReadonlyMap<MembershipId, string>>;
  /** REQUIRED. See the header on why this is not an optional callback. */
  onCompositionGap(orgId: OrgId, gap: SafetyComposedGap): void;
}

/** Read a non-empty string off the payload at `key`, else null (mirrors M36's core resolvers). */
function readPath(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A `*Path` arg as a string (where in the payload a subject id lives), or undefined. */
function pathArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * §4.3's own note, applied: deliver to the FORWARD TARGET when the row forwards, to the subscriber
 * otherwise.
 *
 * A resolver that ignored `isVacationForwarded` would page a supervisor who is on a plane; one that
 * dropped the forwarding row entirely would lose her coverage. A forwarding row with a null target is
 * dropped from the delivery set — §3.3's `m20_sss_vacation_pair` CHECK makes that unwritable, so reaching
 * it means the row was written around the constraint, and paging the subscriber a row says not to page is
 * the wrong repair to make silently.
 */
export function deliveryMembershipsFor(
  supervisors: readonly {
    readonly supervisorMembershipId: MembershipId;
    readonly isVacationForwarded: boolean;
    readonly vacationForwardToMembershipId: MembershipId | null;
  }[],
): readonly MembershipId[] {
  const out: MembershipId[] = [];
  for (const s of supervisors) {
    const target = s.isVacationForwarded
      ? s.vacationForwardToMembershipId
      : s.supervisorMembershipId;
    if (target !== null && !out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * Register M20's `field_safety_composed` resolver onto an EXISTING M36 resolver registry (the map
 * `createRecipientResolverRegistry` returns), over the given source ports. Additive — the name is new to
 * the registry and no built-in is replaced. Returns the same registry for chaining; idempotent
 * re-registration overwrites with an equivalent resolver (the M36-T09 / M34 precedent).
 *
 * Ordering is SUPERVISORS FIRST, then the on-call parallel set, and both are de-duplicated by user id
 * with first-seen winning. A fan-out that treats position as priority then reaches the person whose own
 * subscription named this clinician before it reaches the rotation covering the whole PE — which is the
 * §4.5 ordering ("the PRIMARY recipient set is M20's supervisors, COMBINED with M19's on-call").
 */
export function registerM20AlertResolvers(
  registry: Map<string, RecipientResolverFn>,
  ports: M20AlertResolverPorts,
): Map<string, RecipientResolverFn> {
  registry.set(M20_COMPOSED_RECIPIENT_RESOLVER, async (orgId, args, payload) => {
    const org = orgId as OrgId;
    const clinicianMembershipId = readPath(
      payload,
      pathArg(args, "clinicianMembershipIdPath") ?? "postedByMembershipId",
    ) as MembershipId | null;
    const providerEntityId = readPath(
      payload,
      pathArg(args, "providerEntityIdPath") ?? "providerEntityId",
    ) as ProviderEntityId | null;
    const atIso = (readPath(payload, pathArg(args, "eventTimePath") ?? "raisedAt") ??
      new Date().toISOString()) as IsoInstant;

    // A payload with no subject is a PRODUCER problem M36's dispatch outcome surfaces (§7.13 "malformed
    // payload"), not a resolver crash — the built-ins answer `[]` for the same case. It is still a
    // composed set that reaches nobody, so the gap channel says so.
    if (clinicianMembershipId === null) {
      ports.onCompositionGap(org, { kind: "no_recipients" });
      return [];
    }

    // NOT caught: see the header. An unreadable supervisor registry must reach M36 as a failure.
    const supervisors = await ports.supervisorsForClinician(org, clinicianMembershipId, "sos");
    const supervisorMemberships = deliveryMembershipsFor(supervisors);

    const parallel =
      providerEntityId === null
        ? ({ kind: "not_after_hours" } as const)
        : await ports.afterHoursParallelSet(org, providerEntityId, atIso);

    const onCallUserIds: string[] = [];
    if (parallel.kind === "unavailable") {
      ports.onCompositionGap(org, { kind: "on_call_unavailable", reason: parallel.reason });
    } else if (parallel.kind === "resolved") {
      if (parallel.externalActors.length > 0) {
        ports.onCompositionGap(org, {
          kind: "external_actors_unreachable",
          shiftIds: parallel.externalActors.map((a) => a.shiftId),
        });
      }
      // M19's membership arm already carries a user id (`OnCallActor.userId`), so the rotation needs no
      // second lookup — and using M19's own value keeps the two modules from disagreeing about which
      // account a shift belongs to. M20-T04's partition dropped it from `SafetyOnCallParallelRecipient`
      // when only membership ids mattered; it carries it now, for this.
      for (const recipient of parallel.recipients) onCallUserIds.push(recipient.userId);
    }

    const supervisorUserIds = await ports.userIdsForMemberships(org, supervisorMemberships);
    const unresolvable = supervisorMemberships.filter((id) => !supervisorUserIds.has(id));
    if (unresolvable.length > 0) {
      // A membership whose user will not resolve is DROPPED, not fabricated: a made-up user id pages
      // nobody while LOOKING like a recipient on the delivery ledger. The drop is reported so it reads as
      // a configuration fault rather than as a supervisor who was simply not subscribed.
      ports.onCompositionGap(org, {
        kind: "unresolvable_memberships",
        membershipIds: unresolvable,
      });
    }

    const out: string[] = [];
    for (const membershipId of supervisorMemberships) {
      const userId = supervisorUserIds.get(membershipId);
      if (userId !== undefined && !out.includes(userId)) out.push(userId);
    }
    for (const userId of onCallUserIds) if (!out.includes(userId)) out.push(userId);

    if (out.length === 0) ports.onCompositionGap(org, { kind: "no_recipients" });
    return out;
  });

  return registry;
}
