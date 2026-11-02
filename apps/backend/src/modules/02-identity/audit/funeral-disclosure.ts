// apps/backend/src/modules/02-identity/audit/funeral-disclosure.ts - the M2 audit + `m2.funeral.invited` event of a funeral-home disclosure that
// does NOT come through POST /funeral/invite (the M36 death-notification send mints the same link). One recorder, so both paths leave the same
// trail for the HIPAA accounting of disclosures. Called inside a request (the org-scoped executors read the request context). Ids only.
import { randomUUID } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { createOrgScopedAuditExecutor, createOrgScopedIdentityOutbox } from "../identity-ports";
import { auditFuneralInviteRefused, auditFuneralInvited } from "./org-admin-audit";

type Publisher = Parameters<typeof createOrgScopedIdentityOutbox>[1];

export interface FuneralDisclosureRecorder {
  invited(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    linkId: string;
    correlationId?: string | undefined;
  }): Promise<void>;
  refused(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    funeralHomeEntityId: string;
    reason: "unknown_funeral_home" | "no_baa";
    correlationId?: string | undefined;
  }): Promise<void>;
}

export function createFuneralDisclosureRecorder(
  db: DbClient,
  m2Publisher: Publisher,
): FuneralDisclosureRecorder {
  const audit = createOrgScopedAuditExecutor(db);
  const outbox = createOrgScopedIdentityOutbox(db, m2Publisher);
  const ctx = (a: { orgId: string; actorUserId: string; correlationId?: string | undefined }) => ({
    organizationId: a.orgId,
    userId: a.actorUserId,
    actorKind: "user" as const,
    correlationId: a.correlationId ?? randomUUID(),
  });
  return {
    async invited(a) {
      await auditFuneralInvited(audit, ctx(a), {
        linkId: a.linkId,
        organizationId: a.orgId,
        patientId: a.patientId,
      });
      await outbox.publish({
        eventName: "m2.funeral.invited",
        payload: { linkId: a.linkId, organizationId: a.orgId, patientId: a.patientId },
        organizationId: a.orgId,
        aggregateKind: "funeral_link",
        aggregateId: a.linkId,
      });
    },
    async refused(a) {
      await auditFuneralInviteRefused(audit, ctx(a), {
        organizationId: a.orgId,
        patientId: a.patientId,
        funeralHomeId: a.funeralHomeEntityId,
        reason: a.reason,
      });
    },
  };
}
