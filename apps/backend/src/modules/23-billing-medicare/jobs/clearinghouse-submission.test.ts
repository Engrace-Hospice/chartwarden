import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tenantClaimMdAccountReference } from "../claimmd-evidence/store";
import { ClearinghouseTransportError, transportUpload } from "./clearinghouse-submission";

const x12 = readFileSync(
  new URL(
    "../../../../../../packages/x12-837-client/src/clearinghouse/__fixtures__/stedi-claim.x12",
    import.meta.url,
  ),
  "utf8",
);
const noticeX12 = (kind: "noe" | "notr" | "transfer_notice") =>
  readFileSync(
    new URL(
      `../../../../../../packages/x12-837-client/src/clearinghouse/__fixtures__/stedi-${kind === "noe" ? "NOE_81A" : kind === "notr" ? "NOTR_81B" : "TRANSFER_81C"}.x12`,
      import.meta.url,
    ),
    "utf8",
  )
    .replace(/(ISA(?:\*[^*]*){7}\*)[^*]*/, `$1${"CLAIMMD".padEnd(15, " ")}`)
    .replace(/(GS\*HC\*[^*]+\*)[^*]*/, "$1CLAIMMD");
const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  providerEntityId: "00000000-0000-4000-8000-000000000002",
  payerId: "payer-context-is-not-used-as-evidence",
  correlationId: "correlation-synthetic",
  usage: "test" as const,
  billingNpi: "1234567893",
  claimMdRouteFingerprint: "a".repeat(64),
};

function makeTransport(
  order: string[],
  reserve: (input: unknown) => Promise<string> = async () => "evidence-synthetic",
  ctx = context,
) {
  return {
    binding: {
      vendor: "claimmd",
      transport: {
        submitClaim: vi.fn(async () => {
          order.push("upload");
          return {
            ok: true as const,
            data: {
              clearinghouseSubmissionId: "claim-synthetic",
              idempotencyKey: "k",
              controlNumber: "WXHOSP0001",
              receivedAt: new Date().toISOString(),
              replayed: false,
            },
          };
        }),
        submitNotice: vi.fn(),
      },
    },
    contexts: { contextFor: async () => ctx, providerEntitiesFor: async () => [] },
    claimMdEvidence: {
      accountReference: "acct-synthetic",
      usage: "test" as const,
      reserve: async (input: unknown) => {
        order.push("reserve");
        return reserve(input);
      },
      observe: async () => {
        order.push("observe");
      },
    },
  } as never;
}

describe("M23 Claim.MD evidence boundary", () => {
  const request = {
    organizationId: context.organizationId,
    providerEntityId: context.providerEntityId,
    kind: "claim_837i" as const,
    x12,
    controlNumber: "WXHOSP0001",
    claimId: "00000000-0000-4000-8000-000000000003",
    submissionId: "00000000-0000-4000-8000-000000000004",
    attemptIndex: 0,
    expectedRouteFingerprint: context.claimMdRouteFingerprint,
  };

  it("commits evidence before upload and appends the receipt afterward", async () => {
    const order: string[] = [];
    const result = await transportUpload(makeTransport(order))(request);
    expect(result.accepted).toBe(true);
    expect(order).toEqual(["reserve", "upload", "observe"]);
  });

  it("fails closed before upload when evidence reservation fails", async () => {
    const order: string[] = [];
    const upload = transportUpload(
      makeTransport(order, async (_input: unknown) => {
        throw new Error("storage unavailable");
      }),
    );
    await expect(upload(request)).rejects.toThrow(/Claim\.MD|claim/i);
    expect(order).toEqual(["reserve"]);
  });

  it("a tenant's own Claim.MD account records evidence under its own org and account reference, never the platform's", async () => {
    const order: string[] = [];
    const platform = makeTransport(order) as unknown as Record<string, unknown>;
    const reserved: unknown[] = [];
    const observed: unknown[] = [];
    const asked: unknown[] = [];
    const tenant = {
      ...platform,
      binding: { ...(platform.binding as object), account: "tenant" },
      tenantClaimMdEvidence: {
        submission: (organizationId: string, usage: string) => {
          asked.push({ organizationId, usage });
          return {
            accountReference: `tenant:${organizationId}`,
            usage,
            reserve: async (input: unknown) => {
              order.push("tenant-reserve");
              reserved.push(input);
              return "tenant-evidence";
            },
            observe: async (input: unknown) => {
              order.push("tenant-observe");
              observed.push(input);
            },
          };
        },
        notice: () => ({}) as never,
      },
    };
    await expect(transportUpload(tenant as never)(request)).resolves.toMatchObject({
      accepted: true,
    });
    expect(order).toEqual(["tenant-reserve", "upload", "tenant-observe"]);
    expect(asked).toEqual([{ organizationId: context.organizationId, usage: "test" }]);
    expect(reserved[0]).toMatchObject({
      organizationId: context.organizationId,
      accountReference: `tenant:${context.organizationId}`,
    });
    expect(observed[0]).toMatchObject({
      evidenceId: "tenant-evidence",
      organizationId: context.organizationId,
      accountReference: `tenant:${context.organizationId}`,
    });
  });

  it("a tenant's account reference passes the evidence tables' CHECK and is never a platform reference", () => {
    const ref = tenantClaimMdAccountReference("0A1B2C3D-0000-4000-8000-000000000001");
    // the same pattern as migration 1352's account_reference CHECK
    expect(ref).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(ref).toBe("tenant:0a1b2c3d-0000-4000-8000-000000000001");
  });

  it("a tenant's own Claim.MD account with no tenant evidence store fails closed and never borrows the platform's", async () => {
    const order: string[] = [];
    const platform = makeTransport(order) as unknown as Record<string, unknown>;
    const tenant = { ...platform, binding: { ...(platform.binding as object), account: "tenant" } };
    await expect(transportUpload(tenant as never)(request)).rejects.toThrow(/evidence/);
    expect(order).toEqual([]);
  });

  it("holds an already queued attempt when the configured payer route changes", async () => {
    const order: string[] = [];
    const transport = makeTransport(order, undefined, {
      ...context,
      claimMdRouteFingerprint: "b".repeat(64),
    });
    await expect(transportUpload(transport)(request)).rejects.toThrow(
      /route changed after submission was authorized/,
    );
    expect(order).toEqual([]);
  });

  it("preserves known pre-send refusal versus ambiguous transport outcome without vendor text", async () => {
    const known = makeTransport([]) as {
      binding: { transport: { submitClaim: () => Promise<unknown> } };
    };
    known.binding.transport.submitClaim = async () => ({
      ok: false,
      degraded: { code: "CH_UNAVAILABLE", reason: "synthetic refused" },
    });
    await expect(transportUpload(known as never)(request)).rejects.toMatchObject({
      name: "ClearinghouseTransportError",
      code: "CH_UNAVAILABLE",
      ambiguous: false,
    });

    const uncertain = makeTransport([]) as {
      binding: { transport: { submitClaim: () => Promise<unknown> } };
    };
    uncertain.binding.transport.submitClaim = async () => ({
      ok: false,
      degraded: { code: "CH_UNAVAILABLE", reason: "synthetic timeout", ambiguous: true },
    });
    await expect(transportUpload(uncertain as never)(request)).rejects.toMatchObject({
      name: "ClearinghouseTransportError",
      code: "CH_UNAVAILABLE",
      ambiguous: true,
    });
    expect(new ClearinghouseTransportError("claim", "CH_UNAVAILABLE").message).not.toContain(
      "SYNTHETIC",
    );
  });

  it("keeps notice uploads off by default and commits typed evidence before any notice transport call", async () => {
    for (const kind of ["noe", "notr", "transfer_notice"] as const) {
      const order: string[] = [];
      const submitNotice = vi.fn(async () => {
        order.push("upload");
        return {
          ok: true as const,
          data: {
            clearinghouseSubmissionId: "file-synthetic",
            idempotencyKey: "notice-key",
            controlNumber: "NOTICE-REF",
            receivedAt: new Date().toISOString(),
            replayed: false,
            vendorIdentifiers: [{ field: "fileid", value: "file-synthetic" }],
          },
        };
      });
      const base = {
        binding: { vendor: "claimmd", transport: { submitClaim: vi.fn(), submitNotice } },
        contexts: {
          contextFor: async () => ({ ...context, payerId: "STEDI" }),
          providerEntitiesFor: async () => [],
        },
        claimMdNoticeEvidence: {
          accountReference: "acct-synthetic",
          usage: "test" as const,
          reserve: async (v: unknown) => {
            order.push("reserve");
            expect(v).toMatchObject({
              noticeKind: kind,
              noticeId: "00000000-0000-4000-8000-000000000005",
              submissionId: "00000000-0000-4000-8000-000000000006",
            });
            return "notice-evidence";
          },
          observe: async () => {
            order.push("observe");
          },
        },
      };
      const notice = {
        organizationId: context.organizationId,
        providerEntityId: context.providerEntityId,
        kind,
        x12: noticeX12(kind),
        controlNumber: kind === "notr" ? "WXNOTR0001" : "WXNOE0001",
        noticeId: "00000000-0000-4000-8000-000000000005",
        submissionId: "00000000-0000-4000-8000-000000000006",
        attemptIndex: 0,
      };
      await expect(transportUpload(base as never)({ ...notice })).rejects.toThrow(/disabled/);
      expect(submitNotice).not.toHaveBeenCalled();
      const enabled = transportUpload({ ...base, claimMdNoticeUploadsEnabled: true } as never);
      await expect(enabled(notice)).resolves.toMatchObject({ accepted: true });
      expect(order).toEqual(["reserve", "upload", "observe"]);
    }
  });

  it("a tenant's own Claim.MD account records NOTICE evidence under its own org and tenant:<org>, never the platform's store", async () => {
    const order: string[] = [];
    const submitNotice = vi.fn(async () => {
      order.push("upload");
      return {
        ok: true as const,
        data: {
          clearinghouseSubmissionId: "file-synthetic",
          idempotencyKey: "notice-key",
          controlNumber: "NOTICE-REF",
          receivedAt: new Date().toISOString(),
          replayed: false,
          vendorIdentifiers: [{ field: "fileid", value: "file-synthetic" }],
        },
      };
    });
    const asked: { organizationId: string; usage: string }[] = [];
    const platformMustNotBeUsed = {
      accountReference: "acct-synthetic",
      usage: "test" as const,
      reserve: async () => {
        throw new Error("MUST-NOT-BE-USED: the platform notice store");
      },
      observe: async () => {
        throw new Error("MUST-NOT-BE-USED: the platform notice store");
      },
    };
    const tenant = {
      binding: {
        vendor: "claimmd",
        account: "tenant",
        transport: { submitClaim: vi.fn(), submitNotice },
      },
      contexts: {
        contextFor: async () => ({ ...context, payerId: "STEDI" }),
        providerEntitiesFor: async () => [],
      },
      claimMdNoticeEvidence: platformMustNotBeUsed,
      claimMdNoticeUploadsEnabled: true,
      tenantClaimMdEvidence: {
        submission: () => ({}) as never,
        notice: (organizationId: string, usage: string) => {
          asked.push({ organizationId, usage });
          return {
            accountReference: tenantClaimMdAccountReference(organizationId),
            usage,
            reserve: async () => {
              order.push("tenant-reserve");
              return "tenant-notice-evidence";
            },
            observe: async () => {
              order.push("tenant-observe");
            },
          };
        },
      },
    };
    await expect(
      transportUpload(tenant as never)({
        organizationId: context.organizationId,
        providerEntityId: context.providerEntityId,
        kind: "noe",
        x12: noticeX12("noe"),
        controlNumber: "WXNOE0001",
        noticeId: "00000000-0000-4000-8000-000000000005",
        submissionId: "00000000-0000-4000-8000-000000000006",
        attemptIndex: 0,
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(asked).toEqual([{ organizationId: context.organizationId, usage: "test" }]);
    expect(order).toEqual(["tenant-reserve", "upload", "tenant-observe"]);
  });
});
