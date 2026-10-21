// apps/backend/src/modules/31-portal/provisioning/types.ts — GAP-092. The ports M31's provisioning services (account +
// grant creation, upload staging hand-off, notification preferences) are injected with at the composition root.
// Every one is a locally-declared STRUCTURAL port: M31's manifest `dependsOn` carries no edge to M2 / M6 / M16 /
// M22 / M39, so the owning module's own function is bound here by the root instead of being imported (the F-160
// `CapConsumerStore` shape). A port left unbound makes the route that needs it answer 503 — never a fake success.
import type { PortalAccessGrantKind, PortalAccountRelationship } from "@chartwarden/types";

/** M2 — find-or-create the identity (`user` row) an invited portal caregiver will sign in as. */
export interface PortalInviteeUserPort {
  /** Find-or-create the user for `email` (unverified until the invitation is accepted). */
  ensureUser(
    organizationId: string,
    input: { readonly email: string; readonly displayName: string },
  ): Promise<{ readonly userId: string }>;
  /** Mark the invitee's email verified — the accepted token was delivered to that address. */
  markEmailVerified(organizationId: string, userId: string): Promise<void>;
}

/** M39 — the governing portal-access consent record an access grant is minted under. */
export interface PortalConsentPort {
  governingConsent(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly grantKind: PortalAccessGrantKind;
  }): Promise<{ readonly consentRecordId: string; readonly consentVersion: string } | null>;
}

/** M6 — the provider entity (+ location) a patient's care sits under; stamped on every patient-bearing M31 row. */
export interface PortalPatientSitePort {
  siteForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<{ readonly providerEntityId: string; readonly locationId: string | null } | null>;
}

/** Out-of-band delivery of the single-use invitation link (email). Best effort; the admin link is the fallback. */
export interface PortalInvitationDeliveryPort {
  deliver(input: {
    readonly organizationId: string;
    readonly email: string;
    readonly displayName: string;
    readonly token: string;
    readonly expiresAt: Date;
  }): Promise<{ readonly inviteUrl: string | null }>;
}

/** M22 — hands a validated upload to the documents intake (a verified document + an intake batch). */
export interface PortalUploadIntakePort {
  accept(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly portalAccountId: string;
    readonly actingUserId: string;
    readonly purpose: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly documentId: string; readonly intakeBatchId: string }>;
}

/** M16 — the bereaved family member's own opt-out from bereavement outreach (D9 portal self-service). */
export interface PortalBereavementOptOutPort {
  optOut(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly portalAccountId: string;
  }): Promise<{ readonly contactsOptedOut: number; readonly alreadyOptedOut: number }>;
}

/** M4 — an account's own read trail (the §164.528 disclosure-accounting view an admin audits). */
export interface PortalAccountAuditPort {
  viewsForUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{
    readonly items: ReadonlyArray<{
      readonly eventId: string;
      readonly viewedAt: string;
      readonly resourceKind: string;
      readonly eventType: string;
    }>;
    readonly nextCursor: string | null;
  }>;
}

/** What an invitation issue request carries (already validated by the route's typebox). */
export interface IssueInvitationInput {
  readonly organizationId: string;
  readonly actingUserId: string;
  readonly patientId: string;
  readonly relationship: PortalAccountRelationship;
  readonly caregiverId?: string;
  readonly bereavedContactId?: string;
  readonly inviteeDisplayName: string;
  readonly inviteeEmail: string;
  readonly inviteePhone?: string;
  /** The categories the invitation grants; empty ⇒ the grant kind's full platform floor. */
  readonly proposedScopeSet: readonly string[];
}

export interface IssuedInvitation {
  readonly invitationId: string;
  readonly portalAccountId: string;
  readonly status: "invited";
  readonly expiresAt: string;
  /** The link, when no email transport delivered it (the admin hands it over); null when delivery is bound. */
  readonly inviteUrl: string | null;
}

export interface InvitationListItem {
  readonly invitationId: string;
  readonly relationship: string;
  readonly status: "outstanding" | "accepted" | "revoked" | "expired";
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface AcceptedInvitation {
  readonly portalAccountId: string;
  readonly patientId: string;
  readonly grantKind: PortalAccessGrantKind;
  readonly status: "active";
  readonly replayed: boolean;
}
