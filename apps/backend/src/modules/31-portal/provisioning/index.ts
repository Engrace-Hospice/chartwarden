// apps/backend/src/modules/31-portal/provisioning/index.ts — GAP-092. The portal provisioning services
// (notification preferences, encrypted upload staging, account + grant provisioning) behind ONE factory, so the
// composition root builds them once and every route reads them off `PortalRouteDeps.provisioning`.
import type { DbClient } from "@wardenx/db";
import type { PortalPhiCipher } from "../portal-crypto";
import { type PortalInvitations, createPortalInvitations } from "./invitations";
import { type PortalPreferences, createPortalPreferences } from "./preferences";
import type {
  PortalConsentPort,
  PortalInvitationDeliveryPort,
  PortalInviteeUserPort,
  PortalPatientSitePort,
  PortalUploadIntakePort,
} from "./types";
import { type PortalUploads, createPortalUploads } from "./uploads";

export interface PortalProvisioning {
  readonly preferences: PortalPreferences;
  readonly uploads: PortalUploads;
  readonly invitations: PortalInvitations;
}

export interface PortalProvisioningDeps {
  readonly db: DbClient;
  /** The tenant-DEK cipher over the account contact columns + the staged upload bytes. */
  readonly cipher: PortalPhiCipher;
  readonly users: PortalInviteeUserPort;
  readonly consent: PortalConsentPort;
  readonly site: PortalPatientSitePort;
  /** Unbound ⇒ the issue response carries the link for the admin to hand over. */
  readonly delivery?: PortalInvitationDeliveryPort;
  /** Unbound ⇒ `upload-complete` refuses 503 and keeps the staged bytes. */
  readonly uploadIntake?: PortalUploadIntakePort;
  readonly now?: () => Date;
}

export function createPortalProvisioning(deps: PortalProvisioningDeps): PortalProvisioning {
  return {
    preferences: createPortalPreferences(deps.db),
    uploads: createPortalUploads({
      db: deps.db,
      cipher: deps.cipher,
      intake: deps.uploadIntake,
      now: deps.now,
    }),
    invitations: createPortalInvitations({
      db: deps.db,
      cipher: deps.cipher,
      users: deps.users,
      consent: deps.consent,
      site: deps.site,
      delivery: deps.delivery,
      now: deps.now,
    }),
  };
}

export * from "./types";
export { createPortalPreferences, toPreferencesView, type PortalPreferences } from "./preferences";
export { createPortalUploads, type PortalUploads } from "./uploads";
export {
  createPortalInvitations,
  hashInvitationToken,
  mintInvitationToken,
  overlayForProposedScope,
  type PortalInvitations,
} from "./invitations";
