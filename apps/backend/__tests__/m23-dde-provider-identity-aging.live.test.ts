/**
 * M23 DDE work queue: the provider-identifier seam on the keying sheet (#765) and age-based status / alerting for items
 * with no deadline (#767), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role through the real routes.
 *
 *   - the keying sheet carries `Provider CCN` and `Billing NPI` read through the seam on the caller's org-scoped
 *     transaction; unbound => the fields are absent; another org's provider entity resolves to nothing (cross-tenant),
 *     whichever org's context asks; no MBI anywhere on the sheet (ADR-0052 D7).
 *   - an open rtp_correction item (deadline NULL) ages: status overdue after the business-day threshold, the
 *     `overdue=true` list filter finds it, a fresh item is on track and not listed; the daily alert reads each org's own
 *     queue only and carries ids/counts only.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-provider-identity-aging:live
 */
import { withOrgContext } from "@chartwarden/tenancy";
import type { FastifyInstance } from "fastify";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readProviderIdentityOnTx } from "../src/bootstrap/provider-entity-resolver";
import { createDrizzleDdeAgingStore } from "../src/modules/23-billing-medicare/dde-aging-store";
import {
  DDE_AGING_ALERT_CODE,
  runDdeAgingAlert,
} from "../src/modules/23-billing-medicare/jobs/dde-aging-alert";
import {
  BASE,
  type DdeLiveDb,
  ORG_A,
  ORG_B,
  PE_A,
  PE_B,
  USER_A,
  USER_B,
  buildDdeApp,
  connectDdeLiveDb,
  seedClaimWithSubmission,
  seedNoe,
} from "./_dde-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const CCN_A = "991111";
const NPI_A = "1111111111";
const CCN_B = "992222";
const NPI_B = "2222222222";

describe.skipIf(!DB_URL)("M23 DDE provider identity and aging, LIVE Postgres (#765, #767)", () => {
  let live: DdeLiveDb;
  let admin: Client;
  let app: FastifyInstance;
  let counter = 0;
  const hdr = (user = USER_A) => ({
    "x-test-user": user,
    "idempotency-key": `dde-pia-${++counter}`,
  });
  const create = async (user: string, body: unknown) => {
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: hdr(user),
      payload: body as never,
    });
    expect(res.statusCode).toBe(201);
    return res.json().ddeWorkItemId as string;
  };
  const detail = async (id: string) =>
    (await app.inject({ method: "GET", url: `${BASE}/${id}`, headers: hdr() })).json();
  const fieldsOf = (d: { keying: { fields: { label: string; value: string }[] } }) =>
    Object.fromEntries(d.keying.fields.map((f) => [f.label, f.value]));
  const withIdentity = async () => {
    await app?.close();
    app = await buildDdeApp(live, {
      providerIdentity: (tx, org, pe) => readProviderIdentityOnTx(tx as never, org, pe),
    });
  };
  const backdate = (id: string, days: number) =>
    admin.query(
      "UPDATE dde_work_item SET created_at = now() - ($2 || ' days')::interval WHERE id=$1",
      [id, String(days)],
    );

  beforeAll(async () => {
    live = await connectDdeLiveDb(DB_URL as string);
    admin = live.admin;
    for (const [id, org, ccn, npi] of [
      [PE_A, ORG_A, CCN_A, NPI_A],
      [PE_B, ORG_B, CCN_B, NPI_B],
    ] as const) {
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,'Synthetic Hospice',$4,'enc','1231')`,
        [id, org, ccn, npi],
      );
    }
  }, 300_000);
  afterAll(async () => {
    await app?.close();
    await live?.handle.close();
    await admin?.end();
  });
  beforeEach(async () => {
    await withIdentity();
  });

  describe("provider identifiers on the keying sheet (#765)", () => {
    it("adds Provider CCN and Billing NPI to the NOE and claim sheets, and no MBI", async () => {
      const noeItem = await create(USER_A, { itemType: "noe", subjectId: await seedNoe(admin) });
      const { claimId } = await seedClaimWithSubmission(admin, { state: "ACK_REJECTED" });
      const claimItem = await create(USER_A, { itemType: "rtp_correction", subjectId: claimId });
      for (const id of [noeItem, claimItem]) {
        const d = await detail(id);
        expect(fieldsOf(d)).toMatchObject({ "Provider CCN": CCN_A, "Billing NPI": NPI_A });
        expect(JSON.stringify(d.keying)).not.toMatch(/mbi|beneficiary/i);
      }
    });

    it("omits the fields when the seam is unbound (fail closed to not shown)", async () => {
      await app.close();
      app = await buildDdeApp(live);
      const id = await create(USER_A, { itemType: "noe", subjectId: await seedNoe(admin) });
      const labels = Object.keys(fieldsOf(await detail(id)));
      expect(labels).toContain("Type of bill");
      expect(labels).not.toContain("Provider CCN");
      expect(labels).not.toContain("Billing NPI");
    });

    it("never returns another org's provider entity, from either side", async () => {
      const asOrg = (org: string, pe: string) =>
        withOrgContext(
          live.handle.db as never,
          { organizationId: org, userId: org === ORG_A ? USER_A : USER_B },
          (tx) => readProviderIdentityOnTx(tx as never, org, pe),
        );
      expect(await asOrg(ORG_A, PE_A)).toEqual({ ccn: CCN_A, npi: NPI_A });
      expect(await asOrg(ORG_B, PE_B)).toEqual({ ccn: CCN_B, npi: NPI_B });
      expect(await asOrg(ORG_A, PE_B)).toBeNull();
      expect(await asOrg(ORG_B, PE_A)).toBeNull();
    });

    it("an org A item that points at org B's provider entity shows no identifiers", async () => {
      const noe = await seedNoe(admin, { providerEntityId: PE_B });
      const id = await create(USER_A, { itemType: "noe", subjectId: noe });
      const labels = Object.keys(fieldsOf(await detail(id)));
      expect(labels).not.toContain("Provider CCN");
      expect(JSON.stringify(await detail(id))).not.toContain(CCN_B);
      expect(JSON.stringify(await detail(id))).not.toContain(NPI_B);
    });
  });

  describe("aging of items with no deadline (#767)", () => {
    it("ages an open RTP item to overdue and finds it with overdue=true; a fresh one is on track", async () => {
      const old = await create(USER_A, {
        itemType: "rtp_correction",
        subjectId: (await seedClaimWithSubmission(admin, { state: "ACK_REJECTED" })).claimId,
      });
      const fresh = await create(USER_A, {
        itemType: "rtp_correction",
        subjectId: (await seedClaimWithSubmission(admin, { state: "ACK_REJECTED" })).claimId,
      });
      await backdate(old, 21); // 21 calendar days is at least 10 business days
      expect((await detail(old)).deadlineStatus).toBe("overdue");
      expect((await detail(fresh)).deadlineStatus).toBe("on_track");

      const listed = await app.inject({
        method: "GET",
        url: `${BASE}?overdue=true&limit=100`,
        headers: hdr(),
      });
      const ids = (listed.json().items as { ddeWorkItemId: string }[]).map((i) => i.ddeWorkItemId);
      expect(ids).toContain(old);
      expect(ids).not.toContain(fresh);
    });

    it("lists a 7-8 day old item under atRisk, not overdue", async () => {
      const mid = await create(USER_A, {
        itemType: "adjustment",
        subjectId: (await seedClaimWithSubmission(admin, { state: "PAID" })).claimId,
      });
      await backdate(mid, 8); // 8 calendar days is 5 or 6 business days
      expect((await detail(mid)).deadlineStatus).toBe("at_risk");
      const get = async (q: string) =>
        (
          (
            await app.inject({ method: "GET", url: `${BASE}?${q}&limit=100`, headers: hdr() })
          ).json().items as { ddeWorkItemId: string }[]
        ).map((i) => i.ddeWorkItemId);
      expect(await get("atRisk=true")).toContain(mid);
      expect(await get("overdue=true")).not.toContain(mid);
    });

    it("the daily alert reads each org's own queue and carries ids and counts only", async () => {
      const aItem = await create(USER_A, {
        itemType: "cancel",
        subjectId: (await seedClaimWithSubmission(admin, { state: "PAID" })).claimId,
      });
      const bClaim = await seedClaimWithSubmission(admin, {
        orgId: ORG_B,
        providerEntityId: PE_B,
        state: "ACK_REJECTED",
      });
      const bItem = await create(USER_B, { itemType: "rtp_correction", subjectId: bClaim.claimId });
      await backdate(aItem, 21);
      await backdate(bItem, 21);

      const sent: {
        organizationId: string;
        alertCode: string;
        payload: Record<string, unknown>;
      }[] = [];
      await runDdeAgingAlert({
        store: createDrizzleDdeAgingStore(live.handle.db as never),
        alerts: { dispatch: async (a) => void sent.push(a) },
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      });
      const forA = sent.find((s) => s.organizationId === ORG_A);
      const forB = sent.find((s) => s.organizationId === ORG_B);
      expect(forA?.alertCode).toBe(DDE_AGING_ALERT_CODE);
      expect(forA?.payload.overdueItemIds).toContain(aItem);
      expect(forA?.payload.overdueItemIds).not.toContain(bItem);
      expect(forB?.payload.overdueItemIds).toEqual([bItem]);
      expect(JSON.stringify(sent)).not.toMatch(/mbi|notes|ccn|npi/i);
    });
  });
});
