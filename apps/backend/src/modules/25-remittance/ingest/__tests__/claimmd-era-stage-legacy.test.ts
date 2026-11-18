import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(_db),
}));

import { stageVerifiedClaimMdEra } from "../claimmd-era-stage";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const ISA13 = "000000001";
const ST02 = "0001";
const LEGACY_ID = "33333333-3333-4333-8333-333333333333";
const STAGE_ID = "55555555-5555-4555-8555-555555555555";
const dialect = new PgDialect();

/**
 * A select mock that answers by the SQL it is actually given: `rowsFor` receives the rendered WHERE
 * clause, so a wrong predicate (a missing `IS NULL`, a swapped control number) changes the answer.
 */
function harness(rowsFor: (whereSql: string, params: readonly unknown[]) => readonly unknown[]) {
  const seen: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    execute: vi.fn(async () => undefined),
    insert: vi.fn(),
    select: vi.fn(() => {
      let rendered = { sql: "", params: [] as readonly unknown[] };
      const query = {
        from: () => query,
        where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          rendered = dialect.sqlToQuery(condition);
          seen.push(rendered);
          return query;
        },
        limit: async () => rowsFor(rendered.sql, rendered.params),
      };
      return query;
    }),
  };
  return { tx, seen };
}

const cipher = { seal: vi.fn(() => Buffer.from("unused")) };

function stage(tx: unknown) {
  return stageVerifiedClaimMdEra({
    tenantDb: tx as never,
    source: {
      inboxId: "44444444-4444-4444-8444-444444444444",
      accountReference: "synthetic-account",
      usage: "test",
      eraId: "1",
      fileIndex: 0,
      digest: "a".repeat(64),
      fileDigest: "b".repeat(64),
      resolutionId: "synthetic-resolution",
      resolutionVersion: 1,
      idempotencyKey: "c".repeat(64),
      contentDigest: "d".repeat(64),
      paymentTraceDigest: null,
      interchangeControlNumber: ISA13,
      interchangeSenderCode: "SENDER",
      interchangeReceiverCode: "RECEIVER",
      functionalGroupControlNumber: "77",
      transactionSetControlNumber: ST02,
      evidenceCodes: ["EXACT_PAYEE_NPI"],
    },
    owner: { organizationId: ORG, providerEntityId: PROVIDER, locationId: null },
    duplicateFacts: { paymentTrace: null, paymentAmount: null, contentDigest: "d".repeat(64) },
    protectedDetails: {},
    protectedCipher: cipher as never,
    protectedKeyId: "synthetic-key",
    verifyCapturedSource: async () => true,
    verifyProviderAndLocation: async () => true,
  });
}

const isLegacyQuery = (whereSql: string) => /functional_group_control_number" is null/i.test(whereSql);

describe("Claim.MD stage legacy envelope guard", () => {
  it("holds when a historical advice row has the same ISA13/ST02 but no GS provenance", async () => {
    // Answers only a query that asks for a NULL GS06 under this ISA13 and ST02: a guard with a wrong
    // predicate is handed no row and falls through to the insert instead of holding.
    const { tx, seen } = harness((whereSql, params) =>
      isLegacyQuery(whereSql) && params.includes(ISA13) && params.includes(ST02)
        ? [{ id: LEGACY_ID }]
        : [],
    );

    const result = await stage(tx);

    expect(result).toEqual({ outcome: "held", reason: "LEGACY_IDENTITY_AMBIGUOUS" });
    const legacy = seen.find((query) => isLegacyQuery(query.sql));
    expect(legacy?.sql).toMatch(/"organization_id" = \$\d+/);
    expect(legacy?.sql).toMatch(/"provider_entity_id" = \$\d+/);
    expect(legacy?.sql).toMatch(/"interchange_control_number" = \$\d+/);
    expect(legacy?.sql).toMatch(/"transaction_set_control_number" = \$\d+/);
    expect(legacy?.params).toEqual(expect.arrayContaining([ORG, PROVIDER, ISA13, ST02]));
    expect(tx.insert).not.toHaveBeenCalled();
    expect(cipher.seal).not.toHaveBeenCalled();
  });

  it("answers an already-staged component from its stage row, before the legacy guard", async () => {
    // The stage row exists (e.g. re-delivery of an ERA that was already posted); a legacy row also
    // matches the ISA13/ST02. The existing stage must win, so the guard is never consulted.
    const { tx, seen } = harness((whereSql) => {
      if (isLegacyQuery(whereSql)) return [{ id: LEGACY_ID }];
      if (/"source_inbox_id" = \$\d+/.test(whereSql))
        return [{ id: STAGE_ID, state: "staged", safeReasonCode: null }];
      return [
        {
          organizationId: ORG,
          providerEntityId: PROVIDER,
          original835Digest: "a".repeat(64),
          resolutionVersion: 1,
        },
      ];
    });

    const result = await stage(tx);

    expect(result).toEqual({ outcome: "already_staged", stageId: STAGE_ID });
    expect(seen.some((query) => isLegacyQuery(query.sql))).toBe(false);
  });
});
