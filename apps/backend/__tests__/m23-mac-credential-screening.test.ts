// A MAC credential's BAA reference is free text a person types and the list returns; it is screened like the clearinghouse's
// BAA reference and attestation note (tenant-clearinghouse/screening.ts): an SSN or MBI shape is a 422 EVIDENCE_LOOKS_LIKE_PHI that
// never echoes the value, and nothing is read or written. This drives the REAL route and the REAL write service over a database
// that records every statement beyond setting the org scope, so "nothing stored" is asserted, not assumed.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { UpsertMacCredentialBodySchema } from "../src/modules/23-billing-medicare/routes/billing-typebox";
import { registerMacCredentialRoutes } from "../src/modules/23-billing-medicare/routes/mac-credentials.routes";
import { buildMacOnboardingCredentialPort } from "../src/modules/23-billing-medicare/routes/onboarding-credential-port";
import { buildDrizzleM23ReadService } from "../src/modules/23-billing-medicare/routes/read-service-drizzle";
import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/routes/write-service-drizzle";
import { OnboardingMacCredentialUpsertRequest } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-typebox";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// synthetic: an SSN with area 900 is never issued; the MBI is on compliance/synthetic-identifiers.json
const SSN_REF = "BAA folder 900-11-2222";
const MBI_REF = "see 1EG4TE5MK73";

const BODY = {
  providerEntityId: PE,
  macJurisdiction: "cgs_j15",
  submitterId: "SUB-1",
  tradingPartnerId: "TP-1",
  clientId: "client-1",
  clientSecret: "synthetic-mac-client-secret-0001",
};

function headerAuth(request: FastifyRequest): void {
  if (request.headers["x-test-user"] !== "admin") return;
  request.context.userId = USER;
  request.context.organizationId = ORG;
  request.context.roles = ["org_admin"];
  request.context.attributes.membershipId = MEMBERSHIP;
  request.context.attributes.stepUpRecent = true;
}

/** Every statement beyond the two `set_config` calls is recorded and refused: reaching the database means the text was accepted. */
function recordingDb(touched: string[]): DbClient {
  const refuse = (what: string) => () => {
    touched.push(what);
    throw new Error(`the database must not be reached (${what})`);
  };
  const tx = {
    execute: async () => [],
    select: refuse("select"),
    insert: refuse("insert"),
    update: refuse("update"),
  };
  return { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as DbClient;
}

let idem = 0;
const post = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/v1/billing/mac-credentials",
    headers: { "x-test-user": "admin", "idempotency-key": `mac-screen-${++idem}` },
    payload,
  });

describe("the MAC credential upsert screens baaRecordRef", () => {
  let touched: string[];
  let app: FastifyInstance;
  beforeEach(() => {
    touched = [];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: USER,
          grants: [
            {
              roleKey: "org_admin",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.mac_credential.read", "billing.mac_credential.admin"],
            },
          ],
        },
      ]).store,
    );
    const predicates = createPredicateRegistry();
    predicates.register("provider_entity_billing_scope", async () => true);
    predicates.register("step_up_recent", async () => true);
    registerAbacRegistry(predicates);
    const db = recordingDb(touched);
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerMacCredentialRoutes(app, {
      readService: buildDrizzleM23ReadService(db),
      writeService: buildDrizzleM23WriteService(db),
    });
  });
  afterEach(async () => {
    await app.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it.each([
    ["an SSN shape", SSN_REF, ["900-11-2222", "900112222"]],
    ["an MBI shape", MBI_REF, ["1EG4TE5MK73"]],
  ])(
    "%s is a 422 EVIDENCE_LOOKS_LIKE_PHI that never echoes it, and nothing is read or written",
    async (_name, ref, secrets) => {
      const res = await post(app, { ...BODY, baaRecordRef: ref });

      expect(res.statusCode, res.body).toBe(422);
      const error = res.json().error;
      expect(error.details).toEqual([
        expect.objectContaining({ field: "baaRecordRef", code: "EVIDENCE_LOOKS_LIKE_PHI" }),
      ]);
      for (const secret of secrets) expect(res.body).not.toContain(secret);
      expect(touched).toEqual([]);
    },
  );

  it("a blank reference is refused too (omit the field to leave it unset), before anything is read", async () => {
    const res = await post(app, { ...BODY, baaRecordRef: "   " });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.details).toEqual([
      expect.objectContaining({ field: "baaRecordRef", code: "MAC_BAA_RECORD_REF_INVALID" }),
    ]);
    expect(touched).toEqual([]);
  });

  it("a plain document reference is accepted: the write goes on to the database", async () => {
    const res = await post(app, { ...BODY, baaRecordRef: "BAA folder 2026, contract 14" });

    expect(res.statusCode).not.toBe(422);
    expect(touched).toContain("select"); // the recording database refused it there, which is past the screen
  });

  it("the operator lane's on-transaction upsert is screened by the same rule", async () => {
    const service = buildDrizzleM23WriteService(recordingDb([]));
    const scopedTx = {
      execute: async () => ({ rows: [{ org_id: ORG }] }),
      select: () => {
        touched.push("select");
        throw new Error("the database must not be reached");
      },
    } as unknown as DbClient;

    await expect(
      service.upsertMacCredentialOnTx(
        scopedTx as never,
        {
          organizationId: ORG,
          userId: USER,
          membershipId: MEMBERSHIP,
          roles: ["platform_ops"],
          stepUpRecent: true,
          actorKind: "user",
        },
        { ...BODY, baaRecordRef: SSN_REF },
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: [
        expect.objectContaining({ field: "baaRecordRef", code: "EVIDENCE_LOOKS_LIKE_PHI" }),
      ],
    });
    expect(touched).toEqual([]);
  });

  describe("submitterId, tradingPartnerId and clientId refuse a separator-formed SSN shape (7A security review L4)", () => {
    const FIELDS = ["submitterId", "tradingPartnerId", "clientId"] as const;
    // synthetic: area 900 is never issued
    const SSN_FORMS = [
      "900-11-2222",
      "900 11 2222",
      "900.11.2222",
      "id 900-11-2222 x",
      "９００-１１-２２２２",
    ];

    it.each(FIELDS.flatMap((field) => SSN_FORMS.map((value) => [field, value] as const)))(
      "%s = %j is a 422 EVIDENCE_LOOKS_LIKE_PHI that never echoes it, and nothing is read or written",
      async (field, value) => {
        const res = await post(app, { ...BODY, [field]: value });

        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().error.details).toEqual([
          expect.objectContaining({ field, code: "EVIDENCE_LOOKS_LIKE_PHI" }),
        ]);
        expect(res.body).not.toContain(value);
        expect(res.body).not.toMatch(/Expected string to match/); // a person's message, not a regular expression
        expect(touched).toEqual([]);
      },
    );

    it.each(FIELDS)(
      "%s keeps plain digit strings and ordinary identifiers: they reach the database",
      async (field) => {
        for (const value of [
          "900112222",
          "SUB-1",
          "TP 99",
          "chartwarden-dev-client",
          "1234-56-7890",
        ]) {
          touched.length = 0;
          const res = await post(app, { ...BODY, [field]: value });
          expect(res.statusCode, `${field}=${value}: ${res.body}`).not.toBe(422);
          expect(touched, value).toContain("select");
        }
      },
    );

    it("the operator lane's port refuses it by the same rule (the body is parsed with M23's schema there)", async () => {
      const port = buildMacOnboardingCredentialPort({
        writeService: { upsertMacCredentialOnTx: async () => ({}) as never },
        readService: { listMacCredentials: async () => ({ items: [] }) as never },
      });
      await expect(
        port.upsert(
          {} as never,
          {
            organizationId: ORG,
            operatorUserId: USER,
            operatorMembershipId: MEMBERSHIP,
            operatorRoles: ["platform_ops"],
            stepUpRecent: true,
            request: {},
          },
          { ...BODY, clientId: "900-11-2222" },
          undefined,
        ),
      ).rejects.toMatchObject({
        statusCode: 422,
        details: [expect.objectContaining({ field: "clientId", code: "EVIDENCE_LOOKS_LIKE_PHI" })],
      });
    });

    it("the published operator schema carries the very same pattern as M23's", () => {
      for (const field of FIELDS) {
        const m23 = (
          UpsertMacCredentialBodySchema.properties as Record<string, { pattern?: string }>
        )[field];
        const m34 = (
          OnboardingMacCredentialUpsertRequest.properties as Record<string, { pattern?: string }>
        )[field];
        expect(m23?.pattern, field).toBeTypeOf("string");
        expect(m34?.pattern, field).toBe(m23?.pattern);
      }
    });
  });
});
