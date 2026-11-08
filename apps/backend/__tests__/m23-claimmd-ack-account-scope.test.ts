// The platform account's Claim.MD response capture serves only the orgs on that account (CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS).
// A tenant with its OWN sealed Claim.MD credential keeps the per-tenant ack poll, capture on or off (owner decision 2026-11-08).
// The poll is observed at its first port call: `providerEntitiesFor(org)` runs only for an org whose acknowledgments are pulled.
import { describe, expect, it } from "vitest";
import { shouldRunLegacyClaimMdAckPoll } from "../src/modules/23-billing-medicare/claimmd-capture/config";
import {
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const TENANT_OWN = "00000000-0000-4000-8000-0000000000c1"; // its own sealed Claim.MD credential
const FALLBACK = "00000000-0000-4000-8000-0000000000c2"; // served by the platform's env Claim.MD account
const STEDI = "00000000-0000-4000-8000-0000000000c3"; // its own Stedi credential

function deps(capture: { captureActive: boolean; dispatcherActive: boolean }) {
  const polled: string[] = [];
  const transport = {} as never;
  const bindings: Record<string, object> = {
    [TENANT_OWN]: { vendor: "claimmd", account: "tenant", transport },
    [FALLBACK]: { vendor: "claimmd", transport }, // the platform binding: no `account`
    [STEDI]: { vendor: "stedi", account: "tenant", transport },
  };
  const d = {
    connection: {} as never,
    db: {} as never,
    claimMdResponseCaptureActive: capture.captureActive,
    claimMdAckDispatcherActive: capture.dispatcherActive,
    activeOrgs: {
      listActiveOrgs: async () =>
        [TENANT_OWN, FALLBACK, STEDI].map((organizationId) => ({ organizationId })),
    },
    transport: {
      binding: {
        vendor: null,
        transport,
        forOrg: async (organizationId: string) => bindings[organizationId],
      },
      contexts: {
        contextFor: async () => {
          throw new Error("no provider entity is pulled in this test");
        },
        providerEntitiesFor: async (organizationId: string) => {
          polled.push(organizationId);
          return [];
        },
      },
    },
  } as unknown as M23WorkerDeps;
  return { d, polled };
}

describe("Claim.MD ack intake is decided per organization's account", () => {
  for (const [name, pull] of [
    ["999", runAckPull999],
    ["277CA", runAckPull277ca],
  ] as const) {
    it(`${name}: with capture and dispatch on, a tenant-owned Claim.MD org is still polled and a fallback org is not`, async () => {
      const { d, polled } = deps({ captureActive: true, dispatcherActive: true });
      await pull(d);
      expect(polled).toEqual([TENANT_OWN, STEDI]);
    });

    it(`${name}: with capture off, the platform account is still never read by the per-provider poll`, async () => {
      const { d, polled } = deps({ captureActive: false, dispatcherActive: false });
      await pull(d);
      expect(polled).toEqual([TENANT_OWN, STEDI]);
    });
  }

  it("the coordination predicate keeps a tenant account's poll and stops the platform account's while capture runs", () => {
    expect(
      shouldRunLegacyClaimMdAckPoll({ captureActive: true, vendor: "claimmd", account: "tenant" }),
    ).toBe(true);
    expect(
      shouldRunLegacyClaimMdAckPoll({
        captureActive: false,
        dispatcherActive: true,
        vendor: "claimmd",
        account: "tenant",
      }),
    ).toBe(true);
    expect(shouldRunLegacyClaimMdAckPoll({ captureActive: true, vendor: "claimmd" })).toBe(false);
  });
});
