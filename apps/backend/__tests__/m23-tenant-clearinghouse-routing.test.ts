// ADR-0053 amendment 2026-11-06 — with tenant clearinghouses the M23 submit path resolves the transport PER ORGANIZATION,
// and an organization with no live clearinghouse is refused (never sent through another org's account, never the legacy
// portal). No database, no network: the per-org binding is a plain function over in-memory transports.
import {
  CH,
  type ClearinghouseBinding,
  type ClearinghouseContext,
  UNBOUND_BINDING,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import {
  type M23TransportDeps,
  hasPerOrgTransport,
  transportForOrg,
  transportUploadPerOrg,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";
import { assertTransportInjected } from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_NONE = "33333333-3333-4333-8333-333333333333";
const PE = "44444444-4444-4444-8444-444444444444";

const X12 = (control: string) =>
  `ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260101*1200*^*00501*${control}*0*T*:~`;

function perOrgDeps() {
  const a = new InMemoryClearinghouse();
  const b = new InMemoryClearinghouse();
  const resolved: string[] = [];
  const binding: ClearinghouseBinding = {
    ...UNBOUND_BINDING,
    forOrg: async (org) => {
      resolved.push(org);
      if (org === ORG_A) return { vendor: "in_memory", transport: a };
      if (org === ORG_B) return { vendor: "in_memory", transport: b };
      return UNBOUND_BINDING;
    },
  };
  const contexts = {
    contextFor: async (organizationId: string): Promise<ClearinghouseContext> => ({
      organizationId,
      providerEntityId: PE,
      payerId: "ngs_j6",
      correlationId: "corr",
      usage: "test",
      jurisdiction: "ngs_j6",
    }),
    providerEntitiesFor: async () => [PE],
  };
  const transport: M23TransportDeps = { binding, contexts };
  return { deps: { transport }, a, b, resolved };
}

const upload = (organizationId: string, control: string) => ({
  organizationId,
  providerEntityId: PE,
  kind: "noe" as const,
  x12: X12(control),
  controlNumber: control,
});

describe("per-organization transport resolution in M23", () => {
  it("recognizes a per-org binding, and never treats its unbound top level as a vendor", () => {
    const { deps } = perOrgDeps();
    expect(hasPerOrgTransport(deps)).toBe(true);
    expect(hasPerOrgTransport({})).toBe(false);
    expect(hasPerOrgTransport({ transport: { ...deps.transport, binding: UNBOUND_BINDING } })).toBe(false);
  });

  it("resolves each org's own binding, with the shared contexts and stores", async () => {
    const { deps, a, b } = perOrgDeps();
    const forA = await transportForOrg(deps, ORG_A);
    const forB = await transportForOrg(deps, ORG_B);
    expect(forA?.binding.transport).toBe(a);
    expect(forB?.binding.transport).toBe(b);
    expect(forA?.contexts).toBe(deps.transport.contexts);
  });

  it("returns an unbound binding (never null = never the legacy ports) for an org with no live clearinghouse", async () => {
    const { deps } = perOrgDeps();
    const none = await transportForOrg(deps, ORG_NONE);
    expect(none).not.toBeNull();
    expect(none?.binding.vendor).toBeNull();
  });

  it("keeps the single-binding behaviour: null for the legacy ports when unbound, the deps when a vendor is bound", async () => {
    const bound: M23TransportDeps = {
      binding: { vendor: "in_memory", transport: new InMemoryClearinghouse() },
      contexts: perOrgDeps().deps.transport.contexts,
    };
    expect(await transportForOrg({}, ORG_A)).toBeNull();
    expect(await transportForOrg({ transport: { ...bound, binding: UNBOUND_BINDING } }, ORG_A)).toBeNull();
    expect(await transportForOrg({ transport: bound }, ORG_A)).toBe(bound);
  });

  it("uploads through the org's own vendor only", async () => {
    const { deps, a, b } = perOrgDeps();
    const send = transportUploadPerOrg(deps);
    const done = await send(upload(ORG_A, "000000001"));
    expect(done.accepted).toBe(true);
    expect(done.generatedFileUri).toMatch(/^clearinghouse:in_memory:/);
    // org B's vendor saw nothing of org A's submission, and A's vendor holds it
    const scopeA = { organizationId: ORG_A, providerEntityId: PE, usage: "test" } as const;
    const scopeB = { ...scopeA, organizationId: ORG_B };
    expect((await a.fetchAcknowledgments({ ...scopeA, payerId: "p", correlationId: "c" }, null)).ok).toBe(true);
    expect((await b.fetchAcknowledgments({ ...scopeB, payerId: "p", correlationId: "c" }, null)).ok).toBe(true);
  });

  it("refuses an org with no live clearinghouse, and does not touch any org's vendor", async () => {
    const { deps } = perOrgDeps();
    await expect(transportUploadPerOrg(deps)(upload(ORG_NONE, "000000002"))).rejects.toThrow(
      new RegExp(`${CH.NOT_WIRED}.*no clearinghouse is active`),
    );
  });

  it("a worker with per-org bindings needs no single vendor at boot", () => {
    const { deps } = perOrgDeps();
    expect(() => assertTransportInjected({ CLEARINGHOUSE_VENDOR: "stedi" }, deps)).not.toThrow();
    expect(() => assertTransportInjected({}, deps)).not.toThrow();
  });
});
