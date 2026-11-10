// Fixtures for the billing step panels' suites (no DOM, so a node-environment test can import them): a tenant wizard step/view builder and
// the clearinghouse and MAC views.
import type { operations } from "@chartwarden/ui";
import type { TenantWizardStep, TenantWizardView } from "./panel-props";

export type TenantClearinghouseView =
  operations["getApiV1TenantClearinghouse"]["responses"][200]["content"]["application/json"];

export const TASK = (key: string): string => `task-${key}`;

export function tenantStep(
  key: string,
  sequence: number,
  over: Partial<TenantWizardStep> = {},
): TenantWizardStep {
  return {
    id: TASK(key),
    key,
    title: over.title ?? key,
    description: `About ${key}`,
    owner: "either",
    sequence,
    optional: false,
    status: "pending",
    locked: false,
    lockedBy: null,
    completionMode: "attestation",
    evidence: null,
    attestedBy: null,
    assignedToMembershipId: null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    blockerReason: null,
    skipRationale: null,
    systemSkipped: false,
    skippedBy: null,
    skippable: false,
    tenantSkippable: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    templateKey: key,
    isCanonical: true,
    canonicalOrder: sequence,
    ...over,
  };
}

export function tenantView(
  steps: TenantWizardStep[],
  over: Partial<TenantWizardView> = {},
): TenantWizardView {
  return {
    tenantAccountId: "ta-1",
    orgSlug: "cedar-ridge",
    tenantStatus: "onboarding",
    currentStepKey: steps.find((s) => s.status !== "done" && s.status !== "skipped")?.key ?? null,
    steps,
    goLive: {
      state: "not_ready",
      attestation: null,
      failedGuards: [],
      complianceOfficerMembershipId: null,
    },
    orgProfile: { displayName: "Cedar Ridge", orgTimezone: "America/Denver" },
    items: steps,
    nextCursor: null,
    ...over,
  } as TenantWizardView;
}

/** A tenant clearinghouse view with nothing chosen; `over` says what is true in a test. */
export function clearinghouseView(
  over: Partial<TenantClearinghouseView> = {},
): TenantClearinghouseView {
  return {
    vendor: null,
    mode: null,
    status: null,
    source: "none",
    hasSecret: false,
    verifiableBy: null,
    verification: null,
    lastTest: null,
    baaRequired: false,
    baa: null,
    activatedAt: null,
    version: null,
    updatedAt: null,
    ...over,
  };
}

/** A tenant that chose Claim.MD and entered a credential (draft, nothing else done yet). */
export const CLAIMMD_DRAFT = clearinghouseView({
  vendor: "claimmd",
  mode: "production",
  status: "draft",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  baaRequired: true,
  version: 3,
  updatedAt: "2026-11-02T00:00:00.000Z",
});

export type TenantMacCredential =
  operations["getApiV1BillingMaccredentials"]["responses"][200]["content"]["application/json"]["items"][number];

export const PROVIDER_ENTITY_ID = "11111111-1111-4111-8111-111111111111";

/** A MAC credential on file for the fixture provider entity. */
export function macCredential(over: Partial<TenantMacCredential> = {}): TenantMacCredential {
  return {
    credentialId: "cred-1",
    organizationId: "o-1",
    providerEntityId: PROVIDER_ENTITY_ID,
    macJurisdiction: "noridian_jf",
    submitterId: "SUB-100",
    tradingPartnerId: "TP-200",
    clientId: "client-300",
    hasSecret: true,
    baaRecordRef: null,
    credentialExpiresAt: null,
    lastSandboxTestAt: null,
    version: 4,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  };
}
