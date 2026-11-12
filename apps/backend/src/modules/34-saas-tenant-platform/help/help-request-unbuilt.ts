// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-unbuilt.ts — the stand-in until piece 7B lands.
//
// Every method answers 501 NOT_IMPLEMENTED (`not-built.ts`) so the registered routes exercise their real guard chains in tests and
// the generated client has real types, while nothing is ever filed. 7B deletes this file when it binds the real service.
import { notBuilt } from "../not-built";
import type { HelpRequestService } from "./help-request-contract";

const FEATURE = "help requests";

export function createUnbuiltHelpRequestService(): HelpRequestService {
  const refuse = async (): Promise<never> => {
    throw notBuilt(FEATURE);
  };
  return {
    listForTenant: refuse,
    file: refuse,
    approve: refuse,
    close: refuse,
    listForPlatform: refuse,
    resolve: refuse,
  };
}
