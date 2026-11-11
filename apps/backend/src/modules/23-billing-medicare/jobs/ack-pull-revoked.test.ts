// The acknowledgment (999 / 277CA) cron skips an organization whose vendor BAA a platform operator revoked (the resolver binds nothing
// for it), but a skip is not silent: it asks for the "responses may still be owed" report, once per organization per tick, and only for
// that reason. A failing report never stops the tick or the other tenants' pulls.
import {
  UNBOUND_BAA_REVOKED,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
} from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import type { M23TransportDeps } from "./clearinghouse-submission";
import { type M23WorkerDeps, runTransportAckPull } from "./m23-jobs";

const REVOKED_ORG = "11111111-1111-4111-8111-111111111111";
const DRAFT_ORG = "22222222-2222-4222-8222-222222222222";

function depsFor(report: (organizationId: string) => Promise<void>): M23WorkerDeps {
  const transport: M23TransportDeps = {
    binding: {
      ...UNBOUND_NOT_CHOSEN,
      forOrg: async (organizationId: string) =>
        organizationId === REVOKED_ORG ? UNBOUND_BAA_REVOKED : UNBOUND_NOT_ACTIVE,
    },
    contexts: { contextFor: async () => ({}) as never, providerEntitiesFor: async () => [] },
  };
  return {
    connection: {} as never,
    db: {} as never,
    transport,
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: REVOKED_ORG }, { organizationId: DRAFT_ORG }],
    },
    reportRevokedResponses: report,
  } as M23WorkerDeps;
}

describe("the 999 / 277CA pull and an organization whose BAA was revoked", () => {
  it.each(["ack_999", "ack_277ca"] as const)(
    "%s: skips it without failing, and asks for the report for that organization only",
    async (kind) => {
      const reported: string[] = [];
      await expect(
        runTransportAckPull(
          depsFor(async (org) => void reported.push(org)),
          kind,
        ),
      ).resolves.toBeUndefined();
      expect(reported).toEqual([REVOKED_ORG]); // a draft config was never owed anything: not reported
    },
  );

  it("a failing report never fails the tick", async () => {
    await expect(
      runTransportAckPull(
        depsFor(async () => {
          throw new Error("alert router down");
        }),
        "ack_999",
      ),
    ).resolves.toBeUndefined();
  });
});
