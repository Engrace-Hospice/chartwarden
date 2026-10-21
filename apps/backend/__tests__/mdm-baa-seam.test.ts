// apps/backend/__tests__/mdm-baa-seam.test.ts — M40-T06 BaaStatusProvider seam (§4.6, §7.7).
//
// Proves M40's focused BAA-gate seam registers over the M1 deny-stub (separately from the omnibus
// MdmEntityProvider), passes validateSeams(), and is fail-closed when unregistered. Drives the two
// named acceptance scenarios over the in-memory store: W-M40-10 (§7.9 inbound by sending-facility)
// and W-M40-11 (§7.10 outbound by entity with asOf time-travel).
import { type BaaStatusProvider, createInMemoryBaaStore } from "@chartwarden/mdm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import { getBaaStatusProvider, registerMdmSeams } from "../src/modules/40-mdm/index";

const ORG = "org-engrace";
const ST_ANTHONY = "33333333-3333-3333-3333-333333333333";

// W-M40-10/11 fixture: ST_ANTHONY_HOSPITAL facility canonical with two sending-facility codes; the
// tenant has an executed BAA expiring 2027-12-31.
function store(expiresOn = "2027-12-31") {
  return createInMemoryBaaStore({
    facilities: [{ facilityId: ST_ANTHONY, sendingFacilityCodes: ["ST_ANTHONY", "STANTHONY_LAB"] }],
    required: [{ orgId: ORG, kind: "facility", required: true }],
    records: [
      {
        orgId: ORG,
        kind: "facility",
        canonicalId: ST_ANTHONY,
        record: {
          id: "baa-stanthony",
          baaStatus: "executed",
          executedOn: "2024-01-01",
          expiresOn,
        },
      },
    ],
  }).store;
}

describe("M40-T06 — BaaStatusProvider registers over the M1 deny-stub (§4.6)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares the seam in REQUIRED_SEAMS owned by M40, separate from MdmEntityProvider", () => {
    const baa = REQUIRED_SEAMS.find((r) => r.key === "BaaStatusProvider");
    const omnibus = REQUIRED_SEAMS.find((r) => r.key === "MdmEntityProvider");
    expect(baa?.ownerModule).toBe(40);
    expect(baa?.denyStub).toBeDefined();
    expect(baa?.phi).toBe(false);
    expect(omnibus).toBeDefined(); // both M40 seams coexist, registered separately
  });

  it("registers so validateSeams() passes and the typed getter resolves it", () => {
    registerMdmSeams({ baaStore: store() });
    expect(() => validateSeams()).not.toThrow();
    const provider: BaaStatusProvider = getBaaStatusProvider();
    expect(provider).toBeDefined();
  });

  it("W-M40-10 — inbound BAA gate by sendingFacility resolves to the facility's active BAA (§7.9)", async () => {
    registerMdmSeams({ baaStore: store() });
    validateSeams();
    const provider = getBaaStatusProvider();
    const result = await provider.baaStatusBySendingFacility({
      orgId: ORG,
      sendingFacility: "STANTHONY_LAB", // case-insensitive GIN match in production
      asOf: new Date("2026-06-19T10:00:00Z"),
    });
    expect(result).toEqual({
      isActive: true,
      status: "executed",
      expiresOn: "2027-12-31",
      requiredByPolicy: true,
      baaRecordId: "baa-stanthony",
    });
  });

  it("an unknown sendingFacility → conservative missing (no facility matched, §7.9)", async () => {
    registerMdmSeams({ baaStore: store() });
    validateSeams();
    const provider = getBaaStatusProvider();
    const result = await provider.baaStatusBySendingFacility({
      orgId: ORG,
      sendingFacility: "UNKNOWN_LAB",
      asOf: new Date("2026-06-19"),
    });
    expect(result.isActive).toBe(false);
    expect(result.status).toBe("missing");
    expect(result.requiredByPolicy).toBe(true);
  });

  it("W-M40-11 — outbound BAA gate by entity is active at transmit time (§7.10)", async () => {
    registerMdmSeams({ baaStore: store() });
    validateSeams();
    const provider = getBaaStatusProvider();
    const result = await provider.baaStatusByMdmEntity({
      orgId: ORG,
      kind: "facility",
      id: ST_ANTHONY,
      asOf: new Date("2026-06-19T14:32:03Z"),
    });
    expect(result.isActive).toBe(true);
    expect(result.status).toBe("executed");
  });

  it("W-M40-11 variant — BAA expired before the (post-expiry) transmit moment → refused (§7.10)", async () => {
    registerMdmSeams({ baaStore: store("2026-06-18") }); // expired yesterday
    validateSeams();
    const provider = getBaaStatusProvider();
    const result = await provider.baaStatusByMdmEntity({
      orgId: ORG,
      kind: "facility",
      id: ST_ANTHONY,
      asOf: new Date("2026-06-19T00:00:01Z"), // job queued before expiry, processed after
    });
    expect(result.isActive).toBe(false);
    expect(result.status).toBe("expired");
    expect(result.expiresOn).toBe("2026-06-18");
  });

  it("without registration the seam boots FAIL-CLOSED (deny-stub throws on any call)", () => {
    validateSeams();
    const provider = getBaaStatusProvider();
    expect(() =>
      provider.baaStatusByMdmEntity({
        orgId: ORG,
        kind: "facility",
        id: ST_ANTHONY,
        asOf: new Date(),
      }),
    ).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers the seam during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    const provider = getBaaStatusProvider();
    // Boot completed AND it's the real impl: an unconfigured org/entity resolves (default-required
    // facility, no record) to a missing gate rather than throwing the deny-stub.
    const result = await provider.baaStatusByMdmEntity({
      orgId: ORG,
      kind: "facility",
      id: ST_ANTHONY,
      asOf: new Date(),
    });
    expect(result.status).toBe("missing");
    await app.close();
  });
});
