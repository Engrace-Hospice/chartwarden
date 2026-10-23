// apps/backend/src/modules/02-identity/events-by-m2.ts — M2's transactional-outbox event catalog
// contribution.
//
// M2 had NO catalog contribution at all (alongside M28 and M36; #205) — no `M2_OUTBOX_EVENTS` anywhere
// in the repo and no entry in the boot dispatcher's `buildBootOutboxCatalog([...])`. Every one of these
// facts was already recorded — as an AUDIT event, through `packages/audit/src/actions/m2.ts` and
// `apps/backend/src/modules/02-identity/audit/*.ts` — at the exact call sites below, which is why wiring
// this needed no new write path: the mutation already happened, only the outbox publish was missing.
//
// The first fourteen are RECORD-ONLY (`declaredConsumers: []`). Checked against the whole repo: nothing
// currently subscribes to any of them. That is a genuine difference from M28's catalog (which had at
// least one real declared relationship, M33's bulk-export MV invalidation) — this is closing the "M2
// contributes no catalog" gap as durable infrastructure other modules can subscribe to later, not
// satisfying an existing declared consumer. The four `m2.organization.*` / `m2.session.created` events
// below ARE declared consumers of M35 (`M35_SUBSCRIBED_EVENT_NAMES`), but M35 has no `consumers/`
// directory of its own yet — so they stay `declaredConsumers: []` too (record-only until M35 binds), and
// `scripts/outbox-subscription-exceptions.ts`'s M35 entry is reclassified `no-handler` (event exists,
// nothing consumes it) now that `no-such-event` (the event didn't exist) is no longer true.
//
// `m2.organization.activated` / `.suspended` / `.closed` / `m2.session.created` — the four events M35's
// §4.12 per-seat billing is specified against (`packages/types/src/subscription-billing.ts`) — are now
// wired too (#205 hard-half follow-up). `m2.session.created` does NOT fire off Better Auth's raw
// session-insert: at that point `session.active_organization_id` is still NULL (bound later, one-time, by
// `POST /api/v1/auth/select-organization` — see `session-writer-db.ts`), so a hook on Better Auth's own
// create step would have no org to attribute the seat to. `select-organization` IS the moment a session
// becomes billing-attributable to one org, and it already runs with `organizationId` + `userId` in hand —
// the natural, and only correct, producer point. `m2.organization.*` are emitted by the new
// `organization-lifecycle.ts` writer, the real admin capability the M35 spec's own worked example names
// ("a `platform_admin` suspends the org via M2 admin route", §11 D19 example) — `organization.status` had
// no UPDATE anywhere in the codebase before this; see that file's header for the transition graph and the
// auth-time enforcement this closes (a suspended/closed org can no longer bind a fresh session either).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

const orgId = Type.String({ minLength: 1 });
const nonEmptyString = Type.String({ minLength: 1 });
const membershipStatus = Type.Union([
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("revoked"),
]);
const stepUpFactor = Type.Union([
  Type.Literal("webauthn"),
  Type.Literal("totp"),
  Type.Literal("sms"),
]);
const attestationPlatform = Type.Union([Type.Literal("ios"), Type.Literal("android")]);
const attestationProvider = Type.Union([
  Type.Literal("managed_enrollment"),
  Type.Literal("apple_app_attest"),
  Type.Literal("google_play_integrity"),
]);
const isoInstant = Type.String({ minLength: 1 });

export const M2_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── §7.1 invitations ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m2.user.invited",
    moduleOwner: "m2",
    description:
      "An org invitation was minted (create) or re-minted (resend). Email is deliberately NOT in the payload — the audit trail redacts it through the field denylist, and an outbox row has no equivalent protection.",
    payloadSchema: Type.Object({
      invitationId: nonEmptyString,
      organizationId: orgId,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.invitation.rescinded",
    moduleOwner: "m2",
    description: "A pending org invitation was rescinded by an admin before acceptance.",
    payloadSchema: Type.Object({
      invitationId: nonEmptyString,
      organizationId: orgId,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §7.5 membership lifecycle ───────────────────────────────────────────────────────────────────
  {
    eventName: "m2.membership.accepted",
    moduleOwner: "m2",
    description:
      "An invitee accepted an invitation and an active membership was created. The §D3 role attach (m3.role.assigned) is the real, synchronous mechanism for downstream role-grant effects — this event has no consumer.",
    payloadSchema: Type.Object({
      membershipId: nonEmptyString,
      organizationId: orgId,
      userId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.membership.suspended",
    moduleOwner: "m2",
    description: "An admin suspended a membership (PATCH .../members/:mId, status='suspended').",
    payloadSchema: Type.Object({
      membershipId: nonEmptyString,
      organizationId: orgId,
      userId: Type.Optional(nonEmptyString), // absent on rows published before ADR-0054 A3
      from: membershipStatus,
      to: membershipStatus,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.membership.reinstated",
    moduleOwner: "m2",
    description: "A suspended membership was returned to active.",
    payloadSchema: Type.Object({
      membershipId: nonEmptyString,
      organizationId: orgId,
      from: membershipStatus,
      to: membershipStatus,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.membership.updated",
    moduleOwner: "m2",
    description:
      "A membership status change that is neither a suspend nor a suspended→active reinstate (the residual arm of the same PATCH route).",
    payloadSchema: Type.Object({
      membershipId: nonEmptyString,
      organizationId: orgId,
      from: membershipStatus,
      to: membershipStatus,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.membership.revoked",
    moduleOwner: "m2",
    description:
      "A membership was revoked (DELETE .../members/:mId) — that user's sessions in this org are terminated in the same route (sessions.revokeForMembership), not via this event.",
    payloadSchema: Type.Object({
      membershipId: nonEmptyString,
      organizationId: orgId,
      userId: Type.Optional(nonEmptyString), // absent on rows published before ADR-0054 A3
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.user.deactivated",
    moduleOwner: "m2",
    description:
      "A user was fully offboarded (credentials disabled everywhere, all sessions reaped in the same route). `scope: 'platform'` marks the §4.7 cross-org platform offboard (POST /api/v1/platform/users/:id/deactivate); absent for the org-bounded tenant route.",
    payloadSchema: Type.Object({
      userId: nonEmptyString,
      reason: nonEmptyString,
      scope: Type.Optional(Type.Literal("platform")),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },

  // ── GAP-115 org-admin surface ───────────────────────────────────────────────────────────────────
  {
    eventName: "m2.session.step_up_policy_override.configured",
    moduleOwner: "m2",
    description:
      "A tenant tightened (never loosened) the step-up policy for one operation (M2 §4.3.2, D9).",
    payloadSchema: Type.Object({
      organizationId: orgId,
      operationKey: nonEmptyString,
      qualifyingFactors: Type.Array(stepUpFactor),
      maxAgeSec: Type.Integer({ minimum: 1 }),
      configuredByMembershipId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.funeral.invited",
    moduleOwner: "m2",
    description: "A per-deceased funeral-home magic-link was minted (72h, one-time).",
    payloadSchema: Type.Object({
      linkId: nonEmptyString,
      organizationId: orgId,
      patientId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── §7.6 external collaborator ──────────────────────────────────────────────────────────────────
  {
    eventName: "m2.collaborator.invited",
    moduleOwner: "m2",
    description: "A per-patient external-collaborator magic-link was minted.",
    payloadSchema: Type.Object({
      linkId: nonEmptyString,
      organizationId: orgId,
      patientId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.collaborator.session_started",
    moduleOwner: "m2",
    description: "An external-collaborator session was issued from a consumed magic-link.",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      organizationId: orgId,
      patientId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── SecHardening §12.2/§12.4 device attestation ─────────────────────────────────────────────────
  {
    eventName: "m2.device.attested",
    moduleOwner: "m2",
    description: "A device passed the §12.4 posture check and now backs the session.",
    payloadSchema: Type.Object({
      attestationId: nonEmptyString,
      provider: attestationProvider,
      platform: attestationPlatform,
      expiresAt: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.device.attestation_failed",
    moduleOwner: "m2",
    description:
      "A device failed the §12.4 posture check. `reason` is the verifier's CATEGORY, never the detector's wording (the same denylist reasoning as `device_attestation.failure_reason`).",
    payloadSchema: Type.Object({
      attestationId: nonEmptyString,
      provider: attestationProvider,
      platform: attestationPlatform,
      reason: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.device.attestation_revoked",
    moduleOwner: "m2",
    description: "An administrator took a device out of service.",
    payloadSchema: Type.Object({
      attestationId: nonEmptyString,
      membershipId: nonEmptyString,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.4 step-up ─────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m2.session.step_up.completed",
    moduleOwner: "m2",
    description:
      "A step-up challenge was completed (login-MFA init or the explicit /sessions/step-up route).",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      factor: stepUpFactor,
      source: Type.Union([Type.Literal("login_mfa"), Type.Literal("explicit_route")]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.session.unlocked",
    moduleOwner: "m2",
    description:
      "A screen-locked session was unlocked by re-entering the password (`POST /api/v1/auth/unlock`). Same session and org: no new session is minted, so this is NOT a `m2.session.created` (it must not count a second billing seat).",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      userId: nonEmptyString,
      organizationId: orgId,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.session.step_up.failed",
    moduleOwner: "m2",
    description: "A step-up verification attempt failed (carries the running failure count).",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      factor: stepUpFactor,
      failureReason: nonEmptyString,
      failureCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.session.terminated_step_up_lockout",
    moduleOwner: "m2",
    description:
      "The session was forcibly terminated after the consecutive step-up failure threshold (STEP_UP_POLICY.lockoutThreshold).",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      factor: stepUpFactor,
      failureCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §11 D19 / M35 hard-half: org lifecycle + per-user session billing ──────────────────────────────
  {
    eventName: "m2.organization.activated",
    moduleOwner: "m2",
    description:
      "A platform admin activated an org (first activation past `created`, or reactivation out of `suspended` via `organization-lifecycle.ts`). M35 resumes/starts the Stripe subscription in sympathy.",
    payloadSchema: Type.Object({
      organizationId: orgId,
      reason: Type.String(),
      actorMembershipId: nonEmptyString,
      occurredAt: isoInstant,
    }),
    // F-142 (#248) — m35 added: M35's own D21 (locked) names this event among its 8 exhaustive inbound
    // subscriptions, and this event's own description already states the mechanism.
    declaredConsumers: ["m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.organization.suspended",
    moduleOwner: "m2",
    description:
      "A platform admin suspended an org for a non-billing reason (compliance, customer request) — every active session bound to it is revoked in the same write. M35 reactively pauses Stripe billing (§11 D19); M35 does NOT own this decision.",
    payloadSchema: Type.Object({
      organizationId: orgId,
      reason: nonEmptyString,
      actorMembershipId: nonEmptyString,
      occurredAt: isoInstant,
    }),
    // F-142 (#248) — m35 added: same D21 reasoning as `organization.activated` above.
    declaredConsumers: ["m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.organization.closed",
    moduleOwner: "m2",
    description:
      "A platform admin closed an org (terminal — `organization-lifecycle.ts` accepts no event out of `closed`). Every active session bound to it is revoked in the same write. M35 cancels the Stripe subscription at period end.",
    payloadSchema: Type.Object({
      organizationId: orgId,
      reason: nonEmptyString,
      actorMembershipId: nonEmptyString,
      occurredAt: isoInstant,
    }),
    // F-142 (#248) — m35 added: same D21 reasoning as `organization.activated` above.
    declaredConsumers: ["m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m2.session.created",
    moduleOwner: "m2",
    description:
      "A session became attributable to one org — fired from `POST /api/v1/auth/select-organization`, the one-time org bind, NOT from Better Auth's raw session insert (before that bind `session.active_organization_id` is NULL, so there is no org to attribute a billing seat to yet). Drives M35's `user_active_period` aggregator.",
    payloadSchema: Type.Object({
      sessionId: nonEmptyString,
      userId: nonEmptyString,
      organizationId: orgId,
    }),
    // F-142 (#248) — m35 added: same D21 reasoning as `organization.activated` above.
    declaredConsumers: ["m35"],
    isOutboxOnly: true,
  },
];
