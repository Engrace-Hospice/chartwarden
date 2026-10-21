// apps/backend/__tests__/f238-records-request-expiry.test.ts — F-238 (0314): records-request expiry and the
// extend / re-open route, over the in-memory service + the real route registrar. (Kept beside
// f238-records-request.test.ts, which covers the code, the cover sheet and the other routes.)
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryRecordsRequestService,
  defaultExpiresOn,
  receivedAfterExpiry,
  registerRecordsRequestRoutes,
  runRecordsRequestExpiryFanout,
} from "../src/modules/22-documents/index";

const ORG = "org_a";
const ORG_B = "org_b";
const REFERRAL = "66666666-6666-4666-8666-666666666666";
const OTHER_REFERRAL = "77777777-7777-4777-8777-777777777777";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["intake"];
}

const GRANTS: Record<string, string[]> = {
  intake_1: ["intake.upload", "intake.read"],
  reader_1: ["intake.read"],
};

function makeServer() {
  const grantStore = createInMemoryEffectivePermissionStore(
    Object.entries(GRANTS).flatMap(([userId, permissionKeys]) =>
      [ORG, ORG_B].map((orgId) => ({
        orgId,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();
  // "Today" is 2026-10-04 (UTC).
  const service = createInMemoryRecordsRequestService({
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  const referrals = new Set([REFERRAL, OTHER_REFERRAL]);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerRecordsRequestRoutes(app, {
    service,
    referralReader: {
      async canAccessReferral(i) {
        return i.organizationId === ORG && referrals.has(i.referralId);
      },
      async getReferralSubject(i) {
        return i.organizationId === ORG && referrals.has(i.referralId)
          ? { patientId: null, patientNameAtReceipt: "DOCLENS, ARTHUR", patientDobAtReceipt: null }
          : null;
      },
    },
  } as Parameters<typeof registerRecordsRequestRoutes>[1]);
  return { app, service };
}

const H = (user: string, org = ORG) => ({ "x-test-user": user, "x-test-org": org });
const BODY = {
  recipientName: "Dr. Pell",
  recipientFax: "(503) 555-0100",
  recordsRequested: ["history_and_physical"],
  dueDate: "2026-10-01",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("F-238 — records-request expiry", () => {
  type App = ReturnType<typeof makeServer>["app"];
  const create = (app: App, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/referrals/${REFERRAL}/records-requests`,
      headers: H("intake_1"),
      payload: { ...BODY, ...extra },
    });
  const extend = (
    app: App,
    id: string,
    payload: Record<string, unknown>,
    user = "intake_1",
    referral = REFERRAL,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/referrals/${referral}/records-requests/${id}/extend`,
      headers: H(user),
      payload,
    });
  const mark = (app: App, id: string, status: "received" | "partially_received") =>
    app.inject({
      method: "POST",
      url: `/api/v1/referrals/${REFERRAL}/records-requests/${id}/status`,
      headers: H("intake_1"),
      payload: { status },
    });
  const byId = async (app: App) =>
    new Map<string, Record<string, unknown>>(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/referrals/${REFERRAL}/records-requests`,
          headers: H("reader_1"),
        })
      )
        .json()
        .items.map((x: { id: string }) => [x.id, x]),
    );

  it("the default expiry is 30 days after the due date, or after today once the due date has passed", () => {
    expect(defaultExpiresOn("2026-10-20", "2026-10-04")).toBe("2026-11-19");
    expect(defaultExpiresOn("2026-10-01", "2026-10-04")).toBe("2026-11-03");
    expect(defaultExpiresOn(null, "2026-12-15")).toBe("2027-01-14");
  });

  it("'arrived after expiry' only when records came in at/after the sweep expired the request", () => {
    expect(receivedAfterExpiry("2026-10-05T00:00:00.000Z", "2026-10-04T00:17:00.000Z")).toBe(true);
    expect(receivedAfterExpiry("2026-10-03T00:00:00.000Z", "2026-10-04T00:17:00.000Z")).toBe(false);
    expect(receivedAfterExpiry(null, "2026-10-04T00:17:00.000Z")).toBe(false);
    expect(receivedAfterExpiry("2026-10-05T00:00:00.000Z", null)).toBe(false);
  });

  it("a new request carries its expiry (default or chosen); an expiry before the due date is 422", async () => {
    const { app } = makeServer();
    const dflt = await create(app);
    expect(dflt.statusCode).toBe(201);
    expect(dflt.json()).toMatchObject({
      expiresOn: "2026-11-03",
      expiredAt: null,
      receivedAfterExpiry: false,
    });
    const chosen = await create(app, { dueDate: "2026-10-10", expiresOn: "2026-10-31" });
    expect(chosen.statusCode).toBe(201);
    expect(chosen.json().expiresOn).toBe("2026-10-31");
    const before = await create(app, { dueDate: "2026-10-10", expiresOn: "2026-10-09" });
    expect(before.statusCode).toBe(422);
  });

  it("the sweep expires only unanswered requests past their expiry; extending re-opens one", async () => {
    const { app, service } = makeServer();
    const stale = (await create(app, { dueDate: "2026-09-01", expiresOn: "2026-10-03" })).json();
    const today = (await create(app, { dueDate: "2026-09-01", expiresOn: "2026-10-04" })).json();
    const fresh = (await create(app)).json();
    const partial = (await create(app, { dueDate: "2026-09-01", expiresOn: "2026-10-03" })).json();
    expect((await mark(app, partial.id, "partially_received")).statusCode).toBe(200);

    expect(service.expireDue(ORG_B)).toBe(0);
    expect(service.expireDue(ORG)).toBe(1);
    let rows = await byId(app);
    expect(rows.get(stale.id)).toMatchObject({ status: "expired", overdue: true });
    expect(rows.get(stale.id)?.expiredAt).toBeTruthy();
    // Expires AFTER its expiry day, not on it.
    expect(rows.get(today.id)).toMatchObject({ status: "requested" });
    expect(rows.get(fresh.id)).toMatchObject({ status: "requested" });
    // A partial receipt has records in hand: never expired.
    expect(rows.get(partial.id)).toMatchObject({ status: "partially_received" });

    // Re-open: today / a past day is 422; a reader is 403; another referral's path is 404.
    expect((await extend(app, stale.id, { expiresOn: "2026-10-04" })).statusCode).toBe(422);
    expect((await extend(app, stale.id, { expiresOn: "2026-12-01" }, "reader_1")).statusCode).toBe(
      403,
    );
    expect(
      (await extend(app, stale.id, { expiresOn: "2026-12-01" }, "intake_1", OTHER_REFERRAL))
        .statusCode,
    ).toBe(404);
    // A new expiry before the (new) due date is 422.
    expect(
      (await extend(app, stale.id, { expiresOn: "2026-11-01", dueDate: "2026-11-15" })).statusCode,
    ).toBe(422);
    const reopened = await extend(app, stale.id, {
      expiresOn: "2026-12-01",
      dueDate: "2026-11-01",
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({
      status: "requested",
      expiresOn: "2026-12-01",
      dueDate: "2026-11-01",
      expiredAt: null,
      overdue: false,
    });
    rows = await byId(app);
    expect(rows.get(stale.id)).toMatchObject({ status: "requested" });
    expect(service.expireDue(ORG)).toBe(0);
  });

  it("records marked received after expiry say so (and keep the expiry stamp)", async () => {
    const { app, service } = makeServer();
    const r = (await create(app, { dueDate: "2026-09-01", expiresOn: "2026-10-01" })).json();
    service.expireDue(ORG);
    const res = await mark(app, r.id, "received");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "received", receivedAfterExpiry: true });
    expect(res.json().expiredAt).toBeTruthy();
  });

  it("only an open or expired request can be extended (409 otherwise)", async () => {
    const { app } = makeServer();
    const a = (await create(app)).json();
    await mark(app, a.id, "received");
    const res = await extend(app, a.id, { expiresOn: "2026-12-01" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RECORDS_REQUEST_NOT_EXTENDABLE");
  });

  it("the hourly fan-out runs every org; one org's failure never skips the others", async () => {
    const orgs = async () => [{ organizationId: "a" }, { organizationId: "b" }];
    expect(
      await runRecordsRequestExpiryFanout({
        activeOrgs: { listActiveOrgs: orgs },
        expireForOrg: async (org) => (org === "a" ? 2 : 0),
      }),
    ).toEqual({ orgs: 2, expired: 2 });
    const seen: string[] = [];
    await expect(
      runRecordsRequestExpiryFanout({
        activeOrgs: { listActiveOrgs: orgs },
        expireForOrg: async (org) => {
          seen.push(org);
          if (org === "a") throw new Error("boom");
          return 1;
        },
      }),
    ).rejects.toThrow(/1 org failure/);
    expect(seen).toEqual(["a", "b"]);
  });
});
