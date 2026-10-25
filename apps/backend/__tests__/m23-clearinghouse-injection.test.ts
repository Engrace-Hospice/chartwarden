// #707 - the bound clearinghouse transport reaches the M23 workers, and a worker cannot be built without it while a
// vendor is configured. Also pins the direct_mac gateway adaptation (#706). No database, no network.
import {
  CH,
  type ClearinghouseBinding,
  type ClearinghouseContext,
} from "@chartwarden/x12-837-client";
import { NOT_WIRED_TRANSPORT } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import { clearinghouseUsageFromEnv } from "../src/modules/23-billing-medicare/jobs/clearinghouse-context";
import {
  type M23TransportDeps,
  type TransportAck,
  ackFromEvent,
  activeTransport,
  priorClaimAttempt,
  pullTransportAcks,
  transportUpload,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";
import { buildDirectMacGateway } from "../src/modules/23-billing-medicare/jobs/direct-mac-gateway";
import {
  assertTransportInjected,
  buildM23WorkerDeps,
  registerM23LaunchWorkers,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "22222222-2222-2222-2222-222222222222";
const ISA = (usage: "T" | "P", controlNumber: string) =>
  `ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260101*1200*^*00501*${controlNumber}*0*${usage}*:~`;

const ctx: ClearinghouseContext = {
  organizationId: ORG,
  providerEntityId: PE,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
};

function transportDeps(inMemory = new InMemoryClearinghouse()): M23TransportDeps {
  const binding: ClearinghouseBinding = { vendor: "in_memory", transport: inMemory };
  return {
    binding,
    contexts: {
      contextFor: async () => ctx,
      providerEntitiesFor: async () => [PE],
    },
  };
}

const unboundPortal = () => {
  throw new Error("the legacy portal must not be reached");
};

describe("a worker cannot be built without the binding while a vendor is configured (#707)", () => {
  it("assertTransportInjected throws when CLEARINGHOUSE_VENDOR is set and no transport was injected", () => {
    expect(() => assertTransportInjected({ CLEARINGHOUSE_VENDOR: "stedi" }, {})).toThrow(
      /CLEARINGHOUSE_VENDOR=stedi.*without that clearinghouse binding/,
    );
  });

  it("also throws for an injected-but-unbound binding or one for another vendor", () => {
    const unbound: M23TransportDeps = {
      binding: { vendor: null, transport: NOT_WIRED_TRANSPORT },
      contexts: transportDeps().contexts,
    };
    expect(() =>
      assertTransportInjected({ CLEARINGHOUSE_VENDOR: "stedi" }, { transport: unbound }),
    ).toThrow();
    expect(() =>
      assertTransportInjected({ CLEARINGHOUSE_VENDOR: "stedi" }, { transport: transportDeps() }),
    ).toThrow();
  });

  it("passes when the matching binding is injected, and when no vendor is configured", () => {
    expect(() =>
      assertTransportInjected(
        { CLEARINGHOUSE_VENDOR: "in_memory", CLEARINGHOUSE_PAYER_ID: "MCARE" },
        { transport: transportDeps() },
      ),
    ).not.toThrow();
    expect(() => assertTransportInjected({}, {})).not.toThrow();
  });

  it("refuses a bound vendor with no CLEARINGHOUSE_PAYER_ID (the MAC enum is not an X12 payer id)", () => {
    for (const payer of [undefined, "  "]) {
      expect(() =>
        assertTransportInjected(
          { CLEARINGHOUSE_VENDOR: "in_memory", CLEARINGHOUSE_PAYER_ID: payer },
          { transport: transportDeps() },
        ),
      ).toThrow(/requires CLEARINGHOUSE_PAYER_ID/);
    }
  });

  it("registerM23LaunchWorkers refuses to build the workers (before opening any queue)", () => {
    const deps = buildM23WorkerDeps({
      connection: {} as never,
      db: {} as never,
      outbox: { publish: async () => {} },
      x12: {} as never,
      macPortal: {} as never,
      jurisdictions: { listJurisdictions: async () => [] },
    });
    expect(() => registerM23LaunchWorkers(deps, { CLEARINGHOUSE_VENDOR: "in_memory" })).toThrow(
      /M23LaunchCapabilityIncomplete.*CLEARINGHOUSE_VENDOR=in_memory/,
    );
  });

  it("buildM23WorkerDeps carries the transport through", () => {
    const transport = transportDeps();
    expect(
      buildM23WorkerDeps({ connection: {} as never, db: {} as never, transport }).transport,
    ).toBe(transport);
  });

  it("activeTransport is null for an unbound binding (the legacy ports) and set for a vendor", () => {
    expect(
      activeTransport({
        transport: {
          binding: { vendor: null, transport: NOT_WIRED_TRANSPORT },
          contexts: transportDeps().contexts,
        },
      }),
    ).toBeNull();
    expect(activeTransport({})).toBeNull();
    expect(activeTransport({ transport: transportDeps() })).not.toBeNull();
  });
});

describe("transportUpload (claim / NOE / NOTR submit + retry go through the vendor)", () => {
  const upload = (
    kind: "claim_837i" | "noe" | "notr" | "transfer_notice",
    n: string,
    t = transportDeps(),
  ) =>
    transportUpload(t)({
      organizationId: ORG,
      providerEntityId: PE,
      kind,
      x12: ISA("T", "000000001"),
      controlNumber: n,
    });

  it("files each kind with the vendor and answers in the legacy shape", async () => {
    for (const [kind, n] of [
      ["claim_837i", "CCN1"],
      ["noe", "NOE1"],
      ["notr", "NOTR1"],
      ["transfer_notice", "TN1"],
    ] as const) {
      const r = await upload(kind, n);
      expect(r.accepted).toBe(true);
      expect(r.generatedFileUri).toMatch(/^clearinghouse:in_memory:/);
    }
  });

  it("a retry of the same control number replays instead of filing twice", async () => {
    const t = transportDeps();
    const a = await upload("claim_837i", "CCN2", t);
    const b = await upload("claim_837i", "CCN2", t);
    expect(b.generatedFileUri).toBe(a.generatedFileUri);
  });

  it("a degraded vendor answer throws (the worker records failed_portal) and never reaches the legacy portal", async () => {
    const inMemory = new InMemoryClearinghouse();
    await inMemory.control.setOutage(true);
    await expect(upload("claim_837i", "CCN3", transportDeps(inMemory))).rejects.toThrow(
      CH.UNAVAILABLE,
    );
    const worker = buildM23WorkerDeps({
      connection: {} as never,
      db: {} as never,
      transport: transportDeps(),
      macPortal: {
        upload: unboundPortal,
        pullPending999: unboundPortal,
        pullPending277ca: unboundPortal,
        probeHealth: unboundPortal,
      },
    });
    expect(worker.macPortal?.upload).toBe(unboundPortal); // the legacy port is only bypassed inside macPortalOf
  });

  it("a transfer notice rides submitNotice; a vendor that cannot carry it refuses with a typed error, never the legacy portal", async () => {
    const inMemory = new InMemoryClearinghouse();
    await inMemory.control.setOutage(true);
    await expect(upload("transfer_notice", "TN2", transportDeps(inMemory))).rejects.toThrow(
      CH.UNAVAILABLE,
    );
    const refusing = transportDeps();
    const refuse = async () => ({
      ok: false as const,
      degraded: {
        code: CH.INVALID_REQUEST,
        reason: "this transport cannot carry a transfer notice",
      },
    });
    const t = {
      ...refusing,
      binding: {
        ...refusing.binding,
        transport: Object.assign(Object.create(refusing.binding.transport), {
          submitNotice: refuse,
        }),
      },
    };
    await expect(upload("transfer_notice", "TN3", t)).rejects.toThrow(CH.INVALID_REQUEST);
    await expect(upload("bogus" as never, "TN4")).rejects.toThrow(CH.INVALID_REQUEST);
  });
});

/** Collects every page handed to `onPage` (the shape these tests assert on). */
async function pulledAcks(t: M23TransportDeps, kind: "ack_999" | "ack_277ca") {
  const acks: TransportAck[] = [];
  const { failures } = await pullTransportAcks(t, ORG, kind, async (page) => {
    acks.push(...page);
  });
  return { acks, failures };
}

describe("acknowledgments over the transport", () => {
  it("rides the 999 edge for the clearinghouse stage and the 277CA edge for the payer stage", () => {
    const scope = { organizationId: ORG, providerEntityId: PE, macJurisdiction: "ngs_j6" };
    const base = {
      controlNumber: "CCN1",
      reasonCodes: [],
      occurredAt: "2026-10-11T10:00:00.000Z",
    } as const;
    const ch = ackFromEvent(
      { ...base, eventId: "e1", stage: "clearinghouse", disposition: "accepted" },
      scope,
    );
    const payer = ackFromEvent(
      { ...base, eventId: "e2", stage: "payer", disposition: "accepted", payerClaimNumber: "ICN9" },
      scope,
    );
    expect(ch).toMatchObject({
      kind: "ack_999",
      stage: "clearinghouse",
      outcome: "accepted",
      day: "2026-10-11",
    });
    expect(payer).toMatchObject({ kind: "ack_277ca", stage: "payer", payerControlNumber: "ICN9" });
    expect(ch.ackFileUri).toBe("clearinghouse:e1");
  });

  it("maps a first-class partial payer disposition, and no longer reads a PARTIAL marker", () => {
    const scope = { organizationId: ORG, providerEntityId: PE, macJurisdiction: "ngs_j6" };
    const event = {
      eventId: "e3",
      stage: "payer" as const,
      controlNumber: "CCN1",
      occurredAt: "2026-10-11",
    };
    const partial = ackFromEvent(
      { ...event, disposition: "partial", reasonCodes: ["A7:562"] },
      scope,
    );
    expect(partial).toMatchObject({
      kind: "ack_277ca",
      outcome: "partial",
      reasonCodes: ["A7:562"],
    });
    const marked = ackFromEvent(
      { ...event, disposition: "rejected", reasonCodes: ["PARTIAL", "A7:562"] },
      scope,
    );
    expect(marked).toMatchObject({ outcome: "rejected", reasonCodes: ["PARTIAL", "A7:562"] });
  });

  it("pulls the provider's events from the vendor and filters by stage", async () => {
    const inMemory = new InMemoryClearinghouse();
    const t = transportDeps(inMemory);
    await transportUpload(t)({
      organizationId: ORG,
      providerEntityId: PE,
      kind: "claim_837i",
      x12: ISA("T", "000000001"),
      controlNumber: "CCN7",
    });
    const scope = { organizationId: ORG, providerEntityId: PE, usage: "test" as const };
    await inMemory.control.clearinghouseAccepts("CCN7", scope);
    await inMemory.control.payerAccepts("CCN7", "ICN7", scope);
    const first = await pulledAcks(t, "ack_999");
    const second = await pulledAcks(t, "ack_277ca");
    expect(first.acks.map((a) => a.stage)).toEqual(["clearinghouse"]);
    expect(second.acks.map((a) => [a.stage, a.payerControlNumber])).toEqual([["payer", "ICN7"]]);
  });

  it("a degraded pull is reported as a failure (the cron then fails and BullMQ retries it)", async () => {
    const inMemory = new InMemoryClearinghouse();
    await inMemory.control.setOutage(true);
    const pulled = await pulledAcks(transportDeps(inMemory), "ack_999");
    expect(pulled.acks).toEqual([]);
    expect(pulled.failures).toEqual([expect.stringContaining(CH.UNAVAILABLE)]);
  });

  it("one provider entity that cannot be pulled does not stop the others", async () => {
    const inMemory = new InMemoryClearinghouse();
    const bad = "33333333-3333-3333-3333-333333333333";
    const t: M23TransportDeps = {
      binding: { vendor: "in_memory", transport: inMemory },
      contexts: {
        providerEntitiesFor: async () => [bad, PE],
        contextFor: async (_o, pe) => {
          if (pe === bad) throw new Error("no NPI on file");
          return ctx;
        },
      },
    };
    await transportUpload(t)({
      organizationId: ORG,
      providerEntityId: PE,
      kind: "claim_837i",
      x12: ISA("T", "000000001"),
      controlNumber: "CCN8",
    });
    await inMemory.control.clearinghouseAccepts("CCN8", {
      organizationId: ORG,
      providerEntityId: PE,
      usage: "test",
    });
    const pulled = await pulledAcks(t, "ack_999");
    expect(pulled.acks).toHaveLength(1);
    expect(pulled.failures).toEqual([expect.stringContaining("no NPI on file")]);
  });
});

describe("buildDirectMacGateway (the launch gateway behind the direct_mac transport)", () => {
  const x12Port = (overrides: Record<string, unknown> = {}) =>
    ({
      generate837i: async () => ({ x12: "CLAIM", correlationId: "c" }),
      generateNoe: async () => ({ x12: "NOE", correlationId: "c" }),
      generateNotr: async () => ({ x12: "NOTR", correlationId: "c" }),
      parse999: async () => [],
      parse277ca: async () => [],
      ...overrides,
    }) as never;
  const portal = (overrides: Record<string, unknown> = {}) =>
    ({
      upload: async () => ({ accepted: true, generatedFileUri: "s3://f" }),
      pullPending999: async () => [{ rawFileUri: "raw-999" }],
      pullPending277ca: async () => [{ rawFileUri: "raw-277" }],
      probeHealth: async () => true,
      ...overrides,
    }) as never;

  it("maps generate by kind and upload to the legacy portal kinds", async () => {
    const calls: unknown[] = [];
    const gw = buildDirectMacGateway({
      x12: x12Port(),
      macPortal: portal({
        upload: async (i: unknown) => {
          calls.push(i);
          return { accepted: true, generatedFileUri: "s3://f" };
        },
      }),
      controlNumberOf: async () => null,
    });
    expect(
      (
        await gw.generate({
          kind: "claim",
          organizationId: ORG,
          controlNumber: "C",
          document: { claimId: "c", claimDocument: {} },
        })
      ).x12,
    ).toBe("CLAIM");
    expect(
      (
        await gw.generate({
          kind: "noe",
          organizationId: ORG,
          controlNumber: "N",
          document: { noeId: "n" },
        })
      ).x12,
    ).toBe("NOE");
    expect(
      (
        await gw.generate({
          kind: "notr",
          organizationId: ORG,
          controlNumber: "R",
          document: { notrId: "r" },
        })
      ).x12,
    ).toBe("NOTR");
    await expect(
      gw.generate({ kind: "noe", organizationId: ORG, controlNumber: "N", document: {} }),
    ).rejects.toThrow(/noeId/);
    const up = await gw.upload({
      kind: "claim",
      organizationId: ORG,
      providerEntityId: PE,
      controlNumber: "C",
      x12: "X",
    });
    expect(up).toEqual({ accepted: true, fileId: "s3://f" });
    expect(calls).toEqual([expect.objectContaining({ kind: "claim_837i", controlNumber: "C" })]);
  });

  it("turns the pending 999/277CA files into port events for this org only", async () => {
    const gw = buildDirectMacGateway({
      x12: x12Port({
        parse999: async () => [
          {
            organizationId: ORG,
            claimId: "c",
            submissionId: "s",
            claimControlNumber: "CCN1",
            accepted: true,
            reasonCodes: [],
            ackFileUri: "u1",
            functionalGroupDate: "2026-10-01",
          },
          {
            organizationId: "other",
            claimId: "c",
            submissionId: "s",
            claimControlNumber: "CCN2",
            accepted: true,
            reasonCodes: [],
            ackFileUri: "u2",
          },
        ],
        parse277ca: async () => [
          {
            organizationId: ORG,
            claimId: "c",
            submissionId: "sub-1",
            outcome: "partial",
            payerClaimControlNumber: "ICN",
            reasonCodes: ["A7"],
            ackFileUri: "u3",
          },
          {
            organizationId: ORG,
            claimId: "c",
            submissionId: "unknown",
            outcome: "accepted",
            payerClaimControlNumber: "ICN",
            reasonCodes: [],
            ackFileUri: "u4",
          },
        ],
      }),
      macPortal: portal(),
      controlNumberOf: async (_o, s) => (s === "sub-1" ? "CCN1" : null),
      now: () => new Date("2026-10-11T00:00:00Z"),
    });
    const events = await gw.pullAcknowledgments(ctx);
    expect(events).toEqual([
      expect.objectContaining({
        eventId: "999:u1:CCN1",
        stage: "clearinghouse",
        occurredAt: "2026-10-01",
      }),
      expect.objectContaining({
        eventId: "277ca:u3:CCN1",
        stage: "payer",
        disposition: "partial",
        reasonCodes: ["A7"],
        occurredAt: "2026-10-11",
      }),
    ]);
  });

  it("refuses to pull without a jurisdiction", async () => {
    const gw = buildDirectMacGateway({
      x12: x12Port(),
      macPortal: portal(),
      controlNumberOf: async () => null,
    });
    const { jurisdiction: _j, ...noJurisdiction } = ctx;
    await expect(gw.pullAcknowledgments(noJurisdiction)).rejects.toThrow(/jurisdiction/);
  });
});

describe("clearinghouseUsageFromEnv", () => {
  it("defaults by NODE_ENV, honours an explicit value, and refuses test mode in production", () => {
    expect(clearinghouseUsageFromEnv({})).toBe("test");
    expect(clearinghouseUsageFromEnv({ NODE_ENV: "production" })).toBe("production");
    expect(clearinghouseUsageFromEnv({ CLEARINGHOUSE_USAGE: "production" })).toBe("production");
    expect(() => clearinghouseUsageFromEnv({ CLEARINGHOUSE_USAGE: "bogus" })).toThrow();
    expect(() =>
      clearinghouseUsageFromEnv({ NODE_ENV: "production", CLEARINGHOUSE_USAGE: "test" }),
    ).toThrow(/refused in production/);
  });
});

describe("the retry's view of an earlier attempt fails closed (#754)", () => {
  it("priorClaimAttempt is null without an attempt store, so an in-doubt retry cannot be judged settled", async () => {
    const withoutStore = transportDeps(); // no `attempts`
    expect(withoutStore.attempts).toBeUndefined();
    await expect(
      priorClaimAttempt(withoutStore, ORG, PE, "ABC123-260101-8zde6-00"),
    ).resolves.toBeNull();
  });
});
