// The submission drain with a clearinghouse PER ORGANIZATION, with a row that really goes out (ADR-0053 amendment 2026-11-06): each
// org's due submission is sent through THAT org's transport and no other, an org with none sends nothing, and the transport sees the
// org's own context. (The tick-level behaviour of an unbound org is in submission-worker.test.ts; the SQL is proven by
// m41-commercial-submission.live.test.ts. The database here is a fake transaction answering by table and organization.)
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
  controlNumber: `CN-${id}`,
  interchangeControlNumber: 1,
  clearinghousePayerId: "payer-1",
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
    evaluateGateForClaim: async () => ({ ok: true, clearinghousePayerId: "payer-1", reasons: [] }),
  };
});

import { runSubmissionDrain } from "./submission-worker";

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

function deps(bound: Record<string, string>, orgs: string[]) {
  return {
    db: {} as never,
    // the platform pair is the unbound default; only forOrg says anything about an organization
    binding: {
      vendor: null,
      transport: transportOf("PLATFORM-DEFAULT-MUST-NOT-BE-USED"),
      forOrg: async (organizationId: string) => ({
        vendor: bound[organizationId] ?? null,
        transport: transportOf(bound[organizationId] ?? "unbound"),
      }),
    },
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
    renderer: { render: async () => ({ ok: true as const, x12: "ISA*00~" }) },
    outbox: { publish: async () => undefined },
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  };
}

describe("runSubmissionDrain: each org's due claim goes out through that org's own transport", () => {
  beforeEach(() => {
    sent.length = 0;
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
});
