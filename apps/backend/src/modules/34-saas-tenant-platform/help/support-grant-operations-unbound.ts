// apps/backend/src/modules/34-saas-tenant-platform/help/support-grant-operations-unbound.ts — the bundle until 7S's is bound.
//
// The help service creates and ends consent through `SupportGrantOperations`, which piece 7S implements in
// packages/saas-tenant-platform and binds in the composition root. Until that binding replaces this stand-in, approving or ending
// consent answers 501 NOT_IMPLEMENTED in the standard envelope (nothing is ever granted), and no session exists to summarise.
// The integration step swaps the one call site in `apps/backend/src/index.ts`; nothing else refers to this file.
import type { SupportGrantOperations } from "@chartwarden/saas-tenant-platform";
import { notBuilt } from "../not-built";

const FEATURE = "support consent grants for help requests";

export function createUnboundSupportGrantOperations(): SupportGrantOperations {
  const refuse = async (): Promise<never> => {
    throw notBuilt(FEATURE);
  };
  return {
    depsFor: () => {
      throw notBuilt(FEATURE);
    },
    issueAssistGrant: refuse,
    revokeGrantAndCloseSessions: refuse,
    sessionSummaryForGrant: async () => null,
  };
}
