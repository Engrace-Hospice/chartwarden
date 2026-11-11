import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
});
