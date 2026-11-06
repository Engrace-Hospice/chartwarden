// Owner decision (round 2, Q3): a transfer notice (8xC) for an org that bills outside ChartWarden is refused AT SUBMIT with a typed 409
// CLAIMS_FILE_WITH_YOUR_BILLER, instead of a 202 followed by a silent hold. The choice is read before anything is touched (no
// transaction, no claim_submission, no job, no event). No database: the check comes first, so a bare `{}` db proves it.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildTransferNoticeService } from "../src/modules/23-billing-medicare/services/transfer-notice-service";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = {
  organizationId: ORG,
  userId: "00000000-0000-4000-8000-0000000000b2",
  membershipId: "00000000-0000-4000-8000-0000000000c3",
  stepUpRecent: true,
  actorKind: "user",
  roles: [],
};
const ARGS = { expectedVersion: 1 } as never;

function service(billsOutside: ((org: string) => Promise<boolean>) | undefined) {
  const touched: string[] = [];
  const svc = buildTransferNoticeService(
    {} as never,
    {
      ...(billsOutside ? { billsOutside } : {}),
      jobs: {
        enqueue: async () => {
          touched.push("enqueue");
          return { jobId: "j" };
        },
      },
      outbox: {
        publish: async () => {
          touched.push("publish");
        },
      } as never,
    } as never,
  );
  return { svc, touched };
}

describe("transfer-notice submit for an org that bills outside ChartWarden", () => {
  it("answers 409 CLAIMS_FILE_WITH_YOUR_BILLER and touches nothing", async () => {
    const { svc, touched } = service(async () => true);
    const err = await svc.submit(ACTOR as never, "notice-1", ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChartWardenError);
    expect(err).toMatchObject({ code: "CLAIMS_FILE_WITH_YOUR_BILLER", statusCode: 409 });
    expect(touched).toEqual([]);
  });

  it("fails closed with a typed 503 when the choice cannot be read (never a guess)", async () => {
    const { svc, touched } = service(async () => {
      throw new Error("seam down");
    });
    const err = await svc.submit(ACTOR as never, "notice-1", ARGS).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CLEARINGHOUSE_CHOICE_UNAVAILABLE", statusCode: 503 });
    expect(touched).toEqual([]);
  });

  it("does not ask when no port is bound (a deployment where nobody bills outside): the normal path runs", async () => {
    const { svc } = service(undefined);
    // past the choice check the service needs a database; the bare `{}` makes it fail THERE, not with the 409
    const err = await svc.submit(ACTOR as never, "notice-1", ARGS).catch((e: unknown) => e);
    expect(err).not.toMatchObject({ code: "CLAIMS_FILE_WITH_YOUR_BILLER" });
  });
});
