// Review of slice 4 (LOW): the resolve service hard-coded `actorIsAdministrator: true`, and an unclassified fault of its transaction reached the
// error handler, which logs `{ err }`: a Drizzle error embeds the bound values, the administrator's free-text reason among them.
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createTransmissionResolveService } from "./transmission-resolve";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const REASON = "Checked the account of Jane Synthetic: nothing there.";
const actor = { organizationId: ORG, userId: "u-1", membershipId: "m-1" };

function build(transaction: () => Promise<unknown>) {
  const warnings: { fields: Record<string, string>; message: string }[] = [];
  let touched = 0;
  const service = createTransmissionResolveService({
    db: {
      transaction: async () => {
        touched += 1;
        return transaction();
      },
    } as unknown as DbClient,
    outbox: { publish: async () => undefined } as never,
    audit: { record: async () => undefined } as never,
    warn: (fields, message) => warnings.push({ fields, message }),
  });
  return { service, warnings, touched: () => touched };
}

describe("resolving a held transmission", () => {
  it("is refused (403) unless the route says the caller is an administrator, before the database is touched", async () => {
    const h = build(async () => {
      throw new Error("not reached");
    });
    await expect(
      h.service.resolve(
        actor,
        ORDER,
        { outcome: "not_sent", reason: REASON },
        { actorIsAdministrator: false },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.touched()).toBe(0);
  });

  it("an unexpected fault is rethrown typed and WITHOUT its cause, and logged with ids and the class only (never the reason)", async () => {
    const h = build(async () => {
      throw new TypeError(`Failed query: update ... params: ${REASON}`);
    });
    const err = await h.service
      .resolve(actor, ORDER, { outcome: "not_sent", reason: REASON }, { actorIsAdministrator: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChartWardenError);
    expect(err).toMatchObject({ code: "DOSESPOT_RESOLVE_FAILED", statusCode: 500 });
    expect((err as Error).cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain("Jane");
    expect((err as Error).message).not.toContain("Jane");
    expect(h.warnings.map((w) => w.fields)).toEqual([
      { organizationId: ORG, orderId: ORDER, outcome: "not_sent", cause: "TypeError" },
    ]);
    expect(JSON.stringify(h.warnings)).not.toContain("Jane");
  });

  it("a typed refusal from inside the transaction passes through unchanged", async () => {
    const refusal = new ChartWardenError("DOSESPOT_TRANSMISSION_NOT_HELD", "not held", 409);
    const h = build(async () => {
      throw refusal;
    });
    await expect(
      h.service.resolve(
        actor,
        ORDER,
        { outcome: "not_sent", reason: REASON },
        { actorIsAdministrator: true },
      ),
    ).rejects.toBe(refusal);
    expect(h.warnings).toEqual([]);
  });
});
