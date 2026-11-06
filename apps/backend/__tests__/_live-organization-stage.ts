// apps/backend/__tests__/_live-organization-stage.ts — the explicit "this organization is live" stage reader for a test that
// builds the authenticate hook but does not exercise the not-yet-live organization gate (bootstrap/onboarding-org-gate.ts).
// `SessionAuthenticateDeps.organizationStage` is required, so a hook can never silently skip the gate; a test that does not care
// says so with this. Production code never imports it (it lives beside the tests).
import type { OrganizationStageReader } from "../src/bootstrap/onboarding-org-gate";

export const liveOrganizationStage: OrganizationStageReader = {
  isConfined: async () => false,
};
