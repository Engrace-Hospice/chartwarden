// apps/backend/src/modules/20-field-safety/terminus/dial.ts - GAP-032: the `dial_contact` executor step.
//
// Runs OUTSIDE any tenant tx, at EXECUTION time (not decision time), in this order - each failure writes a
// precise outcome code and nothing here throws past the row:
//   1. platform kill switch            -> skipped / dial_disabled
//   2. consent re-read (three-valued)  -> absent/expired -> skipped; UNAVAILABLE -> retried, never recorded as "declined"
//   3. open the sealed contact         -> failed / contact_unreadable  (+ an explicit read-audit event)
//   4. normalise to E.164              -> failed / number_invalid      (911/short codes refused)
//   5. place the call via M36          -> succeeded | skipped voice_unbound | retry | failed
// The platform NEVER dials 911 or a PSAP (spec 2.2.2 (b) is "surface the number to a human"). The decrypted
// number is passed to the transport and nowhere else: not logged, not in an error, not in the ledger.
import { auditPhiRead } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { runWithRequestContext } from "@wardenx/tenancy";
import type { IsoInstant, MembershipId, OrgId } from "@wardenx/types";
import { logM20Cron } from "../jobs/worker-support";
import { readEmergencyContact } from "../seams/emergency-contact";
import { openEmergencyContact, resolveDialNumber } from "./contact";
import type { TerminusDeps } from "./deps";
import type { ClaimedTerminusAction, RetryOrFail, TerminusSettlement } from "./ledger";

const WORKER_SYSTEM_USER_ID = "";
const CONTACT_CONSENT_RESOURCE = "safety_emergency_contact_consent";

export interface DialContext {
  readonly deps: TerminusDeps;
  readonly db: DbClient;
  readonly row: ClaimedTerminusAction;
  readonly clinicianMembershipId: MembershipId;
  readonly now: Date;
  readonly retryOrFail: RetryOrFail;
}

/** The consent read-audit: opening a spouse's number is an access the clinician can later see. */
async function auditContactOpen(
  db: DbClient,
  organizationId: string,
  consentId: string,
): Promise<void> {
  await withOrgContext(db, { organizationId, userId: WORKER_SYSTEM_USER_ID }, async (tx) => {
    await auditPhiRead(
      tx as never,
      {
        organizationId,
        userId: null,
        actorKind: "system",
        correlationId: `m20.sos-terminus.${consentId}`,
      },
      {
        resourceKind: CONTACT_CONSENT_RESOURCE,
        resourceId: consentId,
        fields: ["consent_scope_detail"],
      },
    );
  });
}

export async function dialSettlement(ctx: DialContext): Promise<TerminusSettlement> {
  const { deps, row } = ctx;
  if (!deps.dialEnabled) return { status: "skipped", outcomeCode: "dial_disabled" };

  const consent = await runWithRequestContext(
    { organizationId: row.organizationId, userId: WORKER_SYSTEM_USER_ID },
    () =>
      readEmergencyContact(deps.store, {
        orgId: row.organizationId as OrgId,
        clinicianMembershipId: ctx.clinicianMembershipId,
        atIso: ctx.now.toISOString() as IsoInstant,
      }),
  );
  if (consent.kind === "unavailable") return ctx.retryOrFail("consent_unavailable");
  if (consent.kind === "absent")
    return { status: "skipped", outcomeCode: "consent_expired_or_revoked" };

  if (deps.decipher === undefined) return { status: "failed", outcomeCode: "contact_unreadable" };
  const opened = await openEmergencyContact(consent.consentScopeDetail, {
    organizationId: row.organizationId,
    decipher: deps.decipher,
  });
  try {
    await auditContactOpen(ctx.db, row.organizationId, consent.consentId);
  } catch (error) {
    // Best effort: a life-safety call is not blocked by an audit hiccup, but it is never silent.
    logM20Cron("m20.sos-terminus: contact-open read-audit failed", {
      organizationId: row.organizationId,
      sosAlertId: row.sosAlertId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  if (opened.kind === "unreadable") return { status: "failed", outcomeCode: "contact_unreadable" };

  const dial = resolveDialNumber(opened.phone);
  if (dial.kind === "invalid") return { status: "failed", outcomeCode: "number_invalid" };

  if (deps.caller === undefined) return { status: "skipped", outcomeCode: "voice_unbound" };
  const names = deps.speakNames
    ? await deps.speakNames(row.organizationId, ctx.clinicianMembershipId).catch(() => null)
    : null;
  const result = await deps.caller.place({
    organizationId: row.organizationId,
    idempotencyKey: row.idempotencyKey,
    toE164: dial.e164,
    agencyName: names?.agencyName ?? "",
    subjectDisplayName: names?.subjectDisplayName ?? "",
  });
  if (result.kind === "accepted") {
    return { status: "succeeded", outcomeCode: "ok", externalRef: result.vendorCallId };
  }
  if (result.reason === "transport_not_configured") {
    return { status: "skipped", outcomeCode: "voice_unbound" };
  }
  if (result.retryable)
    return ctx.retryOrFail(result.reason === "timeout" ? "timeout" : "vendor_refused");
  return { status: "failed", outcomeCode: "vendor_refused" };
}
