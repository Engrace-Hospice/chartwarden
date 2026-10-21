/**
 * F-223 — unit tests for the `m11.order.recertification_signed` consumer's pure edges (no database):
 * binding identity and the malformed-payload SETTLE (never a retry storm). The DB behaviour is proven by
 * `m6-recertification-signed.live.test.ts`.
 */
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  M6_RECERTIFICATION_SIGNED_CONSUMER,
  applyRecertificationSigned,
  buildM6RecertificationSignedConsumer,
} from "../src/modules/06-admission/outbox-consumers/m11-recertification-signed";

// A db that explodes on any use: a settled-on-payload delivery must never reach it.
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched for an invalid payload");
    },
  },
) as unknown as DbClient;
const deps = { db: explodingDb, outbox: { async publish() {} } };

describe("F-223 m6.recertification-signed consumer", () => {
  it("binds the catalogued M11 event under module m6", () => {
    const b = buildM6RecertificationSignedConsumer(deps);
    expect(b.consumerModule).toBe("m6");
    expect(b.eventTypes).toEqual(["m11.order.recertification_signed"]);
    expect(b.consumerName).toBe(M6_RECERTIFICATION_SIGNED_CONSUMER.consumerName);
  });

  it.each([
    ["null payload", null],
    ["missing orderId", { admissionId: "a", periodEndDate: "2026-03-31" }],
    ["missing admissionId", { orderId: "o", periodEndDate: "2026-03-31" }],
    ["non-date periodEndDate", { orderId: "o", admissionId: "a", periodEndDate: "next week" }],
    ["numeric orderId", { orderId: 7, admissionId: "a", periodEndDate: "2026-03-31" }],
  ])("settles (no throw, no db) on %s", async (_name, payload) => {
    await expect(
      applyRecertificationSigned(deps, { organizationId: "org", payload }),
    ).resolves.toEqual({ kind: "settled", reason: "invalid_payload" });
    await expect(
      buildM6RecertificationSignedConsumer(deps).handle({ organizationId: "org", payload }),
    ).resolves.toBeUndefined();
  });
});
