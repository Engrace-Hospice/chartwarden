// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/org-bound-transport.ts — a tenant's vendor transport,
// bound to the tenant it was built for.
//
// The transport holds ONE organization's own vendor credential. Every call carries a `ClearinghouseContext`; a caller that
// names a DIFFERENT organization (a mis-routed job, a cached binding handed to the wrong tenant) must never reach the vendor
// under this credential, so the call is refused with `CH_INVALID_REQUEST` before any request is made.
//
// It is bound to the vendor MODE of the config row it was built from as well. The call's context carries the usage the caller
// read from the org's config, in a read of its own; if the org moved between test and production in between, the call would
// name one mode and the credential open the other (a test envelope into a production account, or the reverse). Such a call is
// refused, retryably (`CH_UNAVAILABLE`), before any request: the retry reads the new mode and meets the new binding.
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseTransport,
  type X12WorkerResult,
  degraded,
} from "@chartwarden/x12-837-client";

export const WRONG_ORG_REASON = "this clearinghouse binding belongs to another organization";
export const MODE_CHANGED_REASON =
  "this organization's clearinghouse mode changed since the call was prepared; retry";

export function bindTransportToOrg(
  transport: ClearinghouseTransport,
  organizationId: string,
  mode?: ClearinghouseContext["usage"],
): ClearinghouseTransport {
  const owner = organizationId.toLowerCase();
  const guard =
    <A extends unknown[], R>(
      call: (ctx: ClearinghouseContext, ...args: A) => Promise<X12WorkerResult<R>>,
    ) =>
    (ctx: ClearinghouseContext, ...args: A): Promise<X12WorkerResult<R>> => {
      if (ctx.organizationId.toLowerCase() !== owner) {
        return Promise.resolve(degraded<R>(CH.INVALID_REQUEST, WRONG_ORG_REASON));
      }
      if (mode !== undefined && ctx.usage !== mode) {
        return Promise.resolve(degraded<R>(CH.UNAVAILABLE, MODE_CHANGED_REASON));
      }
      return call.call(transport, ctx, ...args);
    };
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
