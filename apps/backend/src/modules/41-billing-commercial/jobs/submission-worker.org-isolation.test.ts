// The submission drain with a clearinghouse PER ORGANIZATION, with a row that really goes out (ADR-0053 amendment 2026-11-06): each
// org's due submission is sent through THAT org's transport and no other, an org with none sends nothing, and the transport sees the
// org's own context. (The tick-level behaviour of an unbound org is in submission-worker.test.ts; the SQL is proven by
// m41-commercial-submission.live.test.ts. The database here is a fake transaction answering by table and organization.)
import { readFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SUB = (organizationId: string, id: string) => ({
  id,
  organizationId,
  providerEntityId: "pe-1",
  locationId: null,
  claimId: `claim-${id}`,
  status: "queued",
  attemptCount: 0,
  ambiguous: false,
  transportCallStartedAt: null,
  // the synthetic 837I fixture's PCN, payer and billing NPI: a Claim.MD send checks the rendered identity against the row
  controlNumber: "WXHOSP0001",
  interchangeControlNumber: 1,
  clearinghousePayerId: "STEDI",
  clearinghouseKey: "x",
  requestedByMembershipId: "m-1",
  requestedAt: new Date("2026-11-01T00:00:00Z"),
  payloadStamp: new Date("2026-11-01T00:00:00Z"),
  payloadHash: null,
});
const dueByOrg = new Map<string, ReturnType<typeof SUB>[]>();

vi.mock("@chartwarden/tenancy", async () => {
  const actual = await vi.importActual<object>("@chartwarden/tenancy");
  const chain = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(rows).then(resolve, reject)
            : () => chain(rows),
      },
    );
  return {
    ...actual,
    withOrgContext: async (
      _db: unknown,
      ctx: { organizationId: string },
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      const rowsOf = (table: Parameters<typeof getTableName>[0]): unknown[] => {
        const name = getTableName(table);
        if (name === "commercial_submission") return dueByOrg.get(ctx.organizationId) ?? [];
        if (name === "commercial_claim") return [{ id: "claim", state: "ready" }];
        return [];
      };
      return fn({
        select: () => ({
          from: (table: Parameters<typeof getTableName>[0]) => chain(rowsOf(table)),
        }),
        update: (table: Parameters<typeof getTableName>[0]) => chain(rowsOf(table)),
        insert: () => ({ values: async () => undefined }),
      });
    },
  };
});

// the send gate is the submission service's own (proven there); here it only lets the row through
vi.mock("../services/submission-service", async () => {
  const actual = await vi.importActual<object>("../services/submission-service");
  return {
    ...actual,
    evaluateGateForClaim: async () => ({ ok: true, clearinghousePayerId: "STEDI", reasons: [] }),
  };
});

import { runSubmissionDrain } from "./submission-worker";

const syntheticClaimX12 = readFileSync(
  new URL(
    "../../../../../../packages/x12-837-client/src/clearinghouse/__fixtures__/stedi-claim.x12",
    import.meta.url,
  ),
  "utf8",
);

interface Sent {
  readonly vendor: string;
  readonly organizationId: string;
}
const sent: Sent[] = [];
const transportOf = (vendor: string) => ({
  submitClaim: async (ctx: { organizationId: string }) => {
    sent.push({ vendor, organizationId: ctx.organizationId });
    return { ok: true as const, data: { clearinghouseSubmissionId: `receipt-${vendor}` } };
  },
});

/** Evidence each send recorded, by the account it was recorded for. */
const evidence: {
  readonly port: string;
  readonly step: string;
  readonly input: Record<string, unknown>;
}[] = [];
const evidencePort = (port: string, accountReference: string, reserve?: () => Promise<string>) => ({
  accountReference,
  usage: "test" as const,
  reserve: async (input: Record<string, unknown>) => {
    evidence.push({ port, step: "reserve", input });
    return reserve ? reserve() : `${port}-evidence`;
  },
  observe: async (input: Record<string, unknown>) => {
    evidence.push({ port, step: "observe", input });
  },
});

/** `claimmd` here is a tenant's OWN sealed Claim.MD account (`account: "tenant"`), as the tenant resolver builds it. */
function deps(
  bound: Record<string, string>,
  orgs: string[],
  opts: { tenantEvidence?: boolean; tenantReserve?: () => Promise<string> } = {},
) {
  return {
    db: {} as never,
    // the platform pair is the unbound default; only forOrg says anything about an organization
    binding: {
      vendor: null,
      transport: transportOf("PLATFORM-DEFAULT-MUST-NOT-BE-USED"),
      forOrg: async (organizationId: string) => ({
        vendor: bound[organizationId] ?? null,
        ...(bound[organizationId] === "claimmd" ? { account: "tenant" as const } : {}),
        transport: transportOf(bound[organizationId] ?? "unbound"),
      }),
    },
    // the platform account's store: a tenant's own account must never record under it
    claimMdEvidence: evidencePort("PLATFORM-EVIDENCE-MUST-NOT-BE-USED", "acct-platform"),
    ...(opts.tenantEvidence === false
      ? {}
      : {
          tenantClaimMdEvidence: {
            submission: (organizationId: string) =>
              evidencePort(
                `tenant-${organizationId}`,
                `tenant:${organizationId}`,
                opts.tenantReserve,
              ),
            notice: () => ({}) as never,
          },
        }),
    contexts: {
      contextFor: async (organizationId: string, providerEntityId: string) => ({
        organizationId,
        providerEntityId,
        payerId: "payer-1",
        correlationId: "corr",
        usage: "test" as const,
        billingNpi: "1234567893",
      }),
    },
    renderer: { render: async () => ({ ok: true as const, x12: syntheticClaimX12 }) },
    outbox: { publish: async () => undefined },
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  };
}

describe("runSubmissionDrain: each org's due claim goes out through that org's own transport", () => {
  beforeEach(() => {
    sent.length = 0;
    evidence.length = 0;
    dueByOrg.clear();
  });

  it("sends org-1's row through org-1's vendor and org-2's through org-2's, each with its own context", async () => {
    dueByOrg.set("org-1", [SUB("org-1", "a")]);
    dueByOrg.set("org-2", [SUB("org-2", "b")]);

    const result = await runSubmissionDrain(
      deps({ "org-1": "stedi", "org-2": "claimmd" }, ["org-1", "org-2"]) as never,
    );

    expect(result).toEqual({ sent: 2, failures: [] });
    expect(sent).toEqual([
      { vendor: "stedi", organizationId: "org-1" },
      { vendor: "claimmd", organizationId: "org-2" },
    ]);
  });

  it("sends nothing at all for an org with no clearinghouse, and never through the platform default", async () => {
    dueByOrg.set("org-1", [SUB("org-1", "a")]);
    dueByOrg.set("org-3", [SUB("org-3", "c")]);

    const result = await runSubmissionDrain(
      deps({ "org-1": "stedi" }, ["org-1", "org-3"]) as never,
    );

    expect(result.sent).toBe(1);
    expect(sent).toEqual([{ vendor: "stedi", organizationId: "org-1" }]);
    expect(sent.map((s) => s.vendor)).not.toContain("PLATFORM-DEFAULT-MUST-NOT-BE-USED");
    expect(sent.map((s) => s.vendor)).not.toContain("unbound");
  });

  it("a tenant's own Claim.MD send records its evidence under its own org and account, never the platform account's", async () => {
    dueByOrg.set("org-2", [SUB("org-2", "b")]);

    const result = await runSubmissionDrain(deps({ "org-2": "claimmd" }, ["org-2"]) as never);

    expect(result).toEqual({ sent: 1, failures: [] });
    expect(evidence.map((e) => [e.port, e.step])).toEqual([
      ["tenant-org-2", "reserve"],
      ["tenant-org-2", "observe"],
    ]);
    expect(evidence[0]?.input).toMatchObject({
      organizationId: "org-2",
      accountReference: "tenant:org-2",
    });
    expect(evidence[1]?.input).toMatchObject({
      organizationId: "org-2",
      accountReference: "tenant:org-2",
    });
  });

  it("a tenant's own Claim.MD send whose evidence cannot be written is not sent", async () => {
    dueByOrg.set("org-2", [SUB("org-2", "b")]);

    await runSubmissionDrain(
      deps({ "org-2": "claimmd" }, ["org-2"], {
        tenantReserve: async () => {
          throw new Error("storage unavailable");
        },
      }) as never,
    );

    expect(sent).toEqual([]);
    expect(evidence.map((e) => e.port)).not.toContain("PLATFORM-EVIDENCE-MUST-NOT-BE-USED");
  });

  it("a tenant's own Claim.MD account with no tenant evidence store sends nothing and never borrows the platform's", async () => {
    dueByOrg.set("org-2", [SUB("org-2", "b")]);

    await runSubmissionDrain(
      deps({ "org-2": "claimmd" }, ["org-2"], { tenantEvidence: false }) as never,
    );

    expect(sent).toEqual([]);
    expect(evidence).toEqual([]);
  });
});
