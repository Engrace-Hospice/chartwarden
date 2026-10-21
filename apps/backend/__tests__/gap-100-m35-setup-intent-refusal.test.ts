/**
 * GAP-100 — `POST /payment_methods/setup_intent` must not answer a permanent `{clientSecret: null,
 * status: "pending"}`: no stripe-dispatcher worker exists to provision a SetupIntent. The Drizzle route service
 * refuses 503 and never touches the database.
 */
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import type { M35WriteActor } from "../src/modules/35-subscription/routes/actor";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";

const UNTOUCHED_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("a refused SetupIntent must not touch the database");
    },
  },
) as DbClient;

describe("M35 createSetupIntent without a Stripe dispatcher (GAP-100)", () => {
  it("refuses 503 instead of returning a pending marker nothing will resolve", async () => {
    const service = buildDrizzleM35RouteService(UNTOUCHED_DB);
    await expect(
      service.createSetupIntent({ organizationId: "org-1", userId: "user-1" } as M35WriteActor),
    ).rejects.toMatchObject({ code: "STRIPE_DISPATCHER_UNAVAILABLE", statusCode: 503 });
  });
});
