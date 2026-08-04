// apps/backend/src/modules/28-fhir/__tests__/m28-routes.test.ts — M28-T08 §7 acceptance tests.
//
// W-FHIR-01 (client onboard propose→approve), W-FHIR-02 (dual-approval; self-approval refused),
// W-FHIR-07 (forward-seam Claim route 404 BEFORE any reader), W-FHIR-12 (revocation cascade → sessions
// revoked + in-flight exports cancelled). The package-level §7 cases (W-FHIR-03/04/05/06/08/09/10/11) are
// already covered by `packages/fhir/__tests__/*`; these exercise the T08 store + routes.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerFhirR4Routes } from "../routes/fhir-r4.routes";
import {
  type FhirRevocationCascadePort,
  cascadeClientRevocation,
} from "../routes/revocation-cascade";
import { FhirStoreError, createInMemoryFhirGatewayStore } from "../routes/store";

const ORG = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";
const COMPLIANCE = "33333333-3333-3333-3333-333333333333";

const baseClientArgs = {
  name: "Partner EHR",
  type: "api_key" as const,
  allowedScopes: ["system/Patient.read"],
  tier: "tier-2" as const,
  rateLimitRps: 10,
  ipAllowlist: [] as string[],
  baaContractReference: "baa-001",
  proposedByMembershipId: ADMIN,
};

describe("W-FHIR-01 — client onboard (propose → co-approve → active)", () => {
  it("proposes into pending_approval then activates on distinct co-approval", async () => {
    const store = createInMemoryFhirGatewayStore();
    const { client, plaintextSecret } = await store.createClient(ORG, baseClientArgs);
    expect(client.status).toBe("pending_approval");
    expect(plaintextSecret).toBeTypeOf("string"); // api_key mints a one-time secret

    const approved = await store.approveClient(
      ORG,
      client.id,
      COMPLIANCE,
      "BAA verified, scopes reviewed.",
    );
    expect(approved.status).toBe("active");
    expect(approved.approvedAt).not.toBeNull();
  });
});

describe("W-FHIR-02 — dual approval refuses self-approval", () => {
  it("refuses when the Compliance approver is the same membership as the proposing Admin", async () => {
    const store = createInMemoryFhirGatewayStore();
    const { client } = await store.createClient(ORG, baseClientArgs);
    await expect(
      store.approveClient(ORG, client.id, ADMIN, "self approval attempt here."),
    ).rejects.toBeInstanceOf(FhirStoreError);
    // The client stays pending — a refused approval must not advance the FSM.
    const still = await store.getClient(ORG, client.id);
    expect(still?.status).toBe("pending_approval");
  });

  it("accepts a DISTINCT compliance approver", async () => {
    const store = createInMemoryFhirGatewayStore();
    const { client } = await store.createClient(ORG, baseClientArgs);
    const approved = await store.approveClient(
      ORG,
      client.id,
      COMPLIANCE,
      "distinct approver rationale.",
    );
    expect(approved.status).toBe("active");
  });
});

describe("W-FHIR-12 — revocation cascade", () => {
  it("cascadeClientRevocation revokes every live session and cancels every in-flight job", async () => {
    const revoked: string[] = [];
    const cancelled: string[] = [];
    const port: FhirRevocationCascadePort = {
      async activeSessionJtisForClient() {
        return ["jti-1", "jti-2"];
      },
      async revokeSession(_org, _client, jti) {
        revoked.push(jti);
      },
      async inflightJobIdsForClient() {
        return ["job-1"];
      },
      async cancelJob(_org, jobId) {
        cancelled.push(jobId);
      },
    };
    const result = await cascadeClientRevocation(ORG, "client-1", port);
    expect(result).toEqual({ sessionsRevoked: 2, jobsCancelled: 1 });
    expect(revoked).toEqual(["jti-1", "jti-2"]);
    expect(cancelled).toEqual(["job-1"]);
  });

  it("store.revokeClient cascades to seeded sessions + jobs in the same call", async () => {
    const store = createInMemoryFhirGatewayStore({
      clients: [{ id: "c1", organizationId: ORG, status: "active" }],
      sessions: [
        { jti: "s1", clientId: "c1", organizationId: ORG, token: "tok-1" },
        { jti: "s2", clientId: "c1", organizationId: ORG, token: "tok-2" },
      ],
      jobs: [{ id: "j1", clientId: "c1", organizationId: ORG, status: "in_progress" }],
    });
    const { client, cascade } = await store.revokeClient(
      ORG,
      "c1",
      ADMIN,
      "revoked for cause with sufficient detail here.",
    );
    expect(client.status).toBe("revoked");
    expect(cascade.sessionsRevoked).toBe(2);
    expect(cascade.jobsCancelled).toBe(1);
    // The bearer token no longer resolves once its session is revoked.
    expect(await store.resolveBearer("tok-1")).toBeNull();
    const jobs = await store.listJobs(ORG, { clientId: "c1" });
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
  });

  it("suspend also runs the cascade (a suspended client's live tokens must die)", async () => {
    const store = createInMemoryFhirGatewayStore({
      clients: [{ id: "c2", organizationId: ORG, status: "active" }],
      sessions: [{ jti: "s3", clientId: "c2", organizationId: ORG, token: "tok-3" }],
    });
    const { client, cascade } = await store.suspendClient(ORG, "c2", ADMIN, "rate violation");
    expect(client.status).toBe("suspended");
    expect(cascade.sessionsRevoked).toBe(1);
  });
});

describe("W-FHIR-07 — forward-seam Claim route 404 BEFORE any reader", () => {
  const buildApp = () => {
    const app = Fastify();
    registerFhirR4Routes(app, { store: createInMemoryFhirGatewayStore() });
    return app;
  };

  it("GET /fhir/r4/Claim/:id returns 404 + OperationOutcome (short-circuits before ClaimReader)", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/Claim/abc" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("not-found");
    await app.close();
  });

  it("the other forward-seam + Phase-2 resources also 404", async () => {
    const app = buildApp();
    for (const resource of [
      "ClaimResponse",
      "ExplanationOfBenefit",
      "ServiceRequest",
      "QuestionnaireResponse",
      "Location",
    ]) {
      const res = await app.inject({ method: "GET", url: `/fhir/r4/${resource}/x` });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  it("GET /fhir/r4/metadata returns a CapabilityStatement", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/metadata" });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("CapabilityStatement");
    await app.close();
  });

  it("a bearer-required route without a token is 401 + OperationOutcome", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/Patient/p1" });
    expect(res.statusCode).toBe(401);
    expect(res.json().resourceType).toBe("OperationOutcome");
    await app.close();
  });

  it("FHIR R5 routes are 415 Unsupported Media Type", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/fhir/r5/Patient/1" });
    expect(res.statusCode).toBe(415);
    await app.close();
  });
});
