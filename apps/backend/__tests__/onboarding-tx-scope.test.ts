/**
 * The `...OnTx` credential writes run on a CALLER-owned transaction, so nothing in the callee proves that transaction
 * is scoped to the actor's organization. `assertTxScopedToOrg` reads `current_setting('app.org_id', true)` on it and
 * refuses (a typed 500: this is a wiring bug, never a caller error) when it is not the actor's org; both `...OnTx`
 * methods run it before they touch a table, a cipher or the outbox.
 */
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { assertTxScopedToOrg } from "../src/bootstrap/onboarding-credential-port";
import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/index";
import { buildDrizzleM24WriteService } from "../src/modules/24-billing-medicaid/index";

const ORG = "a1000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "b2000000-0000-4000-8000-0000000000b2";

/** A transaction whose `app.org_id` reads back as `scoped` (null = unset), failing on any other statement. */
function txScopedTo(scoped: string | null, touched: string[] = []): DbClient {
  const refuse = (what: string) => () => {
    touched.push(what);
    throw new Error(`the guard must refuse before ${what}`);
  };
  return {
    execute: async () => ({ rows: [{ org_id: scoped }] }),
    select: refuse("select"),
    insert: refuse("insert"),
    update: refuse("update"),
  } as unknown as DbClient;
}

describe("assertTxScopedToOrg", () => {
  it("passes when app.org_id is the actor's organization (case-insensitively)", async () => {
    await expect(assertTxScopedToOrg(txScopedTo(ORG), ORG)).resolves.toBeUndefined();
    await expect(assertTxScopedToOrg(txScopedTo(ORG.toUpperCase()), ORG)).resolves.toBeUndefined();
  });

  it("refuses another organization, an unset setting and an empty one, with a typed 500 naming no org", async () => {
    for (const scoped of [OTHER_ORG, null, ""]) {
      const attempt = assertTxScopedToOrg(txScopedTo(scoped), ORG);
      await expect(attempt, String(scoped)).rejects.toMatchObject({
        code: "TENANT_SCOPE_MISMATCH",
        statusCode: 500,
      });
      await attempt.catch((e: Error) => {
        expect(e.message).not.toContain(ORG);
        expect(e.message).not.toContain(OTHER_ORG);
      });
    }
  });
});

describe("the ...OnTx credential writes assert the scope first", () => {
  it("M23 upsertMacCredentialOnTx refuses a transaction scoped to another org before touching anything", async () => {
    const touched: string[] = [];
    const service = buildDrizzleM23WriteService({} as never, {});
    await expect(
      service.upsertMacCredentialOnTx(
        txScopedTo(OTHER_ORG, touched) as never,
        {
          organizationId: ORG,
          userId: "u",
          roles: ["platform_ops"],
          membershipId: "m",
          stepUpRecent: true,
          actorKind: "user",
        },
        {
          providerEntityId: "f6000000-0000-4000-8000-0000000000f6",
          macJurisdiction: "noridian_jf",
          submitterId: "S",
          tradingPartnerId: "T",
          clientId: "c",
          clientSecret: "s",
        } as never,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH", statusCode: 500 });
    expect(touched).toEqual([]);
  });

  it("M24 upsertCredentialOnTx refuses a transaction scoped to another org before touching anything", async () => {
    const touched: string[] = [];
    const service = buildDrizzleM24WriteService({} as never);
    await expect(
      service.upsertCredentialOnTx(
        txScopedTo(OTHER_ORG, touched),
        { organizationId: ORG, userId: "u", roles: ["platform_ops"], stepUpRecent: true },
        {
          providerEntityId: "f6000000-0000-4000-8000-0000000000f6",
          serviceState: "CA",
          channel: "portal",
          tradingPartnerId: "TP",
          activeFrom: "2026-01-01",
        } as never,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH", statusCode: 500 });
    expect(touched).toEqual([]);
  });
});
