// apps/backend/src/modules/02-identity/routes/identity-typebox.ts — M2 OpenAPI request/response
// DTOs (F0 enrichment). Named `*-typebox` (NOT `*schema*`) so the table-ownership import
// heuristic never mistakes these for a Drizzle import. The M2 identity + step-up routes read
// their bodies manually (readString/readFactor) and published NO OpenAPI contract, so the
// generated client typed every body as `never`. These schemas mirror the routes' real
// request/response shapes 1:1; the two read views that HAVE a typed interface (`MembershipView`,
// `OrgBinding`) are pinned to it by the compile-time `Conforms` aliases below, so a view field
// added or renamed breaks `bun run build` rather than silently drifting from the client. Enum
// fields are literal unions, never a bare `Type.String()`.
import { type Static, Type } from "@sinclair/typebox";
import type {
  AccountStatus,
  MembershipStatus,
  MembershipView,
  OrgBinding,
} from "../identity-ports";
import type { StepUpQualifyingFactor } from "../step-up-ports";

// ── Shared enums (mirrored from the M1-owned enums the ports re-declare) ─────────────────────────
const MembershipStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("revoked"),
]);
const AccountStatusSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("deactivated"),
]);
const StepUpFactorSchema = Type.Union([Type.Literal("webauthn"), Type.Literal("totp")]);

// ── §7.1–7.7 REQUEST bodies / queries (grounded in the routes' readString/readFactor calls) ──────

/** POST /api/v1/auth/select-organization — bind the pre-org session to one org (§7.2). */
export const SelectOrganizationRequestSchema = Type.Object({
  organizationId: Type.String({ minLength: 1 }),
});

/** POST /api/v1/orgs/:id/invitations — invite a user to the org (§7.1). */
export const OrgInvitationCreateRequestSchema = Type.Object({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  proposedRoleKeys: Type.Optional(Type.Array(Type.String())),
  proposedDefaultLocationIds: Type.Optional(Type.Array(Type.String())),
  proposedDefaultProviderEntityId: Type.Optional(Type.String()),
});

/** POST /api/v1/invitations/accept — consume an invite token → membership (§7.1). */
export const InvitationAcceptRequestSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
});

/** POST /api/v1/orgs/:id/invitations/:invId/resend — no input beyond the path (TASK-030). */
export const InvitationResendRequestSchema = Type.Object({}, { additionalProperties: false });

/** GET /api/v1/orgs/:id/members — optional staff-facet search narrowing (FB-T11). */
export const MembersListQuerySchema = Type.Object({
  q: Type.Optional(Type.String()),
});

/** PATCH /api/v1/orgs/:id/members/:mId — suspend/reinstate and/or re-scope (§7.5). */
export const MemberPatchRequestSchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("suspended")])),
  defaultLocationIds: Type.Optional(Type.Array(Type.String())),
});

/** POST /api/v1/users/:id/deactivate — full offboard (§7.5). */
export const UserDeactivateRequestSchema = Type.Object({
  reason: Type.String({ minLength: 1 }),
});

/** POST /api/v1/collaborators/invite — mint a per-patient magic-link (§7.6). */
export const CollaboratorInviteRequestSchema = Type.Object({
  patientId: Type.String({ minLength: 1 }),
});

/** POST /api/v1/collaborators/consume — consume the link → scoped session (§7.6). */
export const CollaboratorConsumeRequestSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
});

/** POST /api/v1/sessions/step-up/initiate — start an MFA challenge (§4.4; only WebAuthn/TOTP qualify). */
export const StepUpInitiateRequestSchema = Type.Object({
  factor: StepUpFactorSchema,
});

/** POST /api/v1/sessions/step-up — verify a challenge (§4.4.1). */
export const StepUpVerifyRequestSchema = Type.Object({
  challengeId: Type.String({ minLength: 1 }),
  factor: StepUpFactorSchema,
  assertion: Type.Optional(Type.Unknown()),
  totpCode: Type.Optional(Type.String({ pattern: "^[0-9]{6}$" })),
});

// ── §4.2 RESPONSE DTOs ───────────────────────────────────────────────────────────────────────────

/** A membership row as returned to clients (mirrors `MembershipView`). */
export const MembershipViewSchema = Type.Object({
  membershipId: Type.String(),
  userId: Type.String(),
  organizationId: Type.String(),
  organizationName: Type.String(),
  status: MembershipStatusSchema,
  isAdmin: Type.Boolean(),
  defaultLocationIds: Type.Array(Type.String()),
  displayName: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  accountStatus: Type.Union([AccountStatusSchema, Type.Null()]),
});

/** GET /api/v1/auth/memberships — the pre-org membership list (§7.2). */
export const MembershipListResponseSchema = Type.Object({
  memberships: Type.Array(MembershipViewSchema),
});

/** GET /api/v1/orgs/:id/members — the org roster + the pending-invites KPI (FB-T12). */
export const MembersListResponseSchema = Type.Object({
  members: Type.Array(MembershipViewSchema),
  pendingInvitations: Type.Integer(),
});

/** GET /api/v1/auth/context — the app shell's identity/role/permission projection (FB-T15). */
export const AuthContextResponseSchema = Type.Object({
  userId: Type.String(),
  organizationId: Type.Union([Type.String(), Type.Null()]),
  organizationName: Type.Union([Type.String(), Type.Null()]),
  membershipId: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.Union([Type.String(), Type.Null()]),
  roles: Type.Array(Type.String()),
  isAdmin: Type.Boolean(),
  permissions: Type.Array(Type.String()),
});

/** POST /api/v1/auth/select-organization — the server-bound org binding (mirrors `OrgBinding`). */
export const OrgBindingResponseSchema = Type.Object({
  activeOrganizationId: Type.String(),
  organizationName: Type.String(),
  expiresAt: Type.String(),
});

/**
 * POST /api/v1/orgs/:id/invitations (201) — the created invite. `inviteUrl` DELIBERATELY carries the
 * raw token (TASK-030): no vendor email sender is wired yet, so the accept link is echoed to the
 * inviting admin (who already holds `member.invite`) as a copyable fallback, in addition to the
 * best-effort email send. Absent when no `webAppBaseUrl` is configured to build a link from.
 */
export const InvitationCreatedResponseSchema = Type.Object({
  invitationId: Type.String(),
  expiresAt: Type.String(),
  inviteUrl: Type.Optional(Type.String()),
});

/** POST /api/v1/orgs/:id/invitations/:invId/resend — re-minted invite (TASK-030; same shape as create). */
export const InvitationResendResponseSchema = InvitationCreatedResponseSchema;

/** GET /api/v1/orgs/:id/invitations — the org's invitation roster (TASK-030 pending-invite list). */
export const InvitationListResponseSchema = Type.Object({
  invitations: Type.Array(
    Type.Object({
      invitationId: Type.String(),
      email: Type.String(),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("accepted"),
        Type.Literal("expired"),
        Type.Literal("revoked"),
      ]),
      expiresAt: Type.String(),
      createdAt: Type.String(),
    }),
  ),
});

/** GET /api/v1/invitations/:token — pre-auth preview of a token's target (TASK-030, §7.1). */
export const InvitationPeekResponseSchema = Type.Object({
  email: Type.String(),
  organizationName: Type.String(),
});

/** POST /api/v1/invitations/accept — the newly created membership stub (§7.1). */
export const InvitationAcceptedResponseSchema = Type.Object({
  membershipId: Type.String(),
  organizationId: Type.String(),
  status: MembershipStatusSchema,
});

/** DELETE /api/v1/orgs/:id/invitations/:invId — rescind acknowledgement. */
export const InvitationRescindedResponseSchema = Type.Object({
  rescinded: Type.Boolean(),
});

/** DELETE /api/v1/orgs/:id/members/:mId — revoke acknowledgement (§7.5). */
export const MemberRevokedResponseSchema = Type.Object({
  revoked: Type.Boolean(),
});

// ── §3.7 named approval authority (GAP-043) ────────────────────────────────────────────────────────
/** The `elevated_approval_kind` vocabulary — kept as a literal union so the generated client narrows. */
export const ElevatedApprovalKindSchema = Type.Union([Type.Literal("cost_report_approval")], {
  description:
    "A named per-tenant approval authority. `cost_report_approval` designates a membership as authorized to certify a CMS-1984-14 filing (M27 §4.7).",
});

/** One designation row — live (`revokedAt: null`) or historical. */
export const ElevatedApprovalGrantSchema = Type.Object({
  id: Type.String(),
  membershipId: Type.String(),
  approvalKind: Type.String(),
  grantedByMembershipId: Type.String(),
  grantedAt: Type.String(),
  grantReason: Type.String(),
  revokedAt: Type.Union([Type.String(), Type.Null()]),
  revokedByMembershipId: Type.Union([Type.String(), Type.Null()]),
  revokedReason: Type.Union([Type.String(), Type.Null()]),
});

/** POST body — the ≥10-char reason floor matches the `grant_reason` CHECK in migration 0204. */
export const ElevatedApprovalGrantRequestSchema = Type.Object({
  approvalKind: ElevatedApprovalKindSchema,
  grantReason: Type.String({ minLength: 10 }),
});

/** DELETE body — same reason floor, matching the revocation-consistency CHECK. */
export const ElevatedApprovalRevokeRequestSchema = Type.Object({
  revokedReason: Type.String({ minLength: 10 }),
});

/** POST /api/v1/users/:id/deactivate — full-offboard acknowledgement (§7.5). */
export const UserDeactivatedResponseSchema = Type.Object({
  deactivated: Type.Boolean(),
});

/** POST /api/v1/collaborators/invite (201) — the minted link (token delivered out-of-band, §7.6). */
export const CollaboratorInviteResponseSchema = Type.Object({
  linkId: Type.String(),
  expiresAt: Type.String(),
});

/** POST /api/v1/collaborators/consume — the scoped external-collaborator session (§7.6). */
export const CollaboratorConsumeResponseSchema = Type.Object({
  sessionClass: Type.Literal("external_collaborator"),
  scope: Type.Object({ patientId: Type.String() }),
  expiresAt: Type.String(),
});

/** POST /api/v1/sessions/step-up/initiate — the challenge (WebAuthn carries its challenge, §4.4.1). */
export const StepUpInitiateResponseSchema = Type.Union([
  Type.Object({ challengeId: Type.String(), factor: Type.Literal("totp") }),
  Type.Object({
    challengeId: Type.String(),
    factor: Type.Literal("webauthn"),
    webauthnChallenge: Type.Object({ challenge: Type.String(), rpId: Type.String() }),
  }),
]);

/** POST /api/v1/sessions/step-up — the paired-write step-up freshness on success (§4.4.1, D8). */
export const StepUpVerifyResponseSchema = Type.Object({
  lastStepUpAt: Type.String(),
  lastStepUpFactor: StepUpFactorSchema,
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (the service view).
type Conforms<T extends V, V> = T;
type _MembershipView = Conforms<Static<typeof MembershipViewSchema>, MembershipView>;
type _OrgBinding = Conforms<Static<typeof OrgBindingResponseSchema>, OrgBinding>;
// Enum unions must remain the exact port unions (a widened `Type.String()` would break these).
type _MembershipStatus = Conforms<Static<typeof MembershipStatusSchema>, MembershipStatus>;
type _AccountStatus = Conforms<Static<typeof AccountStatusSchema>, AccountStatus>;
type _StepUpFactor = Conforms<Static<typeof StepUpFactorSchema>, StepUpQualifyingFactor>;
