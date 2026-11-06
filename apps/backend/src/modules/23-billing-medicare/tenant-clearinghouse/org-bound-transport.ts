// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/org-bound-transport.ts — a tenant's vendor transport,
// bound to the tenant it was built for.
//
// The transport holds ONE organization's own vendor credential. Every call carries a `ClearinghouseContext`; a caller that
// names a DIFFERENT organization (a mis-routed job, a cached binding handed to the wrong tenant) must never reach the vendor
// under this credential, so the call is refused with `CH_INVALID_REQUEST` before any request is made.
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseTransport,
  type X12WorkerResult,
  degraded,
} from "@chartwarden/x12-837-client";

export const WRONG_ORG_REASON = "this clearinghouse binding belongs to another organization";

export function bindTransportToOrg(
  transport: ClearinghouseTransport,
  organizationId: string,
): ClearinghouseTransport {
  const owner = organizationId.toLowerCase();
  const guard =
    <A extends unknown[], R>(
      call: (ctx: ClearinghouseContext, ...args: A) => Promise<X12WorkerResult<R>>,
    ) =>
    (ctx: ClearinghouseContext, ...args: A): Promise<X12WorkerResult<R>> =>
      ctx.organizationId.toLowerCase() === owner
        ? call.call(transport, ctx, ...args)
        : Promise.resolve(degraded<R>(CH.INVALID_REQUEST, WRONG_ORG_REASON));
  return {
    vendor: transport.vendor,
    checkEligibility: guard(transport.checkEligibility),
    validateOnly: guard(transport.validateOnly),
    submitNotice: guard(transport.submitNotice),
    submitClaim: guard(transport.submitClaim),
    fetchAcknowledgments: guard(transport.fetchAcknowledgments),
    fetchRemittances: guard(transport.fetchRemittances),
    fetchClaimStatus: guard(transport.fetchClaimStatus),
    // A webhook push names no organization of ours; its signature is the vendor's own check.
    verifyAndParseEvent: (webhook) => transport.verifyAndParseEvent(webhook),
  };
}
