// apps/backend/src/modules/28-fhir/__tests__/m28-abac.test.ts — M28-T08 §4.7 predicate unit tests.
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { describe, expect, it } from "vitest";

import {
  buildFhirGatewayAbacPredicates,
  denyStubFhirGatewayAbacResolver,
  FHIR_OWNER_MODULE_WRITE_PERMISSION,
  type FhirGatewayAbacResolver,
} from "../abac-predicates";

const ORG = "org-1";
const ctx = (over: Partial<AbacContext> = {}): AbacContext =>
  ({
    organizationId: ORG,
    userId: "u1",
    roles: [],
    attributes: { membershipId: "m1" },
    ...over,
  }) as AbacContext;

const resolver = (over: Partial<FhirGatewayAbacResolver>): FhirGatewayAbacResolver => ({
  ...denyStubFhirGatewayAbacResolver,
  ...over,
});

describe("fhir_client_organization_scope", () => {
  it("allows a client in the actor's org and denies a cross-tenant one", async () => {
    const p = buildFhirGatewayAbacPredicates({
      resolver: resolver({ async clientOrgId() { return ORG; } }),
    }).fhir_client_organization_scope;
    expect(await p(ctx(), { clientId: "c1" } as AbacTarget)).toBe(true);

    const cross = buildFhirGatewayAbacPredicates({
      resolver: resolver({ async clientOrgId() { return "other-org"; } }),
    }).fhir_client_organization_scope;
    expect(await cross(ctx(), { clientId: "c1" } as AbacTarget)).toBe(false);
  });
});

describe("fhir_inbound_owner_module_match", () => {
  it("allows only a reviewer holding the owner module's native write permission", async () => {
    const predicates = buildFhirGatewayAbacPredicates({
      resolver: resolver({
        async inboundOwnerModule() {
          return "m5";
        },
        async holdsPermission(_org, _member, key) {
          return key === FHIR_OWNER_MODULE_WRITE_PERMISSION.m5;
        },
      }),
    });
    expect(await predicates.fhir_inbound_owner_module_match(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(true);

    const denied = buildFhirGatewayAbacPredicates({
      resolver: resolver({
        async inboundOwnerModule() {
          return "m12";
        },
        async holdsPermission(_org, _member, key) {
          return key === FHIR_OWNER_MODULE_WRITE_PERMISSION.m5; // holds m5, not m12
        },
      }),
    });
    expect(await denied.fhir_inbound_owner_module_match(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(false);
  });

  it("fails closed when the proposal is unreadable", async () => {
    const p = buildFhirGatewayAbacPredicates({ resolver: denyStubFhirGatewayAbacResolver })
      .fhir_inbound_owner_module_match;
    expect(await p(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(false);
  });
});

describe("bulk_export_initiator_or_admin", () => {
  it("allows the initiator", async () => {
    const p = buildFhirGatewayAbacPredicates({
      resolver: resolver({
        async loadBulkExportJob() {
          return { jobId: "j1", organizationId: ORG, clientId: "c1", initiatedByMembershipId: "m1" };
        },
      }),
    }).bulk_export_initiator_or_admin;
    expect(await p(ctx(), { jobId: "j1" } as AbacTarget)).toBe(true);
  });

  it("allows a non-initiator who holds the cancel permission", async () => {
    const p = buildFhirGatewayAbacPredicates({
      resolver: resolver({
        async loadBulkExportJob() {
          return { jobId: "j1", organizationId: ORG, clientId: "c1", initiatedByMembershipId: "someone-else" };
        },
        async holdsPermission() {
          return true;
        },
      }),
    }).bulk_export_initiator_or_admin;
    expect(await p(ctx(), { jobId: "j1" } as AbacTarget)).toBe(true);
  });

  it("denies an unrelated member without the cancel permission", async () => {
    const p = buildFhirGatewayAbacPredicates({
      resolver: resolver({
        async loadBulkExportJob() {
          return { jobId: "j1", organizationId: ORG, clientId: "c1", initiatedByMembershipId: "someone-else" };
        },
        async holdsPermission() {
          return false;
        },
      }),
    }).bulk_export_initiator_or_admin;
    expect(await p(ctx(), { jobId: "j1" } as AbacTarget)).toBe(false);
  });
});
